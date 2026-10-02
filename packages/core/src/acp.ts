/**
 * acp.ts — one ACP (Agent Client Protocol) conversation over a child's stdio.
 *
 * The child speaks JSON-RPC 2.0 as NDJSON on stdin/stdout. The protocol facts
 * this client relies on (the same ones every ACP agent speaks):
 *   - `initialize` opens the connection (protocolVersion defaults to the
 *     integer 1; AcpClientOptions.protocolVersion overrides it for CLIs that
 *     want the string "1", e.g. grok);
 *   - `session/new` (or `session/load`) opens the conversation;
 *   - `session/set_mode` / `session/set_config_option` apply mode and model;
 *   - `session/prompt` is the user turn, `session/update` notifications carry
 *     the stream, and `session/cancel` ends an in-flight turn in-protocol.
 *
 * Updates map onto AgentEvent: agent_message_chunk → "assistant-text",
 * tool_call → "tool-call", agent_thought_chunk is dropped. Incoming
 * `session/request_permission` requests are answered with the configured
 * option so a turn can never stall on a prompt nobody watches; every other
 * incoming request is refused with -32601 — this client advertises no
 * capabilities of its own.
 *
 * Lifecycle: the child is spawned detached into its own process group, so a
 * crashed parent cannot leak it. `dispose()` runs the stop ladder — in-protocol
 * cancel, SIGTERM to the whole group, one grace window, then SIGKILL to the
 * group. `kill(-pid)` is guarded to pid > 0 — signalling group -0 would hit
 * our own process group.
 *
 * A dead child rejects every pending reply with "the ACP process exited
 * before replying" — a caller never waits on a corpse.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AgentEvent } from "./agent.js";
import { MAX_DIAGNOSTIC_CHARS, sanitizeDiagnostic } from "./diagnostics.js";

/** An AgentEvent without the `at` stamp; the client adds it on emit. */
type WithoutAt<T> = T extends { at: string } ? Omit<T, "at"> : T;
type AgentEventDraft = WithoutAt<AgentEvent>;

type RpcRecord = Record<string, unknown>;

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
/** SIGTERM → SIGKILL grace inside the dispose ladder. */
const KILL_GRACE_MS = 5_000;
const DEFAULT_CLIENT_NAME = "kagero";
const DEFAULT_CLIENT_VERSION = "0.2.0";
const DEFAULT_PERMISSION_OPTION = "approve_once";
const EXITED_MESSAGE = "the ACP process exited before replying";
const MAX_STDERR_TAIL = 4_000;

export interface AcpClientOptions {
  /** Full argv to spawn, e.g. ["qwen", "--acp"]. */
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Where the stream of the run lands (assistant text, tool calls, errors). */
  readonly onEvent: (e: AgentEvent, sessionId: string) => void;
  /**
   * Answer to incoming session/request_permission requests.
   * Typically "approve_always" or "approve_once". Default "approve_once".
   */
  readonly permissionOption?: string;
  /** Extra `_meta` merged into initialize `clientCapabilities` — extension gates (e.g. mcode "minimax-code/extensions"). */
  readonly clientCapabilitiesMeta?: Record<string, unknown>;
  /** Extra `additionalDirectories` sent with session/new (kimi honors on create). */
  readonly additionalDirectories?: readonly string[];
  /** Timeout for the initialize / session-new / load handshake. Default 15000. */
  readonly handshakeTimeoutMs?: number;
  readonly clientInfo?: { readonly name: string; readonly version: string };
  /**
   * `initialize` protocolVersion value. Default 1 (the integer every ACP
   * agent speaks); some CLIs want the STRING "1" (grok sends a string) —
   * pass "1" to match them byte-for-byte.
   */
  readonly protocolVersion?: number | string;
  /** Strings (the user prompt) that must never appear in surfaced stderr diagnostics. */
  readonly redact?: readonly string[];
}

/** One config option for session/set_config_option. */
export interface AcpConfigOption {
  readonly configId: string;
  readonly value: unknown;
}

export interface AcpSessionConfig {
  /** Extra tool-access directories (kimi honors on session/new). */
  readonly additionalDirectories?: readonly string[];
  /** Default []. */
  readonly mcpServers?: readonly unknown[];
  /** Sent as `_meta` on session/new and session/load. */
  readonly meta?: Record<string, unknown>;
  /** Applied with session/set_mode right after the session is open. */
  readonly modeId?: string;
  /** Applied with session/set_config_option, in order, after the session is open. */
  readonly configOptions?: readonly AcpConfigOption[];
}

