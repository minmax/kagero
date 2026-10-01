// Early native session id + deferred cancellation through the MCP facade.
//
// A scripted agent lets each test decide WHEN a run reports its native id
// (PromptOptions.onSessionId), when it settles, and records every abort — the
// server must attribute ids per run (no wildcard heuristics) and route
// task_stop / notifications/cancelled to the run once its id is known.

import {
  type Agent,
  type AgentCapabilities,
  type AgentEvent,
  type AgentResponse,
  createRegistry,
  type HistoryResult,
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

function capabilities(overrides: Partial<AgentCapabilities> = {}): AgentCapabilities {
  return {
    resume: true,
    models: false,
    sessions: false,
    history: false,
    subscribe: true,
    abort: true,
    steer: true,
    followUp: true,
    limits: { timeout: true, maxTurns: false, maxToolCalls: false },
    workspaceCreate: true,
    ...overrides,
  };
}

/** One scripted run: the test reports its id and settles it. */
class ScriptedRun {
  readonly aborts: string[] = [];
  reportedId: string | undefined;
  private settle: ((response: AgentResponse) => void) | undefined;
  readonly done = new Promise<AgentResponse>((resolve) => {
    this.settle = resolve;
  });

  private readonly opts: PromptOptions | undefined;

  constructor(opts: PromptOptions | undefined) {
    this.opts = opts;
  }

  /** The backend learns its native id: tell the run's own observer. */
  reportId(id: string): void {
    this.reportedId = id;
    this.opts?.onSessionId?.(id);
  }

  finish(status: AgentResponse["status"], sessionId?: string): void {
    this.settle?.({
      status,
      text: status === "completed" ? "done" : "",
      ...(sessionId === undefined ? {} : { sessionId }),
      durationMs: 1,
    });
  }
}

class ScriptedAgent implements Agent {
  readonly name = "scripted";
  readonly capabilities: AgentCapabilities;
  /** Runs by prompt text — tests address runs by what they asked. */
  readonly runs = new Map<string, ScriptedRun>();
  readonly abortCalls: string[] = [];
  /** When true, abort(id) settles the run that reported `id` as aborted (a cooperative backend). */
  cooperative = true;

  constructor(caps: AgentCapabilities) {
    this.capabilities = caps;
  }

  prompt(prompt: string, opts?: PromptOptions): Promise<AgentResponse> {
    const run = new ScriptedRun(opts);
    this.runs.set(prompt, run);
    return run.done;
  }

  resume(sessionId: string, prompt: string, opts?: PromptOptions): Promise<AgentResponse> {
    const pending = this.prompt(prompt, opts);
    this.run(prompt).reportId(sessionId);
    return pending;
  }

  run(prompt: string): ScriptedRun {
    const run = this.runs.get(prompt);
    if (run === undefined) throw new Error(`no run for "${prompt}"`);
    return run;
  }

  async abort(sessionId: string): Promise<void> {
    this.abortCalls.push(sessionId);
    for (const run of this.runs.values()) {
      if (run.reportedId !== sessionId) continue;
      run.aborts.push(sessionId);
      if (this.cooperative) run.finish("aborted", sessionId);
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }
  async listSessions(): Promise<SessionInfo[]> {
    return [];
  }
  async history(sessionId: string): Promise<HistoryResult> {
    return { sessionId, entries: [], totalEntries: 0, truncated: false };
  }
  subscribe(_sessionId: string, _onEvent: (event: AgentEvent) => void): () => void {
    return () => undefined;
  }
  async send(): Promise<void> {}
  async dispose(): Promise<void> {}
}

async function harness(caps: AgentCapabilities = capabilities(), delaySelection = false) {
  const agent = new ScriptedAgent(caps);
  const registry = createRegistry();
  let releaseSelection: (() => void) | undefined;
  registry.register(
    "scripted",
    delaySelection
      ? () => new Promise<ScriptedAgent>((resolve) => (releaseSelection = () => resolve(agent)))
      : () => agent,
  );
  const { server } = createKageroMcpServer({
    name: "kagero-test",
    version: "0.0.0-test",
    registry,
    defaultBackend: "scripted",
    watch: undefined,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const logs: LoggingMessageNotification["params"][] = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    logs.push(n.params);
  });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    agent,
    client,
    clientTransport,
    logs,
    releaseSelection: () => releaseSelection?.(),
    selectionPending: () => releaseSelection !== undefined,
  };
}

const asResult = (value: unknown): CallToolResult => value as CallToolResult;
const call = async (
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> => asResult(await client.callTool({ name, arguments: args }));
const textOf = (result: CallToolResult): string =>
  result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
const jsonOf = (result: CallToolResult): Record<string, unknown> =>
  JSON.parse(textOf(result)) as Record<string, unknown>;
const data = (log: LoggingMessageNotification["params"]): Record<string, unknown> =>
  log.data as Record<string, unknown>;

async function startBackground(client: Client, agent: ScriptedAgent, prompt: string): Promise<string> {
  const started = await call(client, "kagero_run", { prompt, run_in_background: true });
  await vi.waitFor(() => expect(agent.runs.has(prompt)).toBe(true));
  return jsonOf(started).task_id as string;
}

async function listTasks(client: Client): Promise<Record<string, unknown>[]> {
  const listing = jsonOf(await call(client, "kagero_task_list", { active_only: false }));
  return listing.tasks as Record<string, unknown>[];
}

const taskById = async (client: Client, taskId: string): Promise<Record<string, unknown> | undefined> =>
  (await listTasks(client)).find((task) => task.task_id === taskId);

describe("early native session id — background tasks", () => {
  it("exposes the id on the running task as soon as the backend reports it", async () => {
    const { agent, client, logs } = await harness();
    const taskId = await startBackground(client, agent, "fresh job");

    // Fresh run: nothing known yet — no fabricated id.
    expect((await taskById(client, taskId))?.session_id).toBeUndefined();

    agent.run("fresh job").reportId("native-early");

    expect(await taskById(client, taskId)).toMatchObject({
      task_id: taskId,
      status: "running",
      session_id: "native-early",
    });
    const output = await call(client, "kagero_task_output", { task_id: taskId });
    expect(output._meta).toMatchObject({ taskId, status: "running", sessionId: "native-early" });
    expect(textOf(output)).toContain("still running");
    expect(textOf(output)).toContain("native-early");
    expect(logs.map(data)).toContainEqual(
      expect.objectContaining({
        kind: "session-started",
        task_id: taskId,
        session_id: "native-early",
        backend: "scripted",
      }),
    );
  });

  it("attributes ids per run: parallel tasks reporting in reverse order never cross", async () => {
    const { agent, client, logs } = await harness();
    const first = await startBackground(client, agent, "cycle-1");
    const second = await startBackground(client, agent, "cycle-2");
    const third = await startBackground(client, agent, "cycle-3");

    agent.run("cycle-3").reportId("native-3");
    agent.run("cycle-1").reportId("native-1");
    agent.run("cycle-2").reportId("native-2");

    expect((await taskById(client, first))?.session_id).toBe("native-1");
    expect((await taskById(client, second))?.session_id).toBe("native-2");
    expect((await taskById(client, third))?.session_id).toBe("native-3");

    const pairs = logs
      .map(data)
      .filter((entry) => entry.kind === "session-started")
      .map((entry) => `${String(entry.task_id)}=${String(entry.session_id)}`)
      .sort();
    expect(pairs).toEqual([`${first}=native-1`, `${second}=native-2`, `${third}=native-3`]);

    // Stopping one task aborts only its own session.
    const stopped = await call(client, "kagero_task_stop", { task_id: second });
    expect(stopped._meta).toMatchObject({ taskId: second, status: "running", cancelPending: true });
    expect(agent.abortCalls).toEqual(["native-2"]);
    await vi.waitFor(async () => expect((await taskById(client, second))?.status).toBe("canceled"));
    expect((await taskById(client, first))?.status).toBe("running");
    expect((await taskById(client, third))?.status).toBe("running");
  });

  it("a late report after the task settled does not rewrite it", async () => {
    const { agent, client } = await harness();
    const taskId = await startBackground(client, agent, "quick");
    agent.run("quick").finish("completed", "native-final");
    await vi.waitFor(async () => expect((await taskById(client, taskId))?.status).toBe("succeeded"));
    agent.run("quick").reportId("native-too-late");
    expect((await taskById(client, taskId))?.session_id).toBe("native-final");
  });
});

describe("task_stop before the native id is known", () => {
  it("is explicit about the pending cancel, does not claim canceled, and delivers the abort when the id appears", async () => {
    const { agent, client } = await harness();
    const taskId = await startBackground(client, agent, "stop me early");

    const stopped = await call(client, "kagero_task_stop", { task_id: taskId, reason: "enough" });
    expect(stopped.isError).toBeFalsy();
    expect(textOf(stopped)).toContain("NOT yet delivered");
    expect(stopped._meta).toMatchObject({ taskId, status: "running", cancelPending: true });
    // The registry must not claim canceled for a run nobody could stop.
    expect(await taskById(client, taskId)).toMatchObject({ status: "running", cancel_pending: true });
    expect(agent.abortCalls).toEqual([]);

    agent.run("stop me early").reportId("native-late");

    // The deferred abort reached the backend with the run's own id…
    expect(agent.abortCalls).toEqual(["native-late"]);
    // …and the run's real outcome (aborted) decides the final status.
    await vi.waitFor(async () => expect((await taskById(client, taskId))?.status).toBe("canceled"));
    expect((await taskById(client, taskId))?.session_id).toBe("native-late");
  });

  it("stays honest when the backend never reports an id: the run's own outcome wins, no fake cancel", async () => {
    const { agent, client } = await harness();
    const taskId = await startBackground(client, agent, "never learns id");
    const stopped = await call(client, "kagero_task_stop", { task_id: taskId });
    expect(stopped._meta).toMatchObject({ status: "running", cancelPending: true });

    agent.run("never learns id").finish("completed");
    await vi.waitFor(async () => expect((await taskById(client, taskId))?.status).toBe("succeeded"));
    expect(agent.abortCalls).toEqual([]);
  });

  it("with a known id sends abort and waits for the backend outcome", async () => {
    const { agent, client } = await harness();
    const taskId = await startBackground(client, agent, "known id");
    agent.run("known id").reportId("native-known");
    const stopped = await call(client, "kagero_task_stop", { task_id: taskId });
    expect(stopped._meta).toMatchObject({ taskId, status: "running", cancelPending: true });
    expect(agent.abortCalls).toEqual(["native-known"]);
    await vi.waitFor(async () => expect((await taskById(client, taskId))?.status).toBe("canceled"));
  });

  it("does not claim canceled if an aborted backend later reports success", async () => {
    const { agent, client } = await harness();
    agent.cooperative = false;
    const taskId = await startBackground(client, agent, "abort ignored");
    agent.run("abort ignored").reportId("native-ignored");

    const stopped = await call(client, "kagero_task_stop", { task_id: taskId });
    expect(stopped._meta).toMatchObject({ taskId, status: "running", cancelPending: true });
    expect(agent.abortCalls).toEqual(["native-ignored"]);
    agent.run("abort ignored").finish("completed", "native-ignored");
    await vi.waitFor(async () => expect((await taskById(client, taskId))?.status).toBe("succeeded"));
  });

  it("refuses with unsupported_capability on a backend that cannot abort, even before the id is known", async () => {
    const { agent, client } = await harness(capabilities({ abort: false }));
    const taskId = await startBackground(client, agent, "no abort");
    const stopped = await call(client, "kagero_task_stop", { task_id: taskId });
    expect(stopped.isError).toBe(true);
    expect(textOf(stopped)).toContain("[unsupported_capability]");
    expect((await taskById(client, taskId))?.status).toBe("running");
  });
});

describe("notifications/cancelled before the native id is known (blocking run)", () => {
  it("is remembered and delivered through agent.abort once the run reports its id", async () => {
    const { agent, client, clientTransport, logs } = await harness();

    let requestId: RequestId | undefined;
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = async (message: JSONRPCMessage) => {
      if ("method" in message && "id" in message && message.id !== undefined) requestId = message.id;
      return originalSend(message);
    };

    const pending = call(client, "kagero_run", { prompt: "blocking fresh" });
    await vi.waitFor(() => expect(agent.runs.has("blocking fresh")).toBe(true));

    await client.notification({
      method: "notifications/cancelled",
      params: { requestId: requestId as RequestId, reason: "user asked" },
    });
    // Fresh run, id unknown: the cancel cannot be routed yet — and must not be dropped.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(agent.abortCalls).toEqual([]);

    agent.run("blocking fresh").reportId("native-blocking");
    expect(agent.abortCalls).toEqual(["native-blocking"]);

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("run aborted");
    expect(textOf(result)).toContain("native-blocking");
    expect(logs.map(data)).toContainEqual(
      expect.objectContaining({
        kind: "session-started",
        session_id: "native-blocking",
        request_id: requestId,
      }),
    );
  });

  it("retries a resume cancel after the backend has registered the run", async () => {
    const { agent, client, clientTransport, releaseSelection, selectionPending } = await harness(
      capabilities(),
      true,
    );
    let requestId: RequestId | undefined;
    const originalSend = clientTransport.send.bind(clientTransport);
    clientTransport.send = async (message: JSONRPCMessage) => {
      if ("method" in message && "id" in message && message.id !== undefined) requestId = message.id;
      return originalSend(message);
    };

    const pending = call(client, "kagero_run", {
      prompt: "resume and cancel",
      session_id: "native-resume",
    });
    await vi.waitFor(() => expect(requestId).toBeDefined());
    await vi.waitFor(() => expect(selectionPending()).toBe(true));
    await client.notification({
      method: "notifications/cancelled",
      params: { requestId: requestId as RequestId, reason: "stop before backend registration" },
    });
    releaseSelection();

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("run aborted");
    // The first abort was early and reached no active run. The per-run native
    // id callback retries it after resume has registered the session.
    expect(agent.abortCalls).toEqual(["native-resume", "native-resume"]);
  });

  it("without a cancel the early id changes nothing: the run completes normally", async () => {
    const { agent, client } = await harness();
    const pending = call(client, "kagero_run", { prompt: "calm" });
    await vi.waitFor(() => expect(agent.runs.has("calm")).toBe(true));
    agent.run("calm").reportId("native-calm");
    agent.run("calm").finish("completed", "native-calm");
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(agent.abortCalls).toEqual([]);
  });
});

describe("run tool descriptions state real per-backend support (README contract)", () => {
  it("documents which limits are supported, rejected, or only labels", async () => {
    const { client } = await harness();
    const { tools } = await client.listTools();
    const run = tools.find((tool) => tool.name === "kagero_run");
    const props = run?.inputSchema.properties as Record<string, { description?: string }>;
    expect(props["max_tool_calls"]?.description).toContain("No registered backend supports it");
    expect(props["max_turns"]?.description).toContain("ONLY by the claude backend");
    expect(props["timeout_ms"]?.description).toContain("pi-sdk, pi-rpc and claude-stream");
    expect(props["timeout_ms"]?.description).toContain("does NOT stop the background run");
    expect(props["thinking_effort"]?.description).toContain("claude (--effort)");
    expect(props["thinking_effort"]?.description).toContain("unsupported_capability");
    expect(props["native_overrides"]?.description).toContain("codex");
  });
});
