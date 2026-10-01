/**
 * server.ts — the MCP facade over the Agent contract.
 *
 * One factory, seven honest tools. Design rules:
 *  - The server advertises `{ tools: {}, logging: {} }`: without the logging
 *    capability `sendLoggingMessage` is a silent no-op and the live feed would
 *    swallow every agent event (the P0 from the v0.1 audit).
 *  - Every tool checks the agent's capabilities BEFORE calling it and refuses
 *    with an `[unsupported_capability]` isError result — never an exception,
 *    never a pretend success.
 *  - `run` never throws on abort or timeout: the run comes back as an isError
 *    result whose text names the still-resumable session, and `_meta` carries
 *    status / sessionId / model / workspace / usage. With
 *    `run_in_background: true` the call returns a task id immediately; the
 *    registry (`tasks`) tracks the run and a `task-completed` logging
 *    notification announces the outcome. `task_list` / `task_output` /
 *    `task_stop` read and steer that registry.
 *  - `notifications/cancelled` is honored at the wire level: the matching
 *    in-flight blocking `run` is aborted through `agent.abort(sessionId)` when
 *    the session is known. The factory takes over the SDK's default handling
 *    of that notification (which only aborted the handler's AbortSignal) —
 *    the Agent contract has no signal input, so the cancel must be routed to
 *    `agent.abort` explicitly.
 *  - Early session identity: every run passes its OWN `onSessionId` closure
 *    (PromptOptions), bound to that run's task / in-flight call — no wildcard
 *    subscription, so parallel runs never attribute ids to each other. The id
 *    lands on the task (`task_list` / `task_output`) as soon as the backend
 *    reports its native id and is announced as a `session-started` logging
 *    notification. A cancel (wire `notifications/cancelled` or `task_stop`)
 *    that arrives before the id is known is remembered and delivered through
 *    `agent.abort(id)` the moment the id appears; until then `task_stop`
 *    answers "cancel pending" and keeps the task `running` — the registry
 *    never claims `canceled` for a run nobody could actually stop. The run's
 *    real outcome (`aborted` → `canceled`) decides the final status.
 *  - `stop()` disposes the registry; the task registry is server-lifetime
 *    memory (v1) and dies with the process.
 */

import {
  type Agent,
  type AgentCapabilities,
  AgentError,
  type AgentResponse,
  type BackendRegistry,
  DEFAULT_HISTORY_PAGE_SIZE,
  type DigestWindow,
  MAX_HISTORY_PAGE_SIZE,
  type PromptOptions,
  renderDigestBlocks,
  renderHistory,
  type UsageTelemetry,
  unsupportedCapability,
  type WorkspaceOption,
} from "@kagero/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  RequestId,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { CancelledNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { StreamCompressorHub } from "./stream-compressor.js";
import { readWatchConfig, summarizeRun, type WatchConfig } from "./watch.js";
import { loadWatchState } from "./watch-state.js";

/** Options for {@link createKageroMcpServer}. */
export interface KageroMcpServerOptions {
  /** Server name reported to MCP clients, e.g. "kagero" or "claude-mcp". */
  readonly name: string;
  readonly version: string;
  /** Tool name prefix. Default "kagero" → tools "kagero_run", … */
  readonly toolPrefix?: string;
  /** Backend registry — owned by the caller, disposed on stop(). */
  readonly registry: BackendRegistry;
  /** Backend used when a tool call does not name one. */
  readonly defaultBackend: string;
  /**
   * Server instructions. Default: auto text that names the tools, the
   * registered backends and the honest-refusal contract.
   */
  readonly instructions?: string;
  /**
   * Watch/compressor configuration; default comes from the environment
   * (KAGERO_COMPRESS_BACKEND / KAGERO_COMPRESS_MODEL). When unset on both
   * paths there is no compressor: no live feed, no run reports, no digest
   * headers — the run tools work exactly the same otherwise.
   */
  readonly watch?: WatchConfig | undefined;
}

/** Extra context the SDK hands to every tool handler. */
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const READ_ONLY: ToolAnnotations = { readOnlyHint: true };

/**
 * Run-option schemas. Descriptions state ACTUAL per-backend support — an
 * accepted field is not proof it takes effect (README: Security & behavior).
 * Keep them in step with each backend's `capabilities.limits` and spec.
 */
function runOptionFields() {
  return {
    model_id: z.string().optional(),
    cwd: z.string().optional(),
    timeout_ms: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Wall-clock checkpoint in ms; the run stops with status timed-out and the session stays resumable. " +
          "Supported by claude, codex, dsh, grok, kimi, mcode, qwen. REJECTED with [unsupported_capability] by " +
          "pi-sdk, pi-rpc and claude-stream. With run_in_background: true the backend must still support it, but " +
          "the value is only a label — it does NOT stop the background run (use task_stop).",
      ),
    max_turns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Turn cap. Supported ONLY by the claude backend (--max-turns); every other backend rejects it with " +
          "[unsupported_capability] — omit it unless backend is claude.",
      ),
    max_tool_calls: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Tool-call cap. No registered backend supports it: it is always rejected with [unsupported_capability]. " +
          "Omit it; bound a run with timeout_ms (where supported) or stop it with task_stop / send_message abort.",
      ),
    approval_mode: z.enum(["default", "yolo"]).optional(),
    additional_dirs: z.array(z.string()).optional(),
    thinking_effort: z
      .string()
      .optional()
      .describe(
        "Reasoning effort. Forwarded by claude (--effort), codex (model_reasoning_effort), and kimi (thinking config). " +
          "Every other backend rejects it with [unsupported_capability]; omit unless using a supported backend. " +
          "The accepted values depend on the backend/model.",
      ),
    native_overrides: z
      .array(z.string())
      .optional()
      .describe(
        "Verbatim per-run native overrides. Takes effect only on codex (-c key=value pairs) and dsh (--patch file " +
          "paths); other backends accept the field and ignore it.",
      ),
  };
}

