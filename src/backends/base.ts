/**
 * base.ts — shared logic for CLI-based backends (subprocess).
 *
 * Each CLI backend (dsh, qwen, grok, kimi, mcode) extends `CliBackendAgent`
 * and just provides: binary name, arg layout, output parser.
 *
 * This keeps each backend ~50 lines instead of duplicating ~300 lines of
 * process-spawning + state-management code.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Agent, AgentEvent, AgentResponse, ModelInfo, PromptOptions, SessionInfo } from "../agent.js";
import { AgentError } from "../agent.js";

const DEFAULT_KILL_GRACE_MS = 5_000;

export interface CliBackendOptions {
  /** Name of the binary on PATH (or DSH_MCP_BIN override). */
  binary: string;
  /** Env-var to override binary path (e.g. DSH_MCP_BIN). */
  binaryEnvVar: string;
  /** Display name (e.g. "dsh"). */
  displayName: string;
  /** Per-call timeout in ms. Default 5 min. */
  callTimeoutMs?: number;
  /** Per-server timeout ceiling. Default 30 min. */
  serverTimeoutMs?: number;
  /** Max concurrent subprocesses (slot semaphore). Default 4. */
  maxConcurrent?: number;
}

/**
 * Base class for all CLI-based backends. Concrete backends override:
 *   - buildArgs(prompt, opts) → string[]
 *   - parseModels(stdout) → ModelInfo[]
 *   - parseSessionList(stdout) → SessionInfo[]
 *   - parseSessionOutput(stdout) → string (the assistant text)
 */
export abstract class CliBackendAgent implements Agent {
  public abstract readonly name: string;
  protected readonly opts: Required<CliBackendOptions>;
  private readonly activeRuns = new Map<string, AbortController>();
  private readonly subscribers = new Map<string, Set<(e: AgentEvent) => void>>();

  constructor(opts: CliBackendOptions) {
    this.opts = {
      callTimeoutMs: 5 * 60_000,
      serverTimeoutMs: 30 * 60_000,
      maxConcurrent: 4,
      ...opts,
    };
  }

  /** Override: build the args for one-shot prompt. */
  protected abstract buildArgs(prompt: string, opts: PromptOptions): string[];

  /** Override: build the args for resume. */
  protected buildResumeArgs(sessionId: string, prompt: string, opts: PromptOptions): string[] {
    return [...this.buildArgs(prompt, opts), "--session", sessionId];
  }

  /** Override: parse model list from stdout. */
  protected abstract parseModels(stdout: string): ModelInfo[];

  /** Override: parse session list. Default: empty. */
  protected parseSessionList(_stdout: string): SessionInfo[] {
    return [];
  }

  /** Override: extract assistant text from process output. Default: whole stdout. */
  protected parseSessionOutput(stdout: string): string {
    return stdout;
  }

  // ===========================================================================
  // Agent interface
  // ===========================================================================

  async prompt(prompt: string, opts: PromptOptions = {}): Promise<AgentResponse> {
    const start = Date.now();
    const res = await this.run(this.buildArgs(prompt, opts), opts);
    const out: AgentResponse = {
      text: this.parseSessionOutput(res.stdout),
      durationMs: Date.now() - start,
    };
    if (opts.modelId) out.modelId = opts.modelId;
    return out;
  }

