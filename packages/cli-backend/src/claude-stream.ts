/**
 * claude-stream.ts — the LIVE stream-json transport for the claude CLI,
 * ported from niwa's Rust adapter (~/ai/niwa/crates/niwa-claude-adapter:
 * command.rs compose_stream_json_argv, frames.rs control/user frames,
 * transport.rs live session pump).
 *
 * One long-lived `claude -p --input-format stream-json --output-format
 * stream-json --include-partial-messages` process per model. Protocol:
 *  - stdin: user turns `{type:"user",message:{role:"user",content:[{type:
 *    "text","text":...}]}}`, control requests `{type:"control_request",
 *    request_id,request:{subtype,...}}` — initialize, interrupt (sent with
 *    `cancel_queued:true`; the success receipt carries `still_queued`/
 *    `cancelled`), and the native subtypes set_model, set_permission_mode,
 *    set_max_thinking_tokens, apply_flag_settings, seed_read_state,
 *    cancel_async_message, end_session (all via nativeControl);
 *  - stdout: `{type:"system"|"assistant"|"stream_event"|"result"|
 *    "rate_limit_event",...}` frames, each carrying session_id; REVERSE
 *    `control_request` frames are classified: `can_use_tool` is answered
 *    fail-closed deny (no approval authority here — the niwa pattern),
 *    `hook_callback`/`request_user_dialog`/`control_cancel_request` get an
 *    error-shaped control_response (harmless), everything unknown gets
 *    nothing; `control_response` frames settle our requests.
 *
 * Turn lifecycle: a user turn line starts a turn; the `result` frame ends it
 * (the same envelope the print transport parses). A second user line while
 * streaming is queued by claude itself — steer/follow_up are plain writes.
 * Resume: spawn with `--resume <sessionId>`; a prompt for a different
 * session respawns the process.
 */

import { type ChildProcess, spawn } from "node:child_process";
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
import { resolveBinary } from "@kagero/core";

type Frame = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Result of one native control round-trip (control_response correlated by request_id). */
interface ControlResult {
  readonly success: boolean;
  /**
   * The full success body: receipts (interrupt `still_queued`/`cancelled`)
   * and advertised data (initialize `commands`) live on it or nested under
   * `response`.
   */
  readonly payload: Frame;
  readonly error?: string;
}

/** Permission modes the native `set_permission_mode` control accepts (claude 2.1.270 wire). */
export type ClaudePermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "manual"
  | "dontAsk"
  | "plan";

/** Receipt echoed by the interrupt control_response when `cancel_queued` was set. */
export interface InterruptReceipt {
  readonly stillQueued: readonly string[];
  readonly cancelled: readonly string[];
}

/** Slash command advertised by the initialize control_response. */
export interface SlashCommand {
  readonly name: string;
  readonly description: string;
}

/**
 * Interrupt receipt parser — the `{still_queued,cancelled}` lists may live
 * directly on the success body or nested one level down (`response.response`)
 * depending on CLI version; read both, defensively.
 */
const parseInterruptReceipt = (payload: Frame): InterruptReceipt => {
  const nested = isRecord(payload["response"]) ? payload["response"] : undefined;
  const list = (key: string): string[] => {
    for (const source of [payload, nested]) {
      const value = source?.[key];
      if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === "string");
      }
    }
    return [];
  };
  return { stillQueued: list("still_queued"), cancelled: list("cancelled") };
};

/** Initialize `commands[]` parser — same defensive nesting as the receipt. */
const parseSlashCommands = (payload: Frame): SlashCommand[] => {
  const nested = isRecord(payload["response"]) ? payload["response"] : undefined;
  for (const source of [payload, nested]) {
    const raw = source?.["commands"];
    if (!Array.isArray(raw)) continue;
    const commands: SlashCommand[] = [];
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const name = str(entry["name"]);
      if (name === undefined) continue;
      commands.push({ name, description: str(entry["description"]) ?? "" });
    }
    return commands;
  }
  return [];
};

