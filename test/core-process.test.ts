// Unit tests for the subprocess runner: honest statuses, the stop ladder,
// combined output caps, and binary resolution.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { AgentError, resolveBinary, runProcess } from "@kagero/core";
import { describe, expect, it } from "vitest";

/** Run `fn` with process.env[name] set to value, restoring afterwards. */
const withEnv = (name: string, value: string, fn: () => void): void => {
  const prev = process.env[name];
  try {
    process.env[name] = value;
    fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
};

const isLinuxOrMac = process.platform === "darwin" || process.platform === "linux";

describe("resolveBinary", () => {
  it("prefers the env variable when it is set and the file exists", () => {
    withEnv("KAGERO_TEST_BIN", process.execPath, () => {
      const resolved = resolveBinary("some-name", "KAGERO_TEST_BIN");
      expect(resolved).toEqual({ path: process.execPath, source: "env" });
    });
  });

  it("falls back to PATH when the env var is set but the file is missing", () => {
    withEnv("KAGERO_TEST_BIN", "/nonexistent/kagero-binary", () => {
      const resolved = resolveBinary("node", "KAGERO_TEST_BIN");
      expect(resolved.source).toBe("path");
      expect(existsSync(resolved.path)).toBe(true);
    });
  });

  it("resolves through a PATH search", () => {
    const resolved = resolveBinary("node");
    expect(resolved.source).toBe("path");
    expect(existsSync(resolved.path)).toBe(true);
  });

  it("throws AgentError('binary_not_found', kind user) naming the env var as a hint", () => {
    let caught: unknown;
    try {
      resolveBinary("kagero-no-such-binary-xyz", "KAGERO_TEST_BIN");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentError);
    const err = caught as AgentError;
    expect(err.code).toBe("binary_not_found");
    expect(err.kind).toBe("user");
    expect(err.message).toContain("KAGERO_TEST_BIN");
    expect(err.message).toContain("kagero-no-such-binary-xyz");
  });
});

describe("runProcess — statuses", () => {
  it("reports completed with stdout for a clean run", async () => {
    const res = await runProcess(process.execPath, ["-e", `process.stdout.write("hello kagero")`]);
    expect(res.status).toBe("completed");
    expect(res.exitCode).toBe(0);
    expect(res.signal).toBeNull();
    expect(res.stdout).toBe("hello kagero");
    expect(res.stderr).toBe("");
    expect(res.truncated).toBe(false);
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports exit-error for a non-zero exit without our kill", async () => {
    const res = await runProcess(process.execPath, ["-e", `process.stderr.write("boom"); process.exit(3)`]);
    expect(res.status).toBe("exit-error");
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toBe("boom");
    expect(res.stdout).toBe("");
  });

  it("reports timed-out when the deadline expires", async () => {
    const res = await runProcess(process.execPath, ["-e", `setTimeout(() => {}, 60_000)`], {
      timeoutMs: 250,
    });
    expect(res.status).toBe("timed-out");
    expect(res.exitCode).toBeNull();
  });

  it("reports aborted when the external signal fires", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const res = await runProcess(process.execPath, ["-e", `setTimeout(() => {}, 60_000)`], {
      signal: controller.signal,
    });
    expect(res.status).toBe("aborted");
    expect(res.exitCode).toBeNull();
  });

  it("resolves aborted immediately for an already-aborted signal (nothing spawned)", async () => {
    const controller = new AbortController();
    controller.abort();
    const res = await runProcess(process.execPath, ["-e", `process.stdout.write("nope")`], {
      signal: controller.signal,
    });
    expect(res.status).toBe("aborted");
    expect(res.stdout).toBe("");
    expect(res.exitCode).toBeNull();
  });

  it("reports spawn-failed when the binary does not exist", async () => {
    const res = await runProcess("kagero-missing-binary-xyz", []);
    expect(res.status).toBe("spawn-failed");
    expect(res.exitCode).toBeNull();
    expect(res.signal).toBeNull();
  });
});

