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
    thinkingEffort: true,
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

  /** Release a held prompt with the default completed response. */
  release(): void {
    const release = this.pendingRelease;
    this.pendingRelease = undefined;
    release?.(this.defaultResponse());
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
      { index: 8, role: "user", text: "list the files", at: "2026-09-12T10:00:00Z" },
      { index: 9, role: "assistant", text: "two files: a.ts, b.ts", at: "2026-09-12T10:00:05Z" },
    ];
    return {
      sessionId,
      entries,
      totalEntries: 9,
      truncated: true,
      page: { index: 0, size: 2, totalPages: 5 },
      older: { page: 1 },
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
  logs: LoggingMessageNotification["params"][];
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
  const logs: LoggingMessageNotification["params"][] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    logs.push(notification.params);
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, clientTransport, agent, registry, logs };
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

function jsonOf(result: CallToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

describe("kagero MCP server", () => {
  it("exposes exactly the seven prefixed tools", async () => {
    const { client } = await makeHarness();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "kagero_history",
      "kagero_info",
      "kagero_run",
      "kagero_send_message",
      "kagero_task_list",
      "kagero_task_output",
      "kagero_task_stop",
    ]);
  });

  it("round-trips a run: text plus _meta telemetry", async () => {
    const { client, agent } = await makeHarness();
    const result = await call(client, "kagero_run", {
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

  it("continues a session through run with session_id (resume path)", async () => {
    const { client, agent } = await makeHarness();
    const result = await call(client, "kagero_run", {
      prompt: "keep going",
      session_id: "sess-1",
      model_id: "fake-model",
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("done");
    expect(agent.resumeCalls).toHaveLength(1);
    expect(agent.resumeCalls[0]?.sessionId).toBe("sess-1");
    expect(agent.resumeCalls[0]?.prompt).toBe("keep going");
    expect(agent.resumeCalls[0]?.opts?.modelId).toBe("fake-model");
    expect(agent.promptCalls).toHaveLength(0);
  });

  it("attaches session_id through the prompt path when the backend cannot resume", async () => {
    const { client, agent } = await makeHarness({ resume: false });
    const result = await call(client, "kagero_run", { prompt: "attach", session_id: "sess-live" });
    expect(result.isError).toBeFalsy();
    expect(agent.resumeCalls).toHaveLength(0);
    expect(agent.promptCalls).toHaveLength(1);
    expect(agent.promptCalls[0]?.opts?.sessionId).toBe("sess-live");
  });

  it("refuses honestly when the backend lacks the capability", async () => {
    const noHistory = await makeHarness({ history: false });
    const history = await call(noHistory.client, "kagero_history", { session_id: "sess-1" });
    expect(history.isError).toBe(true);
    expect(textOf(history)).toContain("[unsupported_capability]");
    expect(textOf(history)).toContain("history");

    const noAbort = await makeHarness({ abort: false });
    const abort = await call(noAbort.client, "kagero_send_message", {
      session_id: "sess-1",
      kind: "abort",
    });
    expect(abort.isError).toBe(true);
    expect(textOf(abort)).toContain("[unsupported_capability]");
    expect(textOf(abort)).toContain("abort");
  });

  it("renders session history through the core renderer", async () => {
    const { client, agent } = await makeHarness();
    const result = await call(client, "kagero_history", {
      session_id: "sess-h",
      page_size: 2,
      max_chars: 40,
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("session sess-h — 2/9 entries (truncated) · page 1/5");
    expect(text).toContain("#9 asst");
    expect(text).toContain("two files: a.ts, b.ts");
    expect(text).toContain("— full history: /logs/sess-h.jsonl (from line 3)");
    expect(text).toContain("— older entries: page=1");

    const olderPage = await call(client, "kagero_history", { session_id: "sess-h", page: 1 });
    expect(olderPage.isError).toBeFalsy();

    expect(agent.historyCalls).toHaveLength(2);
    const recorded = agent.historyCalls[0];
    expect(recorded?.sessionId).toBe("sess-h");
    expect(recorded?.opts?.pageSize).toBe(2);
    expect(recorded?.opts?.maxChars).toBe(40);
    expect(agent.historyCalls[1]?.opts?.page).toBe(1);
  });

  it("refuses requested limits the backend cannot honor", async () => {
    const { client } = await makeHarness({
      workspaceCreate: false,
      limits: { timeout: false, maxTurns: false, maxToolCalls: false },
    });
    const result = await call(client, "kagero_run", {
      prompt: "go",
      workspace_create: true,
      timeout_ms: 1000,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("[unsupported_capability]");
  });

  it("refuses thinking_effort when a backend cannot forward it", async () => {
    const { client } = await makeHarness({ thinkingEffort: false });
    const result = await call(client, "kagero_run", { prompt: "go", thinking_effort: "medium" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("[unsupported_capability]");
    expect(textOf(result)).toContain("thinking_effort");
  });

  it("forwards thinking_effort to a backend that declares support", async () => {
    const { client, agent } = await makeHarness({ thinkingEffort: true });
    const result = await call(client, "kagero_run", { prompt: "go", thinking_effort: "medium" });
    expect(result.isError).toBeFalsy();
    expect(agent.promptCalls[0]?.opts?.thinkingEffort).toBe("medium");
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
    const result = await call(client, "kagero_run", { prompt: "long job" });
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("run timed out");
    expect(text).toContain("session stays resumable: sess-9");
    expect(text).toContain("partial so far");
    expect(result._meta?.status).toBe("timed-out");
  });

  it("aborts the in-flight blocking run on a wire-level cancelled notification", async () => {
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
    const pendingCall = call(client, "kagero_run", { prompt: "long job", session_id: "sess-live" });
    await vi.waitFor(() => expect(agent.resumeCalls).toHaveLength(1));

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

  it("info merges backends, default and models of the active backend", async () => {
    const { client, registry } = await makeHarness();
    registry.register("zzz", () => new FakeAgent());
    const result = await call(client, "kagero_info");
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("backends: fake, zzz");
    expect(text).toContain("default: fake");
    expect(text).toContain("models (fake): fake-model");
  });

  it("info reports 'not reported' when the backend cannot enumerate models", async () => {
    const { client } = await makeHarness({ models: false });
    const result = await call(client, "kagero_info", { backend: "fake" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("models (fake): not reported");
  });

  it("send_message steers, queues follow-ups and aborts", async () => {
    const { client, agent } = await makeHarness();

    const steered = await call(client, "kagero_send_message", {
      session_id: "sess-live",
      message: "go left",
      kind: "steer",
    });
    expect(steered.isError).toBeFalsy();
    expect(textOf(steered)).toContain("steer delivered to sess-live");

    const queued = await call(client, "kagero_send_message", {
      session_id: "sess-live",
      message: "and then",
    });
    expect(queued.isError).toBeFalsy();
    expect(agent.sendCalls[1]?.kind).toBe("steer"); // default kind

    const aborted = await call(client, "kagero_send_message", {
      session_id: "sess-live",
      kind: "abort",
    });
    expect(aborted.isError).toBeFalsy();
    expect(textOf(aborted)).toContain("abort signal sent to sess-live");
    expect(agent.abortCalls).toEqual(["sess-live"]);
    expect(agent.sendCalls).toHaveLength(2);
  });

  it("send_message requires a message for steer/follow_up", async () => {
    const { client } = await makeHarness();
    const missing = await call(client, "kagero_send_message", { session_id: "s1", kind: "follow_up" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("message is required");
  });
});

describe("kagero background tasks", () => {
  it("run_in_background returns a task id immediately and task_list shows it running", async () => {
    const { client, agent } = await makeHarness();
    agent.hold();
    const started = await call(client, "kagero_run", {
      prompt: "long job",
      run_in_background: true,
      agent_name: "worker-1",
      model_id: "fake-model",
    });
    expect(started.isError).toBeFalsy();
    const body = jsonOf(started);
    expect(body).toEqual({ task_id: "task-1", status: "running" });
    expect(started._meta).toMatchObject({ taskId: "task-1", status: "running" });
    // The tool call returned while the run is still parked in the agent.
    expect(agent.promptCalls).toHaveLength(1);

    const listing = jsonOf(await call(client, "kagero_task_list", {}));
    expect(listing).toMatchObject({ total: 1, page: 0, page_size: 20 });
    const task = (listing.tasks as Record<string, unknown>[])[0];
    expect(task).toMatchObject({
      task_id: "task-1",
      status: "running",
      agent_name: "worker-1",
      model_id: "fake-model",
    });
    expect(task?.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("completion updates the registry entry and fires the task-completed notification", async () => {
    const { client, agent, logs } = await makeHarness();
    agent.hold();
    const started = await call(client, "kagero_run", { prompt: "job", run_in_background: true });
    const taskId = jsonOf(started).task_id;

    // While running, task_output reports the status without the result.
    const running = await call(client, "kagero_task_output", { task_id: taskId as string });
    expect(running.isError).toBeFalsy();
    expect(running._meta).toMatchObject({ taskId, status: "running" });
    expect(textOf(running)).toContain("still running");

    agent.release();

    await vi.waitFor(() =>
      expect(logs.some((l) => (l.data as Record<string, unknown>)?.["kind"] === "task-completed")).toBe(true),
    );
    const note = logs.find((l) => (l.data as Record<string, unknown>)?.["kind"] === "task-completed");
    expect(note?.data).toMatchObject({
      kind: "task-completed",
      task_id: taskId,
      status: "succeeded",
      session_id: "sess-1",
    });
    expect(String((note?.data as Record<string, unknown>)?.["summary"])).toContain("done");

    const output = await call(client, "kagero_task_output", { task_id: taskId as string });
    expect(output.isError).toBeFalsy();
    expect(output._meta).toMatchObject({ taskId, status: "succeeded", sessionId: "sess-1" });
    expect(output._meta?.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(textOf(output)).toContain("task-1 finished: succeeded (session sess-1)");
    expect(textOf(output)).toContain("done");

    const activeOnly = jsonOf(await call(client, "kagero_task_list", {}));
    expect(activeOnly.total).toBe(0);
    const all = jsonOf(await call(client, "kagero_task_list", { active_only: false }));
    expect(all.total).toBe(1);
    expect((all.tasks as Record<string, unknown>[])[0]).toMatchObject({
      task_id: taskId,
      status: "succeeded",
    });
  });

  it("task_output wait_ms waits for a finishing task", async () => {
    const { client, agent } = await makeHarness();
    agent.hold();
    const started = await call(client, "kagero_run", { prompt: "quick job", run_in_background: true });
    const taskId = jsonOf(started).task_id as string;
    const pending = call(client, "kagero_task_output", { task_id: taskId, wait_ms: 5_000 });
    agent.release();
    const output = await pending;
    expect(output.isError).toBeFalsy();
    expect(textOf(output)).toContain("finished: succeeded");
  });

  it("task_stop sends abort and marks canceled only after the run reports aborted", async () => {
    const { client, agent, logs } = await makeHarness();
    agent.hold();
    const started = await call(client, "kagero_run", {
      prompt: "job",
      session_id: "sess-live",
      run_in_background: true,
    });
    const taskId = jsonOf(started).task_id as string;

    const stopped = await call(client, "kagero_task_stop", { task_id: taskId, reason: "no longer needed" });
    expect(stopped.isError).toBeFalsy();
    expect(stopped._meta).toMatchObject({ taskId, status: "running", cancelPending: true });
    expect(textOf(stopped)).toContain("abort sent to task-1");
    expect(agent.abortCalls).toEqual(["sess-live"]);

    // The abort resolves the held run with status "aborted".
    await vi.waitFor(() =>
      expect(logs.some((l) => (l.data as Record<string, unknown>)?.["kind"] === "task-completed")).toBe(true),
    );
    const listing = jsonOf(await call(client, "kagero_task_list", { active_only: false }));
    expect((listing.tasks as Record<string, unknown>[])[0]).toMatchObject({ task_id: taskId, status: "canceled" });
    const note = logs.find((l) => (l.data as Record<string, unknown>)?.["kind"] === "task-completed");
    expect(note?.data).toMatchObject({ task_id: taskId, status: "canceled" });
    const all = jsonOf(await call(client, "kagero_task_list", { active_only: false }));
    expect((all.tasks as Record<string, unknown>[])[0]).toMatchObject({ status: "canceled" });
  });

  it("task_stop on a finished task and unknown task ids are honest errors", async () => {
    const { client } = await makeHarness();
    const unknownOutput = await call(client, "kagero_task_output", { task_id: "task-99" });
    expect(unknownOutput.isError).toBe(true);
    expect(textOf(unknownOutput)).toContain("[unknown_task]");

    const unknownStop = await call(client, "kagero_task_stop", { task_id: "task-99" });
    expect(unknownStop.isError).toBe(true);
    expect(textOf(unknownStop)).toContain("[unknown_task]");

    // A run that already finished cannot be stopped.
    await call(client, "kagero_run", { prompt: "fast", run_in_background: true });
    const finishedStop = await call(client, "kagero_task_stop", { task_id: "task-1" });
    expect(finishedStop.isError).toBe(true);
    expect(textOf(finishedStop)).toContain("[task_not_running]");
  });

  it("a failed background run lands as failed with the error text", async () => {
    const { client, agent } = await makeHarness();
    agent.onPrompt(() => Promise.reject(new Error("backend exploded")));
    const started = await call(client, "kagero_run", { prompt: "doomed", run_in_background: true });
    const taskId = jsonOf(started).task_id as string;
    const output = await call(client, "kagero_task_output", { task_id: taskId, wait_ms: 1_000 });
    expect(output.isError).toBeFalsy();
    expect(output._meta).toMatchObject({ taskId, status: "failed" });
    expect(textOf(output)).toContain("task-1 finished: failed");
    expect(textOf(output)).toContain("backend exploded");
  });

  it("task_list pages the registry", async () => {
    const { client, agent } = await makeHarness();
    for (const prompt of ["one", "two", "three"]) {
      await call(client, "kagero_run", { prompt, run_in_background: true });
    }
    agent.release();
    const page0 = jsonOf(await call(client, "kagero_task_list", { active_only: false, page_size: 2 }));
    expect(page0.total).toBe(3);
    expect(page0.page).toBe(0);
    expect((page0.tasks as unknown[]).length).toBe(2);
    const page1 = jsonOf(
      await call(client, "kagero_task_list", { active_only: false, page: 1, page_size: 2 }),
    );
    expect((page1.tasks as unknown[]).length).toBe(1);
  });
});
