/**
 * pi-rpc backend — drives `pi --mode rpc` over stdio.
 *
 * The REAL pi rpc protocol (verified live, rpc.md): stdin takes one NDJSON
 * command per line `{id, type, ...params}`; every command is answered by a
 * correlated `{id, type:"response", command, success, error?, data?}` ack
 * (pi echoes our id verbatim, string or number), and a turn then streams
 * typed events — agent_start/turn_start/turn_end/agent_end,
 * message_start/message_end (full message records: role user|assistant|
 * toolResult, content parts, model, usage), message_update (streaming
 * deltas), tool_execution_start/tool_execution_end, auto_retry_start,
 * queue_update — until `agent_settled` marks the end of the turn. Closing
 * stdin is how the process is asked to shut down; an in-flight turn ends
 * with `{type:"abort"}`. `extension_ui_request` dialog frames are answered
 * with `cancelled: true` so a headless turn can never hang on a hidden
 * prompt.
 *
 * One long-lived process per model: the model is chosen at spawn
 * (`--model <id>`), but a prompt with a DIFFERENT modelId first tries an
 * in-place `set_model` (provider resolved from pi's own catalog via
 * `get_available_models`) and only respawns when that fails. Native
 * commands (set_model, get_available_models, get_state, get_session_stats,
 * get_last_assistant_text, steer, follow_up, switch_session, and anything
 * else rpc.md lists) go through `nativeRpc()`. Turn session ids here are
 * per-turn (`rpc-<n>`); `resume` loads a real pi session file via
 * `switch_session` and runs the turn inside it.
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

/** pi rejects commands that need the agent while a turn is streaming. */
const BUSY_PATTERN = /another turn is already in progress/i;

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
    resume: true,
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
  /** Correlation sequence for native command ids. */
  private rpcSeq = 0;
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
        /** The proc this turn was written to (a stale proc's close must not
         * fail a turn that already moved to a respawned one). */
        proc: ChildProcess;
        settled: (response: AgentResponse) => void;
        failed: (error: AgentError) => void;
      }
    | undefined;
  /**
   * Pending command responses (id → settle hooks): prompt, steer, set_model,
   * get_state, … Correlated by the id pi echoes into `type:"response"` frames.
   */
  private readonly pending = new Map<
    string,
    {
      /** The proc the request was written to (late closes must not reject
       * requests that were already re-routed to a respawned proc). */
      proc: ChildProcess;
      command: string;
      resolve: (data: unknown) => void;
      reject: (error: AgentError) => void;
    }
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
      const isCurrent = this.proc === proc;
      if (isCurrent) {
        this.proc = null;
        this.procModel = undefined;
      }
      // proc===proc guard: a respawned proc's predecessor closes late — only
      // the death of the proc that OWNS the active turn may fail it.
      if (this.active !== undefined && this.active.proc === proc) {
        this.failActive("pi rpc subprocess closed before the turn settled");
      }
      this.rejectPendingFor(proc, "pi rpc subprocess closed before the response arrived");
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

  /**
   * The single stdin write path: one NDJSON command frame, LF-terminated.
   * Throws when the proc (or its stdin) is already gone.
   */
  private writeLine(proc: ChildProcess | null, frame: Record<string, unknown>): void {
    const stdin = proc?.stdin;
    if (proc === null || stdin === null || stdin === undefined) {
      throw new Error("pi rpc stdin is not available");
    }
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

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

    // Command ACK: pi echoes our correlation id verbatim (string or number).
    // success:false must reject the pending caller, or it hangs forever.
    if (event.type === "response") {
      const rawId = event["id"];
      if (typeof rawId === "string" || typeof rawId === "number") {
        const key = String(rawId);
        const pending = this.pending.get(key);
        if (pending !== undefined) {
          this.pending.delete(key);
          if (event["success"] === false) {
            pending.reject(
              new AgentError(
                "cli_error",
                `pi rejected ${pending.command}: ${String(event["error"] ?? "unknown")}`,
                "tool",
              ),
            );
          } else {
            pending.resolve(event["data"]);
          }
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
      case "queue_update": {
        // The pending steering/followUp lines (`{steering:[...],followUp:[...]}`)
        // have no AgentEvent mapping worth faking — parse and discard. Actual
        // delivery is acked by the steer/follow_up command responses.
        return;
      }
      case "extension_ui_request": {
        // No human watches the pipe: cancel every dialog so an extension UI
        // prompt can never hang the turn (fire-and-forget frames ignore the
        // response anyway). The id must echo pi's request id.
        const frameId = event["id"];
        if (typeof frameId !== "string" && typeof frameId !== "number") return;
        try {
          this.writeLine(this.proc, { type: "extension_ui_response", id: frameId, cancelled: true });
        } catch {
          // proc may be gone — the close handler fails the turn.
        }
        return;
      }
      case "message_end": {
        const message = event["message"];
        if (!isRecord(message)) return;
        if (message["role"] === "assistant") {
          const text = textFromParts(message["content"]).trim();
          const stopReason = typeof message["stopReason"] === "string" ? message["stopReason"] : undefined;
          const errorMessage =
            typeof message["errorMessage"] === "string" ? message["errorMessage"] : undefined;
          if (active !== undefined && stopReason !== "toolUse" && text !== "") {
            active.text.push(text);
          }
          if (active !== undefined) {
            if (active.model === undefined && typeof message["model"] === "string")
              active.model = message["model"];
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
              active.errorMessage = errorMessage ?? `pi stopped with stopReason=${stopReason ?? "error"}`;
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

  /** Reject every pending command that was written to `proc`. */
  private rejectPendingFor(proc: ChildProcess, message: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.proc !== proc) continue;
      this.pending.delete(id);
      entry.reject(new AgentError("rpc_closed", message, "internal"));
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

  /**
   * Raw native pi rpc command (rpc.md): writes `{id, type:<command>, ...params}`
   * on the live proc's stdin and resolves with the response's parsed `data`
   * (undefined for commands that carry none). Rejects with pi's error text on
   * `success:false`; a "another turn is already in progress" rejection is
   * reworded to say the agent is busy and what to do about it.
   */
  async nativeRpc(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const proc = this.start(this.procModel);
    this.rpcSeq += 1;
    const id = `rpc-${this.rpcSeq}`;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { proc, command, resolve, reject });
        try {
          this.writeLine(proc, { id, type: command, ...params });
        } catch (err) {
          this.pending.delete(id);
          reject(new AgentError("rpc_write_failed", (err as Error).message, "tool"));
        }
      });
    } catch (err) {
      if (err instanceof AgentError && BUSY_PATTERN.test(err.message)) {
        throw new AgentError(
          "cli_busy",
          `pi is busy: another turn is already in progress — "${command}" was rejected; wait for the turn to settle or abort it first`,
          "tool",
          { command },
        );
      }
      throw err;
    }
  }

  /**
   * Try to move the LIVE proc to `model` in place: `set_model` needs the
   * CATALOG provider (e.g. "bifrost" for "agnes/agnes-3.0-flash"), which we
   * resolve by looking the modelId up in pi's own catalog. False = the caller
   * must fall back to a respawn.
   */
  private async trySwitchModel(model: string): Promise<boolean> {
    if (this.proc === null) return false;
    let data: unknown;
    try {
      data = await this.nativeRpc("get_available_models");
    } catch {
      return false;
    }
    if (!isRecord(data) || !Array.isArray(data["models"])) return false;
    for (const entry of data["models"]) {
      if (!isRecord(entry)) continue;
      const id = entry["id"];
      if (typeof id !== "string" || id !== model) continue;
      const provider = entry["provider"];
      if (typeof provider !== "string") return false;
      try {
        await this.setModel(provider, model);
      } catch {
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Reuse the live proc whenever it can serve `model` (no preference or a
   * match); on a mismatch try `set_model` in place, and respawn only as the
   * fallback. Returns the proc the turn must be written to.
   */
  private async ensureProc(model: string | undefined): Promise<ChildProcess> {
    if (this.proc !== null) {
      if (model === undefined || this.procModel === model) return this.proc;
      if (await this.trySwitchModel(model)) return this.proc;
    }
    return this.start(model);
  }

  /** Run one prompt turn to `agent_settled`; resolves with the collected answer. */
  private runTurn(
    message: string,
    model: string | undefined,
    timeoutMs: number | undefined,
    switchTo?: string,
  ): Promise<AgentResponse> {
    // pi accepts ONE prompt at a time; overlap writes are rejected on the
    // wire. Serialize turn starts so a second caller queues, not corrupts.
    const run = this.turnQueue.then(() => this.runTurnInner(message, model, timeoutMs, switchTo));
    this.turnQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runTurnInner(
    message: string,
    model: string | undefined,
    timeoutMs: number | undefined,
    switchTo: string | undefined,
  ): Promise<AgentResponse> {
    const proc = await this.ensureProc(model);
    if (switchTo !== undefined) {
      // resume = switch_session (rpc.md) + a normal turn inside the loaded file.
      await this.nativeRpc("switch_session", { sessionPath: switchTo });
    }
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
        proc,
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
      // The prompt ack: a rejection must fail the turn, or it hangs.
      this.pending.set(ackId, {
        proc,
        command: "prompt",
        resolve: () => {},
        reject: (error) => this.failActive(error.message),
      });
      try {
        this.writeLine(proc, { id: ackId, type: "prompt", message });
      } catch (err) {
        this.pending.delete(ackId);
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
            this.writeLine(proc, { id: `abort-${sessionId}`, type: "abort" });
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

  async resume(sessionId: string, prompt: string, opts: PromptOptions = {}): Promise<AgentResponse> {
    // switch_session (rpc.md) takes a session path; the id or path the caller
    // holds is passed through and pi reports a clear error when it is wrong.
    return await this.runTurn(prompt, opts.modelId, opts.timeoutMs, sessionId);
  }

  async listModels(): Promise<ModelInfo[]> {
    // get_available_models (rpc.md) returns pi's full catalog as Model objects.
    const data = await this.nativeRpc("get_available_models");
    if (!isRecord(data) || !Array.isArray(data["models"])) return [];
    const models: ModelInfo[] = [];
    for (const entry of data["models"]) {
      if (!isRecord(entry)) continue;
      const id = entry["id"];
      if (typeof id !== "string" || id === "") continue;
      const input = Array.isArray(entry["input"]) ? entry["input"] : [];
      models.push({
        id,
        displayName: typeof entry["name"] === "string" ? entry["name"] : id,
        provider: typeof entry["provider"] === "string" ? entry["provider"] : "",
        contextWindow: typeof entry["contextWindow"] === "number" ? entry["contextWindow"] : 0,
        supportsTools: true,
        supportsVision: input.includes("image"),
      });
    }
    return models;
  }

  /**
   * `set_model` (rpc.md): switch the live proc in place. `provider` is the
   * CATALOG provider (e.g. "bifrost"); `modelId` the full catalog id
   * (e.g. "agnes/agnes-3.0-flash").
   */
  async setModel(provider: string, modelId: string): Promise<unknown> {
    const data = await this.nativeRpc("set_model", { provider, modelId });
    this.procModel = modelId; // the live proc now runs this model
    return data;
  }

  /** `get_state` (rpc.md): parsed session state (model, flags, counters). */
  async getState(): Promise<unknown> {
    return await this.nativeRpc("get_state");
  }

  /** `get_session_stats` (rpc.md): parsed token/cost/context statistics. */
  async getSessionStats(): Promise<unknown> {
    return await this.nativeRpc("get_session_stats");
  }

  /** `get_last_assistant_text` (rpc.md): parsed `{text}` (null when none). */
  async getLastAssistantText(): Promise<unknown> {
    return await this.nativeRpc("get_last_assistant_text");
  }

  async listSessions(): Promise<SessionInfo[]> {
    // --no-session: pi keeps no sessions for this backend (switch_session can
    // still load an external session file — see resume()).
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
    this.rpcSeq += 1;
    try {
      this.writeLine(this.proc, { id: `abort-manual-${this.rpcSeq}`, type: "abort" });
    } catch {
      // proc may be dead — the turn fails through the close handler.
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
    if (this.proc === null) {
      throw new AgentError("rpc_closed", "pi rpc subprocess is not running", "tool");
    }
    // rpc.md: steer queues the message for after the current assistant turn's
    // tool calls; follow_up waits for the agent to stop. The correlated ack
    // is what resolves this promise: callers learn delivery actually happened.
    await this.nativeRpc(kind, { message });
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
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.reject(
        new AgentError("rpc_closed", "PiRpcAgent disposed before the response arrived", "internal"),
      );
    }
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