describe("runProcess — stop ladder", () => {
  it("escalates to SIGKILL when the child ignores SIGTERM and leaves no orphans", async () => {
    const grandchildSleep = "60461"; // unique seconds — pgrep marker
    const script = [
      `const { spawn } = require("node:child_process");`,
      `const c = spawn("sleep", ["${grandchildSleep}"]); c.unref();`,
      `process.on("SIGTERM", () => {});`, // trap SIGTERM → ladder must escalate
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const res = await runProcess(process.execPath, ["-e", script], {
      timeoutMs: 200,
      killGraceMs: 300,
    });
    // close arrived while the child ignored SIGTERM → SIGKILL escalation worked
    expect(res.status).toBe("timed-out");

    // The grandchild shares the child's process group → swept as well.
    if (isLinuxOrMac) {
      const probe = spawnSync("pgrep", ["-f", `sleep ${grandchildSleep}`]);
      expect(probe.status).not.toBe(0); // no match → no orphan
    }
  }, 15_000);
});

describe("runProcess — output cap and streaming", () => {
  it("caps stdout+stderr COMBINED and flags truncation", async () => {
    const res = await runProcess(
      process.execPath,
      ["-e", `process.stdout.write("a".repeat(100)); process.stderr.write("b".repeat(100));`],
      { maxOutputBytes: 10 },
    );
    expect(res.truncated).toBe(true);
    expect(res.stdout.length + res.stderr.length).toBe(10);
    expect(res.status).toBe("completed"); // the run itself finished fine
  });

  it("does not flag truncation under the cap", async () => {
    const res = await runProcess(process.execPath, ["-e", `process.stdout.write("a".repeat(10))`], {
      maxOutputBytes: 100,
    });
    expect(res.truncated).toBe(false);
    expect(res.stdout).toBe("a".repeat(10));
  });

  it("streams stdout chunks as they arrive", async () => {
    const chunks: string[] = [];
    const res = await runProcess(
      process.execPath,
      ["-e", `process.stdout.write("chunk-one;"); process.stdout.write("chunk-two;")`],
      { onStdoutChunk: (chunk) => chunks.push(chunk) },
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.join("")).toBe(res.stdout);
    expect(res.stdout).toBe("chunk-one;chunk-two;");
  });

  it("keeps multibyte characters intact when a read chunk splits one", async () => {
    // ~600KB of 3-byte characters: the 64KB pipe reads cannot stay aligned, so
    // several characters land split across chunk boundaries. Per-chunk
    // toString() would corrupt each of them into U+FFFD; the streaming decoder
    // must not. (P(no split at all) ≈ (1/3)^9 — effectively never.)
    const chunks: string[] = [];
    const res = await runProcess(process.execPath, ["-e", `process.stdout.write("あ".repeat(200_000))`], {
      onStdoutChunk: (chunk) => chunks.push(chunk),
    });
    expect(res.status).toBe("completed");
    expect(chunks.join("")).toBe(res.stdout);
    expect(res.stdout).not.toContain("\uFFFD");
    expect(res.stdout.length).toBe(200_000);
  });
});

describe("runProcess — sweepGroupOnExit", () => {
  it("reaps grandchildren that outlived a clean exit", async () => {
    const grandchildSleep = "60467"; // unique seconds — pgrep marker
    const script = [
      `const { spawn } = require("node:child_process");`,
      // stdio "ignore" — with pipes the unref'd grandchild keeps this node alive.
      `const c = spawn("sleep", ["${grandchildSleep}"], { stdio: "ignore" }); c.unref();`,
      `process.stdout.write("done");`,
    ].join("\n");
    const res = await runProcess(process.execPath, ["-e", script], {
      sweepGroupOnExit: true,
    });
    expect(res.status).toBe("completed");

    // The grandchild shares the child's process group → swept as well.
    if (isLinuxOrMac) {
      const probe = spawnSync("pgrep", ["-f", `sleep ${grandchildSleep}`]);
      expect(probe.status).not.toBe(0); // no match → no orphan
    }
  }, 15_000);
});

describe("runProcess — spawn options", () => {
  it("passes cwd and env through to the child", async () => {
    const res = await runProcess(
      process.execPath,
      ["-e", `process.stdout.write(\`\${process.env["KAGERO_TEST_VAL"]}|\${process.cwd()}\`)`],
      { env: { ...process.env, KAGERO_TEST_VAL: "injected" } },
    );
    expect(res.status).toBe("completed");
    expect(res.stdout).toBe(`injected|${process.cwd()}`);
  });
});
