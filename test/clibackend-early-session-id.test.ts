// Early native session identity (PromptOptions.onSessionId) and pre-turn
// cancellation on CliSpecAgent / ClaudeStreamAgent, against the fake ACP agent,
// the fake headless CLI and the fake live claude. Real CLIs are never spawned.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliSpec } from "@kagero/cli-backend";
import { CliSpecAgent } from "@kagero/cli-backend";
import type { AgentEvent } from "@kagero/core";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeStreamAgent } from "../packages/cli-backend/src/claude-stream.js";
import { parseClaudeLineage } from "../packages/cli-backend/src/parse/claude-lineage.js";

const FAKE_CLI = fileURLToPath(new URL("./helpers/fake-cli.mjs", import.meta.url));
const FAKE_ACP = fileURLToPath(new URL("./helpers/fake-acp-server.mjs", import.meta.url));
const FAKE_CLAUDE_STREAM = fileURLToPath(new URL("./helpers/fake-claude-stream.mjs", import.meta.url));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** ACP spec whose fake names its session after the prompt (`sid-<prompt>`), so parallel runs are distinguishable. */
function acpSpec(overrides: Partial<CliSpec> = {}): CliSpec {
  return {
    name: "fake-acp",
    binary: "fake-acp-node",
    binaryEnvVar: "KAGERO_TEST_FAKE_ACP_BIN",
    defaultTransport: "acp",
    acp: {
      args: [FAKE_ACP],
      protocolVersion: 1,
      extraArgs: (ctx) => ["--sid", `sid-${ctx.prompt}`],
    },
    ...overrides,
  };
}

function printSpec(overrides: Partial<CliSpec> = {}): CliSpec {
  return {
    name: "fake-cli",
    binary: "fake-cli",
    binaryEnvVar: "KAGERO_TEST_FAKE_CLI_BIN",
    defaultTransport: "print",
    print: {
      resumeCapable: true,
      args: (ctx) => [FAKE_CLI, "--session-id", ctx.runSessionId ?? "sess-unset", ctx.prompt],
      parse: (stdout) => parseClaudeLineage(stdout, { usageStyle: "claude" }),
    },
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kagero-early-id-"));
  process.env["KAGERO_TEST_FAKE_ACP_BIN"] = process.execPath;
  process.env["KAGERO_TEST_FAKE_CLI_BIN"] = process.execPath;
});

afterEach(() => {
  for (const name of ["FAKE_ACP_LOG", "FAKE_ACP_MODE", "FAKE_CLI_MODE", "FAKE_CLI_SLEEP_MS"])
    delete process.env[name];
  rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  delete process.env["KAGERO_TEST_FAKE_ACP_BIN"];
  delete process.env["KAGERO_TEST_FAKE_CLI_BIN"];
  delete process.env["CLAUDE_STREAM_BIN"];
});

const logLines = (file: string): { method?: string; text?: string }[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { method?: string; text?: string });

describe("CliSpecAgent — onSessionId (ACP)", () => {
  it("reports the native ACP id once, before the turn settles, equal to the response id", async () => {
    const agent = new CliSpecAgent(acpSpec());
    const order: string[] = [];
    const reported: string[] = [];
    agent.subscribe("*", (event: AgentEvent) => order.push(`event:${event.type}`));
    const response = await agent.prompt("one", {
      onSessionId: (id) => {
        reported.push(id);
        order.push("callback");
      },
    });
    expect(reported).toEqual(["sid-one"]);
    expect(response.sessionId).toBe("sid-one");
    // Same moment as the session-start event, strictly before the turn's end.
    expect(order.indexOf("callback")).toBeGreaterThan(order.indexOf("event:session-start"));
    expect(order.indexOf("callback")).toBeLessThan(order.indexOf("event:session-end"));
    await agent.dispose();
  }, 15_000);

  it("never exposes the generated placeholder id of a spec that also names print sessions upfront", async () => {
    const agent = new CliSpecAgent(acpSpec({ newSessionId: () => "00000000-0000-4000-8000-000000000000" }));
    const reported: string[] = [];
    const response = await agent.prompt("qw", { onSessionId: (id) => reported.push(id) });
    expect(reported).toEqual(["sid-qw"]);
    expect(reported.some((id) => UUID.test(id))).toBe(false);
    expect(response.sessionId).toBe("sid-qw");
    await agent.dispose();
  }, 15_000);

  it("attributes ids per run: concurrent runs never see each other's id", async () => {
    const agent = new CliSpecAgent(acpSpec());
    const seen: Record<string, string[]> = { a: [], b: [], c: [] };
    const responses = await Promise.all(
      (["a", "b", "c"] as const).map((name) =>
        agent.prompt(name, { onSessionId: (id) => seen[name]?.push(id) }),
      ),
    );
    expect(seen).toEqual({ a: ["sid-a"], b: ["sid-b"], c: ["sid-c"] });
    expect(responses.map((r) => r.sessionId)).toEqual(["sid-a", "sid-b", "sid-c"]);
    await agent.dispose();
  }, 30_000);

  it("a throwing observer cannot break the run", async () => {
    const agent = new CliSpecAgent(acpSpec());
    const response = await agent.prompt("boom", {
      onSessionId: () => {
        throw new Error("observer exploded");
      },
    });
    expect(response.status).toBe("completed");
    await agent.dispose();
  }, 15_000);

  it("a cancel delivered from inside the callback (raced ahead of the id) never prompts the backend", async () => {
    const log = join(dir, "acp-cancel.jsonl");
    process.env["FAKE_ACP_LOG"] = log;
    const agent = new CliSpecAgent(acpSpec());
    const response = await agent.prompt("early-cancel", {
      onSessionId: (id) => {
        void agent.abort(id);
      },
    });
    expect(response.status).toBe("aborted");
    expect(response.sessionId).toBe("sid-early-cancel");
    expect(response.meta?.partial).toBe(true);
    expect(response.text).toBe("");
    const methods = logLines(log).map((entry) => entry.method);
    expect(methods).toContain("session/new");
    expect(methods).not.toContain("session/prompt");
    await agent.dispose();
  }, 15_000);

  it("an abort for an id that is not a live run is an idempotent no-op", async () => {
    const agent = new CliSpecAgent(acpSpec());
    await expect(agent.abort("no-such-session")).resolves.toBeUndefined();
    await agent.dispose();
  });
});

