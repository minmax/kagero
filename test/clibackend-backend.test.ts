// CliSpecAgent contract tests against a fake headless CLI (test/helpers/fake-cli.mjs)
// and a fake ACP agent (test/helpers/fake-acp-server.mjs). Real CLIs are never spawned.
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliSpec, PrintTransport } from "@kagero/cli-backend";
import { CliSpecAgent } from "@kagero/cli-backend";
import type { AgentEvent, AgentResponse } from "@kagero/core";
import { AgentError } from "@kagero/core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClaudeLineage } from "../packages/cli-backend/src/parse/claude-lineage.js";

const FAKE_CLI = fileURLToPath(new URL("./helpers/fake-cli.mjs", import.meta.url));
const FAKE_ACP = fileURLToPath(new URL("./helpers/fake-acp-server.mjs", import.meta.url));

/** Run `fn` with the given env vars set, restoring the previous values afterwards. */
const withEnv = async (values: Record<string, string>, fn: () => Promise<void>): Promise<void> => {
  const entries = Object.entries(values);
  const prev = entries.map(([name]) => process.env[name]);
  try {
    for (const [name, value] of entries) process.env[name] = value;
    await fn();
  } finally {
    entries.forEach(([name], index) => {
      const previous = prev[index];
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
};

interface RecordedCall {
  readonly cwd: string;
  readonly args: string[];
}

const readArgvLog = (file: string): RecordedCall[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RecordedCall);

/** A print spec whose binary is node running the fake CLI script. */
function fakePrintSpec(overrides: Partial<CliSpec> = {}, print: Partial<PrintTransport> = {}): CliSpec {
  const base: PrintTransport = {
    resumeCapable: true,
    args: (ctx) => [FAKE_CLI, "--session-id", ctx.runSessionId ?? "sess-unset", ctx.prompt],
    parse: (stdout) => parseClaudeLineage(stdout, { usageStyle: "claude" }),
  };
  return {
    name: "fake-cli",
    binary: "fake-cli",
    binaryEnvVar: "KAGERO_TEST_FAKE_CLI_BIN",
    defaultTransport: "print",
    print: { ...base, ...print },
    ...overrides,
  };
}

function fakeAcpSpec(): CliSpec {
  return {
    name: "fake-acp",
    binary: "fake-acp-node",
    binaryEnvVar: "KAGERO_TEST_FAKE_ACP_BIN",
    defaultTransport: "acp",
    acp: {
      args: [FAKE_ACP],
      protocolVersion: 1,
    },
  };
}

const collectEvents = (agent: CliSpecAgent): { events: AgentEvent[]; unsubscribe: () => void } => {
  const events: AgentEvent[] = [];
  const unsubscribe = agent.subscribe("*", (e) => events.push(e));
  return { events, unsubscribe };
};

/** Attach a handler immediately so a rejection is never unhandled while we wait. */
const guard = <T>(promise: Promise<T>): Promise<T | Error> => promise.catch((err: unknown) => err as Error);

let workspaceDir: string;
let argvLog: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "kagero-cli-test-"));
  argvLog = join(workspaceDir, "argv.jsonl");
  process.env["KAGERO_TEST_FAKE_CLI_BIN"] = process.execPath;
  process.env["KAGERO_TEST_FAKE_ACP_BIN"] = process.execPath;
});

afterEach(() => {
  delete process.env["FAKE_CLI_ARGV_LOG"];
  delete process.env["FAKE_CLI_MODE"];
  delete process.env["FAKE_CLI_SLEEP_MS"];
  delete process.env["FAKE_CLI_REPORT_MODEL"];
  delete process.env["FAKE_CLI_NO_RESULT"];
  delete process.env["FAKE_CLI_RESULT_ERROR"];
  delete process.env["FAKE_CLI_EXIT_CODE"];
  delete process.env["FAKE_CLI_STDERR"];
  delete process.env["FAKE_ACP_MODE"];
  delete process.env["FAKE_ACP_LOG"];
});

afterAll(() => {
  delete process.env["KAGERO_TEST_FAKE_CLI_BIN"];
  delete process.env["KAGERO_TEST_FAKE_ACP_BIN"];
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
});

// --- print transport ----------------------------------------------------------------

