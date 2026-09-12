// Tests for the @kagero/mcp server factory, over InMemoryTransport.
//
// The FakeAgent implements the Agent contract from @kagero/core; backends are
// registered in a real core BackendRegistry. The factory is imported from its
// TS source by a relative path; @kagero/core resolves through the vitest alias.

import {
  type Agent,
  type AgentCapabilities,
  type AgentEvent,
  type AgentResponse,
  type BackendRegistry,
  createRegistry,
  type HistoryEntry,
  type HistoryOptions,
  type HistoryResult,
  type MidRunCommand,
  type ModelInfo,
  type PromptOptions,
  type SessionInfo,
} from "@kagero/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  CallToolResult,
  JSONRPCMessage,
  LoggingMessageNotification,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { createKageroMcpServer } from "../packages/mcp/src/index.js";

function fullCapabilities(): AgentCapabilities {
  return {
    resume: true,
    models: true,
    sessions: true,
    history: true,
    subscribe: true,
    abort: true,
    steer: true,
    followUp: true,
    limits: { timeout: true, maxTurns: true, maxToolCalls: true },
    workspaceCreate: true,
  };
}

class FakeAgent implements Agent {
  readonly name = "fake";
  readonly capabilities: AgentCapabilities;
  readonly promptCalls: { prompt: string; opts?: PromptOptions }[] = [];
  readonly resumeCalls: { sessionId: string; prompt: string; opts?: PromptOptions }[] = [];
  readonly historyCalls: { sessionId: string; opts?: HistoryOptions }[] = [];
  readonly abortCalls: string[] = [];
  readonly sendCalls: { sessionId: string; message: string; kind?: MidRunCommand }[] = [];
  readonly subscribers: ((event: AgentEvent) => void)[] = [];
  disposed = false;

  private promptResponder: ((prompt: string, opts?: PromptOptions) => Promise<AgentResponse>) | undefined;
  private pendingRelease: ((response: AgentResponse) => void) | undefined;

  constructor(capabilities?: AgentCapabilities) {
    this.capabilities = capabilities ?? fullCapabilities();
  }

  /** Script the prompt response instead of the default completed one. */
  onPrompt(respond: (prompt: string, opts?: PromptOptions) => Promise<AgentResponse>): void {
    this.promptResponder = respond;
  }

  /** Make prompt hang until abort() (or release()) resolves it. */
  hold(): void {
    this.onPrompt(
      () =>
        new Promise<AgentResponse>((resolve) => {
          this.pendingRelease = resolve;
        }),
    );
  }

  emit(event: AgentEvent): void {
    for (const subscriber of [...this.subscribers]) subscriber(event);
  }

  prompt(prompt: string, opts?: PromptOptions): Promise<AgentResponse> {
    this.promptCalls.push(opts === undefined ? { prompt } : { prompt, opts });
    if (this.promptResponder !== undefined) return this.promptResponder(prompt, opts);
    return Promise.resolve(this.defaultResponse());
  }

  resume(sessionId: string, prompt: string, opts?: PromptOptions): Promise<AgentResponse> {
    this.resumeCalls.push(opts === undefined ? { sessionId, prompt } : { sessionId, prompt, opts });
    if (this.promptResponder !== undefined) return this.promptResponder(prompt, opts);
    return Promise.resolve({ ...this.defaultResponse(), sessionId });
  }