const RunInput = z
  .object({
    prompt: z.string().min(1),
    session_id: z.string().optional(),
    backend: z.string().optional(),
    agent_name: agentNameSchema(),
    workspace_create: z.boolean().optional(),
    workspace_path: z.string().optional(),
    run_in_background: z.boolean().default(false),
    ...runOptionFields(),
  })
  .strict();
type RunInput = z.infer<typeof RunInput>;

const SendMessageInput = z
  .object({
    session_id: z.string(),
    message: z.string().min(1).optional(),
    kind: z.enum(["steer", "follow_up", "abort"]).default("steer"),
    backend: z.string().optional(),
  })
  .strict();
type SendMessageInput = z.infer<typeof SendMessageInput>;

const TaskListInput = z
  .object({
    active_only: z.boolean().default(true),
    page: z.number().int().min(0).default(0),
    page_size: z.number().int().min(1).max(200).default(20),
  })
  .strict();
type TaskListInput = z.infer<typeof TaskListInput>;

const TaskOutputInput = z
  .object({
    task_id: z.string(),
    wait_ms: z.number().int().min(0).default(0),
    include_blocks: z.boolean().default(false),
  })
  .strict();
type TaskOutputInput = z.infer<typeof TaskOutputInput>;

const TaskStopInput = z
  .object({
    task_id: z.string(),
    reason: z.string().optional(),
  })
  .strict();
type TaskStopInput = z.infer<typeof TaskStopInput>;

const HistoryInput = z
  .object({
    session_id: z.string(),
    page: z.number().int().min(0).optional(),
    page_size: z.number().int().min(1).max(MAX_HISTORY_PAGE_SIZE).optional(),
    max_chars: z.number().int().positive().optional(),
    backend: z.string().optional(),
  })
  .strict();
type HistoryInput = z.infer<typeof HistoryInput>;

const InfoInput = z.object({ backend: z.string().optional() }).strict();
type InfoInput = z.infer<typeof InfoInput>;

/** Optional display name for a background task's session: 1..64, no control chars. */
function agentNameSchema() {
  const hasControlChar = (value: string): boolean => {
    for (const ch of value) {
      const code = ch.codePointAt(0) ?? 0;
      if (code <= 0x1f || code === 0x7f) return true;
    }
    return false;
  };
  return z
    .string()
    .max(64)
    .refine((value) => value.trim() !== "" && !hasControlChar(value), {
      message: "agent_name must be 1-64 characters with no control characters",
    })
    .optional();
}

/** Lifecycle of a background task. */
type TaskStatus = "running" | "succeeded" | "failed" | "canceled";

/** The final outcome stored in a finished task's registry entry. */
interface TaskResult {
  readonly status: TaskStatus;
  readonly text: string;
  /** The compressed session report appended to the run text, when produced. */
  readonly report?: string;
  readonly usage?: UsageTelemetry;
  readonly error?: string;
}

/** One background run in the server-lifetime registry. */
interface TaskEntry {
  readonly taskId: string;
  readonly backend: string;
  status: TaskStatus;
  sessionId?: string;
  agentName?: string;
  modelId?: string;
  /**
   * task_stop was asked while the run had no native session id (or is being
   * routed): delivered through agent.abort the moment the id is reported.
   */
  cancelRequested?: boolean;
  cancelReason?: string;
  /** timeout_ms is a label in background mode — it never aborts the run. */
  readonly timeoutLabelMs?: number;
  readonly startedAt: number;
  finishedAt?: number;
  result?: TaskResult;
}

/** Optional prompt limits the caller asked for, for capability gating. */
interface RequestedLimits {
  timeout_ms?: number | undefined;
  max_turns?: number | undefined;
  max_tool_calls?: number | undefined;
  thinking_effort?: string | undefined;
  workspace_create?: boolean | undefined;
}

/** Structural view of the run-option fields of the `run` tool input. */
interface RunArgsLike {
  cwd?: string | undefined;
  model_id?: string | undefined;
  timeout_ms?: number | undefined;
  max_turns?: number | undefined;
  max_tool_calls?: number | undefined;
  approval_mode?: "default" | "yolo" | undefined;
  additional_dirs?: string[] | undefined;
  thinking_effort?: string | undefined;
  native_overrides?: string[] | undefined;

  workspace_create?: boolean | undefined;
  workspace_path?: string | undefined;
  session_id?: string | undefined;
}