describe("CliSpecAgent — print transport", () => {
  it("resolves a happy path: text, sessionId, reported model, usage, workspace echo", async () => {
    const agent = new CliSpecAgent(
      fakePrintSpec(
        {},
        {
          args: (ctx) => [FAKE_CLI, "--session-id", "sess-known", ctx.prompt],
        },
      ),
    );
    const response = await agent.prompt("Say FAKE-ANSWER", {
      modelId: "fake-super-model",
      workspace: { path: workspaceDir },
    });
    expect(response.status).toBe("completed");
    expect(response.text).toBe("Say FAKE-ANSWER");
    expect(response.sessionId).toBe("sess-known");
    // The CLI reports a model (init/assistant/modelUsage all say fake-default-model).
    expect(response.modelSource).toBe("reported");
    expect(response.modelId).toBe("fake-default-model");
    expect(response.workspace).toBe(workspaceDir);
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
    expect(response.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: 0.01,
    });
    expect(response.meta?.partial).toBeUndefined();
    expect(response.meta?.truncated).toBeUndefined();
  });

  it("echoes the requested model when the CLI stayed silent (modelSource requested)", async () => {
    await withEnv({ FAKE_CLI_REPORT_MODEL: "0" }, async () => {
      const agent = new CliSpecAgent(fakePrintSpec());
      const response = await agent.prompt("hello", { modelId: "requested-model" });
      expect(response.modelId).toBe("requested-model");
      expect(response.modelSource).toBe("requested");
    });
  });

  it("builds resume argv with the resume flag and the session id", async () => {
    await withEnv({ FAKE_CLI_ARGV_LOG: argvLog }, async () => {
      const agent = new CliSpecAgent(
        fakePrintSpec(
          {},
          {
            args: (ctx) => {
              const resume = ctx.mode === "resume" && ctx.sessionId !== undefined;
              return [
                FAKE_CLI,
                ...(resume
                  ? ["--resume", ctx.sessionId as string]
                  : ["--session-id", ctx.runSessionId ?? "x"]),
                ctx.prompt,
              ];
            },
          },
        ),
      );
      const response = await agent.resume("sess-42", "continue", { workspace: { path: workspaceDir } });
      expect(response.sessionId).toBe("sess-42");
      const call = readArgvLog(argvLog).at(-1);
      expect(call?.args).toContain("--resume");
      expect(call?.args).toContain("sess-42");
      expect(call?.args).not.toContain("--session-id");
      // macOS /var → /private/var: compare through realpath.
      expect(realpathSync(call?.cwd ?? "/")).toBe(realpathSync(workspaceDir));
    });
  });

  it("maps a deadline to status timed-out with meta.partial", async () => {
    const agent = new CliSpecAgent(
      fakePrintSpec(
        {},
        {
          args: (ctx) => [FAKE_CLI, ctx.prompt],
        },
      ),
    );
    await withEnv({ FAKE_CLI_MODE: "sleep", FAKE_CLI_SLEEP_MS: "5000" }, async () => {
      const response = await agent.prompt("slow", { timeoutMs: 300 });
      expect(response.status).toBe("timed-out");
      expect(response.meta?.partial).toBe(true);
    });
  }, 15_000);

  it("maps abort() to status aborted (upfront session id)", async () => {
    const agent = new CliSpecAgent(
      fakePrintSpec(
        { newSessionId: () => "sess-abort-me" },
        {
          args: (ctx) => [FAKE_CLI, "--session-id", ctx.runSessionId ?? "?", ctx.prompt],
        },
      ),
    );
    await withEnv({ FAKE_CLI_MODE: "sleep", FAKE_CLI_SLEEP_MS: "5000" }, async () => {
      const pending = guard(agent.prompt("abort me"));
      // Let the run register, then abort through the well-known session key.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await agent.abort("sess-abort-me");
      const response = await pending;
      expect(response).not.toBeInstanceOf(Error);
      expect((response as AgentResponse).status).toBe("aborted");
      expect((response as AgentResponse).sessionId).toBe("sess-abort-me");
      expect((response as AgentResponse).meta?.partial).toBe(true);
    });
  }, 15_000);

  it("throws AgentError('cli_error') with the stderr head on exit-error", async () => {
    const agent = new CliSpecAgent(fakePrintSpec({}, { args: () => [FAKE_CLI] }));
    await withEnv({ FAKE_CLI_EXIT_CODE: "3", FAKE_CLI_STDERR: "boom: bad flag" }, async () => {
      const caught = await agent.prompt("x").catch((err: unknown) => err);
      expect(caught).toBeInstanceOf(AgentError);
      const err = caught as AgentError;
      expect(err.code).toBe("cli_error");
      expect(err.context).toMatchObject({ exitCode: 3 });
      expect(err.message).toContain("boom: bad flag");
    });
  });

  it("throws AgentError('spawn_failed') when the file cannot be executed", async () => {
    const notExecutable = join(workspaceDir, "not-executable");
    writeFileSync(notExecutable, "#!/bin/sh\nexit 0\n");
    chmodSync(notExecutable, 0o644);
    process.env["KAGERO_TEST_NO_BIN"] = notExecutable;
    try {
      const agent = new CliSpecAgent({
        name: "no-such-cli",
        binary: "kagero-no-such-binary-xyz",
        binaryEnvVar: "KAGERO_TEST_NO_BIN",
        defaultTransport: "print",
        print: {
          resumeCapable: false,
          args: (ctx) => [ctx.prompt],
          parse: () => ({ text: "" }),
        },
      });
      const caught = await agent.prompt("x").catch((err: unknown) => err);
      expect(caught).toBeInstanceOf(AgentError);
      expect((caught as AgentError).code).toBe("spawn_failed");
    } finally {
      delete process.env["KAGERO_TEST_NO_BIN"];
    }
  });

  it("surfaces a CLI-reported error result as AgentError, not text", async () => {
    const agent = new CliSpecAgent(fakePrintSpec({}, { args: () => [FAKE_CLI] }));
    await withEnv({ FAKE_CLI_RESULT_ERROR: "1" }, async () => {
      const caught = await agent.prompt("x").catch((err: unknown) => err);
      expect(caught).toBeInstanceOf(AgentError);
      const err = caught as AgentError;
      expect(err.code).toBe("cli_error");
      expect(err.message).toContain("reached the turn limit");
    });
  });

  it("marks a run without a result envelope partial", async () => {
    const agent = new CliSpecAgent(fakePrintSpec({}, { args: (ctx) => [FAKE_CLI, ctx.prompt] }));
    await withEnv({ FAKE_CLI_NO_RESULT: "1" }, async () => {
      const response = await agent.prompt("x");
      expect(response.status).toBe("completed");
      expect(response.meta?.partial).toBe(true);
      expect(response.text).toBe("x");
    });
  });

  it("emits user-prompt, session-start and session-end around a run", async () => {
    const agent = new CliSpecAgent(
      fakePrintSpec(
        {},
        {
          args: (ctx) => [FAKE_CLI, "--session-id", "sess-events", ctx.prompt],
        },
      ),
    );
    const { events, unsubscribe } = collectEvents(agent);
    await agent.prompt("hi", { workspace: { path: workspaceDir } });
    unsubscribe();
    const types = events.map((e) => e.type);
    expect(types).toContain("user-prompt");
    expect(types).toContain("session-start");
    expect(types).toContain("session-end");
    const start = events.find((e) => e.type === "session-start");
    expect(start && start.type === "session-start" ? start.sessionId : undefined).toBe("sess-events");
    const end = events.find((e) => e.type === "session-end");
    expect(end && end.type === "session-end" ? end.reason : undefined).toBe("completed");
  });

  it("forwards raw stdout chunks to onStream", async () => {
    const agent = new CliSpecAgent(fakePrintSpec());
    const chunks: string[] = [];
    await agent.prompt("stream me", { onStream: (chunk) => chunks.push(chunk) });
    expect(chunks.join("")).toContain("stream me");
  });
});

