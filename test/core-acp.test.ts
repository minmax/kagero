// AcpClient contract tests against a fake ACP agent (test/helpers/fake-acp-server.mjs)
// speaking JSON-RPC NDJSON over stdio.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { AcpClient } from "../packages/core/src/acp.js";
import type { AgentEvent } from "../packages/core/src/agent.js";

const TIMEOUT = 15_000;

const helpersDir = fileURLToPath(new URL("./helpers", import.meta.url));
const fakeServer = join(helpersDir, "fake-acp-server.mjs");

const workspace = mkdtempSync(join(tmpdir(), "kagero-acp-"));

type LogEntry = Record<string, unknown>;

const clients: AcpClient[] = [];

interface ClientSpec {
  readonly env?: Record<string, string>;
  readonly onEvent?: (e: AgentEvent, sessionId: string) => void;
  readonly permissionOption?: string;
  readonly protocolVersion?: number | string;
}

function makeClient(spec: ClientSpec = {}): { client: AcpClient; logPath: string } {
  const logPath = join(workspace, `acp-${clients.length + 1}.ndjson`);
  const client = new AcpClient({
    command: ["node", fakeServer],
    cwd: workspace,
    env: { ...process.env, FAKE_ACP_LOG: logPath, ...spec.env },
    onEvent: spec.onEvent ?? (() => {}),
    ...(spec.permissionOption !== undefined ? { permissionOption: spec.permissionOption } : {}),
    ...(spec.protocolVersion !== undefined ? { protocolVersion: spec.protocolVersion } : {}),
  });
  clients.push(client);
  return { client, logPath };
}

function readLog(path: string): LogEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LogEntry);
}

function methodOf(entry: LogEntry | undefined): string {
  return typeof entry?.method === "string" ? entry.method : "";
}

