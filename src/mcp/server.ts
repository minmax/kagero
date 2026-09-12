/**
 * MCP server — exposes the kagero Agent interface as MCP tools.
 *
 * Uses the high-level McpServer API (auto-validates inputSchema via Ajv).
 * Each tool is a thin adapter over the Agent interface; no business logic.
 *
 * Tools exposed:
 *   - kagero_prompt      — one-shot prompt
 *   - kagero_resume      — resume session
 *   - kagero_models      — list models
 *   - kagero_sessions    — list sessions
 *   - kagero_subscribe   — subscribe to events
 *   - kagero_unsubscribe — release a subscription
 *   - kagero_abort       — abort a session
 *   - kagero_backends    — list available backends
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Agent } from "../agent.js";
import { availableBackends, type BackendName, select } from "../registry.js";

export interface McpServerOptions {
  /** Default backend to use. */
  defaultBackend: BackendName | string;
}

export class KageroMcpServer {
  private mcp: McpServer;
  private agents = new Map<string, Agent>();
  private getAgentPromises = new Map<string, Promise<Agent>>();
  private defaultBackend: BackendName | string;
  private readonly eventSubscribers = new Map<string, () => void>();

  constructor(opts: McpServerOptions) {
    this.defaultBackend = opts.defaultBackend;
    this.mcp = new McpServer(
      {
        name: "kagero-mcp",
        version: "0.1.0",
        title: "Kagero MCP",
      },
      {
        capabilities: { tools: {}, logging: {} },
        instructions:
          "Kagero unifies 7 agent backends (pi-sdk, pi-rpc, dsh, qwen, grok, kimi, mcode) behind one MCP interface. " +
          "Use kagero_prompt for one-shot prompts. Override `backend` per call if needed. " +
          "Use kagero_subscribe for live event streaming, then kagero_unsubscribe with the returned subId to release.",
      },
    );
    this.registerTools();
  }