// --- ACP transport --------------------------------------------------------------------

describe("CliSpecAgent — ACP transport", () => {
  it("runs a turn end-to-end: text, sessionId, session-start, no partial", async () => {
    const agent = new CliSpecAgent(fakeAcpSpec());
    const { events, unsubscribe } = collectEvents(agent);
    const response = await agent.prompt("hello acp");
    unsubscribe();
    expect(response.status).toBe("completed");
    expect(response.text).toBe("Hello world");
    expect(response.sessionId).toBe("sess-fake-1");
    expect(response.meta?.partial).toBeUndefined();
    const start = events.find((e) => e.type === "session-start");
    expect(start && start.type === "session-start" ? start.sessionId : undefined).toBe("sess-fake-1");
    const text = events.find((e) => e.type === "assistant-text");
    expect(text && text.type === "assistant-text" ? text.content : undefined).toBe("Hello ");
    await agent.dispose();
  });

  it("maps abort() to status aborted through in-protocol cancel", async () => {
    await withEnv({ FAKE_ACP_MODE: "wait" }, async () => {
      const agent = new CliSpecAgent(fakeAcpSpec());
      const pending = guard(agent.prompt("hold"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await agent.abort("sess-fake-1");
      const response = await pending;
      expect(response).not.toBeInstanceOf(Error);
      expect((response as AgentResponse).status).toBe("aborted");
      expect((response as AgentResponse).meta?.partial).toBe(true);
      await agent.dispose();
    });
  }, 15_000);

  it("steers a live turn: cancel then re-prompt with the steering text", async () => {
    await withEnv({ FAKE_ACP_MODE: "wait" }, async () => {
      const agent = new CliSpecAgent(fakeAcpSpec());
      const pending = guard(agent.prompt("original"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await agent.send("sess-fake-1", "go left", "steer");
      const response = await pending;
      expect(response).not.toBeInstanceOf(Error);
      expect((response as AgentResponse).status).toBe("completed");
      expect((response as AgentResponse).text).toBe("steered:go left");
      await agent.dispose();
    });
  }, 15_000);

  it("queues a follow-up after the turn settles", async () => {
    const log = join(workspaceDir, "acp.jsonl");
    await withEnv({ FAKE_ACP_LOG: log }, async () => {
      const agent = new CliSpecAgent(fakeAcpSpec());
      await agent.prompt("first");
      await agent.send("sess-fake-1", "and then", "follow_up");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const lines = readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line !== "");
      const followUp = lines
        .map((line) => JSON.parse(line) as { method?: string; text?: string; notification?: boolean })
        .find((e) => e.method === "session/prompt" && e.notification === true);
      expect(followUp?.text).toBe("and then");
      await agent.dispose();
    });
  }, 15_000);

  it("rejects send with unsupported_capability on a print-only spec", async () => {
    const agent = new CliSpecAgent(fakePrintSpec());
    const caught = await agent.send("whatever", "hi", "steer").catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).code).toBe("unsupported_capability");
    await agent.dispose();
  });

  it("refuses resume on a spec that cannot resume (dsh shape)", async () => {
    const agent = new CliSpecAgent({
      name: "no-resume",
      binary: "x",
      defaultTransport: "print",
      print: {
        resumeCapable: false,
        args: (ctx) => [ctx.prompt],
        parse: () => ({ text: "" }),
      },
    });
    const caught = await agent.resume("sess-1", "hi").catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).code).toBe("unsupported_capability");
  });
});