/** Mutable draft of {@link PromptOptions}; readonly at the core boundary. */
interface RunOptionsDraft {
  cwd?: string;
  modelId?: string;
  thinkingEffort?: string;
  timeoutMs?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  approvalMode?: "default" | "yolo";
  additionalDirs?: readonly string[] | undefined;
  nativeOverrides?: readonly string[] | undefined;
  workspace?: WorkspaceOption;
  sessionId?: string;
  onSessionId?: (sessionId: string) => void;
}

/** Mutable draft of {@link HistoryOptions}. */
interface HistoryOptionsDraft {
  page?: number;
  pageSize?: number;
  maxChars?: number;
}

/** One in-flight blocking call, cancellable from the wire. */
interface InflightCall {
  readonly controller: AbortController;
  agent: Agent | undefined;
  sessionId: string | undefined;
  /** A wire-level cancel was seen for this call (it may still await a session id to be routed). */
  cancelRequested: boolean;
  /** The session id the last agent.abort was routed with (dedup of repeated cancels). */
  abortedSessionId: string | undefined;
}

function defaultInstructions(prefix: string, backends: string[], defaultBackend: string): string {
  return [
    `Kagero runs coding-agent backends and exposes them as MCP tools (prefix "${prefix}_").`,
    `Start a run with ${prefix}_run; pass session_id to continue an existing session. Sessions survive timeouts and aborts: the error text names the resumable session id.`,
    `Set run_in_background: true to not block: the reply carries a task_id — poll ${prefix}_task_list / ${prefix}_task_output, stop with ${prefix}_task_stop.`,
    `Inspect state with ${prefix}_info and ${prefix}_history; steer a live run with ${prefix}_send_message (kind "steer", "follow_up" or "abort").`,
    `A client may cancel an in-flight blocking ${prefix}_run with notifications/cancelled; the run is then aborted and reported as aborted, not lost.`,
    `Every tool reports what its backend cannot do as an "[unsupported_capability]" error instead of pretending.`,
    `Registered backends: ${backends.length > 0 ? backends.join(", ") : "(none)"}. Default backend: ${defaultBackend}.`,
  ].join("\n");
}

/**
 * Build the MCP server over a backend registry.
 *
 * The returned `start()` serves stdio; tests and embedders connect their own
 * transport to `server` directly.
 */