export interface AcpTurnResult {
  /** As reported by the agent: "end_turn" | "cancelled" | "max_tokens" | ... */
  readonly stopReason: string;
  /** Concatenated agent_message_chunk text of the turn. */
  readonly text: string;
}

interface PendingRequest {
  resolve: (value: RpcRecord) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

interface Turn {
  resolve: (result: AcpTurnResult) => void;
  reject: (err: Error) => void;
  timeoutMs: number | undefined;
}

interface RequestOptions {
  readonly timeoutMs?: number;
  /** Human name for the timeout error, e.g. "the initialize handshake". */
  readonly label?: string;
}

function asRecord(value: unknown): RpcRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RpcRecord) : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * One ACP JSON-RPC conversation over a spawned agent's stdin/stdout.
 *
 * One turn at a time: `prompt()` rejects while a turn is in flight. `steer`
 * cancels the turn and re-prompts with the steering text once it settles as
 * cancelled; `followUp` queues a session/prompt notification for right after
 * the turn settles.
 */
export class AcpClient {
  private readonly opts: AcpClientOptions;
  private readonly handshakeTimeoutMs: number;
  private readonly permissionOptionId: string;
  private readonly protocolVersion: number | string;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private child: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private disposePromise: Promise<void> | null = null;
  private exited = false;
  private lineBuffer = "";
  private stderrTail = "";
  /** The capped tail dropped older output, so its first line may be partial. */
  private stderrTailCut = false;
  private sessionIdValue: string | null = null;
  private textChunks: string[] = [];
  private turn: Turn | null = null;
  private pendingSteer: string | null = null;
  private pendingFollowUp: string | null = null;
  private abortCleanup: (() => void) | null = null;

  constructor(opts: AcpClientOptions) {
    this.opts = opts;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.permissionOptionId = opts.permissionOption ?? DEFAULT_PERMISSION_OPTION;
    this.protocolVersion = opts.protocolVersion ?? 1;
  }

  /** The open ACP session id, or null before session/new / session/load. */
  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  /**
   * Bounded, sanitized tail of the child's stderr (secret formats and the
   * configured `redact` strings removed, capped) — safe for error messages,
   * AgentError.context and receipts. Empty when the child wrote nothing.
   */
  get stderrDiagnostic(): string {
    return sanitizeDiagnostic(this.stderrTail, {
      from: "tail",
      maxChars: MAX_DIAGNOSTIC_CHARS,
      edgeCut: this.stderrTailCut,
      ...(this.opts.redact === undefined ? {} : { redact: this.opts.redact }),
    });
  }

  // --- lifecycle -------------------------------------------------------------