// --- discovery + lifecycle ------------------------------------------------------------

describe("CliSpecAgent — discovery and lifecycle", () => {
  it("throws unsupportedCapability for missing models/sessions/history", async () => {
    const agent = new CliSpecAgent(fakePrintSpec());
    for (const attempt of [agent.listModels(), agent.listSessions(), agent.history("s")]) {
      const caught = await attempt.catch((err: unknown) => err);
      expect(caught).toBeInstanceOf(AgentError);
      expect((caught as AgentError).code).toBe("unsupported_capability");
    }
  });

  it("runs a models command when the spec has one", async () => {
    const agent = new CliSpecAgent(
      fakePrintSpec({
        models: {
          args: () => [FAKE_CLI],
          parse: () => [
            {
              id: "m1",
              displayName: "m1",
              provider: "fake",
              contextWindow: 0,
              supportsTools: false,
              supportsVision: false,
            },
          ],
        },
      }),
    );
    const models = await agent.listModels();
    expect(models.map((m) => m.id)).toEqual(["m1"]);
  });

  it("delegates history to the spec reader", async () => {
    const agent = new CliSpecAgent(
      fakePrintSpec({
        history: {
          read: async (sessionId) => ({
            sessionId,
            entries: [{ index: 0, role: "user", text: "hello" }],
            totalEntries: 1,
            truncated: false,
          }),
        },
      }),
    );
    const history = await agent.history("sess-9");
    expect(history.sessionId).toBe("sess-9");
    expect(history.entries).toHaveLength(1);
  });

  it("abort on an unknown session is a no-op; prompt after dispose throws", async () => {
    const agent = new CliSpecAgent(fakePrintSpec());
    await expect(agent.abort("never-started")).resolves.toBeUndefined();
    await agent.dispose();
    const caught = await agent.prompt("x").catch((err: unknown) => err);
    expect(caught).toBeInstanceOf(AgentError);
  });

  it("dispose stops an in-flight ACP run", async () => {
    await withEnv({ FAKE_ACP_MODE: "wait" }, async () => {
      const agent = new CliSpecAgent(fakeAcpSpec());
      // Attach the handler before dispose so the rejection is never unhandled.
      const guarded = guard(agent.prompt("hold"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await agent.dispose();
      const caught = await guarded;
      expect(caught).toBeInstanceOf(AgentError);
    });
  }, 15_000);
});

// --- sanity bridge ----------------------------------------------------------------------

describe("print parse bridge", () => {
  it("parses a fake claude stream through the lineage parser", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m" }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "hi",
        session_id: "s1",
        usage: { input_tokens: 1 },
      }),
      "",
    ].join("\n");
    const parsed = parseClaudeLineage(stdout, { usageStyle: "claude" });
    expect(parsed.text).toBe("hi");
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.modelId).toBe("m");
  });
});
