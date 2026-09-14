// Tests for the dsh backend against the REAL DeepSeek Harness interface
// (reviews/dsh-real-interface.md; dsh 0.1.5-rc.1, probed live 2026-09-12) plus
// the dsh-headless-bridge plugin contract (repo
// https://github.com/minmax/dsh-bridge — README.md, src/args.ts,
// src/output.ts). No real dsh is spawned: argv shape and parse are pure
// functions, the readers run on throw-away HOME fixtures, and the process
// paths use fake binaries through DSH_BIN.

import { chmodSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { CliSpecAgent } from "@kagero/cli-backend";
import { AgentError, type UsageTelemetry } from "@kagero/core";
import { afterEach, describe, expect, it } from "vitest";
import { splitZstdFrames } from "../packages/cli-backend/src/history-readers/dsh.js";
import {
  createDshHistoryReader,
  readDshSessions,
} from "../packages/cli-backend/src/history-readers/index.js";
import { deriveCapabilities, type PromptContext } from "../packages/cli-backend/src/spec.js";
import { dshSpec } from "../packages/cli-backend/src/specs/index.js";

const homes: string[] = [];
const envKeys: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((p) => rm(p, { recursive: true, force: true })));
  for (const key of envKeys.splice(0)) delete process.env[key];
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "kagero-dsh-"));
  homes.push(home);
  return home;
}

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kagero-dsh-ws-"));
  homes.push(dir);
  return dir;
}

const iso = (ms: number): string => new Date(ms).toISOString();

const T0 = 1789185631000; // whole second — utimes/fstat rounding-safe
const T_MTIME = 1789185600000;
const T1 = 1789185631407;
const T2 = 1789185633132;
const T3 = 1789185633133;

// ---------------------------------------------------------------------------
// argv shape — the bridge grammar: --profile headless, then the bridge flags
// (--model, --session), then --json, then the positional task LAST
// (dsh-bridge src/args.ts: a commander `[task...]` variadic).
// ---------------------------------------------------------------------------

