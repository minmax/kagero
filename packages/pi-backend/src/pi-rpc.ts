/**
 * pi-rpc backend — talks to `pi --mode rpc` over stdio.
 *
 * Same Agent interface as the in-process SDK, but goes through a subprocess.
 * Useful when the user prefers the official CLI (or doesn't want to install
 * the SDK as a runtime dep).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  Agent,
  AgentCapabilities,
  AgentEvent,
  AgentResponse,
  HistoryOptions,
  HistoryResult,
  MidRunCommand,
  ModelInfo,
  PromptOptions,
  SessionInfo,
} from "@kagero/core";
import { AgentError, unsupportedCapability } from "@kagero/core";

type RpcResponse = {
  type: "response";
  id: number;
  result?: unknown;
  error?: { message: string };
};

type RpcEvent = {
  type: string;
  [k: string]: unknown;
};

function isResponse(x: unknown): x is RpcResponse {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { type?: string }).type === "response" &&
    typeof (x as { id?: unknown }).id === "number"
  );
}

function isEvent(x: unknown): x is RpcEvent {
  return typeof x === "object" && x !== null && typeof (x as { type?: unknown }).type === "string";
}

export class PiRpcAgent implements Agent {
  public readonly name = "pi-rpc";

  public readonly capabilities: AgentCapabilities = {
    resume: true,
    models: true,
    sessions: true,
    history: false,
    subscribe: true,
    abort: true,
    steer: true,
    followUp: true,
    limits: { timeout: false, maxTurns: false, maxToolCalls: false },
    workspaceCreate: true,
  };

  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: RpcResponse) => void; reject: (err: Error) => void }>();
  private subscribers = new Map<string, Set<(e: AgentEvent) => void>>();
  private buffer = "";
  private collectedText = "";

  private start(): ChildProcess {
    if (this.proc) return this.proc;
    const bin = this.resolveBinary();
    const proc = spawn(bin, ["--mode", "rpc", "--no-session"], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    proc.unref();
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.ingest(chunk));
    proc.stderr?.on("data", () => {
      // swallow — RPC errors are reported via response objects
    });
    proc.on("error", (err) => {
      // Reject all pending calls so callers don't hang
      const err2 = new AgentError("spawn_failed", err.message, "internal", { binary: bin });
      for (const [id, p] of this.pending) {
        p.reject(err2);
        this.pending.delete(id);
      }
      this.proc = null;
    });
    proc.on("close", () => {
      // Reject all in-flight calls on proc death
      const err = new AgentError("rpc_closed", "pi rpc subprocess closed unexpectedly", "internal");
      for (const [id, p] of this.pending) {
        p.reject(err);
        this.pending.delete(id);
      }
      this.proc = null;
    });
    this.proc = proc;
    return proc;
  }

  private resolveBinary(): string {
    const envPath = process.env["PI_RPC_BIN"] ?? process.env["PI_BINARY"];
    if (envPath && existsSync(envPath)) return envPath;
    const home = homedir();
    for (const dir of ["/usr/local/bin", "/usr/bin", `${home}/.local/bin`]) {
      const p = resolve(dir, "pi");
      if (existsSync(p)) return p;
    }
    throw new AgentError(
      "binary_not_found",
      "Cannot find `pi` on PATH. Set PI_RPC_BIN or PI_BINARY.",
      "user",
    );
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isResponse(parsed)) {
          const p = this.pending.get(parsed.id);
          if (p) {
            this.pending.delete(parsed.id);
            p.resolve(parsed);
          }
        } else if (isEvent(parsed)) {
          this.forwardEvent(parsed);
        }
      } catch {
        // ignore malformed lines
      }
    }
  }

  private forwardEvent(ev: RpcEvent): void {
    const at = new Date().toISOString();
    const sessionId = String(ev["sessionId"] ?? "default");
    switch (ev.type) {
      case "message_update": {
        const inner = ev["assistantMessageEvent"] as { type?: string; delta?: string } | undefined;
        if (inner?.type === "text_delta" && typeof inner.delta === "string") {
          this.collectedText += inner.delta;
          this.emit(sessionId, { type: "assistant-text", content: inner.delta, at });
        }
        break;
      }
      case "tool_call":
        this.emit(sessionId, {
          type: "tool-call",
          name: String(ev["name"] ?? ""),
          args: ev["args"],
          at,
        });
        break;
      case "tool_result":
        this.emit(sessionId, {
          type: "tool-result",
          name: String(ev["name"] ?? ""),
          result: ev["result"],
          at,
        });
        break;
      case "error":
        this.emit(sessionId, { type: "error", message: String(ev["message"] ?? "unknown"), at });
        break;
      default:
        break;
    }
  }

  private call(method: string, params?: unknown): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolveP, rejectP) => {
      const proc = this.start();
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (r) => {
          if (r.error) rejectP(new AgentError("rpc_error", r.error.message, "tool", { method }));
          else resolveP(r);
        },
        reject: (err) => rejectP(err),
      });
      const line = `${JSON.stringify({ type: "request", id, method, params })}\n`;
      try {
        if (!proc.stdin?.write(line)) {
          // backpressure — fall through; ingest handles responses
        }
      } catch (err) {
        this.pending.delete(id);
        rejectP(new AgentError("rpc_write_failed", (err as Error).message, "tool", { method }));
      }
    });
  }

  // ===========================================================================
  // Agent interface
  // ===========================================================================

  async prompt(prompt: string, opts: PromptOptions = {}): Promise<AgentResponse> {
    const sessionId = opts.sessionId ?? `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const start = Date.now();
    try {
      await this.call("prompt", { text: prompt, ...(opts.modelId ? { model: opts.modelId } : {}) });
      this.emit(sessionId, { type: "session-end", reason: "completed", at: new Date().toISOString() });
      return {
        status: "completed",
        text: this.collectText(),
        durationMs: Date.now() - start,
        ...(opts.modelId ? { modelId: opts.modelId, modelSource: "requested" as const } : {}),
      };
    } catch (err) {
      this.emit(sessionId, {
        type: "error",
        message: (err as Error).message,
        at: new Date().toISOString(),
      });
      this.emit(sessionId, { type: "session-end", reason: "errored", at: new Date().toISOString() });
      throw err;
    }
  }

  async resume(sessionId: string, prompt: string, opts: PromptOptions = {}): Promise<AgentResponse> {
    const start = Date.now();
    try {
      await this.call("switch_session", { id: sessionId });
      await this.call("follow_up", {
        text: prompt,
        ...(opts.modelId ? { model: opts.modelId } : {}),
      });
      this.emit(sessionId, { type: "session-end", reason: "completed", at: new Date().toISOString() });
      return {
        status: "completed",
        text: this.collectText(),
        sessionId,
        durationMs: Date.now() - start,
        ...(opts.modelId ? { modelId: opts.modelId, modelSource: "requested" as const } : {}),
      };
    } catch (err) {
      this.emit(sessionId, {
        type: "error",
        message: (err as Error).message,
        at: new Date().toISOString(),
      });
      this.emit(sessionId, { type: "session-end", reason: "errored", at: new Date().toISOString() });
      throw err;
    }
  }

  async listModels(_opts: PromptOptions = {}): Promise<ModelInfo[]> {
    const r = await this.call("list_models");
    const arr =
      (
        r.result as
          | {
              models?: Array<{ id: string; displayName?: string; provider?: string; contextWindow?: number }>;
            }
          | undefined
      )?.models ?? [];
    return arr.map((m) => ({
      id: m.id,
      displayName: m.displayName ?? m.id,
      provider: m.provider ?? "pi",
      contextWindow: m.contextWindow ?? 32768,
      supportsTools: true,
      supportsVision: false,
    }));
  }

  async listSessions(_opts: PromptOptions = {}): Promise<SessionInfo[]> {
    try {
      const r = await this.call("list_sessions");
      const arr =
        (
          r.result as
            | {
                sessions?: Array<{
                  id: string;
                  createdAt?: string;
                  lastUsedAt?: string;
                  cwd?: string;
                  messageCount?: number;
                  summary?: string;
                }>;
              }
            | undefined
        )?.sessions ?? [];
      return arr.map((s) => ({
        id: s.id,
        createdAt: s.createdAt ?? new Date().toISOString(),
        lastUsedAt: s.lastUsedAt ?? new Date().toISOString(),
        cwd: s.cwd ?? process.cwd(),
        summary: s.summary ?? "",
        messageCount: s.messageCount ?? 0,
      }));
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

  async abort(_sessionId: string): Promise<void> {
    try {
      await this.call("abort");
    } catch {
      // best-effort: proc may be dead
    }
    this.emit(_sessionId, { type: "session-end", reason: "killed", at: new Date().toISOString() });
  }

  async send(_sessionId: string, message: string, kind: MidRunCommand = "steer"): Promise<void> {
    if (kind === "follow_up") {
      await this.call("follow_up", { text: message });
    } else {
      await this.call("steer", { text: message });
    }
  }

  async history(_sessionId: string, _opts?: HistoryOptions): Promise<HistoryResult> {
    throw unsupportedCapability("history", "use the pi backend's own session files via a history reader spec.");
  }

  async dispose(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    // Reject all in-flight calls so callers don't hang
    const err = new AgentError("disposed", "PiRpcAgent disposed before response", "internal");
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    this.subscribers.clear();
  }

  // ---------------------------------------------------------------------------

  private collectText(): string {
    const out = this.collectedText;
    this.collectedText = "";
    return out;
  }

  private emit(sessionId: string, event: AgentEvent): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(event);
      } catch {
        // ignore
      }
    }
  }
}