  /**
   * Spawn the child detached into its own process group. Rejects when the
   * spawn fails or the child dies before the connection is up. Idempotent.
   */
  start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise;
    if (this.disposePromise !== null) {
      return Promise.reject(new Error("the ACP client was disposed"));
    }
    const [command, ...args] = this.opts.command;
    if (command === undefined || command === "") {
      return Promise.reject(new Error("ACP command is empty"));
    }
    this.startPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      let child: ChildProcess;
      try {
        child = spawn(command, args, {
          cwd: this.opts.cwd,
          env: this.opts.env ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
      } catch (err) {
        reject(
          new Error(
            `failed to spawn the ACP process ${command}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }
      this.child = child;
      child.once("spawn", () => {
        settled = true;
        resolve();
      });
      child.once("error", (err: Error) => {
        if (!settled) {
          settled = true;
          reject(new Error(`failed to spawn the ACP process ${command}: ${err.message}`));
        }
        this.handleChildDeath();
      });
      child.once("close", () => {
        if (!settled) {
          settled = true;
          const tail = this.stderrDiagnostic;
          reject(
            new Error(
              `the ACP process ${command} exited before the connection opened${tail === "" ? "" : `: ${tail}`}`,
            ),
          );
        }
        this.handleChildDeath();
      });
      this.wireStreams(child);
    });
    return this.startPromise;
  }

  /**
   * Stop ladder: in-protocol session/cancel, then SIGTERM to the process
   * group, a grace window, SIGKILL to the group. Rejects every pending reply.
   * Idempotent.
   */
  dispose(): Promise<void> {
    if (this.disposePromise === null) this.disposePromise = this.runStopLadder();
    return this.disposePromise;
  }

  private async runStopLadder(): Promise<void> {
    this.abortCleanup?.();
    this.abortCleanup = null;
    this.rejectAll("the ACP client was disposed");
    const child = this.child;
    if (child === null) return;
    this.cancel();
    this.signalTree("SIGTERM");
    const closed = this.onceClosed(child);
    await Promise.race([closed, sleep(KILL_GRACE_MS)]);
    if (!this.exited) this.signalTree("SIGKILL");
    await Promise.race([closed, sleep(KILL_GRACE_MS)]);
  }

  private onceClosed(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
  }

  /** Signal the whole process group; kill(-pid) only when pid > 0. */
  private signalTree(signal: NodeJS.Signals): void {
    const child = this.child;
    if (child === null) return;
    const pid = child.pid;
    if (pid === undefined || pid <= 0) {
      try {
        child.kill(signal);
      } catch {
        // Already dead — nothing to do.
      }
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already dead — nothing to do.
      }
    }
  }

  private handleChildDeath(): void {
    if (this.exited) return;
    this.exited = true;
    const hadBusiness = this.pending.size > 0 || this.turn !== null;
    this.rejectAll(EXITED_MESSAGE);
    if (hadBusiness) {
      const tail = this.stderrDiagnostic;
      this.emit({
        type: "error",
        message: tail === "" ? EXITED_MESSAGE : `${EXITED_MESSAGE} stderr tail: ${tail}`,
      });
    }
  }

  // --- handshake and sessions --------------------------------------------------

  /** Open the connection: the initialize request. */
  async initialize(timeoutMs?: number): Promise<void> {
    await this.request(
      "initialize",
      {
        protocolVersion: this.protocolVersion,
        clientInfo: this.opts.clientInfo ?? { name: DEFAULT_CLIENT_NAME, version: DEFAULT_CLIENT_VERSION },
        clientCapabilities:
          this.opts.clientCapabilitiesMeta === undefined
            ? {}
            : { _meta: this.opts.clientCapabilitiesMeta },
      },
      { timeoutMs: timeoutMs ?? this.handshakeTimeoutMs, label: "the initialize handshake" },
    );
  }

  /**
   * Raw native RPC against the live ACP agent (allowlisted by the caller):
   * `session/list`, `session/fork`, extension methods (`mcode/session/steer`,
   * grok `x.ai/*`), etc. Same wire path as every internal call.
   */
  async nativeRequest(method: string, params: RpcRecord, timeoutMs?: number): Promise<RpcRecord> {
    return await this.request(method, params, { timeoutMs: timeoutMs ?? 120_000, label: method });
  }

  /** session/new → sessionId, then modeId / configOptions applied in order. */
  async newSession(config: AcpSessionConfig, timeoutMs?: number): Promise<string> {
    const budget = timeoutMs ?? this.handshakeTimeoutMs;
    const params: RpcRecord = {
      cwd: this.opts.cwd,
      mcpServers: config.mcpServers ?? [],
    };
    if (config.additionalDirectories !== undefined && config.additionalDirectories.length > 0) {
      params["additionalDirectories"] = config.additionalDirectories;
    }
    if (config.meta !== undefined) params["_meta"] = config.meta;
    const created = await this.request("session/new", params, { timeoutMs: budget, label: "session/new" });
    const reported = created["sessionId"];
    if (typeof reported !== "string" || reported === "") {
      throw new Error("session/new did not return a sessionId");
    }
    this.sessionIdValue = reported;
    await this.applySessionConfig(reported, config, budget);
    return reported;
  }

  /** session/load for a resume; applies modeId / configOptions; returns sessionId. */
  async loadSession(sessionId: string, config: AcpSessionConfig, timeoutMs?: number): Promise<string> {
    const budget = timeoutMs ?? this.handshakeTimeoutMs;
    const params: RpcRecord = {
      sessionId,
      cwd: this.opts.cwd,
      mcpServers: config.mcpServers ?? [],
    };
    if (config.meta !== undefined) params["_meta"] = config.meta;
    await this.request("session/load", params, { timeoutMs: budget, label: "session/load" });
    this.sessionIdValue = sessionId;
    await this.applySessionConfig(sessionId, config, budget);
    return sessionId;
  }

  private async applySessionConfig(
    sessionId: string,
    config: AcpSessionConfig,
    timeoutMs: number,
  ): Promise<void> {
    if (config.modeId !== undefined) {
      await this.request(
        "session/set_mode",
        { sessionId, modeId: config.modeId },
        {
          timeoutMs,
          label: "session/set_mode",
        },
      );
    }
    for (const option of config.configOptions ?? []) {
      await this.request(
        "session/set_config_option",
        { sessionId, configId: option.configId, value: option.value },
        { timeoutMs, label: "session/set_config_option" },
      );
    }
  }

  // --- turns -------------------------------------------------------------------

  /**
   * session/prompt. Resolves when the response to this prompt arrives
   * (stopReason from the result; a protocol error rejects). Text chunks have
   * already gone through onEvent; `text` returns their aggregate. When the
   * turn settles as cancelled after `steer()`, the steering prompt is sent
   * and this promise resolves with its result instead.
   */
  prompt(text: string, timeoutMs?: number): Promise<AcpTurnResult> {
    if (this.turn !== null) {
      return Promise.reject(new Error("another ACP turn is already in flight"));
    }
    const sessionId = this.sessionIdValue;
    if (sessionId === null) {
      return Promise.reject(new Error("ACP session is not open"));
    }
    if (this.exited) {
      return Promise.reject(new Error(EXITED_MESSAGE));
    }
    return new Promise<AcpTurnResult>((resolve, reject) => {
      this.textChunks = [];
      this.turn = { resolve, reject, timeoutMs };
      this.sendTurnRequest(sessionId, text, timeoutMs, true);
    });
  }

  /** Cancel the in-flight turn and re-prompt with `text` once it settles as cancelled. */
  steer(text: string): void {
    this.pendingSteer = text;
    this.cancel();
  }

  /** Queue `text`; right after the current turn settles it goes out as a session/prompt notification. */
  followUp(text: string): void {
    if (this.turn === null) {
      this.notify("session/prompt", {
        sessionId: this.sessionIdValue ?? "",
        prompt: [{ type: "text", text }],
      });
      return;
    }
    this.pendingFollowUp = text;
  }

  /** Best-effort in-protocol cancel of the in-flight turn. */
  cancel(): void {
    const sessionId = this.sessionIdValue;
    if (sessionId !== null) this.notify("session/cancel", { sessionId });
  }

  /** Register an external abort signal — abort fires cancel(). */
  abortWith(signal: AbortSignal): void {
    if (signal.aborted) {
      this.cancel();
      return;
    }
    const onAbort = (): void => this.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    this.abortCleanup = () => signal.removeEventListener("abort", onAbort);
  }

  /** Send one turn's session/prompt and register its pending reply. */
  private sendTurnRequest(
    sessionId: string,
    text: string,
    timeoutMs: number | undefined,
    cancelOnTimeout: boolean,
  ): void {
    const id = this.nextId++;
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        this.pending.delete(id);
        this.failTurn(new Error(`session/prompt timed out after ${timeoutMs} ms`));
        if (cancelOnTimeout) this.cancel();
      }, timeoutMs);
    }
    this.pending.set(id, {
      resolve: (result) => this.settlePrompt(result),
      reject: (err) => this.failTurn(err),
      timer,
    });
    this.send({
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text }] },
    });
  }

  /** The response to a prompt arrived — steer, flush the follow-up, settle. */
  private settlePrompt(result: RpcRecord): void {
    const stop = typeof result["stopReason"] === "string" ? result["stopReason"] : "end_turn";

    if (this.pendingSteer !== null && (stop === "cancelled" || stop === "canceled")) {
      const steered = this.pendingSteer;
      const sessionId = this.sessionIdValue;
      this.pendingSteer = null;
      if (sessionId === null) {
        this.finishTurn(stop);
        return;
      }
      this.textChunks = [];
      this.sendTurnRequest(sessionId, steered, this.turn?.timeoutMs, false);
      return;
    }

    if (this.pendingFollowUp !== null) {
      const followUp = this.pendingFollowUp;
      this.pendingFollowUp = null;
      this.notify("session/prompt", {
        sessionId: this.sessionIdValue ?? "",
        prompt: [{ type: "text", text: followUp }],
      });
    }

    this.finishTurn(stop);
  }

  private finishTurn(stopReason: string): void {
    const turn = this.turn;
    this.turn = null;
    if (turn !== null) turn.resolve({ stopReason, text: this.textChunks.join("") });
  }

  private failTurn(err: Error): void {
    const turn = this.turn;
    this.turn = null;
    if (turn !== null) turn.reject(err);
  }

  // --- wire protocol -------------------------------------------------------------

  private wireStreams(child: ChildProcess): void {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.lineBuffer += chunk;
      let newline = this.lineBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.lineBuffer.slice(0, newline).trim();
        this.lineBuffer = this.lineBuffer.slice(newline + 1);
        newline = this.lineBuffer.indexOf("\n");
        if (line !== "") this.handleRawLine(line);
      }
    });
    // stderr is captured (capped) for diagnostics only; it is never a protocol stream.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const combined = this.stderrTail + chunk;
      if (combined.length > MAX_STDERR_TAIL) this.stderrTailCut = true;
      this.stderrTail = combined.slice(-MAX_STDERR_TAIL);
    });
  }

  private handleRawLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // not a message line — ignore
    }
    const record = asRecord(parsed);
    if (record === null || record["jsonrpc"] !== "2.0") return;

    const method = record["method"];
    if (typeof method === "string" && Object.hasOwn(record, "id") && !Object.hasOwn(record, "result")) {
      this.answerIncoming(record, method);
      return;
    }

    const id = record["id"];
    if (typeof id === "number") {
      const waiter = this.pending.get(id);
      if (waiter) {
        this.pending.delete(id);
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        const error = asRecord(record["error"]);
        if (error !== null) {
          const message = typeof error["message"] === "string" ? error["message"] : "ACP request failed";
          waiter.reject(new Error(message));
        } else {
          waiter.resolve(asRecord(record["result"]) ?? {});
        }
        return;
      }
    }

    if (method === "session/update") {
      this.onUpdate(asRecord(record["params"]));
    }
  }

  /** Requests from the agent are answered so a turn cannot stall on them. */
  private answerIncoming(record: RpcRecord, method: string): void {
    if (method === "session/request_permission") {
      this.send({
        jsonrpc: "2.0",
        id: record["id"],
        result: { outcome: { outcome: "selected", optionId: this.permissionOptionId } },
      });
      return;
    }
    this.send({
      jsonrpc: "2.0",
      id: record["id"],
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  /** session/update → AgentEvent, as far as the mapping goes. */
  private onUpdate(params: RpcRecord | null): void {
    if (params === null) return;
    const update = asRecord(params["update"]) ?? params;
    const kind = update["sessionUpdate"];
    if (kind === "agent_thought_chunk") return;
    if (kind === "agent_message_chunk") {
      const content = asRecord(update["content"]);
      const text = typeof content?.["text"] === "string" ? content["text"] : "";
      if (text !== "") {
        this.textChunks.push(text);
        this.emit({ type: "assistant-text", content: text });
      }
      return;
    }
    if (kind === "tool_call") {
      const rawName = update["toolName"] ?? update["title"];
      const name = typeof rawName === "string" && rawName !== "" ? rawName : "tool";
      this.emit({ type: "tool-call", name, args: update["rawInput"] ?? {} });
    }
  }

  private emit(draft: AgentEventDraft): void {
    const event = { ...draft, at: new Date().toISOString() } as AgentEvent;
    this.opts.onEvent(event, this.sessionIdValue ?? "");
  }

  private request(method: string, params: RpcRecord, options: RequestOptions = {}): Promise<RpcRecord> {
    if (this.child === null) {
      return Promise.reject(new Error("the ACP client is not started"));
    }
    if (this.exited) {
      return Promise.reject(new Error(EXITED_MESSAGE));
    }
    const id = this.nextId++;
    return new Promise<RpcRecord>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${options.label ?? method} timed out after ${options.timeoutMs} ms`));
        }, options.timeoutMs);
      }
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: RpcRecord): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown): void {
    const stdin = this.child?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectAll(reason: string): void {
    for (const [id, waiter] of [...this.pending]) {
      this.pending.delete(id);
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    this.failTurn(new Error(reason));
  }
}
