/**
 * Agent — common interface for any agentic backend.
 *
 * Every concrete backend (pi SDK, dsh CLI, qwen CLI, ...) implements this
 * interface. The MCP server and CLI both depend only on this contract.
 *
 * The shape mirrors what pi SDK provides, so the SDK is the "canonical"
 * implementation. CLI backends adapt to fit.
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

/** Per-event payload for live observation. */
export type AgentEvent =
  | { type: "user-prompt"; content: string; at: string }
  | { type: "assistant-text"; content: string; at: string }
  | { type: "tool-call"; name: string; args: unknown; at: string }
  | { type: "tool-result"; name: string; result: unknown; at: string }
  | { type: "error"; message: string; at: string }
  | { type: "session-end"; reason: "completed" | "killed" | "errored"; at: string };

/** Common Agent contract. */
export interface Agent {
  /** Stable name of this backend (e.g. "pi-sdk", "dsh", "qwen"). */
  readonly name: string;

  /** Send a one-shot prompt. No session, no resume. */
  prompt(prompt: string, opts?: PromptOptions): Promise<AgentResponse>;

  /** Continue a persistent session. */
  resume(sessionId: string, prompt: string, opts?: PromptOptions): Promise<AgentResponse>;

  /** List available models. */
  listModels(): Promise<ModelInfo[]>;

  /** List persistent sessions. */
  listSessions(): Promise<SessionInfo[]>;

  /** Subscribe to live events. Returns unsubscribe function. */
  subscribe(sessionId: string, onEvent: (e: AgentEvent) => void): () => void;

  /** Abort an in-flight run. */
  abort(sessionId: string): Promise<void>;

  /** Cleanup. */
  dispose(): Promise<void>;
}

export interface PromptOptions {
  cwd?: string;
  modelId?: string;
  timeoutMs?: number;
  /** Optional session id (for prompt() that wants to attach to a known session). */
  sessionId?: string;
  onStream?: (chunk: string) => void;
}

export interface AgentResponse {
  /** The model's final text. */
  text: string;
  /** Session id (if persistent). */
  sessionId?: string;
  /** Model that was used. */
  modelId?: string;
  /** Wall-clock time. */
  durationMs: number;
  /** Optional metadata from the backend. */
  meta?: Record<string, unknown>;
}

/** Standardized error. */
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
