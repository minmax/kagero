/**
 * Agent — the common contract for every kagero backend.
 *
 * Every concrete backend (pi SDK, pi RPC, CLI wrappers) implements this
 * interface. The MCP server and CLI depend only on this contract.
 *
 * Contract rules (see docs/LIB-PLAN.md §4.0):
 *  - Responses always carry the final assistant `text` and, when the backend
 *    produced one, the `sessionId` — a caller must never need a second call
 *    to learn what session to resume.
 *  - `modelId` is the model as REPORTED by the backend (`modelSource:
 *    "reported"`); when the backend stays silent we echo the requested id and
 *    say so (`"requested"`). Silent model drift is the one unforgivable bug.
 *  - `usage` omits anything the backend did not report. Never fabricate zeros.
 *  - `status` is honest: a timed-out or aborted run never looks successful.
 *    The session stays resumable — a timeout is a checkpoint, not a failure
 *    of the conversation.
 */

/** Information about a model the agent can use. */
export interface ModelInfo {
  readonly id: string;
  readonly displayName: string;
  readonly provider: string;
  readonly contextWindow: number;
  readonly supportsTools: boolean;
  readonly supportsVision: boolean;
}

/** Information about a persistent session. */
export interface SessionInfo {
  readonly id: string;
  readonly createdAt: string;
  readonly lastUsedAt: string;
  readonly cwd: string;
  readonly summary: string;
  readonly messageCount: number;
}

/** Token/cost accounting as reported by a backend. */
export interface UsageTelemetry {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly costUsd?: number;
}

/** How a finished run ended. */
export type AgentRunStatus = "completed" | "aborted" | "timed-out";

export interface AgentResponse {
  readonly status: AgentRunStatus;
  /** The assistant's final text (partial when status is not "completed"). */
  readonly text: string;
  /** Session to resume, when the backend produced or continued one. */
  readonly sessionId?: string;
  /** Actual model when the backend reported it, otherwise the requested id. */
  readonly modelId?: string;
  readonly modelSource?: "reported" | "requested";
  /** Working directory the run executed in (resolved workspace). */
  readonly workspace?: string;
  readonly durationMs: number;
  readonly usage?: UsageTelemetry;
  readonly meta?: {
    /** Text was cut short (abort, timeout, CLI limit) — resumable. */
    readonly partial?: boolean;
    /** Output hit the byte cap; tail was dropped. */
    readonly truncated?: boolean;
  };
}

/** Run in a fresh scratch directory (`{create: true}`) or an explicit one. */
export type WorkspaceOption =
  | { readonly create: true; readonly parent?: string }
  | { readonly path: string };

export interface PromptOptions {
  readonly cwd?: string;
  readonly modelId?: string;
  /**
   * Wall-clock checkpoint for the run. On expiry the backend stops the run
   * (in-protocol cancel first, then the process ladder) and resolves with
   * status "timed-out" — the session remains resumable.
   */
  readonly timeoutMs?: number;
  /** Turn cap, where the CLI supports one. */
  readonly maxTurns?: number;
  /** Tool-call cap, where the CLI supports one. */
  readonly maxToolCalls?: number;
  /** "default" leaves CLI defaults; "yolo" asks for always-approve. */
  readonly approvalMode?: "default" | "yolo";
  readonly workspace?: WorkspaceOption;
  /** Attach to a known session for a first prompt instead of a fresh one. */
  readonly sessionId?: string;
  /** Raw stdout chunks as they arrive (print transports; best-effort). */
  readonly onStream?: (chunk: string) => void;
}

/** Per-event payload for live observation. */
export type AgentEvent =
  | { type: "session-start"; sessionId: string; at: string }
  | { type: "user-prompt"; content: string; at: string }
  | { type: "assistant-text"; content: string; at: string }
  | { type: "tool-call"; name: string; args: unknown; at: string }
  | { type: "tool-result"; name: string; result: unknown; at: string }
  | { type: "error"; message: string; at: string }
  | { type: "session-end"; reason: "completed" | "killed" | "errored" | "timed-out"; at: string };

/** What a backend can do. Everything not listed is honestly off. */
export interface AgentCapabilities {
  readonly resume: boolean;
  readonly models: boolean;
  readonly sessions: boolean;
  readonly history: boolean;
  readonly subscribe: boolean;
  readonly abort: boolean;
  /** Mid-run redirect: interrupt the current turn with a new instruction. */
  readonly steer: boolean;
  /** Queue a message for after the current turn settles. */
  readonly followUp: boolean;
  readonly limits: {
    readonly timeout: boolean;
    readonly maxTurns: boolean;
    readonly maxToolCalls: boolean;
  };
  readonly workspaceCreate: boolean;
}

/** One normalized conversation entry for the unified history view. */
export interface HistoryEntry {
  readonly index: number;
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly at?: string;
  readonly text: string;
  readonly toolName?: string;
  readonly toolOk?: boolean;
}

export interface HistoryResult {
  readonly sessionId: string;
  readonly entries: readonly HistoryEntry[];
  readonly totalEntries: number;
  readonly truncated: boolean;
  /** Where the full untruncated log lives. Surfaced once per rendered output. */
  readonly fullLog?: { readonly file: string; readonly line?: number };
}

export interface HistoryOptions {
  /** How many trailing entries to return. */
  readonly last?: number;
  /** Per-entry character budget before the "+N chars" cut. */
  readonly maxChars?: number;
}

/** Mid-run message kinds for ACP-style live sessions. */
export type MidRunCommand = "steer" | "follow_up";

/** Common Agent contract. */
export interface Agent {
  /** Stable backend name (e.g. "pi-sdk", "qwen"). */
  readonly name: string;
  readonly capabilities: AgentCapabilities;

  /** Send a one-shot prompt. */
  prompt(prompt: string, opts?: PromptOptions): Promise<AgentResponse>;

  /** Continue a persistent session. */
  resume(sessionId: string, prompt: string, opts?: PromptOptions): Promise<AgentResponse>;

  /** List available models. */
  listModels(): Promise<ModelInfo[]>;

  /** List persistent sessions. */
  listSessions(): Promise<SessionInfo[]>;

  /** Compact, normalized conversation history with a full-log pointer. */
  history(sessionId: string, opts?: HistoryOptions): Promise<HistoryResult>;

  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(sessionId: string, onEvent: (e: AgentEvent) => void): () => void;

  /** Deliver a mid-run message into a live turn (steer) or queue it (follow_up). */
  send(sessionId: string, message: string, kind?: MidRunCommand): Promise<void>;

  /** Abort an in-flight run. Idempotent. */
  abort(sessionId: string): Promise<void>;

  /** Cleanup. */
  dispose(): Promise<void>;
}

/** Standard error for everything an Agent refuses or fails at. */
export class AgentError extends Error {
  public readonly code: string;
  public readonly kind: "internal" | "protocol" | "tool" | "user";
  public readonly context: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    kind: AgentError["kind"] = "tool",
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.kind = kind;
    this.context = context;
  }
}

/** Build the canonical error for a capability the backend does not have. */
export function unsupportedCapability(capability: string, hint?: string): AgentError {
  return new AgentError(
    "unsupported_capability",
    `Backend does not support ${capability}.${hint ? ` ${hint}` : ""}`,
    "user",
    { capability },
  );
}