  private registerTools(): void {
    this.mcp.registerTool(
      "kagero_prompt",
      {
        description:
          "Send a one-shot prompt to the active agent backend (pi-sdk, pi-rpc, dsh, qwen, grok, kimi, mcode). Returns the assistant's final text.",
        inputSchema: z
          .object({
            prompt: z.string().min(1).describe("The prompt to send"),
            backend: z.string().optional().describe("Override the default backend (e.g. 'dsh', 'qwen')"),
            model_id: z.string().optional().describe("Override the model id"),
            cwd: z.string().optional().describe("Override the working directory"),
            timeout_ms: z.number().int().positive().optional().describe("Per-call timeout in ms"),
          })
          .strict(),
      },
      async (args) => {
        const agent = await this.getAgent(args.backend);
        const res = await agent.prompt(args.prompt, {
          ...(args.model_id ? { modelId: args.model_id } : {}),
          ...(args.cwd ? { cwd: args.cwd } : {}),
          ...(args.timeout_ms ? { timeoutMs: args.timeout_ms } : {}),
        });
        return okResult(res.text, {
          sessionId: res.sessionId,
          modelId: res.modelId,
          durationMs: res.durationMs,
        });
      },
    );

    this.mcp.registerTool(
      "kagero_resume",
      {
        description: "Continue a persistent session by id with a new prompt.",
        inputSchema: z
          .object({
            session_id: z.string().min(1),
            prompt: z.string().min(1),
            backend: z.string().optional(),
            model_id: z.string().optional(),
            cwd: z.string().optional(),
          })
          .strict(),
      },
      async (args) => {
        const agent = await this.getAgent(args.backend);
        const res = await agent.resume(args.session_id, args.prompt, {
          ...(args.model_id ? { modelId: args.model_id } : {}),
          ...(args.cwd ? { cwd: args.cwd } : {}),
        });
        return okResult(res.text, {
          sessionId: res.sessionId ?? args.session_id,
          modelId: res.modelId,
          durationMs: res.durationMs,
        });
      },
    );

    this.mcp.registerTool(
      "kagero_models",
      {
        description: "List models the active backend can use.",
        inputSchema: z
          .object({
            backend: z.string().optional().describe("Override the default backend"),
          })
          .strict(),
      },
      async (args) => {
        const agent = await this.getAgent(args.backend);
        const models = await agent.listModels();
        return okResult(JSON.stringify(models, null, 2));
      },
    );

    this.mcp.registerTool(
      "kagero_sessions",
      {
        description: "List persistent sessions on the active backend.",
        inputSchema: z
          .object({
            backend: z.string().optional().describe("Override the default backend"),
          })
          .strict(),
      },
      async (args) => {
        const agent = await this.getAgent(args.backend);
        const sessions = await agent.listSessions();
        return okResult(JSON.stringify(sessions, null, 2));
      },
    );

    this.mcp.registerTool(
      "kagero_subscribe",
      {
        description:
          "Subscribe to live events for a session. Returns a subId; subsequent events " +
          "arrive via the standard MCP logging notification. Always pair with kagero_unsubscribe.",
        inputSchema: z
          .object({
            session_id: z.string().min(1),
            backend: z.string().optional().describe("Override the default backend"),
          })
          .strict(),
      },
      async (args) => {
        const agent = await this.getAgent(args.backend);
        const subId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const unsubscribe = agent.subscribe(args.session_id, (event) => {
          // Use the standard logging notification (MCP 2025-06-18) — clients
          // route unknown methods to /dev/null. Logging is the spec-defined
          // channel for arbitrary server→client messages.
          void this.mcp.server.sendLoggingMessage({
            level: "info",
            logger: "kagero",
            data: { kind: "agent_event", subId, sessionId: args.session_id, event },
          });
        });
        this.eventSubscribers.set(subId, unsubscribe);
        return okResult(JSON.stringify({ subId, sessionId: args.session_id }));
      },
    );

    this.mcp.registerTool(
      "kagero_unsubscribe",
      {
        description: "Release a subscription by its subId (returned from kagero_subscribe).",
        inputSchema: z
          .object({
            sub_id: z.string().min(1).describe("Subscription id from kagero_subscribe"),
          })
          .strict(),
      },
      async (args) => {
        const unsub = this.eventSubscribers.get(args.sub_id);
        if (!unsub) return errResult("subscription not found");
        try {
          unsub();
        } catch {
          // ignore
        }
        this.eventSubscribers.delete(args.sub_id);
        return okResult(JSON.stringify({ released: args.sub_id }));
      },
    );

    this.mcp.registerTool(
      "kagero_abort",
      {
        description: "Abort an in-flight session (idempotent).",
        inputSchema: z
          .object({
            session_id: z.string().min(1),
          })
          .strict(),
      },
      async (args) => {
        const agent = await this.getAgent();
        await agent.abort(args.session_id);
        return okResult(JSON.stringify({ aborted: args.session_id }));
      },
    );

    this.mcp.registerTool(
      "kagero_backends",
      {
        description: "List available backends and which is currently active.",
        inputSchema: z.object({}).strict(),
      },
      async () => {
        const active = this.agents.size === 1 ? [...this.agents.keys()][0] : null;
        return okResult(
          JSON.stringify(
            {
              available: availableBackends(),
              default: this.defaultBackend,
              active,
            },
            null,
            2,
          ),
        );
      },
    );
  }

  /**
   * Get-or-create the agent for the given backend. Single-flight per backend
   * name: concurrent calls with the same backend share one Agent instance and
   * one failure, and a failure never poisons later calls for other backends.
   */
  private getAgent(override?: string): Promise<Agent> {
    const name = override ?? this.defaultBackend;
    const existing = this.agents.get(name);
    if (existing) return Promise.resolve(existing);
    const inFlight = this.getAgentPromises.get(name);
    if (inFlight) return inFlight;
    const creating = select(name)
      .then((agent) => {
        this.agents.set(name, agent);
        return agent;
      })
      .finally(() => {
        this.getAgentPromises.delete(name);
      });
    this.getAgentPromises.set(name, creating);
    return creating;
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
  }

  async stop(): Promise<void> {
    for (const unsub of this.eventSubscribers.values()) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.eventSubscribers.clear();
    for (const agent of this.agents.values()) {
      try {
        await agent.dispose();
      } catch {
        // ignore
      }
    }
    this.agents.clear();
    await this.mcp.close();
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
