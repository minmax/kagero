/**
 * pi-rpc backend — drives `pi --mode rpc` over stdio.
 *
 * The REAL pi rpc protocol (verified live, and mirrored from pi-mcp's
 * transport): stdin takes one JSONL command `{type:"prompt", message}`;
 * stdout answers `{type:"response", command:"prompt", success}` and then
 * streams typed events — agent_start/turn_start/turn_end/agent_end,
 * message_start/message_end (full message records: role user|assistant|
 * toolResult, content parts, model, usage), message_update (streaming
 * deltas), tool_execution_start/tool_execution_end, auto_retry_start —
 * until `agent_settled` marks the end of the turn. Closing stdin is how the
 * process is asked to shut down; an in-flight turn ends with `{type:"abort"}`.
 *
 * One long-lived process per model: the model is chosen at spawn
 * (`--model <id>`), so a prompt with a different modelId restarts the
 * process. Each prompt turn is reported under its own generated session id
 * (`rpc-<n>`); pi keeps no cross-turn session here, so `resume` is honestly
 * unsupported.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
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
import { AgentError, resolveBinary, unsupportedCapability } from "@kagero/core";

type RpcEvent = { type: string; [k: string]: unknown };

/** Content part shapes we read (parse, don't cast — logs are untrusted). */
function textFromParts(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class PiRpcAgent implements Agent {
  public readonly name = "pi-rpc";

  public readonly capabilities: AgentCapabilities = {
    resume: false,
    models: true,
    sessions: false,
    history: false,
    subscribe: true,
    abort: true,
    steer: true,
    followUp: true,
    limits: { timeout: false, maxTurns: false, maxToolCalls: false },
    workspaceCreate: false,
  };

  private proc: ChildProcess | null = null;
  private procModel: string | undefined;
  private buffer = "";
  private subscribers = new Map<string, Set<(e: AgentEvent) => void>>();
  private turnSeq = 0;
  /** The turn currently being pumped: its session id and collected text. */
  private active:
    | {
        sessionId: string;
        text: string[];
        model: string | undefined;
        usage:
          | {
              inputTokens?: number;
              outputTokens?: number;
              reasoningTokens?: number;
            }
          | undefined;
        errorMessage: string | undefined;
        /** Set once the turn resolved one way or another — no second event. */
        finished: boolean;
        settled: (response: AgentResponse) => void;
        failed: (error: AgentError) => void;
      }
    | undefined;
  /** Pending prompt-command acknowledgements (id → settle hooks). */
  private readonly promptAcks = new Map<
    string,
    { settled: () => void; failed: (error: AgentError) => void }
  >();
  /** Serializes turn starts: pi accepts one prompt at a time. */
  private turnQueue: Promise<void> = Promise.resolve();

  // --- process lifecycle -----------------------------------------------------

  private start(model: string | undefined): ChildProcess {
    if (this.proc !== null && this.procModel === model) return this.proc;
    if (this.proc !== null) this.stopProc();
    const bin = this.resolveBinary();
    const proc = spawn(
      bin,
      ["--mode", "rpc", "--no-session", ...(model === undefined ? [] : ["--model", model])],
      {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    );
    proc.unref();
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.ingest(chunk));
    proc.stderr?.on("data", () => {
      // stderr is pi's own diagnostics; protocol errors arrive as events.
    });
    proc.on("close", () => {
      if (this.proc === proc) {
        this.proc = null;
        this.procModel = undefined;
      }
      this.failActive("pi rpc subprocess closed before the turn settled");
    });
    this.proc = proc;
    this.procModel = model;
    return proc;
  }

  private stopProc(): void {
    const proc = this.proc;
    this.proc = null;
    this.procModel = undefined;
    if (proc !== null) {
      try {
        proc.stdin?.end();
      } catch {
        // already gone
      }
      try {
        proc.kill();
      } catch {
        // already gone
      }
    }
  }

  private resolveBinary(): string {
    // Explicit env override first; otherwise the core PATH search covers
    // pnpm (~/Library/pnpm/bin), homebrew and every other install layout.
    const envPath = process.env["PI_RPC_BIN"] ?? process.env["PI_BINARY"];
    if (envPath !== undefined && envPath !== "" && existsSync(envPath)) return envPath;
    return resolveBinary("pi", "PI_RPC_BIN").path;
  }

  // --- protocol pump -----------------------------------------------------------

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
      if (line === "") continue;
      let event: RpcEvent;
      try {
        event = JSON.parse(line) as RpcEvent;
      } catch {
        continue; // malformed line — skip, the turn carries on
      }
      this.handleEvent(event);
    }
  }

  private handleEvent(event: RpcEvent): void {
    const at = new Date().toISOString();

    // The prompt command ACK: a rejection must fail the turn, or it hangs.
    if (event.type === "response" && typeof event["id"] === "string") {
      const pending = this.promptAcks.get(event["id"] as string);
      if (pending !== undefined) {
        this.promptAcks.delete(event["id"] as string);
        if (event["success"] === false) {
          pending.failed(
            new AgentError("cli_error", `pi rejected the prompt: ${String(event["error"] ?? "unknown")}`, "tool"),
          );
        }
      }
      return;
    }

    const active = this.active;
    const emit = (e: AgentEvent): void => {
      if (active === undefined) return;
      this.emit(active.sessionId, e);
    };
    switch (event.type) {
      case "tool_execution_start": {
        emit({
          type: "tool-call",
          name: String(event["toolName"] ?? "unknown"),
          args: event["args"],
          at,
        });
        return;
      }
      case "tool_execution_end": {
        emit({
          type: "tool-result",
          name: String(event["toolName"] ?? "unknown"),
          result: event["result"],
          at,
        });
        return;
      }
      case "message_update": {
        // Streaming deltas live NESTED in assistantMessageEvent (rpc.md 938-996).
        const inner = event["assistantMessageEvent"];
        if (isRecord(inner) && inner["type"] === "text_delta" && typeof inner["delta"] === "string") {
          emit({ type: "assistant-text", content: inner["delta"], at });
        }
        return;
      }
      case "message_end": {
        const message = event["message"];
        if (!isRecord(message)) return;
        if (message["role"] === "assistant") {
          const text = textFromParts(message["content"]).trim();
          const stopReason = typeof message["stopReason"] === "string" ? message["stopReason"] : undefined;
          const errorMessage = typeof message["errorMessage"] === "string" ? message["errorMessage"] : undefined;
          if (active !== undefined && stopReason !== "toolUse" && text !== "") {
            active.text.push(text);
          }
          if (active !== undefined) {
            if (active.model === undefined && typeof message["model"] === "string") active.model = message["model"];
            const usage = isRecord(message["usage"]) ? message["usage"] : undefined;
            if (usage !== undefined) {
              const asNumber = (key: string): number | undefined => {
                const value = usage[key];
                return typeof value === "number" ? value : undefined;
              };
              const input = asNumber("input");
              const output = asNumber("output");
              const reasoning = asNumber("reasoning");
              active.usage = {
                ...(input !== undefined ? { inputTokens: input } : {}),
                ...(output !== undefined ? { outputTokens: output } : {}),
                ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
              };
            }
            if (stopReason === "error" || errorMessage !== undefined) {
              active.errorMessage =
                errorMessage ?? `pi stopped with stopReason=${stopReason ?? "error"}`;
            }
          }
          if (stopReason !== "toolUse" && text !== "") {
            emit({ type: "assistant-text", content: text, at });
          }
        }
        return;
      }
      case "auto_retry_start": {
        emit({ type: "error", message: `pi retrying (attempt ${String(event["attempt"] ?? "?")})`, at });
        return;
      }
      case "agent_settled": {
        if (active === undefined || active.finished) return;
        active.finished = true;
        const { sessionId, text, model, usage, errorMessage } = active;
        this.active = undefined;
        if (errorMessage !== undefined) {
          this.emit(sessionId, { type: "error", message: errorMessage, at });
          this.emit(sessionId, { type: "session-end", reason: "errored", at });
          active.failed(new AgentError("cli_error", errorMessage, "tool"));
          return;
        }
        this.emit(sessionId, { type: "session-end", reason: "completed", at });
        active.settled({
          status: "completed",
          text: text.join("\n\n"),
          sessionId,
          durationMs: 0,
          ...(model !== undefined ? { modelId: model, modelSource: "reported" as const } : {}),
          ...(usage !== undefined ? { usage } : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  private failActive(message: string): void {
    const active = this.active;
    if (active === undefined || active.finished) return;
    active.finished = true;
    this.active = undefined;
    const error = new AgentError("rpc_closed", message, "internal");
    this.emit(active.sessionId, { type: "error", message, at: new Date().toISOString() });
    this.emit(active.sessionId, { type: "session-end", reason: "errored", at: new Date().toISOString() });
    active.failed(error);
  }

  /** Run one prompt turn to `agent_settled`; resolves with the collected answer. */
  private runTurn(
    message: string,
    model: string | undefined,
    timeoutMs: number | undefined,
  ): Promise<AgentResponse> {
    // pi accepts ONE prompt at a time; overlap writes are rejected on the
    // wire. Serialize turn starts so a second caller queues, not corrupts.
    const run = this.turnQueue.then(() => this.runTurnInner(message, model, timeoutMs));
    this.turnQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private runTurnInner(
    message: string,
    model: string | undefined,
    timeoutMs: number | undefined,
  ): Promise<AgentResponse> {
    const proc = this.start(model);
    this.turnSeq += 1;
    const sessionId = `rpc-${this.turnSeq}`;
    return new Promise<AgentResponse>((settle, fail) => {
      let timer: NodeJS.Timeout | undefined;
      this.active = {
        sessionId,
        text: [],
        model: undefined,
        usage: undefined,
        errorMessage: undefined,
        finished: false,
        settled: (response) => {
          if (timer !== undefined) clearTimeout(timer);
          settle({ ...response, durationMs: Date.now() - startedAt });
        },
        failed: (error) => {
          if (timer !== undefined) clearTimeout(timer);
          fail(error);
        },
      };
      const startedAt = Date.now();
      this.emit(sessionId, { type: "session-start", sessionId, at: new Date().toISOString() });
      this.emit(sessionId, { type: "user-prompt", content: message, at: new Date().toISOString() });
      const ackId = `prompt-${sessionId}`;
      this.promptAcks.set(ackId, {
        settled: () => {},
        failed: (error) => this.failActive(error.message),
      });
      const line = `${JSON.stringify({ id: ackId, type: "prompt", message })}\n`;
      try {
        proc.stdin?.write(line);
      } catch (err) {
        this.failActive(`pi rpc stdin write failed: ${(err as Error).message}`);
        return;
      }
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const active = this.active;
          if (active === undefined || active.finished || active.sessionId !== sessionId) return;
          active.finished = true;
          this.active = undefined;
          try {
            proc.stdin?.write(`${JSON.stringify({ type: "abort" })}\n`);
          } catch {
            // proc may be dead — nothing left to abort.
          }
          this.emit(sessionId, { type: "session-end", reason: "killed", at: new Date().toISOString() });
          active.settled({
            status: "timed-out",
            text: active.text.join("\n\n"),
            sessionId,
            durationMs: Date.now() - startedAt,
            meta: { partial: true },
          });
        }, timeoutMs);
      }
    });
  }

  // ===========================================================================
  // Agent interface
  // ===========================================================================

  async prompt(prompt: string, opts: PromptOptions = {}): Promise<AgentResponse> {
    return await this.runTurn(prompt, opts.modelId, opts.timeoutMs);
  }

  async resume(sessionId: string, _prompt: string, _opts: PromptOptions = {}): Promise<AgentResponse> {
    throw unsupportedCapability(
      "resume",
      `pi-rpc keeps no sessions (--no-session); use the pi backend's own session files instead. (${sessionId})`,
    );
  }

  async listModels(): Promise<ModelInfo[]> {
    // pi picks models from its own catalog at spawn time (--model pattern);
    // there is no rpc listing command, so we report the honest minimum.
    return [];
  }

  async listSessions(): Promise<SessionInfo[]> {
    // --no-session: pi keeps no sessions for this backend.
    return [];
  }

  subscribe(sessionId: string, onEvent: (e: AgentEvent) => void): () => void {
    let set = this.subscribers.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(onEvent);
    return () => {
      set?.delete(onEvent);
      if (set !== undefined && set.size === 0) this.subscribers.delete(sessionId);
    };
  }

  async abort(sessionId: string): Promise<void> {
    const proc = this.proc;
    if (proc !== null) {
      try {
        proc.stdin?.write(`${JSON.stringify({ type: "abort" })}\n`);
      } catch {
        // proc may be dead — the turn fails through the close handler.
      }
    }
    const active = this.active;
    if (active !== undefined && active.sessionId === sessionId && !active.finished) {
      // Settle the caller now — a later agent_settled is ignored via `finished`.
      active.finished = true;
      this.active = undefined;
      this.emit(sessionId, { type: "session-end", reason: "killed", at: new Date().toISOString() });
      active.settled({
        status: "aborted",
        text: active.text.join("\n\n"),
        sessionId,
        durationMs: 0,
        meta: { partial: true },
      });
      return;
    }
    this.emit(sessionId, { type: "session-end", reason: "killed", at: new Date().toISOString() });
  }

  async send(_sessionId: string, message: string, kind: MidRunCommand = "steer"): Promise<void> {
    const proc = this.proc;
    if (proc === null || proc.stdin === null) {
      throw new AgentError("rpc_closed", "pi rpc subprocess is not running", "tool");
    }
    // rpc.md: steer queues the message for after the current assistant turn's
    // tool calls; followUp waits for the agent to stop.
    const line = `${JSON.stringify({ type: kind, message })}\n`;
    try {
      proc.stdin.write(line);
    } catch (err) {
      throw new AgentError("rpc_write_failed", (err as Error).message, "tool");
    }
  }

  async history(_sessionId: string, _opts?: HistoryOptions): Promise<HistoryResult> {
    throw unsupportedCapability(
      "history",
      "use the pi backend's own session files via a history reader spec.",
    );
  }

  async dispose(): Promise<void> {
    this.stopProc();
    this.failActive("PiRpcAgent disposed before the turn settled");
    this.subscribers.clear();
  }

  // ---------------------------------------------------------------------------

  private emit(sessionId: string, event: AgentEvent): void {
    // Same contract as the CLI backends: exact-session subscribers plus "*"
    // (which receives everything, e.g. the stream compressor hub).
    for (const key of [sessionId, "*"]) {
      const set = this.subscribers.get(key);
      if (set === undefined) continue;
      for (const cb of set) {
        try {
          cb(event);
        } catch {
          // A broken subscriber must not break the turn.
        }
      }
    }
  }
}
