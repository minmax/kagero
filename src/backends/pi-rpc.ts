/**
 * pi-rpc backend — talks to `pi --mode rpc` over stdio.
 *
 * Same Agent interface as the in-process SDK, but goes through a subprocess.
 * Useful when the user prefers the official CLI (or doesn't want to install
 * the SDK as a runtime dep).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Agent, AgentEvent, AgentResponse, ModelInfo, PromptOptions, SessionInfo } from "../agent.js";
import { AgentError } from "../agent.js";

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

  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: RpcResponse) => void>();
  private subscribers = new Map<string, Set<(e: AgentEvent) => void>>();
  private buffer = "";

  private start(): ChildProcess {
    if (this.proc) return this.proc;
    const bin = this.resolveBinary();
    const proc = spawn(bin, ["--mode", "rpc", "--no-session"], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.ingest(chunk));
    proc.stderr?.on("data", () => {
      // swallow
    });
    proc.on("error", (err) => {
      throw new AgentError("spawn_failed", err.message, "internal", { binary: bin });
    });
    this.proc = proc;
    return proc;
  }

  private resolveBinary(): string {
    const envPath = process.env["PI_RPC_BIN"] ?? process.env["PI_BINARY"];
    if (envPath && existsSync(envPath)) return envPath;
    for (const dir of ["/usr/local/bin", "/usr/bin", `${process.env["HOME"]}/.local/bin`]) {
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
          const resolver = this.pending.get(parsed.id);
          if (resolver) {
            this.pending.delete(parsed.id);
            resolver(parsed);
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
      this.pending.set(id, (r) => {
        if (r.error) rejectP(new AgentError("rpc_error", r.error.message, "tool", { method }));
        else resolveP(r);
      });
      const line = `${JSON.stringify({ type: "request", id, method, params })}\n`;
      proc.stdin?.write(line);
    });
  }

  // ===========================================================================
  // Agent interface
  // ===========================================================================

  async prompt(prompt: string, _opts: PromptOptions = {}): Promise<AgentResponse> {
    const start = Date.now();
    const r = await this.call("prompt", { text: prompt });
    return {
      text: this.collectText(),
      durationMs: Date.now() - start,
      meta: { result: r.result },
    };
  }

  async resume(sessionId: string, prompt: string, _opts: PromptOptions = {}): Promise<AgentResponse> {
    const start = Date.now();
    await this.call("switch_session", { id: sessionId });
    const r = await this.call("follow_up", { text: prompt });
    return {
      text: this.collectText(),
      sessionId,
      durationMs: Date.now() - start,
      meta: { result: r.result },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
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

  async listSessions(): Promise<SessionInfo[]> {
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
    await this.call("abort");
  }

  async dispose(): Promise<void> {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.pending.clear();
    this.subscribers.clear();
  }

  // ---------------------------------------------------------------------------

  private collectedText = "";

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