  abort(sessionId: string): Promise<void> {
    this.abortCalls.push(sessionId);
    const release = this.pendingRelease;
    this.pendingRelease = undefined;
    release?.({ status: "aborted", text: "", sessionId, durationMs: 2 });
    return Promise.resolve();
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      {
        id: "fake-model",
        displayName: "Fake Model",
        provider: "fake",
        contextWindow: 128_000,
        supportsTools: true,
        supportsVision: false,
      },
    ];
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [
      {
        id: "sess-1",
        createdAt: "2026-09-12T00:00:00Z",
        lastUsedAt: "2026-09-12T00:01:00Z",
        cwd: "/ws/fake",
        summary: "fake session",
        messageCount: 2,
      },
    ];
  }

  async history(sessionId: string, opts?: HistoryOptions): Promise<HistoryResult> {
    this.historyCalls.push(opts === undefined ? { sessionId } : { sessionId, opts });
    const entries: HistoryEntry[] = [
      { index: 0, role: "user", text: "list the files", at: "2026-09-12T10:00:00Z" },
      { index: 1, role: "assistant", text: "two files: a.ts, b.ts", at: "2026-09-12T10:00:05Z" },
    ];
    return {
      sessionId,
      entries,
      totalEntries: 9,
      truncated: true,
      fullLog: { file: "/logs/sess-h.jsonl", line: 3 },
    };
  }

  subscribe(sessionId: string, onEvent: (event: AgentEvent) => void): () => void {
    void sessionId;
    this.subscribers.push(onEvent);
    return () => {
      const at = this.subscribers.indexOf(onEvent);
      if (at >= 0) this.subscribers.splice(at, 1);
    };
  }

  async send(sessionId: string, message: string, kind?: MidRunCommand): Promise<void> {
    this.sendCalls.push(kind === undefined ? { sessionId, message } : { sessionId, message, kind });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  private defaultResponse(): AgentResponse {
    return {
      status: "completed",
      text: "done",
      sessionId: "sess-1",
      modelId: "fake-model",
      modelSource: "reported",
      workspace: "/ws/fake",
      durationMs: 5,
      usage: { inputTokens: 3, outputTokens: 2 },
    };
  }
}

interface Harness {
  client: Client;
  clientTransport: InMemoryTransport;
  agent: FakeAgent;
  registry: BackendRegistry;
}

async function makeHarness(overrides?: Partial<AgentCapabilities>): Promise<Harness> {
  const agent = new FakeAgent({ ...fullCapabilities(), ...overrides });
  const registry = createRegistry();
  registry.register("fake", () => agent);
  const { server } = createKageroMcpServer({
    name: "kagero-test",
    version: "0.0.0-test",
    registry,
    defaultBackend: "fake",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, clientTransport, agent, registry };
}

function asToolResult(result: unknown): CallToolResult {
  if (typeof result === "object" && result !== null && "content" in result) {
    return result as CallToolResult;
  }
  throw new Error(`unexpected tool result: ${JSON.stringify(result)}`);
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return asToolResult(await client.callTool({ name, arguments: args }));
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : JSON.stringify(block)))
    .join("\n");
}