interface ActiveTurn {
  sessionId: string;
  text: string[];
  thinking: string[];
  model: string | undefined;
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      }
    | undefined;
  errorMessage: string | undefined;
  finished: boolean;
  settled: (response: AgentResponse) => void;
  failed: (error: AgentError) => void;
}

export class ClaudeStreamAgent implements Agent {
  public readonly name = "claude-stream";

  public readonly capabilities: AgentCapabilities = {
    resume: true,
    models: false,
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
  private procResumeId: string | undefined;
  private buffer = "";
  private subscribers = new Map<string, Set<(e: AgentEvent) => void>>();
  private active: ActiveTurn | undefined;
  private handshakeSucceeded = false;
  private handshakeStarted = false;
  /** Control round-trips in flight, keyed by request_id (initialize/interrupt/native subtypes). */
  private readonly pendingControl = new Map<string, (result: ControlResult) => void>();
  private controlSeq = 0;
  private interruptReceipt: InterruptReceipt | undefined;
  private slashCommandList: readonly SlashCommand[] = [];

  /** Commands advertised by the last successful initialize handshake (empty when none). */
  get slashCommands(): readonly SlashCommand[] {
    return this.slashCommandList;
  }

  /** Receipt of the most recent interrupt, when its control_response carried one. */
  get lastInterruptReceipt(): InterruptReceipt | undefined {
    return this.interruptReceipt;
  }

  // ===========================================================================
  // Agent interface
  // ===========================================================================

  async prompt(prompt: string, opts: PromptOptions = {}): Promise<AgentResponse> {
    return await this.runTurn(prompt, opts);
  }

  async resume(sessionId: string, prompt: string, opts: PromptOptions = {}): Promise<AgentResponse> {
    return await this.runTurn(prompt, { ...opts, sessionId });
  }

  async listModels(): Promise<ModelInfo[]> {
    // claude resolves model aliases (haiku/sonnet/opus/…) internally; there is
    // no rpc listing — report the honest minimum.
    return [];
  }

  async listSessions(): Promise<SessionInfo[]> {
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

  async send(_sessionId: string, message: string, kind: MidRunCommand = "steer"): Promise<void> {
    // Both kinds are a plain user turn: claude queues it mid-stream and
    // executes it when idle (rpc-parity with niwa's render_user_turn_line).
    void kind;
    this.writeUserTurn(message);
  }

  async abort(sessionId: string): Promise<void> {
    const active = this.active;
    if (active !== undefined && active.sessionId === sessionId && !active.finished) {
      this.writeInterrupt();
      // The interrupt control_response (or the turn's result frame) settles
      // the turn; a watchdog resolves it if the CLI never answers. Cancelled
      // turns deliver their own result frames — never pre-settle here.
      setTimeout(() => {
        const current = this.active;
        if (current !== undefined && current.sessionId === sessionId && !current.finished) {
          this.finishAborted(current);
        }
      }, 5_000);
      return;
    }
    this.stopProc();
    this.emit(sessionId, { type: "session-end", reason: "killed", at: new Date().toISOString() });
  }

  async history(_sessionId: string, _opts?: HistoryOptions): Promise<HistoryResult> {
    throw unsupportedCapability(
      "history",
      "use the claude-stream sibling backend's on-disk reader (claude spec) for history.",
    );
  }

  async dispose(): Promise<void> {
    this.stopProc();
    this.failActive("ClaudeStreamAgent disposed before the turn settled");
    this.subscribers.clear();
  }

  // ===========================================================================
  // Native control channel
  // ===========================================================================

  /**
   * Send one native control request and await its correlated control_response
   * (10s ceiling). Never throws — failures come back as `{success:false}`.
   * The remaining verified subtypes ride this directly: seed_read_state
   * (`{path}`), cancel_async_message (`{message_uuid}`), end_session
   * (`{reason}`).
   */
  async nativeControl(subtype: string, extra?: Record<string, unknown>): Promise<ControlResult> {
    try {
      const { promise } = this.writeControlRequest(subtype, extra);
      return await promise;
    } catch (err) {
      return { success: false, payload: {}, error: (err as Error).message };
    }
  }

  /** Switch the model on the live proc (native `set_model`); false if the CLI refused. */
  async setModel(modelId: string): Promise<boolean> {
    return (await this.nativeControl("set_model", { model: modelId })).success;
  }

  /** Switch the permission mode mid-session (native `set_permission_mode`). */
  async setPermissionMode(mode: ClaudePermissionMode): Promise<boolean> {
    return (await this.nativeControl("set_permission_mode", { mode })).success;
  }

  /** Set the thinking-token budget (native `set_max_thinking_tokens`). */
  async setMaxThinkingTokens(max: number): Promise<boolean> {
    return (await this.nativeControl("set_max_thinking_tokens", { max })).success;
  }

  /** Apply CLI flag key/values to the live session (native `apply_flag_settings`). */
  async applyFlagSettings(settings: Record<string, unknown>): Promise<boolean> {
    return (await this.nativeControl("apply_flag_settings", { settings })).success;
  }

  // ===========================================================================
  // Turn lifecycle
  // ===========================================================================

  private runTurn(prompt: string, opts: PromptOptions): Promise<AgentResponse> {
    // One turn at a time: a queued prompt becomes the next turn.
    const sessionId =
      opts.sessionId !== undefined
        ? `claude-${opts.sessionId}`
        : `claude-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return new Promise<AgentResponse>((settle, fail) => {
      const failStart = (err: unknown): void => {
        fail(err instanceof AgentError ? err : new AgentError("spawn_failed", (err as Error).message, "tool"));
      };
      // start() may round-trip a live set_model control before the turn —
      // the user turn is only written once the process is settled.
      void this.start(opts.modelId, opts.sessionId).then(
        (proc) => {
          try {
            if (this.handshakeSucceeded === false && this.handshakeStarted === false) {
              this.handshakeStarted = true;
              const { promise } = this.writeControlRequest("initialize");
              void promise.then((result) => {
                if (result.success) {
                  this.handshakeSucceeded = true;
                  // commands[] absent → discarded (kept empty).
                  this.slashCommandList = parseSlashCommands(result.payload);
                }
              });
            }
            let timer: NodeJS.Timeout | undefined;
            this.active = {
              sessionId,
              text: [],
              thinking: [],
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
            this.emit(sessionId, { type: "user-prompt", content: prompt, at: new Date().toISOString() });
            this.writeUserTurn(prompt);
            void proc; // close/error handlers own the failure path
            if (opts.timeoutMs !== undefined) {
              timer = setTimeout(() => {
                const active = this.active;
                if (active === undefined || active.finished || active.sessionId !== sessionId) return;
                this.writeInterrupt();
                timer = setTimeout(() => {
                  const current = this.active;
                  if (current !== undefined && current.sessionId === sessionId && !current.finished) {
                    this.finishTimedOut(current);
                  }
                }, 5_000);
              }, opts.timeoutMs);
            }
          } catch (err) {
            failStart(err);
          }
        },
        failStart,
      );
    });
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

  private finishTimedOut(active: ActiveTurn): void {
    if (active.finished) return;
    this.emit(active.sessionId, { type: "session-end", reason: "timed-out", at: new Date().toISOString() });
    active.finished = true;
    this.active = undefined;
    active.settled({
      status: "timed-out",
      text: active.text.join("\n\n"),
      sessionId: active.sessionId,
      durationMs: 0,
      meta: { partial: true },
    });
  }

  private finishAborted(active: ActiveTurn): void {
    if (active.finished) return;
    this.emit(active.sessionId, { type: "session-end", reason: "killed", at: new Date().toISOString() });
    active.finished = true;
    this.active = undefined;
    active.settled({
      status: "aborted",
      text: active.text.join("\n\n"),
      sessionId: active.sessionId,
      durationMs: 0,
      meta: { partial: true },
    });
  }

  // ===========================================================================
  // Process + protocol pump
  // ===========================================================================

  private async start(model: string | undefined, resumeId: string | undefined): Promise<ChildProcess> {
    const live = this.proc;
    if (live !== null && this.procResumeId === (resumeId ?? undefined)) {
      if (this.procModel === model) return live;
      if (model !== undefined) {
        // A live proc can switch models in place: try the native set_model
        // control first, and only pay for a respawn if the CLI refuses it.
        const result = await this.nativeControl("set_model", { model });
        if (result.success && this.proc === live) {
          this.procModel = model;
          return live;
        }
      }
    }
    if (this.proc !== null) this.stopProc();
    const bin = resolveBinary("claude", "CLAUDE_STREAM_BIN").path;
    const argv = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-mode",
      "bypassPermissions",
      ...(model === undefined ? [] : ["--model", model]),
      ...(resumeId === undefined ? [] : ["--resume", resumeId]),
    ];
    const proc = spawn(bin, argv, { stdio: ["pipe", "pipe", "pipe"], detached: true });
    proc.unref();
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.ingest(chunk));
    proc.stderr?.on("data", () => {
      // stderr is claude's own diagnostics; protocol errors arrive as frames.
    });
    proc.on("error", (err) => {
      if (this.proc === proc) {
        this.proc = null;
      }
      this.failActive(`claude stream subprocess failed: ${err.message}`);
    });
    proc.on("close", () => {
      // A model/session respawn closes the OLD proc — that must not fail the
      // turn the NEW proc is running.
      if (this.proc === proc) {
        this.proc = null;
        this.procModel = undefined;
        this.handshakeSucceeded = false;
        this.handshakeStarted = false;
        this.failActive("claude stream subprocess closed before the turn settled");
        this.failPendingControl("claude stream subprocess closed before the control settled");
      }
    });
    this.proc = proc;
    this.procModel = model;
    this.procResumeId = resumeId;
    return proc;
  }

  private stopProc(): void {
    const proc = this.proc;
    this.proc = null;
    this.procModel = undefined;
    this.failPendingControl("claude stream subprocess stopped before the control settled");
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

  /** Settle every in-flight control round-trip as failed (proc gone). */
  private failPendingControl(message: string): void {
    const pending = [...this.pendingControl.entries()];
    this.pendingControl.clear();
    for (const [, settle] of pending) {
      settle({ success: false, payload: {}, error: message });
    }
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
      if (line === "") continue;
      let frame: Frame;
      try {
        frame = JSON.parse(line) as Frame;
      } catch {
        continue;
      }
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Frame): void {
    const at = new Date().toISOString();
    const type = str(frame["type"]);

    // Our control requests settle here (initialize / interrupt / native).
    // The real CLI nests request_id inside `response`; accept a top-level one
    // too, defensively.
    if (type === "control_response") {
      const body = isRecord(frame["response"]) ? frame["response"] : undefined;
      const requestId = str(frame["request_id"]) ?? str(body?.["request_id"]);
      if (requestId === undefined) return;
      const pending = this.pendingControl.get(requestId);
      if (pending === undefined) return;
      this.pendingControl.delete(requestId);
      if (body !== undefined && body["subtype"] === "success") {
        // The whole success body is the payload: the interrupt receipt and
        // the initialize commands live on it (or nested under `response`).
        pending({ success: true, payload: body });
      } else {
        pending({
          success: false,
          payload: body ?? {},
          error: str(body?.["error"]) ?? "control request failed",
        });
      }
      return;
    }

    // Reverse control requests, classified: can_use_tool is answered
    // fail-closed deny (no approval authority here — the niwa pattern);
    // interactive subtypes we cannot serve headless get an explicit
    // error-shaped control_response so the CLI never waits; anything else
    // unknown is ignored.
    if (type === "control_request") {
      const requestId = str(frame["request_id"]);
      if (requestId === undefined) return;
      const request = isRecord(frame["request"]) ? frame["request"] : undefined;
      const subtype = str(request?.["subtype"]);
      if (subtype === "can_use_tool") {
        this.writeLine(
          JSON.stringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: requestId,
              response: {
                behavior: "deny",
                message: "claude-stream has no interactive permission authority",
              },
            },
          }),
        );
        return;
      }
      if (
        subtype === "hook_callback" ||
        subtype === "request_user_dialog" ||
        subtype === "control_cancel_request"
      ) {
        this.writeLine(
          JSON.stringify({
            type: "control_response",
            response: { subtype: "error", request_id: requestId, error: "not supported headless" },
          }),
        );
        return;
      }
      return;
    }

    const active = this.active;
    const sessionId =
      active !== undefined ? active.sessionId : (str(frame["session_id"]) ?? "claude-session");
    const emit = (e: AgentEvent): void => {
      this.emit(sessionId, e);
    };

    switch (type) {
      case "system": {
        if (active !== undefined && active.model === undefined) {
          const model = str(frame["model"]);
          if (model !== undefined) active.model = model;
        }
        return;
      }
      case "stream_event": {
        // Partial deltas (include-partial-messages): forward text deltas live.
        const inner = isRecord(frame["event"]) ? frame["event"] : undefined;
        const delta = isRecord(inner?.["delta"]) ? inner["delta"] : undefined;
        if (delta !== undefined && delta["type"] === "text_delta" && typeof delta["text"] === "string") {
          emit({ type: "assistant-text", content: delta["text"], at });
        }
        return;
      }
      case "assistant": {
        const message = isRecord(frame["message"]) ? frame["message"] : undefined;
        if (message === undefined) return;
        const content = Array.isArray(message["content"]) ? message["content"] : [];
        const texts: string[] = [];
        let thinking: string | undefined;
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block["type"] === "text" && typeof block["text"] === "string") {
            texts.push(block["text"]);
          } else if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
            thinking = thinking === undefined ? block["thinking"] : `${thinking}\n${block["thinking"]}`;
          } else if (block["type"] === "tool_use") {
            emit({
              type: "tool-call",
              name: str(block["name"]) ?? "unknown",
              args: block["input"],
              at,
            });
          }
        }
        const text = texts.join("\n");
        if (active !== undefined) {
          if (text !== "") active.text.push(text);
          if (thinking !== undefined) active.thinking.push(thinking);
          if (active.model === undefined && str(message["model"]) !== undefined) {
            active.model = str(message["model"]);
          }
        }
        if (text !== "") emit({ type: "assistant-text", content: text, at });
        return;
      }
      case "user": {
        // Tool results arrive as user frames with tool_result blocks.
        const message = isRecord(frame["message"]) ? frame["message"] : undefined;
        const content = message === undefined ? undefined : message["content"];
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (!isRecord(block) || block["type"] !== "tool_result") continue;
          const inner = Array.isArray(block["content"]) ? block["content"] : [];
          const parts: string[] = [];
          for (const piece of inner) {
            if (isRecord(piece) && typeof piece["text"] === "string") parts.push(piece["text"]);
          }
          emit({
            type: "tool-result",
            name: "claude",
            result: parts.join("\n"),
            at,
          });
        }
        return;
      }
      case "rate_limit_event": {
        emit({ type: "error", message: "claude rate limit event", at });
        return;
      }
      case "result": {
        if (active === undefined || active.finished) return;
        const isError = frame["is_error"] === true;
        const subtype = str(frame["subtype"]) ?? "unknown";
        const resultSessionId = str(frame["session_id"]);
        if (isError) {
          const message = str(frame["result"]) ?? `claude result error (${subtype})`;
          this.emit(active.sessionId, { type: "error", message, at });
          this.emit(active.sessionId, { type: "session-end", reason: "errored", at });
          active.finished = true;
          this.active = undefined;
          active.failed(new AgentError("cli_error", message, "tool", { subtype }));
          return;
        }
        const usage = isRecord(frame["usage"]) ? frame["usage"] : undefined;
        const num = (key: string): number | undefined => {
          const value = usage?.[key];
          return typeof value === "number" ? value : undefined;
        };
        const inputTokens = num("input_tokens");
        const outputTokens = num("output_tokens");
        const cacheReadTokens = num("cache_read_input_tokens");
        const cacheCreationTokens = num("cache_creation_input_tokens");
        this.emit(active.sessionId, { type: "session-end", reason: "completed", at });
        active.finished = true;
        this.active = undefined;
        active.settled({
          status: "completed",
          text: active.text.join("\n\n"),
          sessionId: resultSessionId ?? active.sessionId,
          durationMs: 0,
          ...(active.model !== undefined ? { modelId: active.model, modelSource: "reported" as const } : {}),
          ...(inputTokens !== undefined || outputTokens !== undefined
            ? {
                usage: {
                  ...(inputTokens !== undefined ? { inputTokens } : {}),
                  ...(outputTokens !== undefined ? { outputTokens } : {}),
                  ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
                  ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
                },
              }
            : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  // ===========================================================================
  // Wire writers (niwa frames.rs shapes)
  // ===========================================================================

  private writeLine(line: string): void {
    const proc = this.proc;
    if (proc === null || proc.stdin === null) {
      throw new AgentError("rpc_closed", "claude stream subprocess is not running", "tool");
    }
    try {
      proc.stdin.write(`${line}\n`);
    } catch (err) {
      throw new AgentError("rpc_write_failed", (err as Error).message, "tool");
    }
  }

  private writeUserTurn(message: string): void {
    this.writeLine(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: message }] },
      }),
    );
  }

  /**
   * The one control-request writer: fresh request_id (same scheme as
   * initialize/interrupt always used), promise correlated by the
   * pendingControl map, 10s timeout. The promise never rejects — failures
   * (timeout, dead proc) resolve `{success:false}`.
   */
  private writeControlRequest(
    subtype: string,
    extra: Record<string, unknown> = {},
  ): { requestId: string; promise: Promise<ControlResult> } {
    this.controlSeq += 1;
    const requestId = `kagero-control-${Date.now()}-${this.controlSeq}`;
    const request: Frame = { subtype, ...extra };
    const promise = new Promise<ControlResult>((settled) => {
      this.pendingControl.set(requestId, settled);
      setTimeout(() => {
        if (this.pendingControl.delete(requestId)) {
          settled({ success: false, payload: {}, error: "control request timed out" });
        }
      }, 10_000);
    });
    this.writeLine(
      JSON.stringify({ type: "control_request", request_id: requestId, request }),
    );
    return { requestId, promise };
  }

  /**
   * Interrupt the active turn with `cancel_queued:true` and record the
   * success receipt (`still_queued`/`cancelled`). Cancelled turns deliver
   * their own result frames — nothing is pre-settled here; the watchdog in
   * the caller still classifies a silent CLI as aborted/timed-out.
   */
  private writeInterrupt(): void {
    const { promise } = this.writeControlRequest("interrupt", { cancel_queued: true });
    void promise.then((result) => {
      if (result.success) this.interruptReceipt = parseInterruptReceipt(result.payload);
    });
  }

  // ---------------------------------------------------------------------------

  private emit(sessionId: string, event: AgentEvent): void {
    // Same contract as the other backends: exact-session subscribers plus
    // "*" (which receives everything, e.g. the stream compressor hub).
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