export function createKageroMcpServer(opts: KageroMcpServerOptions): {
  server: McpServer;
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  const prefix = opts.toolPrefix ?? "kagero";
  const watchConfig = opts.watch ?? readWatchConfig();
  /** Squeezes the live event stream of the server's own runs (see module). */
  const streamHub =
    watchConfig === undefined
      ? undefined
      : new StreamCompressorHub({
          selectAgent,
          config: watchConfig,
          onLiveLine: (backend, sessionId, line) => {
            void server
              .sendLoggingMessage({
                level: "info",
                logger: opts.name,
                data: { kind: "run-stream", backend, session_id: sessionId, line },
              })
              .catch(() => undefined);
          },
        });
  /** Server-lifetime registry of background runs (v1: in-memory only). */
  const tasks = new Map<string, TaskEntry>();
  let nextTaskNumber = 1;
  const inflight = new Map<RequestId, InflightCall>();

  const instructions =
    opts.instructions ??
    (() => {
      const base = defaultInstructions(prefix, [...opts.registry.names()].sort(), opts.defaultBackend);
      if (watchConfig === undefined) return base;
      return (
        base +
        `\nBackground sessions: run-stream events are compressed by a cheap agent (backend "${watchConfig.backend}") ` +
        `into anchored digests; ${prefix}_history prepends the digest header when one exists and ` +
        `${prefix}_task_output (include_blocks: true) returns the compressed blocks.`
      );
    })();

  const server = new McpServer(
    { name: opts.name, version: opts.version },
    {
      capabilities: { tools: {}, logging: {} },
      instructions,
    },
  );

  // Take over wire-level cancellation (see module docs). Replaces the SDK
  // default, which only aborted the handler's AbortSignal.
  server.server.setNotificationHandler(CancelledNotificationSchema, (notification) => {
    const requestId = notification.params.requestId;
    if (requestId === undefined) return;
    const entry = inflight.get(requestId);
    if (entry !== undefined) deliverCancel(entry);
  });

  function deliverCancel(entry: InflightCall): void {
    entry.controller.abort();
    entry.cancelRequested = true;
    routeCancel(entry, false);
  }

  /**
   * Land a requested cancel on the backend through the run's session id. A
   * cancel that arrived before the id was known stays requested; it is routed
   * from the run's own onSessionId observer (`force`: an earlier abort for the
   * same id may have hit a run that had not started yet).
   */
  function routeCancel(entry: InflightCall, force: boolean): void {
    const { agent, sessionId } = entry;
    if (!entry.cancelRequested || agent === undefined || sessionId === undefined) return;
    if (!force && entry.abortedSessionId === sessionId) return;
    entry.abortedSessionId = sessionId;
    void agent.abort(sessionId).catch(() => undefined);
  }

  function beginCall(requestId: RequestId): InflightCall {
    const entry: InflightCall = {
      controller: new AbortController(),
      agent: undefined,
      sessionId: undefined,
      cancelRequested: false,
      abortedSessionId: undefined,
    };
    inflight.set(requestId, entry);
    return entry;
  }

  function endCall(requestId: RequestId): void {
    inflight.delete(requestId);
  }

  function selectAgent(backend: string | undefined): Promise<Agent> {
    return opts.registry.select(backend ?? opts.defaultBackend);
  }

  function errorResult(text: string): CallToolResult {
    return { content: [{ type: "text", text }], isError: true };
  }

  function okResult(text: string, meta?: Record<string, unknown>): CallToolResult {
    return meta === undefined
      ? { content: [{ type: "text", text }] }
      : { content: [{ type: "text", text }], _meta: meta };
  }

  function toErrorResult(error: unknown): CallToolResult {
    if (error instanceof AgentError) {
      // A failed run is often still resumable — never drop the session id.
      const resumeId =
        error.context !== undefined && typeof error.context["sessionId"] === "string"
          ? (error.context["sessionId"] as string)
          : undefined;
      const resumeHint =
        resumeId === undefined
          ? ""
          : `\n[resumable session: ${resumeId}] — pass it as session_id to ${prefix}_run.`;
      return errorResult(`[${error.code}] ${error.message}${resumeHint}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`[internal_error] ${message}`);
  }

  function responseMeta(response: AgentResponse): Record<string, unknown> {
    const meta: Record<string, unknown> = { status: response.status, durationMs: response.durationMs };
    if (response.sessionId !== undefined) meta.sessionId = response.sessionId;
    if (response.modelId !== undefined) meta.modelId = response.modelId;
    if (response.modelSource !== undefined) meta.modelSource = response.modelSource;
    if (response.workspace !== undefined) meta.workspace = response.workspace;
    if (response.usage !== undefined) meta.usage = response.usage;
    return meta;
  }

  /** Turn an {@link AgentResponse} into a tool result — abort/timeout are isError, never throws. */
  function responseResult(response: AgentResponse): CallToolResult {
    const meta = responseMeta(response);
    if (response.status === "completed") return okResult(response.text, meta);
    const headline = response.status === "timed-out" ? "run timed out" : "run aborted";
    const resumable =
      response.sessionId !== undefined ? `; session stays resumable: ${response.sessionId}` : "";
    const partial = response.text.length > 0 ? `\n${response.text}` : "";
    return {
      content: [{ type: "text", text: `${headline}${resumable}.${partial}`.trimEnd() }],
      isError: true,
      _meta: meta,
    };
  }

  /** Refuse requested limits the backend honestly cannot honor. */
  function checkLimitCapabilities(caps: AgentCapabilities, requested: RequestedLimits): void {
    if (requested.thinking_effort !== undefined && !caps.thinkingEffort) {
      throw unsupportedCapability("thinking_effort", "Omit thinking_effort or pick a backend that forwards it.");
    }
    if (requested.timeout_ms !== undefined && !caps.limits.timeout) {
      throw unsupportedCapability("timeout_ms", "Omit timeout_ms or pick a backend with timeout support.");
    }
    if (requested.max_turns !== undefined && !caps.limits.maxTurns) {
      throw unsupportedCapability("max_turns", "Omit max_turns or pick a backend that can cap turns.");
    }
    if (requested.max_tool_calls !== undefined && !caps.limits.maxToolCalls) {
      throw unsupportedCapability(
        "max_tool_calls",
        "Omit max_tool_calls or pick a backend that can cap tool calls.",
      );
    }
    if (requested.workspace_create === true && !caps.workspaceCreate) {
      throw unsupportedCapability(
        "workspace_create",
        "Omit workspace_create or pick a backend that can create scratch workspaces.",
      );
    }
  }

  function buildRunOptions(
    args: RunArgsLike,
    includeSessionId: boolean,
    includeTimeout = true,
    onSessionId?: (sessionId: string) => void,
  ): PromptOptions {
    const draft: RunOptionsDraft = {};
    if (onSessionId !== undefined) draft.onSessionId = onSessionId;
    if (args.cwd !== undefined) draft.cwd = args.cwd;
    if (args.model_id !== undefined) draft.modelId = args.model_id;
    if (includeTimeout && args.timeout_ms !== undefined) draft.timeoutMs = args.timeout_ms;
    if (args.max_turns !== undefined) draft.maxTurns = args.max_turns;
    if (args.max_tool_calls !== undefined) draft.maxToolCalls = args.max_tool_calls;
    if (args.approval_mode !== undefined) draft.approvalMode = args.approval_mode;
    if (args.additional_dirs !== undefined) draft.additionalDirs = args.additional_dirs;
    if (args.thinking_effort !== undefined) draft.thinkingEffort = args.thinking_effort;
    if (args.native_overrides !== undefined) draft.nativeOverrides = args.native_overrides;

    if (includeSessionId && args.session_id !== undefined) draft.sessionId = args.session_id;
    if (args.workspace_create === true) {
      draft.workspace =
        args.workspace_path !== undefined ? { create: true, parent: args.workspace_path } : { create: true };
    } else if (args.workspace_path !== undefined) {
      draft.workspace = { path: args.workspace_path };
    }
    return draft;
  }

  /**
   * The compressed session report for a finished run, or undefined on any
   * failure. summarizeRun never throws — the run's own answer stays intact.
   */
  function runReport(backend: string, response: AgentResponse): Promise<string | undefined> {
    if (watchConfig === undefined || response.sessionId === undefined) return Promise.resolve(undefined);
    return summarizeRun(
      { selectAgent, defaultBackend: opts.defaultBackend, config: watchConfig },
      backend,
      response,
    );
  }

  /** The run reply, with the session report appended when the compressor produced one. */
  async function responseResultWithReport(backend: string, response: AgentResponse): Promise<CallToolResult> {
    const report = await runReport(backend, response);
    if (report === undefined) return responseResult(response);
    const base = responseResult(response);
    return { ...base, content: [{ type: "text", text: `${response.text}\n\n${report}` }] };
  }

  // --- background task registry ---------------------------------------------

  function elapsedMs(task: TaskEntry): number {
    return Math.max(0, (task.finishedAt ?? Date.now()) - task.startedAt);
  }

  function taskSummary(result: TaskResult): string {
    const full = result.report === undefined ? result.text : `${result.text}\n\n${result.report}`;
    return full.length > 200 ? `${full.slice(0, 200)}…` : full;
  }

  /** Store the outcome and announce it as a logging notification. */
  function finishTask(task: TaskEntry, result: TaskResult): void {
    task.finishedAt = Date.now();
    const finalResult =
      result.status === "canceled" && task.cancelRequested === true
        ? { ...result, error: `canceled${task.cancelReason === undefined ? "" : `: ${task.cancelReason}`}` }
        : result;
    task.result = finalResult;
    // A sent abort is only a request; the backend's actual outcome decides the
    // final status.
    task.status = finalResult.status;
    void server
      .sendLoggingMessage({
        level: "info",
        logger: opts.name,
        data: {
          kind: "task-completed",
          task_id: task.taskId,
          status: task.status,
          session_id: task.sessionId,
          summary: taskSummary(finalResult),
        },
      })
      .catch(() => undefined);
  }

  function runStatusToTaskStatus(status: AgentResponse["status"]): TaskStatus {
    if (status === "completed") return "succeeded";
    if (status === "aborted") return "canceled";
    return "failed";
  }

  /**
   * The run's own early-id observer (PromptOptions.onSessionId): the native id
   * lands on THIS task only, is announced, and a task_stop that was waiting
   * for it is delivered now. The final status stays the run's outcome.
   */
  function onTaskSessionId(
    task: TaskEntry,
    agent: Agent,
    sessionId: string,
    inflight?: InflightCall,
  ): void {
    if (task.finishedAt !== undefined) return;
    task.sessionId = sessionId;
    announceSession(agent.name, sessionId, { task_id: task.taskId });
    if (inflight !== undefined) {
      inflight.sessionId = sessionId;
      if (inflight.cancelRequested) task.cancelRequested = true;
      if (inflight.cancelRequested) routeCancel(inflight, true);
      else if (task.cancelRequested === true) void agent.abort(sessionId).catch(() => undefined);
    } else if (task.cancelRequested === true) {
      void agent.abort(sessionId).catch(() => undefined);
    }
  }

  /** Tell the client a run's native session id is known (exact: carries task/request correlation). */
  function announceSession(backend: string, sessionId: string, correlation: Record<string, unknown>): void {
    void server
      .sendLoggingMessage({
        level: "info",
        logger: opts.name,
        data: { kind: "session-started", backend, session_id: sessionId, ...correlation },
      })
      .catch(() => undefined);
  }

  /** Kick off a background run WITHOUT awaiting it; completion updates the registry. */
  function startBackgroundRun(task: TaskEntry, agent: Agent, args: RunInput, inflight: InflightCall): void {
    const sessionId = args.session_id;
    const viaResume = sessionId !== undefined && agent.capabilities.resume;
    const options = buildRunOptions(args, !viaResume, false, (reported) =>
      onTaskSessionId(task, agent, reported, inflight),
    );
    const pending = viaResume
      ? agent.resume(sessionId, args.prompt, options)
      : agent.prompt(args.prompt, options);
    void pending.then(
      async (response) => {
        if (response.sessionId !== undefined) task.sessionId = response.sessionId;
        if (response.modelId !== undefined) task.modelId = response.modelId;
        const report = await runReport(agent.name, response);
        finishTask(task, {
          status: runStatusToTaskStatus(response.status),
          text: response.text,
          ...(report !== undefined ? { report } : {}),
          ...(response.usage !== undefined ? { usage: response.usage } : {}),
        });
      },
      (error: unknown) => {
        finishTask(task, {
          status: "failed",
          text: "",
          error: error instanceof AgentError ? `[${error.code}] ${error.message}` : String(error),
        });
      },
    );
  }

  /**
   * The compressed-blocks section of a session's watch journal digest, when
   * one exists (the stream compressor checkpointed batches for this session).
   */
  function digestBlocksSection(backend: string, sessionId: string): string | undefined {
    const state = loadWatchState(backend, sessionId);
    if (state?.digest === undefined) return undefined;
    const aggregate: DigestWindow = {
      turns: [],
      text: "",
      entryFrom: 0,
      entryTo: state.streamCursorIndex ?? state.cursorIndex,
      tokens: 0,
      quoteIds: new Set<string>(),
      thinkingTurnIndexes: new Set<number>(),
    };
    return renderDigestBlocks(state.digest, aggregate);
  }

  /** One-line digest header for the history view: status / goal / belief / volume. */
  function digestHistoryHeader(backend: string, sessionId: string): string | undefined {
    const state = loadWatchState(backend, sessionId);
    const output = state?.digest;
    if (output === undefined) return undefined;
    const upto = state?.streamCursorIndex ?? state?.cursorIndex ?? 0;
    return (
      `[watch digest] status: ${output.report?.status ?? "working"} · goal: ${output.digest.goal} · ` +
      `belief: ${output.digest.currentBelief} · ${output.blocks.length} compressed blocks (through entry #${upto})`
    );
  }

  // --- tool handlers ----------------------------------------------------------

  async function handleRun(args: RunInput, extra: ToolExtra): Promise<CallToolResult> {
    const entry = beginCall(extra.requestId);
    try {
      const agent = await selectAgent(args.backend);
      entry.agent = agent;
      entry.sessionId = args.session_id;
      streamHub?.attach(agent);
      checkLimitCapabilities(agent.capabilities, args);
      // A cancel that raced ahead of backend selection — land it when the
      // session is already known (resume); a fresh run's id comes later, via
      // the onSessionId observer below.
      routeCancel(entry, false);

      if (args.run_in_background) {
        const taskId = `task-${nextTaskNumber}`;
        nextTaskNumber += 1;
        const task: TaskEntry = {
          taskId,
          backend: agent.name,
          status: "running",
          startedAt: Date.now(),
          ...(args.session_id !== undefined ? { sessionId: args.session_id } : {}),
          ...(entry.cancelRequested ? { cancelRequested: true } : {}),
          ...(args.agent_name !== undefined ? { agentName: args.agent_name } : {}),
          ...(args.model_id !== undefined ? { modelId: args.model_id } : {}),
          ...(args.timeout_ms !== undefined ? { timeoutLabelMs: args.timeout_ms } : {}),
        };
        tasks.set(taskId, task);
        startBackgroundRun(task, agent, args, entry);
        return okResult(JSON.stringify({ task_id: taskId, status: "running" }), {
          taskId,
          status: "running",
        });
      }

      const continuing = args.session_id !== undefined;
      const observe = (reported: string): void => {
        entry.sessionId = reported;
        announceSession(agent.name, reported, { request_id: extra.requestId });
        // An earlier cancel may have targeted the resume id before the
        // backend had registered this run; retry once the callback proves it
        // is now an active run.
        routeCancel(entry, true);
      };
      const response =
        continuing && agent.capabilities.resume
          ? await agent.resume(
              args.session_id as string,
              args.prompt,
              buildRunOptions(args, false, true, observe),
            )
          : await agent.prompt(args.prompt, buildRunOptions(args, true, true, observe));
      return await responseResultWithReport(agent.name, response);
    } catch (error) {
      return toErrorResult(error);
    } finally {
      endCall(extra.requestId);
    }
  }

  async function handleSendMessage(args: SendMessageInput): Promise<CallToolResult> {
    const agent = await selectAgent(args.backend);
    if (args.kind === "abort") {
      if (!agent.capabilities.abort) {
        throw unsupportedCapability("abort", "Pick a backend whose runs can be stopped.");
      }
      await agent.abort(args.session_id);
      return okResult(`abort signal sent to ${args.session_id}.`);
    }
    if (args.message === undefined) {
      return errorResult(`[invalid_arguments] message is required when kind is "${args.kind}".`);
    }
    if (args.kind === "steer" && !agent.capabilities.steer) {
      throw unsupportedCapability(
        "steer",
        'Pick a backend that accepts mid-run redirects, or use send_message kind "abort".',
      );
    }
    if (args.kind === "follow_up" && !agent.capabilities.followUp) {
      throw unsupportedCapability(
        "follow_up",
        `Pick a backend that queues post-turn messages, or run again with session_id via ${prefix}_run.`,
      );
    }
    await agent.send(args.session_id, args.message, args.kind);
    return okResult(`${args.kind} delivered to ${args.session_id}.`);
  }

  function handleTaskList(args: TaskListInput): CallToolResult {
    const all = [...tasks.values()].reverse(); // newest first
    const filtered = args.active_only ? all.filter((task) => task.status === "running") : all;
    const start = args.page * args.page_size;
    const page = filtered.slice(start, start + args.page_size).map((task) => ({
      task_id: task.taskId,
      ...(task.sessionId !== undefined ? { session_id: task.sessionId } : {}),
      status: task.status,
      ...(task.agentName !== undefined ? { agent_name: task.agentName } : {}),
      ...(task.modelId !== undefined ? { model_id: task.modelId } : {}),
      ...(task.status === "running" && task.cancelRequested === true ? { cancel_pending: true } : {}),
      elapsed_ms: elapsedMs(task),
    }));
    return okResult(
      JSON.stringify(
        { tasks: page, total: filtered.length, page: args.page, page_size: args.page_size },
        null,
        2,
      ),
    );
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  async function handleTaskOutput(args: TaskOutputInput, extra: ToolExtra): Promise<CallToolResult> {
    const task = tasks.get(args.task_id);
    if (task === undefined) {
      return errorResult(`[unknown_task] No such task: ${args.task_id}`);
    }
    const call = beginCall(extra.requestId);
    try {
      const deadline = Date.now() + args.wait_ms;
      while (task.status === "running" && Date.now() < deadline && !call.cancelRequested) {
        await sleep(25);
      }
    } finally {
      endCall(extra.requestId);
    }

    const meta: Record<string, unknown> = { taskId: task.taskId, status: task.status };
    if (task.sessionId !== undefined) meta.sessionId = task.sessionId;
    if (task.modelId !== undefined) meta.modelId = task.modelId;
    if (task.status === "running" && task.cancelRequested === true) meta.cancelPending = true;
    if (task.result?.usage !== undefined) meta.usage = task.result.usage;

    if (task.status === "running") {
      const where = task.sessionId !== undefined ? `, session ${task.sessionId}` : "";
      const pending = task.cancelRequested === true ? "; cancellation requested, awaiting run outcome" : "";
      return okResult(
        `${task.taskId} is still running (${Math.round(elapsedMs(task) / 100) / 10}s${where})${pending}.`,
        meta,
      );
    }

    const result = task.result;
    const lines: string[] = [
      `${task.taskId} finished: ${task.status}` +
        (task.sessionId !== undefined ? ` (session ${task.sessionId})` : ""),
    ];
    if (result?.error !== undefined) lines.push(`error: ${result.error}`);
    if (result !== undefined && result.text !== "") lines.push(result.text);
    if (result?.report !== undefined) lines.push(result.report);
    if (args.include_blocks && task.sessionId !== undefined) {
      const blocks = digestBlocksSection(task.backend, task.sessionId);
      if (blocks !== undefined) lines.unshift(`[watch digest blocks]\n${blocks}`);
    }
    return okResult(lines.join("\n"), meta);
  }

  async function handleTaskStop(args: TaskStopInput): Promise<CallToolResult> {
    const task = tasks.get(args.task_id);
    if (task === undefined) {
      return errorResult(`[unknown_task] No such task: ${args.task_id}`);
    }
    if (task.status !== "running") {
      return errorResult(`[task_not_running] ${task.taskId} already finished: ${task.status}.`);
    }
    const agent = await selectAgent(task.backend);
    if (!agent.capabilities.abort) {
      throw unsupportedCapability("abort", "Pick a backend whose runs can be stopped.");
    }
    // The run may have settled while the backend was being selected.
    if (task.status !== "running") {
      return errorResult(`[task_not_running] ${task.taskId} already finished: ${task.status}.`);
    }
    task.cancelRequested = true;
    if (args.reason !== undefined) task.cancelReason = args.reason;
    const sessionId = task.sessionId;
    if (sessionId === undefined) {
      // No native session id yet: nothing can be aborted. Never mark the task
      // canceled while the backend keeps running — the onSessionId observer
      // delivers the abort the moment the id is reported, and the run's own
      // outcome decides the final status.
      return okResult(
        `cancel requested for ${task.taskId}, NOT yet delivered: the backend has not reported a native session id, ` +
          `so there is nothing to abort. The abort is sent the moment the id appears; the task stays running until ` +
          `the run settles (a backend that only learns its session id at completion cannot be interrupted early).`,
        { taskId: task.taskId, status: "running", cancelPending: true },
      );
    }
    try {
      await agent.abort(sessionId);
    } catch (error) {
      delete task.cancelRequested;
      throw error;
    }
    if (task.status !== "running") {
      return okResult(`${task.taskId} finished while the abort was being delivered: ${task.status}.`, {
        taskId: task.taskId,
        status: task.status,
      });
    }
    return okResult(
      `abort sent to ${task.taskId} (session ${sessionId}); the task stays running until the backend reports its outcome.`,
      { taskId: task.taskId, status: "running", cancelPending: true },
    );
  }

  async function handleHistory(args: HistoryInput): Promise<CallToolResult> {
    const agent = await selectAgent(args.backend);
    if (!agent.capabilities.history) {
      throw unsupportedCapability(
        "history",
        `Pick a backend that records conversation history (see ${prefix}_info).`,
      );
    }
    const options: HistoryOptionsDraft = {};
    if (args.page !== undefined) options.page = args.page;
    if (args.page_size !== undefined) options.pageSize = args.page_size;
    if (args.max_chars !== undefined) options.maxChars = args.max_chars;
    const result = await agent.history(args.session_id, options);
    const rendered = renderHistory(result);
    const header = digestHistoryHeader(agent.name, args.session_id);
    return okResult(header === undefined ? rendered : `${header}\n${rendered}`);
  }

  async function handleInfo(args: InfoInput): Promise<CallToolResult> {
    const names = [...opts.registry.names()].sort();
    const backend = args.backend ?? opts.defaultBackend;
    let modelsText: string;
    try {
      const agent = await selectAgent(backend);
      const models = agent.capabilities.models ? await agent.listModels() : [];
      modelsText = models.length === 0 ? "not reported" : models.map((model) => model.id).join(", ");
    } catch {
      modelsText = "not reported";
    }
    return okResult(
      [
        `backends: ${names.length > 0 ? names.join(", ") : "(none registered)"}`,
        `default: ${opts.defaultBackend}`,
        `models (${backend}): ${modelsText}`,
      ].join("; "),
    );
  }

  server.registerTool(
    `${prefix}_run`,
    {
      title: "Kagero run",
      description:
        `Run a prompt through a kagero backend. Without session_id: fresh run; with session_id: continue that session. ` +
        `Returns the assistant text; _meta carries sessionId/status/model/workspace/usage. Timeouts and aborts come back ` +
        `as isError results naming the resumable session — the tool never throws. With run_in_background: true the call ` +
        `returns {task_id, status: "running"} immediately; poll ${prefix}_task_list / ${prefix}_task_output, stop with ` +
        `${prefix}_task_stop; a "task-completed" logging notification announces the outcome. A background task's ` +
        `session id appears in task_list / task_output (and a "session-started" logging notification) as soon as the ` +
        `backend reports its native id — ACP backends right after the session opens; print backends that only learn ` +
        `the id from the CLI output expose it when the run ends. Limits are capability-gated per backend: see the ` +
        `timeout_ms / max_turns / max_tool_calls descriptions (max_tool_calls is supported by no backend, max_turns ` +
        `only by claude); unsupported values are rejected with [unsupported_capability], never silently dropped.`,
      inputSchema: RunInput,
    },
    (args, extra) => handleRun(args, extra),
  );

  server.registerTool(
    `${prefix}_send_message`,
    {
      title: "Kagero send message",
      description:
        'Deliver a message into a live session: kind "steer" interrupts the current turn with a new instruction, ' +
        '"follow_up" queues it for after the turn settles, "abort" stops the in-flight run (the session stays resumable).',
      inputSchema: SendMessageInput,
    },
    (args) => handleSendMessage(args).catch(toErrorResult),
  );

  server.registerTool(
    `${prefix}_task_list`,
    {
      title: "Kagero task list",
      description:
        "List background runs (run_in_background) tracked by this server: task id, session, status, agent, model, " +
        "elapsed time. active_only (default) hides finished tasks.",
      inputSchema: TaskListInput,
      annotations: READ_ONLY,
    },
    (args) => handleTaskList(args),
  );

  server.registerTool(
    `${prefix}_task_output`,
    {
      title: "Kagero task output",
      description:
        "Fetch the result of a background task. wait_ms waits up to that long for completion before returning the " +
        "current status; include_blocks prepends the session's compressed watch-digest blocks when the compressor has " +
        "checkpointed any.",
      inputSchema: TaskOutputInput,
      annotations: READ_ONLY,
    },
    (args, extra) => handleTaskOutput(args, extra).catch(toErrorResult),
  );

  server.registerTool(
    `${prefix}_task_stop`,
    {
      title: "Kagero task stop",
      description:
        "Request an abort for a running background task (the session stays resumable). The task stays running until " +
        "the backend reports its outcome; only an actual aborted outcome marks it canceled. If the backend has not " +
        "reported a native session id yet the abort cannot be sent: the reply says " +
        '"NOT yet delivered" (_meta.cancelPending), and the abort is delivered the moment the ' +
        "id appears. Backends that only learn their session id when " +
        "the run ends (print transports without an upfront id, pi-rpc, pi-sdk, claude-stream before its first frame) " +
        "cannot be interrupted before then.",
      inputSchema: TaskStopInput,
    },
    (args) => handleTaskStop(args).catch(toErrorResult),
  );

  server.registerTool(
    `${prefix}_history`,
    {
      title: "Kagero history",
      description:
        "Compact, normalized history of a session (one line per entry, full-log pointer at the end). " +
        "Pages are counted from the newest end: page 0 (default) returns the most recent page_size " +
        `(default ${DEFAULT_HISTORY_PAGE_SIZE}, max ${MAX_HISTORY_PAGE_SIZE}) entries; the footer names ` +
        "the next older page when one exists. When a compressed watch digest exists for the session, its " +
        "header (status / goal / belief / block count) is prepended on every page.",
      inputSchema: HistoryInput,
      annotations: READ_ONLY,
    },
    (args) => handleHistory(args).catch(toErrorResult),
  );

  server.registerTool(
    `${prefix}_info`,
    {
      title: "Kagero info",
      description: "Registered backends, the default one, and the models of the active backend.",
      inputSchema: InfoInput,
      annotations: READ_ONLY,
    },
    (args) => handleInfo(args).catch(toErrorResult),
  );

  return {
    server,
    async start(): Promise<void> {
      await server.connect(new StdioServerTransport());
    },
    async stop(): Promise<void> {
      // Let in-flight background batch compressions checkpoint (bounded):
      // an MCP timeout/retry must not kill a half-done compression.
      await streamHub?.settleAll(180_000).catch(() => undefined);
      await opts.registry.disposeAll();
      await server.close();
    },
  };
}