describe("dsh spec — argv shape", () => {
  const ctx = (overrides: Partial<PromptContext> = {}): PromptContext => ({
    prompt: "Reply with exactly: PONG",
    opts: {},
    mode: "prompt",
    workspace: "/private/tmp/demo",
    ...overrides,
  });

  it("builds the bridge invocation: profile flag, --json, positional task last", () => {
    expect(dshSpec.print?.args(ctx())).toEqual([
      "--profile",
      "headless",
      "--json",
      "Reply with exactly: PONG",
    ]);
  });

  it("passes the task as a single argv element (injection-safe, no shell)", () => {
    const args = dshSpec.print?.args(ctx({ prompt: "a; rm -rf / && echo $(boom)" }));
    expect(args).toEqual(["--profile", "headless", "--json", "a; rm -rf / && echo $(boom)"]);
  });

  it("maps opts.modelId to --model before --json, task still last", () => {
    const args = dshSpec.print?.args(ctx({ opts: { modelId: "minimax/MiniMax-M3" } }));
    expect(args).toEqual([
      "--profile",
      "headless",
      "--model",
      "minimax/MiniMax-M3",
      "--json",
      "Reply with exactly: PONG",
    ]);
  });

  it("resume mode maps to --session <id>", () => {
    const args = dshSpec.print?.args(
      ctx({ mode: "resume", sessionId: "session-056ceb59-d6f0-46d1-8f0d-5628c3a5dfe8" }),
    );
    expect(args).toEqual([
      "--profile",
      "headless",
      "--session",
      "session-056ceb59-d6f0-46d1-8f0d-5628c3a5dfe8",
      "--json",
      "Reply with exactly: PONG",
    ]);
  });

  it("derives honest capabilities: sessions/history/resume on, models listing off", () => {
    const caps = deriveCapabilities(dshSpec);
    expect(caps.resume).toBe(true); // bridge --session resume
    expect(caps.models).toBe(false); // --model selects a route; there is no listing command
    expect(caps.sessions).toBe(true); // projcache sessionsReader
    expect(caps.history).toBe(true); // zstd log reader
    expect(caps.abort).toBe(true);
    expect(caps.steer).toBe(false);
    expect(caps.followUp).toBe(false);
    expect(caps.subscribe).toBe(true);
    expect(caps.limits).toEqual({ timeout: true, maxTurns: false, maxToolCalls: false });
    expect(caps.workspaceCreate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parse — stdout must be exactly one dsh-headless-bridge JSON report line
// (its RunReport). Plain-text stdout is the stock (bridge-less) runner and is
// refused with the install hint; stderr (the `dsh: reasoning:` stream) stays
// diagnostics and is never parsed into the result.
// ---------------------------------------------------------------------------

describe("dsh spec — print parse (bridge JSON report)", () => {
  const parse = dshSpec.print?.parse;
  const run = { status: "completed", exitCode: 0, signal: null } as unknown as Parameters<
    NonNullable<typeof parse>
  >[2];

  const reportOf = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      status: "completed",
      text: "PONG",
      sessionId: "session-056ceb59-d6f0-46d1-8f0d-5628c3a5dfe8",
      model: { provider: "minimax", model: "MiniMax-M3" },
      durationMs: 1179,
      usage: {
        inputTokens: 346,
        outputTokens: 18,
        totalTokens: 7148,
        cacheReadTokens: 6784,
        reasoningTokens: 14,
      },
      ...overrides,
    });

  const parseOrThrow = (stdout: string): unknown => {
    try {
      return parse?.(stdout, "", run);
    } catch (e) {
      return e;
    }
  };

  it("maps the happy report: text, sessionId, modelId `provider/model`, usage", () => {
    expect(parse?.(reportOf(), "dsh: reasoning:\nnoise", run)).toEqual({
      text: "PONG",
      sessionId: "session-056ceb59-d6f0-46d1-8f0d-5628c3a5dfe8",
      modelId: "minimax/MiniMax-M3",
      usage: {
        inputTokens: 346,
        outputTokens: 18,
        reasoningTokens: 14,
        cacheReadTokens: 6784,
      },
    });
  });

  it("keeps unknown usage numbers out instead of inventing them", () => {
    const parsed = parse?.(reportOf({ usage: { inputTokens: 5 } }), "", run) as {
      usage?: UsageTelemetry;
    };
    expect(parsed.usage).toEqual({ inputTokens: 5 });
  });

  it("marks a non-completed (non-error) status partial, text still passes through", () => {
    const parsed = parse?.(reportOf({ status: "aborted" }), "", run) as { partial?: boolean };
    expect(parsed.partial).toBe(true);
  });

  it("status error → AgentError carrying the report's message", () => {
    const err = parseOrThrow(
      reportOf({
        status: "error",
        error: { code: "MISSING_CREDENTIAL", message: "no credential for route" },
      }),
    );
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe("cli_error");
    expect((err as AgentError).message).toBe("no credential for route");
  });

  it("non-JSON stdout → honest AgentError pointing at the bridge install", () => {
    for (const stdout of ["PONG\n", "", "dsh: fatal: bad profile\n", "[1, 2]"]) {
      const err = parseOrThrow(stdout);
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe("cli_error");
      expect((err as AgentError).message).toContain("install dsh-headless-bridge into the headless profile");
      expect((err as AgentError).message).toContain("dsh-headless-bridge");
    }
  });

  it("a JSON line missing the report fields is refused like bridge-less output", () => {
    const err = parseOrThrow('{"status":"completed"}');
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).message).toContain("not a dsh-headless-bridge JSON report");
  });
});

// ---------------------------------------------------------------------------
// Process paths through a fake DSH_BIN — exit!=0 must surface the `dsh:
// CODE: …` line from stderr; exit 0 must complete with the report fields.
// ---------------------------------------------------------------------------

function useFakeDsh(script: string): void {
  const file = path.join(os.tmpdir(), `kagero-dsh-fake-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  homes.push(file);
  process.env["DSH_BIN"] = file;
  envKeys.push("DSH_BIN");
}

describe("dsh agent — process contract (fake DSH_BIN)", () => {
  it("exit 0 → completed, report fields surface (text/session/model/usage)", async () => {
    useFakeDsh(
      `printf '{"status":"completed","text":"PONG","sessionId":"session-056ceb59-d6f0-46d1-8f0d-5628c3a5dfe8","model":{"provider":"deepseek-official","model":"deepseek-v4-flash"},"durationMs":1179,"usage":{"inputTokens":346,"outputTokens":18}}\\n'`,
    );
    const agent = new CliSpecAgent(dshSpec);
    const response = await agent.prompt("Reply with exactly: PONG", {
      workspace: { path: await makeWorkspace() },
    });
    expect(response.status).toBe("completed");
    expect(response.text).toBe("PONG");
    expect(response.sessionId).toBe("session-056ceb59-d6f0-46d1-8f0d-5628c3a5dfe8");
    expect(response.modelId).toBe("deepseek-official/deepseek-v4-flash"); // the REPORTED route
    expect(response.modelSource).toBe("reported");
    expect(response.usage).toEqual({ inputTokens: 346, outputTokens: 18 });
    expect(response.meta?.partial).toBeUndefined();
    await agent.dispose();
  });

  it("exit 1 → AgentError carrying the `dsh: CODE:` line from stderr", async () => {
    useFakeDsh(
      [
        "echo 'dsh: reasoning: planning the call' >&2",
        "echo 'dsh: MISSING_CREDENTIAL: llm-pi-ai: no credential for provider route \"minimax\"' >&2",
        "exit 1",
      ].join("\n"),
    );
    const agent = new CliSpecAgent(dshSpec);
    const err = await agent.prompt("hi", { workspace: { path: await makeWorkspace() } }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AgentError);
    expect((err as AgentError).code).toBe("cli_error");
    expect((err as AgentError).message).toContain("dsh: MISSING_CREDENTIAL:");
    expect((err as AgentError).message).toContain("exited with code 1");
    await agent.dispose();
  });
});

// ---------------------------------------------------------------------------
// Sessions reader — the projcache projection
// (~/.dsh/storages/session_projcache/sessions/<session-id>.json).
// ---------------------------------------------------------------------------

function projcacheRecord(identity: Record<string, unknown>, rows: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 7, record: { identity, rows } });
}

describe("dsh sessions reader (projcache)", () => {
  async function fixture(home: string): Promise<void> {
    const dir = path.join(home, ".dsh", "storages", "session_projcache", "sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "session-056ceb59-d6f0-46d1-8f0d-5628c3a5dfe8.json"),
      projcacheRecord(
        { formatVersion: 3, createdAt: T0, cwd: "/Users/x/kagero-dsh", isSeeded: false },
        {
          title: { ver: 1, seq: 17, val: "PONG reply request" },
          sessionListMetadata: { ver: 1, seq: 17, val: { blank: false, lastPromptAt: T3 } },
        },
      ),
    );
    await writeFile(
      path.join(dir, "session-aa3ff525-65d4-4e9f-bd19-0ac9221b8c8a.json"),
      projcacheRecord(
        { formatVersion: 3, createdAt: T1, cwd: "/Users/x/kagero-dsh" },
        {
          title: { ver: 1, seq: 5, val: "Older run" },
          sessionListMetadata: { ver: 1, seq: 5, val: { blank: false, lastPromptAt: T2 } },
        },
      ),
    );
    // Bare-uuid shape (tui/web profiles) without sessionListMetadata: falls
    // back to the file mtime for lastUsedAt (pinned via utimes for
    // determinism — it makes this record the oldest of the three).
    const bare = path.join(dir, "01641a8e-ee1c-4042-b436-09206ddb2cbb.json");
    await writeFile(
      bare,
      projcacheRecord(
        { formatVersion: 3, createdAt: T0, cwd: "/Users/x/ai/niwa" },
        {
          title: { ver: 1, seq: 99, val: "Niwa session" },
        },
      ),
    );
    await utimes(bare, new Date(T_MTIME), new Date(T_MTIME));
    // A torn write mid-session and a stray non-json file are skipped, not fatal.
    await writeFile(path.join(dir, "session-torn.json"), '{"version": 7, "rec');
    await writeFile(path.join(dir, "session.lock"), "lock");
  }

  it("lists sessions newest-first with id/title/cwd from the projection", async () => {
    const home = await makeHome();
    await fixture(home);
    const sessions = await readDshSessions({ homeDir: home });

    expect(sessions.map((s) => s.id)).toEqual([
      "session-056ceb59-d6f0-46d1-8f0d-5628c3a5dfe8",
      "session-aa3ff525-65d4-4e9f-bd19-0ac9221b8c8a",
      "01641a8e-ee1c-4042-b436-09206ddb2cbb",
    ]);
    const first = sessions[0];
    expect(first).toMatchObject({
      id: "session-056ceb59-d6f0-46d1-8f0d-5628c3a5dfe8",
      createdAt: iso(T0),
      lastUsedAt: iso(T3), // sessionListMetadata.lastPromptAt wins
      cwd: "/Users/x/kagero-dsh",
      summary: "PONG reply request",
      messageCount: 0, // projcache carries no message count
    });
    expect(sessions[1]?.lastUsedAt).toBe(iso(T2));
  });

  it("falls back to the file mtime when lastPromptAt is absent", async () => {
    const home = await makeHome();
    await fixture(home);
    const sessions = await readDshSessions({ homeDir: home });
    const last = sessions.at(-1);
    expect(last?.id).toBe("01641a8e-ee1c-4042-b436-09206ddb2cbb");
    expect(last?.lastUsedAt).toBe(iso(T_MTIME)); // pinned mtime, not write-order drift
  });

  it("caps the listing at 200 records", async () => {
    const home = await makeHome();
    const dir = path.join(home, ".dsh", "storages", "session_projcache", "sessions");
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 205; i++) {
      await writeFile(
        path.join(dir, `session-${String(i).padStart(4, "0")}.json`),
        projcacheRecord(
          { formatVersion: 3, createdAt: T0, cwd: "/w" },
          { sessionListMetadata: { ver: 1, seq: i, val: { blank: false, lastPromptAt: T0 + i } } },
        ),
      );
    }
    const sessions = await readDshSessions({ homeDir: home });
    expect(sessions).toHaveLength(200);
    expect(sessions[0]?.id).toBe("session-0204"); // newest first
  });

  it("resolves nothing when the projection is absent", async () => {
    const home = await makeHome();
    expect(await readDshSessions({ homeDir: home })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// History reader — multi-frame zstd session logs
// (~/.dsh/sessions/<cwd-slug>/<session-id>/session.v3.jsonl.zstd).
// ---------------------------------------------------------------------------

const zstdAvailable = typeof zstdCompressSync === "function" && typeof zstdDecompressSync === "function";

describe.skipIf(!zstdAvailable)("dsh history reader (multi-frame zstd)", () => {
  const sessionId = "session-056ceb59-d6f0-46d1-8f0d-5628c3a5dfe8";

  /** Each JSONL row becomes its OWN zstd frame — the real dsh append shape. */
  async function fixture(home: string): Promise<string> {
    const rows: readonly unknown[] = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        createdAt: T0,
        cwd: "/Users/x/kagero-dsh",
        isSeeded: false,
      },
      { type: "permission/preset", seq: 1, time: T0, data: { mode: "workspace-write" } },
      {
        type: "system/message",
        seq: 2,
        time: T0,
        data: { message: { role: "system", content: [{ type: "text", text: "You are a coding agent." }] } },
      },
      {
        type: "user/message",
        seq: 3,
        time: T1,
        data: {
          content: [{ type: "text", text: "Reply with exactly: PONG" }],
          source: { kind: "user" },
          role: "user",
        },
      },
      {
        type: "user/message",
        seq: 4,
        time: T1,
        data: {
          content: [
            { type: "text", text: "Current runtime context. This snapshot supersedes earlier snapshots." },
          ],
          source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt", form: "snapshot" },
          role: "user",
        },
      },
      {
        type: "assistant/message",
        seq: 5,
        time: T2,
        data: {
          message: {
            content: [
              { type: "reasoning", text: "just say PONG" },
              { type: "tool-call", id: "call_1", name: "run_code", arguments: "{}" },
              { type: "text", text: "PONG" },
            ],
            source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" },
          },
        },
      },
      {
        type: "tool/call",
        seq: 6,
        time: T2,
        data: { callId: "call_1", name: "run_code", arguments: '{"code":"1+1"}' },
      },
      {
        type: "tool/result",
        seq: 7,
        time: T2,
        data: {
          message: {
            source: { kind: "tool", callId: "call_1" },
            content: [
              {
                type: "tool-result",
                toolCallId: "call_1",
                isError: false,
                content: [{ type: "text", text: "2" }],
              },
            ],
          },
        },
      },
      {
        type: "tool/call",
        seq: 8,
        time: T2,
        data: { callId: "call_2", name: "bash", arguments: '{"command":"false"}' },
      },
      {
        type: "tool/result",
        seq: 9,
        time: T3,
        data: {
          message: {
            source: { kind: "tool", callId: "call_2" },
            content: [
              {
                type: "tool-result",
                toolCallId: "call_2",
                isError: true,
                content: [{ type: "text", text: "exit 1" }],
              },
            ],
          },
        },
      },
      {
        type: "assistant/message",
        seq: 10,
        time: T3,
        data: { message: { content: [{ type: "text", text: "Done" }] } },
      },
      { type: "turn/end", seq: 11, time: T3, data: { turn: 1, reason: { kind: "completed" } } },
    ];
    const file = path.join(
      home,
      ".dsh",
      "sessions",
      "--Users-x-kagero-dsh--",
      sessionId,
      "session.v3.jsonl.zstd",
    );
    await mkdir(path.dirname(file), { recursive: true });
    const frames = rows.map((row) => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`, "utf8")));
    await writeFile(file, Buffer.concat(frames));
    return file;
  }

  it("decompresses every frame and maps messages/tools; plumbing rows are skipped", async () => {
    const home = await makeHome();
    const file = await fixture(home);
    const result = await createDshHistoryReader({ homeDir: home }).read(sessionId, undefined);

    expect(result.sessionId).toBe(sessionId);
    expect(result.totalEntries).toBe(6);
    expect(result.truncated).toBe(false);
    // fullLog names the .zstd log; line numbers count DECOMPRESSED jsonl lines.
    expect(result.fullLog).toEqual({ file, line: 1 });

    const entries = result.entries;
    expect(entries.map((e) => e.role)).toEqual(["system", "user", "assistant", "tool", "tool", "assistant"]);
    expect(entries[0]).toMatchObject({ index: 1, text: "You are a coding agent.", at: iso(T0) });
    expect(entries[1]).toMatchObject({
      index: 2,
      role: "user",
      text: "Reply with exactly: PONG",
      at: iso(T1),
    });
    // reasoning is captured as thinking, the text part survives; the parallel
    // tool-call content part must NOT become a second entry (dedicated
    // tool/call rows do).
    expect(entries[2]).toEqual({
      index: 3,
      role: "assistant",
      at: iso(T2),
      text: "PONG",
      thinking: "just say PONG",
      line: 6, // the assistant/message row
    });
    expect(entries[3]).toEqual({
      index: 4,
      role: "tool",
      at: iso(T2),
      text: '{"code":"1+1"}',
      toolName: "run_code",
      toolOk: true, // isError: false merged by callId
      toolResult: "2",
      line: 7, // the tool/call row
    });
    expect(entries[4]).toMatchObject({ index: 5, role: "tool", toolName: "bash", toolOk: false });
    expect(entries[5]).toMatchObject({ index: 6, role: "assistant", text: "Done", at: iso(T3) });
  });

  it("windows the last N entries; the pointer names the first not-shown entry", async () => {
    const home = await makeHome();
    const file = await fixture(home);
    const result = await createDshHistoryReader({ homeDir: home }).read(sessionId, { last: 2 });

    expect(result.truncated).toBe(true);
    expect(result.totalEntries).toBe(6);
    expect(result.entries.map((e) => e.index)).toEqual([5, 6]);
    // First not-shown entry is the system row, decompressed-jsonl line 3.
    expect(result.fullLog).toEqual({ file, line: 3 });
  });

  it("rejects unknown sessions with session_not_found", async () => {
    const home = await makeHome();
    await fixture(home);
    const error = await createDshHistoryReader({ homeDir: home })
      .read("session-00000000-0000-0000-0000-000000000000", undefined)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe("session_not_found");
  });

  it("rejects a non-zstd log honestly (cli_error), never as an empty history", async () => {
    const home = await makeHome();
    const file = path.join(
      home,
      ".dsh",
      "sessions",
      "--Users-x-kagero-dsh--",
      sessionId,
      "session.v3.jsonl.zstd",
    );
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from("definitely not zstd", "utf8"));
    const error = await createDshHistoryReader({ homeDir: home })
      .read(sessionId, undefined)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe("cli_error");
    expect((error as AgentError).message).toContain("not a zstd stream");
  });
});

// ---------------------------------------------------------------------------
// Frame splitter — the multi-frame foundation the reader stands on.
// ---------------------------------------------------------------------------

describe.skipIf(!zstdAvailable)("dsh zstd frame splitting", () => {
  it("splits concatenated frames on the magic; one frame degrades fine", () => {
    const a = zstdCompressSync(Buffer.from("frame one\n", "utf8"));
    const b = zstdCompressSync(Buffer.from("frame two\n", "utf8"));
    expect(splitZstdFrames(Buffer.concat([a, b]))).toHaveLength(2);
    expect(splitZstdFrames(a)).toHaveLength(1);
    expect(splitZstdFrames(Buffer.alloc(0))).toHaveLength(0);
  });
});
