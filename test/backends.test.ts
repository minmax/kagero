// Tests for CLI-based backends using the smart FakeCli.
//
// Pattern from dsh-cli-mcp/test/integration.test.ts: the fake binary is a
// thin shell wrapper that runs `fake-bin.ts` (which uses the FakeCli class).
// State (models, sessions, call records, fail-next, sleep) is persisted to a
// per-test state file so the test can both configure the fake BEFORE the lib
// spawns it AND inspect what the lib sent AFTER the spawn returns.
//
// Tests demonstrate:
//   - basic spawn-and-parse for DshAgent / QwenAgent
//   - the FakeCli's smart-fake features:
//       setFailNext  — inject a transient failure
//       setSleep     — make the next call slow
//       wasCalledWith — assert what the lib sent
//       seedSession  — pre-populate state for resume assertions

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DshAgent } from "../src/backends/dsh.js";
import { QwenAgent } from "../src/backends/qwen.js";
import { FakeCli, type HandleResult } from "./fake-cli.js";

const FAKE_SHIM = join(process.cwd(), "test/fake-cli.sh");

interface FakeHarness {
  dir: string;
  bin: string;
  fake: FakeCli;
  cleanup: () => void;
}

/**
 * Spawn the fake CLI directly (via the shell wrapper) and return the result.
 * This is the same path the lib uses, but lets us run FakeCli.handle() without
 * going through a backend — handy for unit-level tests of the fake itself.
 */