describe("kagero MCP server", () => {
  it("exposes the ten prefixed tools", async () => {
    const { client } = await makeHarness();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "kagero_abort",
      "kagero_backends",
      "kagero_history",
      "kagero_models",
      "kagero_prompt",
      "kagero_resume",
      "kagero_send",
      "kagero_sessions",
      "kagero_subscribe",
      "kagero_unsubscribe",
    ]);
  });

  it("round-trips a prompt: text plus _meta telemetry", async () => {
    const { client, agent } = await makeHarness();
    const result = await call(client, "kagero_prompt", {
      prompt: "fix the race",
      backend: "fake",
      model_id: "fake-model",
      cwd: "/c",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("done");
    expect(result._meta?.status).toBe("completed");
    expect(result._meta?.sessionId).toBe("sess-1");
    expect(result._meta?.modelId).toBe("fake-model");
    expect(result._meta?.modelSource).toBe("reported");
    expect(result._meta?.workspace).toBe("/ws/fake");
    expect(result._meta?.durationMs).toBe(5);
    expect(result._meta?.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    expect(agent.promptCalls).toHaveLength(1);
    const recorded = agent.promptCalls[0];
    expect(recorded?.prompt).toBe("fix the race");
    expect(recorded?.opts?.modelId).toBe("fake-model");
    expect(recorded?.opts?.cwd).toBe("/c");
  });

  it("refuses honestly when the backend lacks the capability", async () => {
    const noHistory = await makeHarness({ history: false });
    const history = await call(noHistory.client, "kagero_history", { session_id: "sess-1" });
    expect(history.isError).toBe(true);
    expect(textOf(history)).toContain("[unsupported_capability]");
    expect(textOf(history)).toContain("history");

    const noResume = await makeHarness({ resume: false });
    const resume = await call(noResume.client, "kagero_resume", { session_id: "sess-1", prompt: "continue" });
    expect(resume.isError).toBe(true);
    expect(textOf(resume)).toContain("[unsupported_capability]");
    expect(textOf(resume)).toContain("resume");
  });

  it("renders session history through the core renderer", async () => {
    const { client, agent } = await makeHarness();
    const result = await call(client, "kagero_history", { session_id: "sess-h", last: 2, max_chars: 40 });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("session sess-h — 2/9 entries (truncated)");
    expect(text).toContain("#1 asst");
    expect(text).toContain("two files: a.ts, b.ts");
    expect(text).toContain("— full history: /logs/sess-h.jsonl (from line 3)");

    expect(agent.historyCalls).toHaveLength(1);
    const recorded = agent.historyCalls[0];
    expect(recorded?.sessionId).toBe("sess-h");
    expect(recorded?.opts?.last).toBe(2);
    expect(recorded?.opts?.maxChars).toBe(40);
  });

  it("refuses requested limits the backend cannot honor", async () => {
    const { client } = await makeHarness({
      workspaceCreate: false,
      limits: { timeout: false, maxTurns: false, maxToolCalls: false },
    });
    const result = await call(client, "kagero_prompt", {
      prompt: "go",
      workspace_create: true,
      timeout_ms: 1000,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("[unsupported_capability]");
  });

  it("reports a timed-out run as isError without throwing", async () => {
    const { client, agent } = await makeHarness();
    agent.onPrompt(() =>
      Promise.resolve({
        status: "timed-out",
        text: "partial so far",
        sessionId: "sess-9",
        durationMs: 10,
      }),
    );
    const result = await call(client, "kagero_prompt", { prompt: "long job" });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("run timed out");
    expect(text).toContain("session stays resumable: sess-9");
    expect(text).toContain("partial so far");
    expect(result._meta?.status).toBe("timed-out");
  });

  it("streams subscribe events as logging messages and detaches on unsubscribe", async () => {
    const { client, agent } = await makeHarness();
    const logs: LoggingMessageNotification["params"][] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      logs.push(notification.params);
    });

    const subscribed = await call(client, "kagero_subscribe", { session_id: "sess-live" });
    expect(subscribed.isError).toBeFalsy();
    const subId = /subscription_id: (\S+)/.exec(textOf(subscribed))?.[1];
    expect(subId).toBeDefined();

    agent.emit({ type: "assistant-text", content: "hello there", at: "t0" });
    await vi.waitFor(() => expect(logs).toHaveLength(1));
    expect(logs[0]?.level).toBe("info");
    expect(logs[0]?.logger).toBe("kagero-test");
    expect(logs[0]?.data).toMatchObject({
      subscription_id: subId,
      session_id: "sess-live",
      event: { type: "assistant-text", content: "hello there" },
    });

    const unsubscribed = await call(client, "kagero_unsubscribe", { subscription_id: subId });
    expect(unsubscribed.isError).toBeFalsy();
    expect(agent.subscribers).toHaveLength(0);

    agent.emit({ type: "assistant-text", content: "after detach", at: "t1" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(logs).toHaveLength(1);

    const unknown = await call(client, "kagero_unsubscribe", { subscription_id: "nope" });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("unknown_subscription");
  });

  it("aborts the in-flight prompt on a wire-level cancelled notification", async () => {
    const { client, clientTransport, agent } = await makeHarness();

    let capturedRequestId: RequestId | undefined;
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = async (message: JSONRPCMessage) => {
      if ("method" in message && "id" in message && message.id !== undefined) {
        capturedRequestId = message.id;
      }
      return originalSend(message);
    };

    agent.hold();
    const pendingCall = call(client, "kagero_prompt", { prompt: "long job", session_id: "sess-live" });
    await vi.waitFor(() => expect(agent.promptCalls).toHaveLength(1));

    const requestId = capturedRequestId;
    expect(requestId).toBeDefined();
    await client.notification({
      method: "notifications/cancelled",
      params: { requestId: requestId as RequestId, reason: "user asked" },
    });

    const result = await pendingCall;
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("run aborted");
    expect(text).toContain("session stays resumable: sess-live");
    expect(agent.abortCalls).toEqual(["sess-live"]);
  });

  it("lists backends with the default", async () => {
    const { client, registry } = await makeHarness();
    registry.register("zzz", () => new FakeAgent());
    const result = await call(client, "kagero_backends");
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("fake");
    expect(text).toContain("zzz");
    expect(text).toContain("default: fake");
  });
});