function paramsOf(entry: LogEntry | undefined): Record<string, unknown> {
  const params = entry?.params;
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

async function waitForLog(path: string, probe: (entry: LogEntry) => boolean): Promise<LogEntry[]> {
  for (let waited = 0; waited < 5_000; waited += 50) {
    if (existsSync(path)) {
      const entries = readLog(path);
      if (entries.some(probe)) return entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the fake ACP log never matched: ${path}`);
}

async function openSession(client: AcpClient): Promise<string> {
  await client.start();
  await client.initialize();
  return client.newSession({});
}

afterAll(async () => {
  await Promise.all(clients.map((client) => client.dispose()));
  rmSync(workspace, { recursive: true, force: true });
});

describe("AcpClient handshake and sessions", () => {
  it("initializes, opens sess-fake-1 and applies mode/config options", { timeout: TIMEOUT }, async () => {
    const { client, logPath } = makeClient();
    try {
      await client.start();
      await client.initialize();
      const sessionId = await client.newSession({
        mcpServers: [{ name: "fs" }],
        meta: { grok: { yoloMode: true } },
        modeId: "yolo",
        configOptions: [{ configId: "model", value: "grok-4" }],
      });
      expect(sessionId).toBe("sess-fake-1");
      expect(client.sessionId).toBe("sess-fake-1");

      const entries = readLog(logPath);
      const methods = entries.map((entry) => methodOf(entry));
      expect(methods[0]).toBe("initialize");
      expect(methods.indexOf("session/new")).toBeLessThan(methods.indexOf("session/set_mode"));
      expect(methods.indexOf("session/set_mode")).toBeLessThan(methods.indexOf("session/set_config_option"));

      const created = paramsOf(entries.find((entry) => methodOf(entry) === "session/new"));
      expect(created["cwd"]).toBe(workspace);
      expect(created["mcpServers"]).toEqual([{ name: "fs" }]);
      expect(created["_meta"]).toEqual({ grok: { yoloMode: true } });

      const mode = paramsOf(entries.find((entry) => methodOf(entry) === "session/set_mode"));
      expect(mode).toMatchObject({ sessionId: "sess-fake-1", modeId: "yolo" });

      const option = paramsOf(entries.find((entry) => methodOf(entry) === "session/set_config_option"));
      expect(option).toMatchObject({ sessionId: "sess-fake-1", configId: "model", value: "grok-4" });
    } finally {
      await client.dispose();
    }
  });

  it("sends protocolVersion 1 (integer) by default and the configured override verbatim", {
    timeout: TIMEOUT,
  }, async () => {
    // Default: the integer 1.
    const fallback = makeClient();
    try {
      await fallback.client.start();
      await fallback.client.initialize();
      const entries = await waitForLog(fallback.logPath, (entry) => methodOf(entry) === "initialize");
      const params = paramsOf(entries.find((entry) => methodOf(entry) === "initialize"));
      expect(params["protocolVersion"]).toBe(1);
    } finally {
      await fallback.client.dispose();
    }

    // Override: grok wants the STRING "1" on the wire.
    const stringVersion = makeClient({ protocolVersion: "1" });
    try {
      await stringVersion.client.start();
      await stringVersion.client.initialize();
      const entries = await waitForLog(stringVersion.logPath, (entry) => methodOf(entry) === "initialize");
      const params = paramsOf(entries.find((entry) => methodOf(entry) === "initialize"));
      expect(params["protocolVersion"]).toBe("1");
    } finally {
      await stringVersion.client.dispose();
    }
  });

  it("resumes with session/load and reports the session id", { timeout: TIMEOUT }, async () => {
    const { client, logPath } = makeClient();
    try {
      await client.start();
      await client.initialize();
      const sessionId = await client.loadSession("sess-existing-7", { meta: { resumed: true } });
      expect(sessionId).toBe("sess-existing-7");
      expect(client.sessionId).toBe("sess-existing-7");

      const loaded = paramsOf(readLog(logPath).find((entry) => methodOf(entry) === "session/load"));
      expect(loaded["sessionId"]).toBe("sess-existing-7");
      expect(loaded["_meta"]).toEqual({ resumed: true });

      // The loaded session takes prompts.
      await expect(client.prompt("hello")).resolves.toEqual({ stopReason: "end_turn", text: "Hello world" });
    } finally {
      await client.dispose();
    }
  });
});

describe("AcpClient turns", () => {
  it("streams assistant text and tool calls through onEvent, aggregates the text", {
    timeout: TIMEOUT,
  }, async () => {
    const events: AgentEvent[] = [];
    const sessionIds: string[] = [];
    const { client } = makeClient({
      env: { FAKE_ACP_TOOL_CALL: "1" },
      onEvent: (e, sessionId) => {
        events.push(e);
        sessionIds.push(sessionId);
      },
    });
    try {
      await openSession(client);
      const result = await client.prompt("hello");
      expect(result).toEqual({ stopReason: "end_turn", text: "Hello world" });

      const texts = events.flatMap((e) => (e.type === "assistant-text" ? [e.content] : []));
      expect(texts).toEqual(["Hello ", "world"]);

      const tools = events.flatMap((e) => (e.type === "tool-call" ? [e] : []));
      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe("Write");
      expect(tools[0]?.args).toEqual({ path: "note.md", content: "hi" });

      for (const event of events) expect(typeof event.at).toBe("string");
      expect(sessionIds.every((sessionId) => sessionId === "sess-fake-1")).toBe(true);
    } finally {
      await client.dispose();
    }
  });

  it("resolves a cancelled turn with stopReason cancelled", { timeout: TIMEOUT }, async () => {
    const { client, logPath } = makeClient({ env: { FAKE_ACP_MODE: "wait" } });
    try {
      await openSession(client);
      const turn = client.prompt("hold");
      client.cancel();
      await expect(turn).resolves.toEqual({ stopReason: "cancelled", text: "" });
      await waitForLog(logPath, (entry) => methodOf(entry) === "session/cancel");
    } finally {
      await client.dispose();
    }
  });

  it("cancels the turn when the registered abort signal fires", { timeout: TIMEOUT }, async () => {
    const { client } = makeClient({ env: { FAKE_ACP_MODE: "wait" } });
    try {
      await openSession(client);
      const controller = new AbortController();
      client.abortWith(controller.signal);
      const turn = client.prompt("hold");
      controller.abort();
      await expect(turn).resolves.toEqual({ stopReason: "cancelled", text: "" });
    } finally {
      await client.dispose();
    }
  });

  it("steers: cancels the turn and re-prompts with the steering text", { timeout: TIMEOUT }, async () => {
    const { client, logPath } = makeClient({ env: { FAKE_ACP_MODE: "wait" } });
    try {
      await openSession(client);
      const turn = client.prompt("hold");
      client.steer("turn left");
      const result = await turn;
      expect(result.stopReason).toBe("end_turn");
      expect(result.text).toBe("steered:turn left");

      const entries = await waitForLog(
        logPath,
        (entry) => methodOf(entry) === "session/prompt" && entry.text === "turn left",
      );
      const prompts = entries.filter((entry) => methodOf(entry) === "session/prompt");
      expect(prompts).toHaveLength(2);
      expect(prompts[0]?.text).toBe("hold");
      expect(prompts[1]?.text).toBe("turn left");
      expect(entries.some((entry) => methodOf(entry) === "session/cancel")).toBe(true);
    } finally {
      await client.dispose();
    }
  });

  it("sends the queued follow-up prompt after the turn settles", { timeout: TIMEOUT }, async () => {
    const { client, logPath } = makeClient();
    try {
      await openSession(client);
      const turn = client.prompt("go");
      client.followUp("after this");
      await turn;
      await waitForLog(
        logPath,
        (entry) =>
          methodOf(entry) === "session/prompt" && entry.notification === true && entry.text === "after this",
      );
    } finally {
      await client.dispose();
    }
  });
});

describe("AcpClient permissions and failures", () => {
  it("answers session/request_permission with the configured option", { timeout: TIMEOUT }, async () => {
    // Default: approve_once.
    const once = makeClient({ env: { FAKE_ACP_ASK_PERMISSION: "1" } });
    try {
      await openSession(once.client);
      await expect(once.client.prompt("go")).resolves.toEqual({
        stopReason: "end_turn",
        text: "Hello world",
      });
      const entries = await waitForLog(once.logPath, (entry) => entry.permissionResponse !== undefined);
      const request = entries.find((entry) => entry.permissionRequest !== undefined)?.permissionRequest;
      expect(request).toMatchObject({ id: 1001 });
      const answer = entries.find((entry) => entry.permissionResponse !== undefined)?.permissionResponse;
      expect(answer).toEqual({ outcome: { outcome: "selected", optionId: "approve_once" } });
    } finally {
      await once.client.dispose();
    }

    // Explicit option: approve_always.
    const always = makeClient({ env: { FAKE_ACP_ASK_PERMISSION: "1" }, permissionOption: "approve_always" });
    try {
      await openSession(always.client);
      await always.client.prompt("go");
      const entries = await waitForLog(always.logPath, (entry) => entry.permissionResponse !== undefined);
      const answer = entries.find((entry) => entry.permissionResponse !== undefined)?.permissionResponse;
      expect(answer).toEqual({ outcome: { outcome: "selected", optionId: "approve_always" } });
    } finally {
      await always.client.dispose();
    }
  });

  it("rejects pending requests when the ACP process exits", { timeout: TIMEOUT }, async () => {
    const client = new AcpClient({
      command: ["node", "-e", "process.exit(0)"],
      cwd: workspace,
      onEvent: () => {},
    });
    await client.start();
    await expect(client.initialize()).rejects.toThrow("the ACP process exited before replying");
    await client.dispose();
  });

  it("rejects start() when the binary cannot spawn", { timeout: TIMEOUT }, async () => {
    const client = new AcpClient({
      command: ["/nonexistent/kagero-acp-probe"],
      cwd: workspace,
      onEvent: () => {},
    });
    await expect(client.start()).rejects.toThrow(/failed to spawn the ACP process/);
    await client.dispose();
  });

  it("rejects the handshake on timeout", { timeout: TIMEOUT }, async () => {
    const client = new AcpClient({
      command: ["node", "-e", "setInterval(() => {}, 1000)"],
      cwd: workspace,
      onEvent: () => {},
    });
    try {
      await client.start();
      await expect(client.initialize(200)).rejects.toThrow("the initialize handshake timed out after 200 ms");
    } finally {
      await client.dispose();
    }
  });
});
