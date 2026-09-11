/**
 * MCP server — exposes the kagero Agent interface as MCP tools.
 *
 * The MCP server is a thin adapter: each tool maps to a single Agent method.
 * No business logic lives here. To add a new tool, add a method to Agent
 * and wire it here.
 *
 * Tools exposed:
 *   - kagero_prompt      — one-shot prompt
 *   - kagero_resume      — resume session
 *   - kagero_models      — list models
 *   - kagero_sessions    — list sessions
 *   - kagero_subscribe   — subscribe to events (returns subscriber id)
 *   - kagero_abort       — abort a session
 *   - kagero_backends    — list available backends
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Agent } from "../agent.js";
import { availableBackends, type BackendName, select } from "../registry.js";

const TOOLS = [
  {
    name: "kagero_prompt",
    description:
      "Send a one-shot prompt to the active agent backend (pi-sdk, pi-rpc, dsh, qwen, grok, kimi, mcode). " +
      "Returns the assistant's final text.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The prompt to send" },
        backend: { type: "string", description: "Override the default backend" },
        model_id: { type: "string", description: "Override the model id" },
        cwd: { type: "string", description: "Override the working directory" },
        timeout_ms: { type: "integer", description: "Override the per-call timeout" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "kagero_resume",
    description: "Continue a persistent session by id with a new prompt.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        prompt: { type: "string" },
        backend: { type: "string" },
        model_id: { type: "string" },
        cwd: { type: "string" },
      },
      required: ["session_id", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "kagero_models",
    description: "List models the active backend can use.",
    inputSchema: {
      type: "object",
      properties: { backend: { type: "string", description: "Override the default backend" } },
      additionalProperties: false,
    },
  },
  {
    name: "kagero_sessions",
    description: "List persistent sessions on the active backend.",
    inputSchema: {
      type: "object",
      properties: { backend: { type: "string", description: "Override the default backend" } },
      additionalProperties: false,
    },
  },
  {
    name: "kagero_subscribe",
    description:
      "Subscribe to live events for a session. Returns a subscription id; " +
      "subsequent events are emitted as MCP notifications.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "kagero_abort",
    description: "Abort an in-flight session.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "kagero_backends",
    description: "List available backends and which is currently active.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
] as const;

export interface McpServerOptions {
  /** Default backend to use. */
  defaultBackend: BackendName | string;
}

export class KageroMcpServer {
  private server: Server;
  private agent: Agent | null = null;
  private defaultBackend: BackendName | string;
  private readonly eventSubscribers = new Map<string, Set<(e: unknown) => void>>();

  constructor(opts: McpServerOptions) {
    this.defaultBackend = opts.defaultBackend;
    this.server = new Server({ name: "kagero-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const a = (args ?? {}) as Record<string, unknown>;
      try {
        switch (name) {
          case "kagero_prompt":
            return await this.toolPrompt(a);
          case "kagero_resume":
            return await this.toolResume(a);
          case "kagero_models":
            return await this.toolModels(a);
          case "kagero_sessions":
            return await this.toolSessions(a);
          case "kagero_subscribe":
            return await this.toolSubscribe(a);
          case "kagero_abort":
            return await this.toolAbort(a);
          case "kagero_backends":
            return await this.toolBackends();
          default:
            return errResult(`Unknown tool: ${name}`);
        }
      } catch (err) {
        return errResult((err as Error).message, (err as { code?: string }).code);
      }
    });
  }

  private async getAgent(override?: string): Promise<Agent> {
    const name = override ?? this.defaultBackend;
    if (this.agent && this.agent.name === name) return this.agent;
    if (this.agent) await this.agent.dispose();
    this.agent = await select(name);
    return this.agent;
  }

  private async toolPrompt(args: Record<string, unknown>): Promise<CallToolResult> {
    const prompt = String(args["prompt"] ?? "");
    if (!prompt) return errResult("prompt is required");
    const backend = args["backend"] as string | undefined;
    const modelId = args["model_id"] as string | undefined;
    const cwd = args["cwd"] as string | undefined;
    const timeoutMs = args["timeout_ms"] as number | undefined;
    const agent = await this.getAgent(backend);
    const res = await agent.prompt(prompt, {
      ...(modelId ? { modelId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    return okResult(res.text, { sessionId: res.sessionId, modelId: res.modelId, durationMs: res.durationMs });
  }

  private async toolResume(args: Record<string, unknown>): Promise<CallToolResult> {
    const sessionId = String(args["session_id"] ?? "");
    const prompt = String(args["prompt"] ?? "");
    if (!sessionId || !prompt) return errResult("session_id and prompt are required");
    const backend = args["backend"] as string | undefined;
    const agent = await this.getAgent(backend);
    const res = await agent.resume(sessionId, prompt);
    return okResult(res.text, { sessionId, modelId: res.modelId, durationMs: res.durationMs });
  }

  private async toolModels(args: Record<string, unknown>): Promise<CallToolResult> {
    const backend = args["backend"] as string | undefined;
    const agent = await this.getAgent(backend);
    const models = await agent.listModels();
    return okResult(JSON.stringify(models, null, 2));
  }

  private async toolSessions(args: Record<string, unknown>): Promise<CallToolResult> {
    const backend = args["backend"] as string | undefined;
    const agent = await this.getAgent(backend);
    const sessions = await agent.listSessions();
    return okResult(JSON.stringify(sessions, null, 2));
  }

  private async toolSubscribe(args: Record<string, unknown>): Promise<CallToolResult> {
    const sessionId = String(args["session_id"] ?? "");
    if (!sessionId) return errResult("session_id is required");
    const agent = await this.getAgent();
    const subId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const unsubscribe = agent.subscribe(sessionId, (event) => {
      this.server.notification({ method: "notifications/event", params: { subId, sessionId, event } });
    });
    this.eventSubscribers.set(subId, new Set<() => void>([unsubscribe]));
    return okResult(JSON.stringify({ subId, sessionId }));
  }

  private async toolAbort(args: Record<string, unknown>): Promise<CallToolResult> {
    const sessionId = String(args["session_id"] ?? "");
    if (!sessionId) return errResult("session_id is required");
    const agent = await this.getAgent();
    await agent.abort(sessionId);
    return okResult(`aborted ${sessionId}`);
  }

  private async toolBackends(): Promise<CallToolResult> {
    return okResult(
      JSON.stringify(
        {
          available: availableBackends(),
          default: this.defaultBackend,
          active: this.agent?.name ?? null,
        },
        null,
        2,
      ),
    );
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }

  async stop(): Promise<void> {
    for (const set of this.eventSubscribers.values()) {
      for (const fn of set) {
        try {
          (fn as () => void)();
        } catch {
          // ignore
        }
      }
    }
    this.eventSubscribers.clear();
    if (this.agent) {
      await this.agent.dispose();
      this.agent = null;
    }
  }
}

function okResult(text: string, meta?: Record<string, unknown>): CallToolResult {
  const content = [{ type: "text" as const, text }];
  if (meta) {
    return { content, _meta: meta };
  }
  return { content };
}

function errResult(message: string, code?: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text: `[${code ?? "error"}] ${message}` }],
    isError: true,
  };
}
