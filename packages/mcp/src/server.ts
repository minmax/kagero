/**
 * server.ts — the MCP facade over the Agent contract.
 *
 * One factory, ten honest tools. Design rules (docs/LIB-PLAN.md §4):
 *  - The server advertises `{ tools: {}, logging: {} }`: without the logging
 *    capability `sendLoggingMessage` is a silent no-op and subscribe would
 *    swallow every agent event (the P0 from the v0.1 audit).
 *  - Every tool checks the agent's capabilities BEFORE calling it and refuses
 *    with an `[unsupported_capability]` isError result — never an exception,
 *    never a pretend success.
 *  - `prompt`/`resume` never throw on abort or timeout: the run comes back as
 *    an isError result whose text names the still-resumable session, and
 *    `_meta` carries status / sessionId / model / workspace / usage.
 *  - `notifications/cancelled` is honored at the wire level: the matching
 *    in-flight prompt/resume is aborted through `agent.abort(sessionId)` when
 *    the session is known. The factory takes over the SDK's default handling
 *    of that notification (which only aborted the handler's AbortSignal) —
 *    the Agent contract has no signal input, so the cancel must be routed to
 *    `agent.abort` explicitly.
 *  - `stop()` detaches every live subscription and disposes the registry.
 */

import { randomUUID } from "node:crypto";
import {
  type Agent,
  type AgentCapabilities,
  AgentError,
  type AgentEvent,
  type AgentResponse,
  type BackendRegistry,
  type PromptOptions,
  renderHistory,
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

/** Options for {@link createKageroMcpServer}. */
export interface KageroMcpServerOptions {
  /** Server name reported to MCP clients, e.g. "kagero" or "claude-mcp". */
  readonly name: string;
  readonly version: string;
  /** Tool name prefix. Default "kagero" → tools "kagero_prompt", … */
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
}

/** Extra context the SDK hands to every tool handler. */
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const READ_ONLY: ToolAnnotations = { readOnlyHint: true };

function runOptionFields() {
  return {
    model_id: z.string().optional(),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().positive().optional(),
    max_turns: z.number().int().positive().optional(),
    max_tool_calls: z.number().int().positive().optional(),
    approval_mode: z.enum(["default", "yolo"]).optional(),
  };
}

const PromptInput = z
  .object({
    prompt: z.string().min(1),
    backend: z.string().optional(),
    session_id: z.string().optional(),
    workspace_create: z.boolean().optional(),
    workspace_path: z.string().optional(),
    ...runOptionFields(),
  })
  .strict();
type PromptInput = z.infer<typeof PromptInput>;

const ResumeInput = z
  .object({
    session_id: z.string(),
    prompt: z.string().min(1),
    backend: z.string().optional(),
    ...runOptionFields(),
  })
  .strict();
type ResumeInput = z.infer<typeof ResumeInput>;

const ModelsInput = z.object({ backend: z.string().optional() }).strict();
type ModelsInput = z.infer<typeof ModelsInput>;

const SessionsInput = z.object({ backend: z.string().optional() }).strict();
type SessionsInput = z.infer<typeof SessionsInput>;

const HistoryInput = z
  .object({
    session_id: z.string(),
    last: z.number().int().positive().optional(),
    max_chars: z.number().int().positive().optional(),
    backend: z.string().optional(),
  })
  .strict();
type HistoryInput = z.infer<typeof HistoryInput>;

const SendInput = z
  .object({
    session_id: z.string(),
    message: z.string().min(1),
    kind: z.enum(["steer", "follow_up"]),
    backend: z.string().optional(),
  })
  .strict();
type SendInput = z.infer<typeof SendInput>;

const SubscribeInput = z.object({ session_id: z.string(), backend: z.string().optional() }).strict();
type SubscribeInput = z.infer<typeof SubscribeInput>;

const UnsubscribeInput = z.object({ subscription_id: z.string() }).strict();
type UnsubscribeInput = z.infer<typeof UnsubscribeInput>;

const AbortInput = z.object({ session_id: z.string(), backend: z.string().optional() }).strict();
type AbortInput = z.infer<typeof AbortInput>;

const BackendsInput = z.object({}).strict();

/** Optional prompt/resume limits the caller asked for, for capability gating. */
interface RequestedLimits {
  timeout_ms?: number | undefined;
  max_turns?: number | undefined;
  max_tool_calls?: number | undefined;
  workspace_create?: boolean | undefined;
}

/** Structural view of the run-option fields shared by prompt and resume inputs. */
interface RunArgsLike {
  cwd?: string | undefined;
  model_id?: string | undefined;
  timeout_ms?: number | undefined;
  max_turns?: number | undefined;
  max_tool_calls?: number | undefined;
  approval_mode?: "default" | "yolo" | undefined;
  workspace_create?: boolean | undefined;
  workspace_path?: string | undefined;
  session_id?: string | undefined;
}

/** Mutable draft of {@link PromptOptions}; readonly at the core boundary. */
interface RunOptionsDraft {
  cwd?: string;
  modelId?: string;
  timeoutMs?: number;
  maxTurns?: number;
  maxToolCalls?: number;
  approvalMode?: "default" | "yolo";
  workspace?: WorkspaceOption;
  sessionId?: string;
}

/** Mutable draft of {@link HistoryOptions}. */
interface HistoryOptionsDraft {
  last?: number;
  maxChars?: number;
}

/** A live subscribe → logging bridge, releasable by unsubscribe or stop(). */
interface LiveSubscription {
  readonly unsubscribe: () => void;
  readonly backend: string;
  readonly sessionId: string;
}

/** One in-flight prompt/resume, cancellable from the wire. */
interface InflightCall {
  readonly controller: AbortController;
  agent: Agent | undefined;
  sessionId: string | undefined;
  cancelDelivered: boolean;
}

function defaultInstructions(prefix: string, backends: string[], defaultBackend: string): string {
  return [
    `Kagero runs coding-agent backends and exposes them as MCP tools (prefix "${prefix}_").`,
    `Start a run with ${prefix}_prompt; continue with ${prefix}_resume. Sessions survive timeouts and aborts: the error text names the resumable session id.`,
    `Inspect state with ${prefix}_models, ${prefix}_sessions, ${prefix}_history; steer live runs with ${prefix}_send; stop a run with ${prefix}_abort.`,
    `Live events: ${prefix}_subscribe forwards agent events as logging messages (level info); detach with ${prefix}_unsubscribe.`,
    `A client may cancel an in-flight ${prefix}_prompt/${prefix}_resume with notifications/cancelled; the run is then aborted and reported as aborted, not lost.`,
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
  const subscriptions = new Map<string, LiveSubscription>();
  const inflight = new Map<RequestId, InflightCall>();

  const instructions =
    opts.instructions ?? defaultInstructions(prefix, [...opts.registry.names()].sort(), opts.defaultBackend);

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
    if (entry.cancelDelivered) return;
    entry.cancelDelivered = true;
    const { agent, sessionId } = entry;
    if (agent !== undefined && sessionId !== undefined) {
      void agent.abort(sessionId).catch(() => undefined);
    }
  }

  function beginCall(requestId: RequestId): InflightCall {
    const entry: InflightCall = {
      controller: new AbortController(),
      agent: undefined,
      sessionId: undefined,
      cancelDelivered: false,
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
    if (error instanceof AgentError) return errorResult(`[${error.code}] ${error.message}`);
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

  function buildRunOptions(args: RunArgsLike, includeSessionId: boolean): PromptOptions {
    const draft: RunOptionsDraft = {};
    if (args.cwd !== undefined) draft.cwd = args.cwd;
    if (args.model_id !== undefined) draft.modelId = args.model_id;
    if (args.timeout_ms !== undefined) draft.timeoutMs = args.timeout_ms;
    if (args.max_turns !== undefined) draft.maxTurns = args.max_turns;
    if (args.max_tool_calls !== undefined) draft.maxToolCalls = args.max_tool_calls;
    if (args.approval_mode !== undefined) draft.approvalMode = args.approval_mode;
    if (includeSessionId && args.session_id !== undefined) draft.sessionId = args.session_id;
    if (args.workspace_create === true) {
      draft.workspace =
        args.workspace_path !== undefined ? { create: true, parent: args.workspace_path } : { create: true };
    } else if (args.workspace_path !== undefined) {
      draft.workspace = { path: args.workspace_path };
    }
    return draft;
  }

  async function handlePrompt(args: PromptInput, extra: ToolExtra): Promise<CallToolResult> {
    const entry = beginCall(extra.requestId);
    try {
      const agent = await selectAgent(args.backend);
      entry.agent = agent;
      entry.sessionId = args.session_id;
      checkLimitCapabilities(agent.capabilities, args);
      if (entry.cancelDelivered && args.session_id !== undefined) {
        // The cancel raced ahead of backend selection — still land it.
        void agent.abort(args.session_id).catch(() => undefined);
      }
      const response = await agent.prompt(args.prompt, buildRunOptions(args, true));
      return responseResult(response);
    } catch (error) {
      return toErrorResult(error);
    } finally {
      endCall(extra.requestId);
    }
  }

  async function handleResume(args: ResumeInput, extra: ToolExtra): Promise<CallToolResult> {
    const entry = beginCall(extra.requestId);
    try {
      const agent = await selectAgent(args.backend);
      entry.agent = agent;
      entry.sessionId = args.session_id;
      if (!agent.capabilities.resume) {
        throw unsupportedCapability(
          "resume",
          "Pick a backend with persistent sessions; one-shot prompt still works.",
        );
      }
      checkLimitCapabilities(agent.capabilities, args);
      if (entry.cancelDelivered) {
        void agent.abort(args.session_id).catch(() => undefined);
      }
      const response = await agent.resume(args.session_id, args.prompt, buildRunOptions(args, false));
      return responseResult(response);
    } catch (error) {
      return toErrorResult(error);
    } finally {
      endCall(extra.requestId);
    }
  }

  async function handleModels(args: ModelsInput): Promise<CallToolResult> {
    const agent = await selectAgent(args.backend);
    if (!agent.capabilities.models) {
      throw unsupportedCapability("models", "Pick a backend that can enumerate its models.");
    }
    const models = await agent.listModels();
    return okResult(models.length === 0 ? "Backend reports no models." : JSON.stringify(models, null, 2));
  }

  async function handleSessions(args: SessionsInput): Promise<CallToolResult> {
    const agent = await selectAgent(args.backend);
    if (!agent.capabilities.sessions) {
      throw unsupportedCapability("sessions", "Pick a backend that tracks persistent sessions.");
    }
    const sessions = await agent.listSessions();
    return okResult(
      sessions.length === 0 ? "Backend reports no sessions." : JSON.stringify(sessions, null, 2),
    );
  }

  async function handleHistory(args: HistoryInput): Promise<CallToolResult> {
    const agent = await selectAgent(args.backend);
    if (!agent.capabilities.history) {
      throw unsupportedCapability(
        "history",
        "Pick a backend that records conversation history (see kagero_backends).",
      );
    }
    const options: HistoryOptionsDraft = {};
    if (args.last !== undefined) options.last = args.last;
    if (args.max_chars !== undefined) options.maxChars = args.max_chars;
    const result = await agent.history(args.session_id, options);
    return okResult(renderHistory(result));
  }

  async function handleSend(args: SendInput): Promise<CallToolResult> {
    const agent = await selectAgent(args.backend);
    if (args.kind === "steer" && !agent.capabilities.steer) {
      throw unsupportedCapability(
        "steer",
        "Pick a backend that accepts mid-run redirects, or use kagero_abort.",
      );
    }
    if (args.kind === "follow_up" && !agent.capabilities.followUp) {
      throw unsupportedCapability(
        "follow_up",
        "Pick a backend that queues post-turn messages, or use kagero_prompt.",
      );
    }
    await agent.send(args.session_id, args.message, args.kind);
    return okResult(`${args.kind} delivered to ${args.session_id}.`);
  }

  async function handleSubscribe(args: SubscribeInput): Promise<CallToolResult> {
    const agent = await selectAgent(args.backend);
    if (!agent.capabilities.subscribe) {
      throw unsupportedCapability("subscribe", "Pick a backend that emits live events.");
    }
    const backend = args.backend ?? opts.defaultBackend;
    const sessionId = args.session_id;
    const subId = randomUUID();
    const unsubscribe = agent.subscribe(sessionId, (event: AgentEvent) => {
      void server
        .sendLoggingMessage({
          level: "info",
          logger: opts.name,
          data: { subscription_id: subId, backend, session_id: sessionId, event },
        })
        .catch(() => undefined);
    });
    subscriptions.set(subId, { unsubscribe, backend, sessionId });
    return okResult(
      [
        `subscribed to ${sessionId} on backend "${backend}"`,
        `subscription_id: ${subId}`,
        `events arrive as logging messages (logger "${opts.name}"); detach with ${prefix}_unsubscribe.`,
      ].join("\n"),
    );
  }

  async function handleUnsubscribe(args: UnsubscribeInput): Promise<CallToolResult> {
    const sub = subscriptions.get(args.subscription_id);
    if (sub === undefined) {
      return errorResult(`[unknown_subscription] No live subscription: ${args.subscription_id}`);
    }
    subscriptions.delete(args.subscription_id);
    sub.unsubscribe();
    return okResult(`unsubscribed ${args.subscription_id}.`);
  }

  async function handleAbort(args: AbortInput): Promise<CallToolResult> {
    const agent = await selectAgent(args.backend);
    if (!agent.capabilities.abort) {
      throw unsupportedCapability("abort", "Pick a backend whose runs can be stopped.");
    }
    await agent.abort(args.session_id);
    return okResult(`abort signal sent to ${args.session_id}.`);
  }

  function handleBackends(): CallToolResult {
    const names = [...opts.registry.names()].sort();
    return okResult(
      [
        `backends: ${names.length > 0 ? names.join(", ") : "(none registered)"}`,
        `default: ${opts.defaultBackend}`,
        `tools: ${prefix}_prompt, ${prefix}_resume, ${prefix}_models, ${prefix}_sessions, ${prefix}_history, ${prefix}_send, ${prefix}_subscribe, ${prefix}_unsubscribe, ${prefix}_abort, ${prefix}_backends`,
      ].join("\n"),
    );
  }

  server.registerTool(
    `${prefix}_prompt`,
    {
      title: "Kagero prompt",
      description:
        "Run a one-shot prompt through a kagero backend. Returns the assistant text; _meta carries sessionId/status/model/workspace/usage. Timeouts and aborts come back as isError results naming the resumable session — the tool never throws.",
      inputSchema: PromptInput,
    },
    (args, extra) => handlePrompt(args, extra),
  );

  server.registerTool(
    `${prefix}_resume`,
    {
      title: "Kagero resume",
      description:
        "Continue a persistent session with a new prompt. Same result shape as kagero_prompt; refuses honestly when the backend has no resume support.",
      inputSchema: ResumeInput,
    },
    (args, extra) => handleResume(args, extra),
  );

  server.registerTool(
    `${prefix}_models`,
    {
      title: "Kagero models",
      description: "List the models the backend reports.",
      inputSchema: ModelsInput,
      annotations: READ_ONLY,
    },
    (args) => handleModels(args).catch(toErrorResult),
  );

  server.registerTool(
    `${prefix}_sessions`,
    {
      title: "Kagero sessions",
      description: "List the persistent sessions the backend knows about.",
      inputSchema: SessionsInput,
      annotations: READ_ONLY,
    },
    (args) => handleSessions(args).catch(toErrorResult),
  );

  server.registerTool(
    `${prefix}_history`,
    {
      title: "Kagero history",
      description:
        "Compact, normalized history of a session (one line per entry, full-log pointer at the end).",
      inputSchema: HistoryInput,
      annotations: READ_ONLY,
    },
    (args) => handleHistory(args).catch(toErrorResult),
  );

  server.registerTool(
    `${prefix}_send`,
    {
      title: "Kagero send",
      description:
        'Deliver a mid-run message: kind "steer" interrupts the current turn with a new instruction, "follow_up" queues it for after the turn settles.',
      inputSchema: SendInput,
    },
    (args) => handleSend(args).catch(toErrorResult),
  );

  server.registerTool(
    `${prefix}_subscribe`,
    {
      title: "Kagero subscribe",
      description:
        "Subscribe to a session's live events; they arrive as logging messages (level info) tagged with the subscription_id. Detach with kagero_unsubscribe.",
      inputSchema: SubscribeInput,
    },
    (args) => handleSubscribe(args).catch(toErrorResult),
  );

  server.registerTool(
    `${prefix}_unsubscribe`,
    {
      title: "Kagero unsubscribe",
      description: "Detach a subscription created by kagero_subscribe.",
      inputSchema: UnsubscribeInput,
    },
    (args) => handleUnsubscribe(args).catch(toErrorResult),
  );

  server.registerTool(
    `${prefix}_abort`,
    {
      title: "Kagero abort",
      description:
        "Abort an in-flight run. Idempotent; the aborted session stays resumable via kagero_resume.",
      inputSchema: AbortInput,
    },
    (args) => handleAbort(args).catch(toErrorResult),
  );

  server.registerTool(
    `${prefix}_backends`,
    {
      title: "Kagero backends",
      description: "List registered backends, the default one, and the tool surface.",
      inputSchema: BackendsInput,
      annotations: READ_ONLY,
    },
    () => handleBackends(),
  );

  return {
    server,
    async start(): Promise<void> {
      await server.connect(new StdioServerTransport());
    },
    async stop(): Promise<void> {
      for (const sub of subscriptions.values()) {
        try {
          sub.unsubscribe();
        } catch {
          // The backend may already be gone; stop must still finish.
        }
      }
      subscriptions.clear();
      await opts.registry.disposeAll();
      await server.close();
    },
  };
}
