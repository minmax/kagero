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

// Fake diagnostic material: nothing here is a real credential.
const SECRET_BEARER = "abcdef0123456789SECRETBEARERTOKEN";
const SECRET_KEY = "sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZZZ";
const SECRET_ASSIGN = "hunter2-not-a-real-password";
const SECRET_COOKIES = ["COOKIESECRET-ONE", "COOKIESECRET-TWO", "COOKIESECRET-THREE"];
const PROMPT_CANARY = "PROMPT-CANARY-do-not-leak-4242 please refactor the billing module";

const isGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
};

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
  delete process.env["FAKE_ACP_HANG_INITIALIZE"];
  delete process.env["FAKE_ACP_STDERR"];
  delete process.env["FAKE_ACP_RECORD_PID"];
  delete process.env["FAKE_CLI_ERROR_TEXT"];
  delete process.env["FAKE_CLI_ERROR_PAD"];
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

  it("surfaces a bounded, sanitized stdout error when stderr is empty on exit-error", async () => {
    const agent = new CliSpecAgent(fakePrintSpec({}, { args: (ctx) => [FAKE_CLI, ctx.prompt] }));
    await withEnv(
      {
        FAKE_CLI_MODE: "claude-error",
        FAKE_CLI_EXIT_CODE: "1",
        FAKE_CLI_ERROR_PAD: "6000",
        // One header-style credential per line: a header value redacts to the end of its line.
        FAKE_CLI_ERROR_TEXT: `STRUCTURED-ERROR-MARKER invalid effort\nAuthorization: Bearer ${SECRET_BEARER}\nANTHROPIC_API_KEY=${SECRET_KEY}\npassword=${SECRET_ASSIGN}\nrequest was`,
      },
      async () => {
        const caught = await agent.prompt(PROMPT_CANARY).catch((err: unknown) => err);
        expect(caught).toBeInstanceOf(AgentError);
        const err = caught as AgentError;
        expect(err.code).toBe("cli_error");
        expect(err.context).toMatchObject({ exitCode: 1, stderrHead: "" });
        const diagnostic = String(err.context?.["stdoutDiagnostic"]);
        // The structured error survives; assistant text is not an error field.
        expect(diagnostic).toContain("STRUCTURED-ERROR-MARKER");
        expect(diagnostic).toContain("subtype=error_during_execution");
        expect(diagnostic).not.toContain("ASSISTANT-TEXT-NOT-AN-ERROR-FIELD");
        expect(err.message).toContain("exited with code 1: stdout: ");
        expect(err.message).toContain("STRUCTURED-ERROR-MARKER");
        // Bounded.
        expect(diagnostic.length).toBeLessThanOrEqual(2_000);
        expect(err.message.length).toBeLessThan(2_300);
        // No prompt, no secrets — anywhere a caller can see.
        const surfaced = `${err.message}\n${JSON.stringify(err.context)}`;
        expect(surfaced).not.toContain("PROMPT-CANARY");
        expect(surfaced).not.toContain("billing module");
        for (const secret of [SECRET_BEARER, SECRET_KEY, SECRET_ASSIGN]) {
          expect(surfaced).not.toContain(secret);
        }
        expect(diagnostic).toContain("[REDACTED]");
        expect(diagnostic).toContain("[PROMPT]");
      },
    );
  });

  it("falls back to a bounded sanitized stdout tail when stdout has no structured error", async () => {
    const agent = new CliSpecAgent(fakePrintSpec({}, { args: (ctx) => [FAKE_CLI, ctx.prompt] }));
    // dsh mode prints one completed RunReport on stdout; exit 2 makes it a CLI failure.
    await withEnv({ FAKE_CLI_MODE: "dsh", FAKE_CLI_EXIT_CODE: "2" }, async () => {
      const caught = await agent.prompt(PROMPT_CANARY).catch((err: unknown) => err);
      expect(caught).toBeInstanceOf(AgentError);
      const err = caught as AgentError;
      expect(err.code).toBe("cli_error");
      const diagnostic = String(err.context?.["stdoutDiagnostic"]);
      expect(diagnostic.length).toBeLessThanOrEqual(1_000);
      expect(`${err.message}${JSON.stringify(err.context)}`).not.toContain("PROMPT-CANARY");
      expect(diagnostic).toContain("[PROMPT]");
    });
  });

  it("redacts the prompt and secrets from stderr on exit-error and bounds the head", async () => {
    const agent = new CliSpecAgent(fakePrintSpec({}, { args: (ctx) => [FAKE_CLI, ctx.prompt] }));
    const stderr = `boom ${PROMPT_CANARY} token=${SECRET_KEY}\n${"filler line\n".repeat(500)}`;
    await withEnv({ FAKE_CLI_EXIT_CODE: "3", FAKE_CLI_STDERR: stderr }, async () => {
      const caught = await agent.prompt(PROMPT_CANARY).catch((err: unknown) => err);
      const err = caught as AgentError;
      expect(err.code).toBe("cli_error");
      expect(String(err.context?.["stderrHead"]).length).toBeLessThanOrEqual(2_000);
      const surfaced = `${err.message}${JSON.stringify(err.context)}`;
      expect(surfaced).toContain("boom [PROMPT] token=[REDACTED]");
      expect(surfaced).not.toContain("PROMPT-CANARY");
      expect(surfaced).not.toContain(SECRET_KEY);
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
  it("reports initialize timeout as an ACP handshake failure", async () => {
    await withEnv({ FAKE_ACP_HANG_INITIALIZE: "1" }, async () => {
      const spec = fakeAcpSpec();
      const agent = new CliSpecAgent({
        ...spec,
        acp: { ...spec.acp!, handshakeTimeoutMs: 30 },
      });
      const result = await guard(agent.prompt("hello"));
      expect(result).toBeInstanceOf(AgentError);
      expect((result as AgentError).code).toBe("acp_initialize_failed");
      expect((result as AgentError).message).toContain("initialize handshake timed out");
      expect((result as AgentError).context).toMatchObject({ phase: "initialize", cwd: expect.any(String) });
      await agent.dispose();
    });
  });

  it("surfaces a bounded sanitized stderr tail on an initialize timeout and finishes the stop ladder", async () => {
    const stderr = [
      "filler line\n".repeat(700), // 8.4 KB: older than both the 4 KB capture and the 2 KB cap
      `echoed request: ${PROMPT_CANARY}`,
      `Authorization: Bearer ${SECRET_BEARER}`,
      `ANTHROPIC_API_KEY=${SECRET_KEY}`,
      `Cookie: session=${SECRET_COOKIES[0]}; csrftoken=${SECRET_COOKIES[1]}; theme=dark`,
      `Set-Cookie: sid=${SECRET_COOKIES[2]}; Path=/; HttpOnly; SameSite=Lax`,
      "FAKE-ACP-DIAG-MARKER agent-name migration waiting for lock",
    ].join("\n");
    const pidLog = join(workspaceDir, "acp-init-timeout.ndjson");
    await withEnv(
      {
        FAKE_ACP_HANG_INITIALIZE: "1",
        FAKE_ACP_STDERR: stderr,
        FAKE_ACP_RECORD_PID: "1",
        FAKE_ACP_LOG: pidLog,
      },
      async () => {
        const spec = fakeAcpSpec();
        const agent = new CliSpecAgent({ ...spec, acp: { ...spec.acp!, handshakeTimeoutMs: 1_500 } });
        const result = await guard(agent.prompt(PROMPT_CANARY, { workspace: { path: workspaceDir } }));
        expect(result).toBeInstanceOf(AgentError);
        const err = result as AgentError;

        // Code and phase mapping are unchanged.
        expect(err.code).toBe("acp_initialize_failed");
        expect(err.message).toContain("initialize handshake timed out after 1500 ms");
        expect(err.context).toMatchObject({ phase: "initialize", cwd: expect.any(String) });

        // The recognizable diagnostic survives, bounded and sanitized.
        const tail = String(err.context?.["stderrTail"]);
        expect(tail).toContain("FAKE-ACP-DIAG-MARKER agent-name migration waiting for lock");
        expect(tail.length).toBeLessThanOrEqual(2_000);
        expect(err.message).toContain("child stderr tail: ");
        expect(err.message).toContain("FAKE-ACP-DIAG-MARKER");
        expect(err.message.length).toBeLessThan(2_300);
        expect(tail).toContain("[REDACTED]");
        expect(tail).toContain("[PROMPT]");

        // No prompt, no secret-like strings in the message or the context.
        const surfaced = `${err.message}\n${JSON.stringify(err.context)}`;
        expect(surfaced).not.toContain("PROMPT-CANARY");
        expect(surfaced).not.toContain("billing module");
        expect(surfaced).not.toContain(SECRET_BEARER);
        expect(surfaced).not.toContain(SECRET_KEY);
        for (const cookie of SECRET_COOKIES) expect(surfaced).not.toContain(cookie);
        expect(surfaced).not.toContain("HttpOnly");

        // The stop ladder completed: the throw waits for dispose, so the child is gone.
        const initRecord = readFileSync(pidLog, "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as { method?: string; pid?: number })
          .find((entry) => entry.method === "initialize");
        expect(typeof initRecord?.pid).toBe("number");
        expect(isGone(initRecord?.pid ?? 0)).toBe(true);
        await agent.dispose();
      },
    );
  });

  for (const shortPrompt of ["x", "ab", "help"]) {
    it(`never lets a ${shortPrompt.length}-character prompt through the initialize stderr tail`, async () => {
      const stderr = `request echoed: ${shortPrompt}\nsecond echo (${shortPrompt}) ${shortPrompt.toUpperCase()}\nFAKE-ACP-DIAG-MARKER lock wait`;
      await withEnv({ FAKE_ACP_HANG_INITIALIZE: "1", FAKE_ACP_STDERR: stderr }, async () => {
        const spec = fakeAcpSpec();
        // Allow slower CI hosts to start the fake child before testing stderr redaction.
        const agent = new CliSpecAgent({ ...spec, acp: { ...spec.acp!, handshakeTimeoutMs: 2_500 } });
        const err = (await guard(
          agent.prompt(shortPrompt, { workspace: { path: workspaceDir } }),
        )) as AgentError;
        // Error code and phase are preserved while the echo is redacted.
        expect(err.code).toBe("acp_initialize_failed");
        expect(err.context).toMatchObject({ phase: "initialize" });
        const tail = String(err.context?.["stderrTail"]);
        expect(tail).toContain("FAKE-ACP-DIAG-MARKER");
        expect(tail).toContain("request echoed: [PROMPT]");
        const standalone = new RegExp(`(^|[^\\p{L}\\p{N}_])${shortPrompt}([^\\p{L}\\p{N}_]|$)`, "iu");
        expect(tail).not.toMatch(standalone);
        expect(err.message).not.toMatch(standalone);
        await agent.dispose();
      });
    });
  }

  it("never lets a one-character prompt through the print stdout diagnostic or stderr head", async () => {
    const agent = new CliSpecAgent(fakePrintSpec({}, { args: (ctx) => [FAKE_CLI, ctx.prompt] }));
    await withEnv(
      {
        FAKE_CLI_MODE: "claude-error",
        FAKE_CLI_EXIT_CODE: "1",
        FAKE_CLI_ERROR_TEXT: "STRUCTURED-ERROR-MARKER bad input",
        FAKE_CLI_STDERR: "stderr echo: x",
      },
      async () => {
        const err = (await agent.prompt("x").catch((e: unknown) => e)) as AgentError;
        expect(err.code).toBe("cli_error");
        expect(String(err.context?.["stdoutDiagnostic"])).toContain("STRUCTURED-ERROR-MARKER");
        const surfaced = `${String(err.context?.["stdoutDiagnostic"])}\n${String(err.context?.["stderrHead"])}`;
        expect(surfaced).toContain("[prompt: [PROMPT]]");
        expect(surfaced).toContain("stderr echo: [PROMPT]");
        expect(surfaced).not.toMatch(/(^|[^\p{L}\p{N}_])x([^\p{L}\p{N}_]|$)/u);
      },
    );
  });

  it("drops a >4 KiB Cookie line cut by the stderr tail cap instead of leaking its unlabelled remainder", async () => {
    // 8.4 KB on one line: the 4 KB tail capture starts inside it, after the "Cookie:" label.
    const stderr = `Cookie: ${"session=COOKIESECRET-LONG; ".repeat(300)}\nFAKE-ACP-DIAG-MARKER lock wait`;
    await withEnv({ FAKE_ACP_HANG_INITIALIZE: "1", FAKE_ACP_STDERR: stderr }, async () => {
      const spec = fakeAcpSpec();
      const agent = new CliSpecAgent({ ...spec, acp: { ...spec.acp!, handshakeTimeoutMs: 1_000 } });
      const err = (await guard(
        agent.prompt("hello world", { workspace: { path: workspaceDir } }),
      )) as AgentError;
      expect(err.code).toBe("acp_initialize_failed");
      const tail = String(err.context?.["stderrTail"]);
      expect(tail).toContain("FAKE-ACP-DIAG-MARKER lock wait");
      const surfaced = `${err.message}\n${JSON.stringify(err.context)}`;
      expect(surfaced).not.toContain("COOKIESECRET");
      expect(surfaced).not.toContain("session=");
      await agent.dispose();
    });
  });

  it("suppresses child output but keeps code and phase when padding hides the prompt from bounded sampling", async () => {
    const hiddenPrompt = `${" ".repeat(70_000)}help${" ".repeat(70_000)}`;
    await withEnv(
      {
        FAKE_ACP_HANG_INITIALIZE: "1",
        FAKE_ACP_STDERR: "request echoed: help\nHELP failed\nFAKE-ACP-DIAG-MARKER",
      },
      async () => {
        const spec = fakeAcpSpec();
        const agent = new CliSpecAgent({ ...spec, acp: { ...spec.acp!, handshakeTimeoutMs: 800 } });
        const err = (await guard(
          agent.prompt(hiddenPrompt, { workspace: { path: workspaceDir } }),
        )) as AgentError;
        expect(err.code).toBe("acp_initialize_failed");
        expect(err.context).toMatchObject({ phase: "initialize" });
        const surfaced = `${err.message}\n${JSON.stringify(err.context)}`;
        expect(surfaced).not.toMatch(/help/i);
        expect(surfaced).not.toContain("FAKE-ACP-DIAG-MARKER");
        expect(String(err.context?.["stderrTail"])).toContain("diagnostic suppressed");
        await agent.dispose();
      },
    );
  });

  it("omits the stderr tail fields when the child wrote nothing before the initialize timeout", async () => {
    await withEnv({ FAKE_ACP_HANG_INITIALIZE: "1" }, async () => {
      const spec = fakeAcpSpec();
      const agent = new CliSpecAgent({ ...spec, acp: { ...spec.acp!, handshakeTimeoutMs: 100 } });
      const err = (await guard(agent.prompt("hello world"))) as AgentError;
      expect(err.code).toBe("acp_initialize_failed");
      expect(err.message).not.toContain("child stderr tail");
      expect(err.context).not.toHaveProperty("stderrTail");
      await agent.dispose();
    });
  });

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
      let opened!: () => void;
      const sessionOpened = new Promise<void>((resolve) => {
        opened = resolve;
      });
      const unsubscribe = agent.subscribe("*", (event) => {
        if (event.type === "session-start" && event.sessionId === "sess-fake-1") opened();
      });
      const pending = guard(agent.prompt("hold"));
      await sessionOpened;
      await agent.abort("sess-fake-1");
      const response = await pending;
      unsubscribe();
      expect(response).not.toBeInstanceOf(Error);
      expect((response as AgentResponse).status).toBe("aborted");
      expect((response as AgentResponse).meta?.partial).toBe(true);
      await agent.dispose();
    });
  }, 15_000);

  it("steers a live turn: cancel then re-prompt with the steering text", async () => {
    await withEnv({ FAKE_ACP_MODE: "wait" }, async () => {
      const agent = new CliSpecAgent(fakeAcpSpec());
      const opened = new Promise<void>((resolve) => {
        const unsubscribe = agent.subscribe("*", (event) => {
          if (event.type === "session-start" && event.sessionId === "sess-fake-1") {
            unsubscribe();
            resolve();
          }
        });
      });
      const pending = guard(agent.prompt("original"));
      await opened;
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
      const opened = new Promise<void>((resolve) => {
        const unsubscribe = agent.subscribe("*", (event) => {
          if (event.type === "session-start" && event.sessionId === "sess-fake-1") {
            unsubscribe();
            resolve();
          }
        });
      });
      // Attach the handler before dispose so the rejection is never unhandled.
      const guarded = guard(agent.prompt("hold"));
      await opened;
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