describe("CliSpecAgent — onSessionId (print)", () => {
  it("reports an upfront native id before the process ends, and routes abort by it", async () => {
    const agent = new CliSpecAgent(printSpec({ newSessionId: () => "sess-upfront" }));
    process.env["FAKE_CLI_MODE"] = "sleep";
    process.env["FAKE_CLI_SLEEP_MS"] = "8000";
    const reported: string[] = [];
    const started = Date.now();
    const response = await agent.prompt("slow", {
      onSessionId: (id) => {
        reported.push(id);
        void agent.abort(id);
      },
    });
    expect(reported).toEqual(["sess-upfront"]);
    expect(response.status).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(6_000); // aborted long before the 8s sleep
  }, 15_000);

  it("a print run without an upfront id reports the id only once the output is parsed", async () => {
    const agent = new CliSpecAgent(printSpec());
    const reported: string[] = [];
    const response = await agent.prompt("plain", { onSessionId: (id) => reported.push(id) });
    // fake-cli echoes the --session-id it was handed ("sess-unset": no upfront id existed).
    expect(response.sessionId).toBe("sess-unset");
    expect(reported).toEqual(["sess-unset"]);
  }, 15_000);

  it("reports a resumed session's id (native by definition)", async () => {
    const agent = new CliSpecAgent(printSpec());
    const reported: string[] = [];
    const response = await agent.resume("sess-resumed", "again", { onSessionId: (id) => reported.push(id) });
    expect(reported).toEqual(["sess-resumed"]);
    expect(response.sessionId).toBe("sess-resumed");
  }, 15_000);
});

describe("ClaudeStreamAgent — onSessionId", () => {
  function makeAgent(delayMs = 30, frameLog?: string): ClaudeStreamAgent {
    const bin = join(dir, "fake-claude");
    const logEnv = frameLog === undefined ? "" : `FAKE_CLAUDE_FRAME_LOG="${frameLog}" `;
    writeFileSync(
      bin,
      `#!/bin/sh\n${logEnv}FAKE_CLAUDE_MODE=echo FAKE_CLAUDE_DELAY_MS=${delayMs} exec node "${FAKE_CLAUDE_STREAM}" "$@"\n`,
    );
    chmodSync(bin, 0o755);
    process.env["CLAUDE_STREAM_BIN"] = bin;
    return new ClaudeStreamAgent();
  }

  it("reports claude's own frame session id — never the synthetic claude-… routing label", async () => {
    const agent = makeAgent();
    const reported: string[] = [];
    const startEvents: string[] = [];
    agent.subscribe("*", (event) => {
      if (event.type === "session-start") startEvents.push(event.sessionId);
    });
    const response = await agent.prompt("hi", { onSessionId: (id) => reported.push(id) });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/^fake-claude-/);
    expect(reported[0]?.startsWith("claude-")).toBe(false);
    expect(response.sessionId).toBe(reported[0]);
    expect(startEvents).toEqual([reported[0]]);
    await agent.dispose();
  }, 15_000);

  it("abort routed by the native id interrupts the turn instead of killing the process", async () => {
    const frameLog = join(dir, "claude-frames.log");
    const agent = makeAgent(250, frameLog);
    const response = await agent.resume("native-resume", "slow", {
      onSessionId: (id) => {
        void agent.abort(id);
      },
    });
    // Resume ids are announced only after the user frame is written, so a
    // synchronous abort from the observer cannot put the interrupt ahead of it.
    expect(readFileSync(frameLog, "utf8").trim().split("\n").slice(0, 2)).toEqual(["user", "interrupt"]);
    expect(response.text).toBe("");
    expect(response.sessionId).toBe("native-resume");
    const next = await agent.prompt("after interrupt");
    expect(next.text).toContain("PONG: after interrupt");
    await agent.dispose();
  }, 15_000);
});