  async resume(sessionId: string, prompt: string, opts: PromptOptions = {}): Promise<AgentResponse> {
    const start = Date.now();
    const args = this.buildResumeArgs(sessionId, prompt, opts);
    const abort = new AbortController();
    this.activeRuns.set(sessionId, abort);

    try {
      const res = await this.run(args, opts, abort);
      const response: AgentResponse = {
        text: this.parseSessionOutput(res.stdout),
        sessionId,
        durationMs: Date.now() - start,
      };
      if (opts.modelId) response.modelId = opts.modelId;
      this.emit(sessionId, { type: "session-end", reason: "completed", at: new Date().toISOString() });
      return response;
    } catch (err) {
      this.emit(sessionId, {
        type: "error",
        message: (err as Error).message,
        at: new Date().toISOString(),
      });
      this.emit(sessionId, { type: "session-end", reason: "errored", at: new Date().toISOString() });
      throw err;
    } finally {
      this.activeRuns.delete(sessionId);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.run(["--list-models"]);
    return this.parseModels(res.stdout);
  }

  async listSessions(): Promise<SessionInfo[]> {
    try {
      const res = await this.run(["--list-sessions"]);
      return this.parseSessionList(res.stdout);
    } catch {
      return [];
    }
  }

  subscribe(sessionId: string, onEvent: (e: AgentEvent) => void): () => void {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(onEvent);
    return () => {
      set?.delete(onEvent);
      if (set && set.size === 0) this.subscribers.delete(sessionId);
    };
  }

  async abort(sessionId: string): Promise<void> {
    const ctrl = this.activeRuns.get(sessionId);
    if (ctrl) {
      ctrl.abort();
    }
    this.emit(sessionId, { type: "session-end", reason: "killed", at: new Date().toISOString() });
  }

  async dispose(): Promise<void> {
    for (const ctrl of this.activeRuns.values()) ctrl.abort();
    this.activeRuns.clear();
    this.subscribers.clear();
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private emit(sessionId: string, event: AgentEvent): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(event);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  private resolveBinaryPath(): string {
    const envPath = process.env[this.opts.binaryEnvVar];
    if (envPath && existsSync(envPath)) return envPath;
    // Also try DSH_MCP_BIN-style fallback
    const fallback = process.env["DSH_MCP_BIN"];
    if (fallback && existsSync(fallback) && fallback.endsWith(this.opts.binary)) return fallback;
    // Try common locations
    for (const dir of ["/usr/local/bin", "/usr/bin", `${process.env["HOME"]}/.local/bin`]) {
      const p = resolve(dir, this.opts.binary);
      if (existsSync(p)) return p;
    }
    throw new AgentError(
      "binary_not_found",
      `Cannot find ${this.opts.binary} on PATH. Set ${this.opts.binaryEnvVar} to override.`,
      "user",
    );
  }

  private run(args: string[], opts: PromptOptions = {}, signal?: AbortController): Promise<RunResult> {
    const bin = this.resolveBinaryPath();
    const start = Date.now();
    const proc = spawn(bin, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const timeoutMs = opts.timeoutMs ?? this.opts.callTimeoutMs;

    return new Promise<RunResult>((resolveP, rejectP) => {
      let killed = false;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
      };

      proc.stdout?.on("data", (c: Buffer) => chunks.push(c));
      proc.stderr?.on("data", (c: Buffer) => errChunks.push(c));

      proc.on("error", (err) => {
        cleanup();
        rejectP(new AgentError("spawn_failed", err.message, "internal", { binary: bin }));
      });

      proc.on("close", (code, sig) => {
        cleanup();
        if (killed) {
          resolveP({
            exitCode: -1,
            stdout: Buffer.concat(chunks).toString("utf8"),
            stderr: Buffer.concat(errChunks).toString("utf8"),
            durationMs: Date.now() - start,
          });
          return;
        }
        const stdout = Buffer.concat(chunks).toString("utf8");
        const stderr = Buffer.concat(errChunks).toString("utf8");
        const exitCode = code ?? (sig ? -1 : 0);
        if (sig === "SIGTERM" || sig === "SIGKILL") {
          resolveP({ exitCode: -1, stdout, stderr, durationMs: Date.now() - start });
          return;
        }
        if (exitCode !== 0) {
          rejectP(
            new AgentError("cli_error", stderr.split("\n")[0]?.slice(0, 200) ?? "unknown", "tool", {
              exitCode,
              stderr: stderr.slice(0, 2000),
            }),
          );
          return;
        }
        resolveP({ exitCode, stdout, stderr, durationMs: Date.now() - start });
      });

      let killTimer: NodeJS.Timeout | undefined;
      const timer: NodeJS.Timeout | undefined = timeoutMs
        ? setTimeout(() => {
            if (killed) return;
            killed = true;
            try {
              process.kill(-(proc.pid ?? 0), "SIGTERM");
            } catch {
              proc.kill("SIGTERM");
            }
            killTimer = setTimeout(() => {
              try {
                process.kill(-(proc.pid ?? 0), "SIGKILL");
              } catch {
                // already dead
              }
            }, DEFAULT_KILL_GRACE_MS);
          }, timeoutMs)
        : undefined;

      signal?.signal.addEventListener("abort", () => {
        if (killed) return;
        killed = true;
        try {
          process.kill(-(proc.pid ?? 0), "SIGTERM");
        } catch {
          proc.kill("SIGTERM");
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-(proc.pid ?? 0), "SIGKILL");
          } catch {
            // already dead
          }
        }, DEFAULT_KILL_GRACE_MS);
      });
    });
  }
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}