async function runFake(args: readonly string[], stateDir: string): Promise<HandleResult> {
  const { spawn } = await import("node:child_process");
  return new Promise<HandleResult>((resolveP, rejectP) => {
    const proc = spawn(FAKE_SHIM, args, {
      cwd: process.cwd(),
      env: { ...process.env, FAKE_STATE_DIR: stateDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout?.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr?.on("data", (c: Buffer) => errChunks.push(c));
    proc.on("error", rejectP);
    proc.on("close", (code) => {
      resolveP({
        stdout: Buffer.concat(chunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        exitCode: code ?? 0,
      });
    });
  });
}

function makeHarness(): FakeHarness {
  const dir = mkdtempSync(join(tmpdir(), "kagero-fake-"));
  const bin = FAKE_SHIM;
  const fake = new FakeCli({ stateDir: dir });
  return {
    dir,
    bin,
    fake,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Configure a harness so that the spawned fake binary shares its state dir
 * with the test's FakeCli instance. Must be called before each spawn.
 */
function armHarness(harness: FakeHarness): void {
  process.env["FAKE_STATE_DIR"] = harness.dir;
  // Note: FAKE_VERBOSE is intentionally NOT set — verbose logging writes to
  // stderr, which the lib captures as the error message. Leave it off.
}

function disarmHarness(): void {
  delete process.env["FAKE_STATE_DIR"];
  delete process.env["FAKE_VERBOSE"];
}

describe("DshAgent (CLI backend, smart FakeCli)", () => {
  let harness: FakeHarness;

  beforeAll(() => {
    if (!existsSync(FAKE_SHIM)) {
      throw new Error(`fake-cli.sh not found at ${FAKE_SHIM}`);
    }
    harness = makeHarness();
    process.env["DSH_MCP_BIN"] = harness.bin;
    armHarness(harness);
  });

  afterAll(async () => {
    delete process.env["DSH_MCP_BIN"];
    disarmHarness();
    harness?.cleanup();
  });

  it("runs a prompt and parses output", async () => {
    const agent = new DshAgent();
    try {
      const res = await agent.prompt("hello world");
      expect(res.text).toBe("ok: hello world\n");
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await agent.dispose();
    }
  });

  it("lists models with parsed metadata", async () => {
    const agent = new DshAgent();
    try {
      const models = await agent.listModels();
      expect(models).toHaveLength(2);
      expect(models[0]?.id).toBe("fake-model-1");
      expect(models[0]?.provider).toBe("fakeprovider");
      expect(models[0]?.contextWindow).toBe(8192);
      expect(models[0]?.supportsTools).toBe(true);
      expect(models[1]?.supportsVision).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it("resumes a session", async () => {
    const agent = new DshAgent();
    try {
      const res = await agent.resume("sess-1", "follow up");
      // Fake echoes `[<id>/<n>] <prompt>` for resume.
      expect(res.text).toContain("follow up");
      expect(res.text).toContain("sess-1");
      expect(res.sessionId).toBe("sess-1");
    } finally {
      await agent.dispose();
    }
  });
});

describe("QwenAgent (CLI backend, smart FakeCli)", () => {
  let harness: FakeHarness;

  beforeAll(() => {
    harness = makeHarness();
    process.env["QWEN_MCP_BIN"] = harness.bin;
    armHarness(harness);
  });

  afterAll(async () => {
    delete process.env["QWEN_MCP_BIN"];
    disarmHarness();
    harness?.cleanup();
  });

  it("runs a prompt and parses output", async () => {
    const agent = new QwenAgent();
    try {
      const res = await agent.prompt("hello");
      expect(res.text).toBe("ok: hello\n");
    } finally {
      await agent.dispose();
    }
  });
});

// =============================================================================
// FakeCli feature tests — verify the smart-fake surface area works as expected
// when driven through the lib's spawn path.
// =============================================================================

describe("FakeCli — smart-fake features via spawn", () => {
  let harness: FakeHarness;

  beforeEach(() => {
    harness = makeHarness();
    process.env["DSH_MCP_BIN"] = harness.bin;
    armHarness(harness);
  });

  afterEach(async () => {
    delete process.env["DSH_MCP_BIN"];
    disarmHarness();
    harness?.cleanup();
  });

  it("setFailNext causes the next lib call to fail, then recovers", async () => {
    // Configure the fake to fail the very next call.
    harness.fake.setFailNext(7, "boom\n");
    harness.fake.persistState(); // write to disk so the spawned binary picks it up

    const agent = new DshAgent();
    try {
      await expect(agent.prompt("trigger failure")).rejects.toThrow(/boom/);
    } finally {
      await agent.dispose();
    }

    // Reload from disk to inspect what the lib sent during the failure.
    harness.fake.loadState();
    expect(harness.fake.wasCalledWith("--print", "trigger failure")).toBe(true);

    // The next call should succeed (failNext is one-shot).
    const agent2 = new DshAgent();
    try {
      const res = await agent2.prompt("recover");
      expect(res.text).toBe("ok: recover\n");
    } finally {
      await agent2.dispose();
    }

    harness.fake.loadState();
    expect(harness.fake.callsMatching((c) => c.args[0] === "--print")).toHaveLength(2);
  });

  it("setSleep makes the next call take time (verifiable via durationMs)", async () => {
    harness.fake.setSleep(120);
    harness.fake.persistState();

    const agent = new DshAgent();
    try {
      const start = Date.now();
      const res = await agent.prompt("slow please");
      const elapsed = Date.now() - start;
      expect(res.text).toBe("ok: slow please\n");
      // The whole subprocess roundtrip should take at least ~100ms.
      expect(elapsed).toBeGreaterThanOrEqual(100);
    } finally {
      await agent.dispose();
    }

    harness.fake.loadState();
    expect(harness.fake.wasCalledWith("--print", "slow please")).toBe(true);
  });

  it("wasCalledWith + callsMatching assert exactly what the lib sent", async () => {
    const agent = new DshAgent();
    try {
      await agent.prompt("first prompt");
      await agent.listModels();
      await agent.resume("abc-123", "second prompt");
    } finally {
      await agent.dispose();
    }

    // Reload so we see all the calls the spawned binary recorded.
    harness.fake.loadState();

    // The lib sent --list-models (not just --print).
    expect(harness.fake.wasCalledWith("--list-models")).toBe(true);

    // Both prompts were sent with --print as the first arg.
    expect(harness.fake.wasCalledWith("--print", "first prompt")).toBe(true);
    expect(harness.fake.wasCalledWith("--print", "second prompt", "--session", "abc-123")).toBe(true);

    const printCalls = harness.fake.callsMatching((c) => c.args[0] === "--print");
    expect(printCalls).toHaveLength(2);
    expect(printCalls[0]?.args).toEqual(["--print", "first prompt"]);

    // lastCall() is the most recent.
    const last = harness.fake.lastCall();
    expect(last?.args).toEqual(["--print", "second prompt", "--session", "abc-123"]);
    expect(typeof last?.at).toBe("number");
  });

  it("seedSession + resume round-trips state across multiple spawns", async () => {
    // First "call" — create the session via the fake directly (no lib yet).
    await runFake(["--print", "initial", "--session", "rt-sess"], harness.dir);

    // Reload from disk; the session is now persisted.
    harness.fake.loadState();
    expect(harness.fake.getSession("rt-sess")?.summary).toBe("initial");
    expect(harness.fake.getSession("rt-sess")?.messageCount).toBe(2);

    // Now resume through the lib — the fake will append to the same session.
    const agent = new DshAgent();
    try {
      const res = await agent.resume("rt-sess", "second message");
      expect(res.text).toContain("rt-sess");
      expect(res.text).toContain("second message");
    } finally {
      await agent.dispose();
    }

    harness.fake.loadState();
    // 2 messages from the first call, +2 from the resume = 4.
    expect(harness.fake.getSession("rt-sess")?.messageCount).toBe(4);
    expect(harness.fake.getSession("rt-sess")?.summary).toBe("second message");
  });
});

// =============================================================================
// FakeCli direct-API tests — exercise the class without spawning.
// =============================================================================

describe("FakeCli — direct class API", () => {
  it("parses --list-models", async () => {
    const fake = new FakeCli();
    const r = await fake.handle(["--list-models"], {}, "/tmp");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("fake-model-1");
    expect(r.stdout.split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("parses --print with a prompt", async () => {
    const fake = new FakeCli();
    const r = await fake.handle(["--print", "hi"], {}, "/tmp");
    expect(r.stdout).toBe("ok: hi\n");
  });

  it("rejects an empty prompt with exit code 2", async () => {
    const fake = new FakeCli();
    const r = await fake.handle(["--print", ""], {}, "/tmp");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("empty prompt");
  });

  it("validates session-id format (rejects path traversal)", async () => {
    const fake = new FakeCli();
    const r = await fake.handle(["--print", "x", "--session", "../etc/passwd"], {}, "/tmp");
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("bad session id");
  });

  it("enforces expectedSessionIds whitelist", async () => {
    const fake = new FakeCli({ expectedSessionIds: ["known"] });
    const r1 = await fake.handle(["--print", "x", "--session", "known"], {}, "/tmp");
    const r2 = await fake.handle(["--print", "x", "--session", "rogue"], {}, "/tmp");
    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(2);
  });

  it("respects a custom model list", async () => {
    const fake = new FakeCli({
      models: [
        {
          id: "custom",
          displayName: "Custom",
          provider: "x",
          contextWindow: 1,
          supportsTools: false,
          supportsVision: false,
        },
      ],
    });
    const r = await fake.handle(["--list-models"], {}, "/tmp");
    expect(r.stdout).toContain("custom");
    expect(r.stdout).not.toContain("fake-model-1");
  });

  it("setFailNext returns the failure exactly once", async () => {
    const fake = new FakeCli();
    fake.setFailNext(42, "boom\n");
    const r1 = await fake.handle(["--print", "x"], {}, "/");
    const r2 = await fake.handle(["--print", "x"], {}, "/");
    expect(r1.exitCode).toBe(42);
    expect(r1.stderr).toBe("boom\n");
    expect(r2.exitCode).toBe(0);
  });

  it("setSleep delays the call", async () => {
    const fake = new FakeCli();
    fake.setSleep(60);
    const start = Date.now();
    await fake.handle(["--print", "x"], {}, "/");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});
