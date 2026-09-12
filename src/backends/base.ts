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
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Agent, AgentEvent, AgentResponse, ModelInfo, PromptOptions, SessionInfo } from "@kagero/core";
import { AgentError } from "@kagero/core";

const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024; // 50MB

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
  /** Max stdout/stderr bytes per call. Default 50MB. */
  maxOutputBytes?: number;
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
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
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
    const sessionId = opts.sessionId ?? `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const abort = new AbortController();
    this.activeRuns.set(sessionId, abort);
    const start = Date.now();
    try {
      const res = await this.run(this.buildArgs(prompt, opts), opts, abort);
      const out: AgentResponse = {
        text: this.parseSessionOutput(res.stdout),
        durationMs: Date.now() - start,
      };
      if (opts.modelId) out.modelId = opts.modelId;
      this.emit(sessionId, { type: "session-end", reason: "completed", at: new Date().toISOString() });
      return out;
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

  async resume(sessionId: string, prompt: string, opts: PromptOptions = {}): Promise<AgentResponse> {
    const args = this.buildResumeArgs(sessionId, prompt, opts);
    const abort = new AbortController();
    this.activeRuns.set(sessionId, abort);
    const start = Date.now();
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

  async listModels(opts: PromptOptions = {}): Promise<ModelInfo[]> {
    const res = await this.run(["--list-models"], opts);
    return this.parseModels(res.stdout);
  }

  async listSessions(opts: PromptOptions = {}): Promise<SessionInfo[]> {
    try {
      const res = await this.run(["--list-sessions"], opts);
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
    const home = homedir();
    for (const dir of ["/usr/local/bin", "/usr/bin", `${home}/.local/bin`]) {
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
    // Don't keep the parent's event loop alive on this child
    proc.unref();

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const maxBytes = this.opts.maxOutputBytes;
    let truncated = false;
    let totalBytes = 0;
    const timeoutMs = opts.timeoutMs ?? this.opts.callTimeoutMs;

    return new Promise<RunResult>((resolveP, rejectP) => {
      let killed = false;
      let killTimer: NodeJS.Timeout | undefined;
      let timer: NodeJS.Timeout | undefined;

      const killGroup = (sig: "SIGTERM" | "SIGKILL"): void => {
        // Guard against self-kill hazard: if pid is undefined, fall back to proc.kill()
        if (proc.pid !== undefined && proc.pid > 0) {
          try {
            process.kill(-proc.pid, sig);
            return;
          } catch {
            // fall through to proc.kill()
          }
        }
        try {
          proc.kill(sig);
        } catch {
          // already dead
        }
      };

      const onAbort = (): void => {
        if (killed) return;
        killed = true;
        killGroup("SIGTERM");
        killTimer = setTimeout(() => killGroup("SIGKILL"), DEFAULT_KILL_GRACE_MS);
      };

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal?.signal.removeEventListener("abort", onAbort);
      };

      proc.stdout?.on("data", (c: Buffer) => {
        totalBytes += c.length;
        if (totalBytes > maxBytes) {
          truncated = true;
          return;
        }
        chunks.push(c);
      });
      proc.stderr?.on("data", (c: Buffer) => {
        totalBytes += c.length;
        if (totalBytes > maxBytes) {
          truncated = true;
          return;
        }
        errChunks.push(c);
      });

      proc.on("error", (err) => {
        cleanup();
        rejectP(new AgentError("spawn_failed", err.message, "internal", { binary: bin }));
      });

      proc.on("close", (code, sig) => {
        cleanup();
        const stdout = Buffer.concat(chunks).toString("utf8");
        const stderr = Buffer.concat(errChunks).toString("utf8");
        const exitCode = code ?? (sig ? -1 : 0);
        const durationMs = Date.now() - start;
        const meta = truncated ? { truncated: true, maxBytes } : undefined;

        // Killed by us (timeout / abort): resolve, don't error.
        if (killed || sig === "SIGTERM" || sig === "SIGKILL") {
          resolveP({ exitCode: -1, stdout, stderr, durationMs, ...(meta ?? {}) });
          return;
        }
        if (exitCode !== 0) {
          rejectP(
            new AgentError("cli_error", stderr.split("\n")[0]?.slice(0, 200) ?? "unknown", "tool", {
              exitCode,
              stderr: stderr.slice(0, 2000),
              ...(meta ?? {}),
            }),
          );
          return;
        }
        resolveP({ exitCode, stdout, stderr, durationMs, ...(meta ?? {}) });
      });

      timer = timeoutMs
        ? setTimeout(() => {
            onAbort();
          }, timeoutMs)
        : undefined;

      signal?.signal.addEventListener("abort", onAbort);
    });
  }
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated?: boolean;
  maxBytes?: number;
}
