// Tests for the per-CLI history readers (@kagero/cli-backend/history-readers).
//
// Every suite builds a throw-away HOME-like tree under os.tmpdir() and points
// its reader at it via `{ homeDir }` — nothing outside the tempdir is touched.
// Fixtures mirror the on-disk formats as observed in the format survey
// (docs/review history-file-formats report); line numbers in assertions refer
// to fixture file lines (1-based).

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentError } from "@kagero/core";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeHistoryReader } from "../packages/cli-backend/src/history-readers/claude.js";
import { createCodexHistoryReader } from "../packages/cli-backend/src/history-readers/codex.js";
import { createGrokHistoryReader } from "../packages/cli-backend/src/history-readers/grok.js";
import { createKimiHistoryReader } from "../packages/cli-backend/src/history-readers/kimi.js";
import { createMcodeHistoryReader } from "../packages/cli-backend/src/history-readers/mcode.js";
import { createPiHistoryReader } from "../packages/cli-backend/src/history-readers/pi.js";
import { createQwenHistoryReader } from "../packages/cli-backend/src/history-readers/qwen.js";
import type { HistoryReader } from "../packages/cli-backend/src/spec.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), "kagero-hist-"));
  homes.push(home);
  return home;
}

/** Write a JSONL file (one compact row per line), creating parent dirs. */
async function writeJsonl(file: string, rows: readonly unknown[]): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return file;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** All readers must reject unknown sessions with AgentError("session_not_found"). */
async function expectNotFound(reader: HistoryReader, sessionId: string): Promise<void> {
  const error = await reader.read(sessionId, undefined).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AgentError);
  expect((error as AgentError).code).toBe("session_not_found");
}

// ---------------------------------------------------------------------------

describe("pi history reader", () => {
  const sessionId = "pi-sess-1";

  async function fixture(home: string): Promise<string> {
    return await writeJsonl(
      path.join(
        home,
        ".pi",
        "agent",
        "sessions",
        "--private-tmp-demo--",
        `2026-09-12T10-00-00-000Z_${sessionId}.jsonl`,
      ),
      [
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-09-12T10:00:00.000Z",
          cwd: "/private/tmp/demo",
        },
        {
          type: "model_change",
          id: "mc1",
          parentId: null,
          timestamp: "2026-09-12T10:00:00.100Z",
          provider: "t",
          modelId: "m",
        },
        {
          type: "message",
          id: "e1",
          timestamp: "2026-09-12T10:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text: "find the bug" }] },
        },
        {
          type: "message",
          id: "e2",
          timestamp: "2026-09-12T10:00:02.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hmm" },
              { type: "text", text: "Looking" },
              { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/x.ts" } },
            ],
          },
        },
        {
          type: "message",
          id: "e3",
          timestamp: "2026-09-12T10:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "read",
            content: [{ type: "text", text: "file body" }],
            isError: false,
          },
        },
        {
          type: "message",
          id: "e4",
          timestamp: "2026-09-12T10:00:04.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "Found it" }] },
        },
        {
          type: "message",
          id: "e5",
          timestamp: "2026-09-12T10:00:05.000Z",
          message: { role: "user", content: [{ type: "text", text: "fix it" }] },
        },
        {
          type: "message",
          id: "e6",
          timestamp: "2026-09-12T10:00:06.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Fixed" },
              { type: "toolCall", id: "call_2", name: "edit", arguments: { path: "/x.ts" } },
            ],
          },
        },
        {
          type: "message",
          id: "e7",
          timestamp: "2026-09-12T10:00:07.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call_2",
            toolName: "edit",
            content: [{ type: "text", text: "Command aborted" }],
            isError: true,
          },
        },
      ],
    );
  }

  it("reads entries with roles, tool merges and through-numbered indexes", async () => {
    const home = await makeHome();
    const file = await fixture(home);
    const result = await createPiHistoryReader({ homeDir: home }).read(sessionId, undefined);

    expect(result.sessionId).toBe(sessionId);
    expect(result.totalEntries).toBe(7);
    expect(result.truncated).toBe(false);
    expect(result.fullLog).toEqual({ file, line: 1 });

    const entries = result.entries;
    expect(entries).toHaveLength(7);
    expect(entries.map((e) => e.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(entries[0]).toMatchObject({ role: "user", text: "find the bug", at: "2026-09-12T10:00:01.000Z" });
    expect(entries[1]).toMatchObject({ role: "assistant", text: "Looking", at: "2026-09-12T10:00:02.000Z" });
    // Thinking surfaces as the assistant entry's `thinking`; toolCall becomes
    // a tool entry merged with its toolResult (isError: false → toolOk: true).
    expect(entries[2]).toEqual({
      index: 3,
      role: "tool",
      at: "2026-09-12T10:00:02.000Z",
      text: '{"path":"/x.ts"}',
      toolName: "read",
      toolOk: true,
      toolResult: "file body",
      line: 4, // the assistant row carrying the toolCall
    });
    expect(entries[6]).toMatchObject({ role: "tool", toolName: "edit", toolOk: false });
  });

  it("windows the last N entries and points at the first not-shown entry", async () => {
    const home = await makeHome();
    await fixture(home);
    const result = await createPiHistoryReader({ homeDir: home }).read(sessionId, { last: 3 });

    expect(result.totalEntries).toBe(7);
    expect(result.truncated).toBe(true);
    expect(result.entries.map((e) => e.index)).toEqual([5, 6, 7]);
    // Entry #1 starts on fixture line 3 (after the session/model_change rows).
    expect(result.fullLog).toEqual({ file: result.fullLog?.file, line: 3 });
    expect(result.fullLog?.file).toContain("pi-sess-1");
  });

  it("rejects unknown sessions with session_not_found", async () => {
    const home = await makeHome();
    await fixture(home);
    await expectNotFound(createPiHistoryReader({ homeDir: home }), "pi-missing");
  });
});

describe("qwen history reader", () => {
  const sessionId = "3cbdd648-1111-2222-3333-444444444444";

  async function fixture(home: string): Promise<string> {
    return await writeJsonl(
      path.join(home, ".qwen", "projects", "-private-tmp-qwen-demo", "chats", `${sessionId}.jsonl`),
      [
        {
          type: "system",
          subtype: "session_model",
          systemPayload: { modelId: "qwen-x", authType: "openai" },
        },
        {
          type: "user",
          timestamp: "2026-09-11T03:16:41.000Z",
          message: { role: "user", parts: [{ text: "explore the repo" }] },
        },
        {
          type: "assistant",
          timestamp: "2026-09-11T03:16:42.000Z",
          model: "qwen-x",
          message: {
            role: "model",
            parts: [
              { text: "Looking" },
              { functionCall: { id: "call_1", name: "read_file", args: { file_path: "/a.ts" } } },
            ],
          },
        },
        {
          type: "tool_result",
          timestamp: "2026-09-11T03:16:43.000Z",
          message: {
            role: "user",
            parts: [
              { functionResponse: { id: "call_1", name: "read_file", response: { output: "repo body" } } },
              {
                functionResponse: { id: "call_9", name: "boom", response: { error: { message: "kaboom" } } },
              },
            ],
          },
        },
        {
          type: "assistant",
          timestamp: "2026-09-11T03:16:44.000Z",
          message: { role: "model", parts: [{ text: "Done exploring" }] },
        },
        {
          type: "user",
          timestamp: "2026-09-11T03:16:45.000Z",
          message: { role: "user", parts: [{ text: "thanks" }] },
        },
      ],
    );
  }

  it("reads entries (assistant role is 'model'), merges results, flags errors", async () => {
    const home = await makeHome();
    const file = await fixture(home);
    const result = await createQwenHistoryReader({ homeDir: home }).read(sessionId, undefined);

    expect(result.totalEntries).toBe(6);
    expect(result.truncated).toBe(false);
    expect(result.fullLog).toEqual({ file, line: 1 });
    const entries = result.entries;
    expect(entries[0]).toMatchObject({
      index: 1,
      role: "user",
      text: "explore the repo",
      at: "2026-09-11T03:16:41.000Z",
    });
    expect(entries[1]).toMatchObject({ index: 2, role: "assistant", text: "Looking" });
    // call_1 merges; the response carries no explicit error flag → no toolOk.
    expect(entries[2]).toMatchObject({ role: "tool", toolName: "read_file", text: '{"file_path":"/a.ts"}' });
    expect(entries[2]?.toolOk).toBeUndefined();
    // call_9 was never issued as a call → standalone record with toolOk false.
    expect(entries[3]).toMatchObject({ index: 4, role: "tool", toolName: "boom", toolOk: false });
    expect(entries[5]).toMatchObject({ index: 6, role: "user", text: "thanks" });
  });

  it("windows the last N entries; the pointer names the first hidden entry", async () => {
    const home = await makeHome();
    const file = await fixture(home);
    const result = await createQwenHistoryReader({ homeDir: home }).read(sessionId, { last: 2 });

    expect(result.truncated).toBe(true);
    expect(result.entries.map((e) => e.index)).toEqual([5, 6]);
    // Entry #1 sits on line 2 (line 1 is the skipped system row).
    expect(result.fullLog).toEqual({ file, line: 2 });
  });

  it("rejects unknown sessions with session_not_found", async () => {
    const home = await makeHome();
    await fixture(home);
    await expectNotFound(createQwenHistoryReader({ homeDir: home }), "00000000-0000-0000-0000-000000000000");
  });
});

describe("kimi history reader", () => {
  const sessionId = "ses_7150480c-7aa3-47f7-8d9d-65edb3d164ce";
  const sessionDir = (home: string): string =>
    path.join(home, ".kimi-code", "sessions", `wd_demo_${sessionId}`);

  async function fixture(home: string): Promise<string> {
    await writeJsonl(path.join(home, ".kimi-code", "session_index.jsonl"), [
      { sessionId: "ses_other", sessionDir: "/elsewhere", workDir: "/x" },
      { sessionId, sessionDir: sessionDir(home), workDir: "/private/tmp/demo" },
    ]);
    return await writeJsonl(path.join(sessionDir(home), "agents", "main", "wire.jsonl"), [
      { type: "metadata", protocol_version: "1.4", created_at: 1781808827784 },
      {
        type: "context.append_message",
        message: { role: "user", content: [{ type: "text", text: "study the spec" }] },
      },
      {
        type: "context.append_loop_event",
        event: { type: "content.part", part: { type: "text", text: "Reading" } },
        time: 1781808830000,
      },
      {
        type: "context.append_loop_event",
        event: { type: "content.part", part: { type: "think", think: "hmm" } },
        time: 1781808830100,
      },
      {
        type: "context.append_loop_event",
        event: { type: "content.part", part: { type: "text", text: "the spec" } },
        time: 1781808830200,
      },
      {
        type: "context.append_loop_event",
        event: { type: "tool.call", toolCallId: "call_1", name: "read", args: { path: "/s.md" } },
        time: 1781808830300,
      },
      {
        type: "context.append_loop_event",
        event: { type: "tool.result", toolCallId: "call_1", result: { output: "spec body" } },
        time: 1781808830400,
      },
      {
        type: "context.append_loop_event",
        event: { type: "content.part", part: { type: "text", text: "Summarised" } },
        time: 1781808830500,
      },
      { type: "usage.record", model: "kimi-code/k3", usage: {}, usageScope: "turn", time: 1781808830600 },
      {
        type: "context.append_loop_event",
        event: { type: "tool.call", toolCallId: "call_2", name: "bash", args: { command: "false" } },
        time: 1781808830700,
      },
      {
        type: "context.append_loop_event",
        event: { type: "tool.result", toolCallId: "call_2", result: { output: "boom", isError: true } },
        time: 1781808830800,
      },
      {
        type: "context.append_loop_event",
        event: { type: "content.part", part: { type: "text", text: "recovered" } },
        time: 1781808830900,
      },
    ]);
  }

  it("merges content.part streams, tool calls/results; captures think as thinking, skips service events", async () => {
    const home = await makeHome();
    const file = await fixture(home);
    const result = await createKimiHistoryReader({ homeDir: home }).read(sessionId, undefined);

    expect(result.totalEntries).toBe(6);
    expect(result.truncated).toBe(false);
    expect(result.fullLog).toEqual({ file, line: 1 });
    const entries = result.entries;
    expect(entries[0]).toMatchObject({ index: 1, role: "user", text: "study the spec" });
    expect(entries[0]?.at).toBeUndefined(); // append_message carries no time
    // Consecutive text parts merge into one assistant entry (think captured
    // as thinking). Entry opens on the first content.part row.
    expect(entries[1]).toEqual({
      index: 2,
      role: "assistant",
      at: iso(1781808830000),
      text: "Reading\nthe spec",
      thinking: "hmm",
      line: 3,
    });
    expect(entries[2]).toEqual({
      index: 3,
      role: "tool",
      at: iso(1781808830300),
      text: '{"path":"/s.md"}',
      toolName: "read",
      toolOk: true,
      toolResult: "spec body",
      line: 6, // the tool.call row
    });
    expect(entries[3]).toMatchObject({ index: 4, role: "assistant", text: "Summarised" });
    expect(entries[4]).toMatchObject({ index: 5, role: "tool", toolName: "bash", toolOk: false });
    expect(entries[5]).toMatchObject({ index: 6, role: "assistant", text: "recovered" });
  });

  it("windows the last N entries; the pointer names the first hidden entry", async () => {
    const home = await makeHome();
    const file = await fixture(home);
    const result = await createKimiHistoryReader({ homeDir: home }).read(sessionId, { last: 2 });

    expect(result.truncated).toBe(true);
    expect(result.entries.map((e) => e.index)).toEqual([5, 6]);
    // Entry #1 sits on line 2 (line 1 is the metadata event).
    expect(result.fullLog).toEqual({ file, line: 2 });
  });

  it("falls back to a sessions-dir scan when the index misses", async () => {
    const home = await makeHome();
    await fixture(home);
    const legacyId = "ses_098bff27-d77c-4427-9f32-20fc2f03fbd9";
    const legacyDir = path.join(home, ".kimi-code", "sessions", "wd_.ai_dacabf39e518", `session_${legacyId}`);
    const legacyFile = await writeJsonl(path.join(legacyDir, "agents", "main", "wire.jsonl"), [
      {
        type: "context.append_message",
        message: { role: "user", content: [{ type: "text", text: "legacy" }] },
      },
    ]);
    const result = await createKimiHistoryReader({ homeDir: home }).read(legacyId, undefined);
    expect(result.totalEntries).toBe(1);
    expect(result.fullLog).toEqual({ file: legacyFile, line: 1 });
  });

  it("rejects unknown sessions with session_not_found", async () => {
    const home = await makeHome();
    await fixture(home);
    await expectNotFound(
      createKimiHistoryReader({ homeDir: home }),
      "ses_00000000-0000-0000-0000-000000000000",
    );
  });
});

describe("grok history reader", () => {
  const sessionId = "01a08b68-945c-7ba0-a429-bc9c7b477435";

  async function fixture(home: string): Promise<string> {
    return await writeJsonl(
      path.join(home, ".grok", "sessions", "%2Fprivate%2Ftmp%2Fgrok-demo", sessionId, "chat_history.jsonl"),
      [
        { type: "system", content: "You are Grok" },
        { type: "user", content: "list the skills" },
        {
          type: "assistant",
          content: "",
          tool_calls: [{ id: "call-1", name: "read_file", arguments: '{"target_file":"x"}' }],
        },
        { type: "tool_result", tool_call_id: "call-1", content: "skills body", status: "completed" },
        { type: "reasoning", id: "rs_1", summary: [] },
        {
          type: "assistant",
          content: "Here they are",
          tool_calls: [{ id: "call-2", function: { name: "run", arguments: "{}" } }],
        },
        { type: "tool_result", tool_call_id: "call-2", content: "nope", status: "error" },
        { type: "user", content: [{ type: "text", text: "thanks (parts form)" }] },
      ],
    );
  }

  it("reads entries incl. system rows; no timestamps exist in this format", async () => {
    const home = await makeHome();
    const file = await fixture(home);
    const result = await createGrokHistoryReader({ homeDir: home }).read(sessionId, undefined);

    expect(result.totalEntries).toBe(6);
    expect(result.truncated).toBe(false);
    expect(result.fullLog).toEqual({ file, line: 1 });
    const entries = result.entries;
    expect(entries.map((e) => e.role)).toEqual(["system", "user", "tool", "assistant", "tool", "user"]);
    for (const entry of entries) expect(entry.at).toBeUndefined(); // format has no timestamps
    expect(entries[0]).toMatchObject({ index: 1, text: "You are Grok" });
    // Flat tool_calls shape; reasoning rows buffer as thinking (empty here,
    // so nothing attaches). Tool entries start on their assistant row and
    // carry the merged result text.
    expect(entries[2]).toEqual({
      index: 3,
      role: "tool",
      text: '{"target_file":"x"}',
      toolName: "read_file",
      toolOk: true,
      toolResult: "skills body",
      line: 3,
    });
    // Nested function.name shape; status "error" → toolOk false.
    expect(entries[4]).toEqual({
      index: 5,
      role: "tool",
      text: "{}",
      toolName: "run",
      toolOk: false,
      toolResult: "nope",
      line: 6,
    });
    expect(entries[5]).toMatchObject({ index: 6, text: "thanks (parts form)" });
  });

  it("windows the last N entries; the pointer names the first hidden entry", async () => {
    const home = await makeHome();
    const file = await fixture(home);
    const result = await createGrokHistoryReader({ homeDir: home }).read(sessionId, { last: 2 });

    expect(result.truncated).toBe(true);
    expect(result.entries.map((e) => e.index)).toEqual([5, 6]);
    expect(result.fullLog).toEqual({ file, line: 1 });
  });

  it("rejects unknown sessions with session_not_found", async () => {
    const home = await makeHome();
    await fixture(home);
    await expectNotFound(createGrokHistoryReader({ homeDir: home }), "00000000-0000-0000-0000-000000000000");
  });
});

describe("mcode history reader", () => {
  const sessionId = "mvs_a4d5474f26b34f0eb8099a3c885014df";

  async function fixture(home: string): Promise<{ dir: string; file: string }> {
    const encoded = Buffer.from(sessionId, "utf8").toString("base64url");
    const dir = path.join(
      home,
      ".minimax",
      "v2",
      "sessions",
      "2026",
      "09",
      "12",
      `11-39-14-321-session_${encoded}`,
    );
    const file = await writeJsonl(path.join(dir, "messages.jsonl"), [
      {
        message_id: "m1",
        turn_id: "t1",
        message: { role: "user", content: [{ type: "text", text: "make the video" }] },
      },
      {
        message_id: "m2",
        turn_id: "t1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "plan" },
            { type: "toolCall", id: "call_function_1", name: "skill", arguments: { name: "video" } },
            { type: "text", text: "On it" },
          ],
          model: "MiniMax-M3",
          timestamp: 1789164366000,
        },
      },
      {
        message_id: "m3",
        message: {
          role: "toolResult",
          toolCallId: "call_function_1",
          toolName: "skill",
          content: [{ type: "text", text: "skill ran" }],
          isError: false,
        },
      },
      {
        message_id: "m4",
        message: {
          role: "custom",
          customType: "background_task_read_settlement",
          content: "",
          display: false,
        },
      },
      {
        message_id: "m5",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Video plan ready" }],
          timestamp: 1789164367000,
        },
      },
    ]);
    return { dir, file };
  }

  it("reads entries; custom rows are skipped; toolResult merges with toolOk", async () => {
    const home = await makeHome();
    const { file } = await fixture(home);
    const result = await createMcodeHistoryReader({ homeDir: home }).read(sessionId, undefined);

    expect(result.totalEntries).toBe(4);
    expect(result.truncated).toBe(false);
    expect(result.fullLog).toEqual({ file, line: 1 });
    const entries = result.entries;
    expect(entries[0]).toMatchObject({ index: 1, role: "user", text: "make the video" });
    expect(entries[1]).toMatchObject({ index: 2, role: "assistant", text: "On it", at: iso(1789164366000) });
    expect(entries[2]).toEqual({
      index: 3,
      role: "tool",
      at: iso(1789164366000),
      text: '{"name":"video"}',
      toolName: "skill",
      toolOk: true,
      toolResult: "skill ran",
      line: 2, // the assistant row carrying the toolCall
    });
    expect(entries[3]).toMatchObject({ index: 4, role: "assistant", text: "Video plan ready" });
  });

  it("windows the last N entries; the pointer names the first hidden entry", async () => {
    const home = await makeHome();
    await fixture(home);
    const result = await createMcodeHistoryReader({ homeDir: home }).read(sessionId, { last: 2 });

    expect(result.truncated).toBe(true);
    expect(result.entries.map((e) => e.index)).toEqual([3, 4]);
    expect(result.fullLog?.line).toBe(1);
  });

  it("rejects unknown sessions with session_not_found", async () => {
    const home = await makeHome();
    await fixture(home);
    await expectNotFound(createMcodeHistoryReader({ homeDir: home }), "mvs_00000000000000000000000000000000");
  });
});

describe("claude history reader", () => {
  const sessionId = "4a9e7e8a-1111-2222-3333-444444444444";

  async function fixture(home: string): Promise<string> {
    const project = path.join(home, ".claude", "projects", "-Users-test-demo");
    // Foreign sidecars must never be picked: exact-name matching only.
    await writeJsonl(path.join(project, `${sessionId}.jsonl.pass1.jsonl`), [
      { type: "user", message: { role: "user", content: "DECOY pass1" } },
    ]);
    await writeJsonl(path.join(project, "deadbeef-0000-0000-0000-000000000000.jsonl"), [
      { type: "user", message: { role: "user", content: "DECOY other session" } },
    ]);
    return await writeJsonl(path.join(project, `${sessionId}.jsonl`), [
      {
        type: "user",
        timestamp: "2026-09-12T08:00:01.000Z",
        isSidechain: false,
        sessionId,
        message: { role: "user", content: "plan the port" },
      },
      {
        type: "assistant",
        timestamp: "2026-09-12T08:00:02.000Z",
        isSidechain: false,
        sessionId,
        message: {
          role: "assistant",
          model: "claude-x",
          content: [
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "text", text: "Starting" },
            { type: "tool_use", id: "toolu_1", name: "read", input: { file_path: "/p" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-09-12T08:00:03.000Z",
        sessionId,
        message: {
          role: "user",
          content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "file text", is_error: false }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-09-12T08:00:04.000Z",
        sessionId,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_2", name: "bash", input: { command: "exit 1" } }],
        },
      },
      {
        type: "user",
        timestamp: "2026-09-12T08:00:05.000Z",
        sessionId,
        message: {
          role: "user",
          content: [
            { tool_use_id: "toolu_2", type: "tool_result", content: "error: boom", is_error: true },
            { type: "text", text: "retry please" },
          ],
        },
      },
      { type: "summary", summary: "ignored", leafUuid: "x" },
      {
        type: "assistant",
        timestamp: "2026-09-12T08:00:06.000Z",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "Retried" }] },
      },
    ]);
  }

  it("reads entries; tool_use becomes tool entries merged via the next user row", async () => {
    const home = await makeHome();
    const file = await fixture(home);
    const result = await createClaudeHistoryReader({ homeDir: home }).read(sessionId, undefined);

    expect(result.totalEntries).toBe(6);
    expect(result.truncated).toBe(false);
    expect(result.fullLog).toEqual({ file, line: 1 });
    const entries = result.entries;
    expect(entries[0]).toMatchObject({
      index: 1,
      role: "user",
      text: "plan the port",
      at: "2026-09-12T08:00:01.000Z",
    });
    expect(entries[1]).toMatchObject({ index: 2, role: "assistant", text: "Starting" });
    expect(entries[2]).toEqual({
      index: 3,
      role: "tool",
      at: "2026-09-12T08:00:02.000Z",
      text: '{"file_path":"/p"}',
      toolName: "read",
      toolOk: true,
      toolResult: "file text",
      line: 2, // the assistant row carrying the tool_use
    });
    // is_error: true → toolOk false; the user text in the same row still lands.
    expect(entries[3]).toMatchObject({ index: 4, role: "tool", toolName: "bash", toolOk: false });
    expect(entries[4]).toMatchObject({ index: 5, role: "user", text: "retry please" });
    expect(entries[5]).toMatchObject({ index: 6, role: "assistant", text: "Retried" });
  });

  it("defaults to the last 20 entries when no options are given", async () => {
    const home = await makeHome();
    const project = path.join(home, ".claude", "projects", "-Users-test-demo");
    const rows = Array.from({ length: 22 }, (_, i) => ({
      type: "user",
      timestamp: `2026-09-12T09:${String(i).padStart(2, "0")}:00.000Z`,
      sessionId,
      message: { role: "user", content: `msg ${i + 1}` },
    }));
    await writeJsonl(path.join(project, `${sessionId}.jsonl`), rows);

    const result = await createClaudeHistoryReader({ homeDir: home }).read(sessionId, undefined);
    expect(result.totalEntries).toBe(22);
    expect(result.entries).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(result.entries.map((e) => e.index)).toEqual([
      3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
    ]);
    expect(result.fullLog).toEqual({ file: result.fullLog?.file, line: 1 });
  });

  it("windows the last N entries; the pointer names the first hidden entry", async () => {
    const home = await makeHome();
    const file = await fixture(home);
    const result = await createClaudeHistoryReader({ homeDir: home }).read(sessionId, { last: 2 });

    expect(result.truncated).toBe(true);
    expect(result.entries.map((e) => e.index)).toEqual([5, 6]);
    expect(result.fullLog).toEqual({ file, line: 1 });
  });

  it("rejects unknown sessions with session_not_found", async () => {
    const home = await makeHome();
    await fixture(home);
    await expectNotFound(
      createClaudeHistoryReader({ homeDir: home }),
      "00000000-0000-0000-0000-000000000000",
    );
  });
});

describe("codex history reader", () => {
  const sessionId = "019eb9b5-3e41-79e1-b724-ba6046bfd228";

  async function fixture(home: string): Promise<{ good: string; bad: string }> {
    const dayDir = path.join(home, ".codex", "sessions", "2026", "09", "12");
    // Newer file whose session_meta names a DIFFERENT session: must be skipped
    // even though the filename matches.
    const bad = await writeJsonl(path.join(dayDir, `rollout-2026-09-12T11-00-00-${sessionId}.jsonl`), [
      {
        timestamp: "2026-09-12T11:00:00.000Z",
        ordinal: 0,
        type: "session_meta",
        payload: { session_id: "some-other-thread" },
      },
      {
        timestamp: "2026-09-12T11:00:01.000Z",
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "WRONG SESSION" }] },
      },
    ]);
    // Old sidecar naming must never match the exact-suffix lookup.
    await writeJsonl(path.join(dayDir, `rollout-2026-09-12T10-00-00-${sessionId}.jsonl.pass1.jsonl`), [
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "DECOY pass1" }] },
      },
    ]);
    const good = await writeJsonl(path.join(dayDir, `rollout-2026-09-12T10-00-00-${sessionId}.jsonl`), [
      {
        timestamp: "2026-09-12T10:00:00.000Z",
        ordinal: 0,
        type: "session_meta",
        payload: { session_id: sessionId, cwd: "/private/tmp/demo", originator: "codex-tui" },
      },
      {
        timestamp: "2026-09-12T10:00:01.000Z",
        ordinal: 1,
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "<skills_instructions>" }],
        },
      },
      {
        timestamp: "2026-09-12T10:00:02.000Z",
        ordinal: 2,
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] },
      },
      {
        timestamp: "2026-09-12T10:00:03.000Z",
        ordinal: 3,
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call_1",
          name: "exec_command",
          arguments: '{"cmd":"ls"}',
        },
      },
      {
        timestamp: "2026-09-12T10:00:04.000Z",
        ordinal: 4,
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call_1", output: "Process exited with code 0" },
      },
      {
        timestamp: "2026-09-12T10:00:05.000Z",
        ordinal: 5,
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "fixed" }] },
      },
      {
        timestamp: "2026-09-12T10:00:06.000Z",
        ordinal: 6,
        type: "response_item",
        payload: { type: "reasoning", summary: [] },
      },
      {
        timestamp: "2026-09-12T10:00:07.000Z",
        ordinal: 7,
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { total_tokens: 100 } } },
      },
    ]);
    return { good, bad };
  }

  it("reads response_item messages; developer maps to system; reasoning/event_msg skipped", async () => {
    const home = await makeHome();
    const { good } = await fixture(home);
    const result = await createCodexHistoryReader({ homeDir: home }).read(sessionId, undefined);

    expect(result.totalEntries).toBe(4);
    expect(result.truncated).toBe(false);
    expect(result.fullLog).toEqual({ file: good, line: 1 });
    const entries = result.entries;
    expect(entries.map((e) => e.role)).toEqual(["system", "user", "tool", "assistant"]);
    expect(entries[0]).toMatchObject({
      index: 1,
      text: "<skills_instructions>",
      at: "2026-09-12T10:00:01.000Z",
    });
    expect(entries[2]).toEqual({
      index: 3,
      role: "tool",
      at: "2026-09-12T10:00:03.000Z",
      text: '{"cmd":"ls"}',
      toolName: "exec_command",
      toolResult: "Process exited with code 0",
      line: 4, // the function_call row
    });
    // The format carries no structured error flag — toolOk stays unset.
    expect(entries[2]?.toolOk).toBeUndefined();
    expect(entries[3]).toMatchObject({ index: 4, role: "assistant", text: "fixed" });
  });

  it("windows the last N entries; the pointer names the first hidden entry", async () => {
    const home = await makeHome();
    await fixture(home);
    const result = await createCodexHistoryReader({ homeDir: home }).read(sessionId, { last: 2 });

    expect(result.truncated).toBe(true);
    expect(result.entries.map((e) => e.index)).toEqual([3, 4]);
    // Entry #1 (the developer row) sits on line 2 (line 1 is session_meta).
    expect(result.fullLog?.line).toBe(2);
  });

  it("skips candidates whose session_meta names another session", async () => {
    const home = await makeHome();
    const { good } = await fixture(home);
    const result = await createCodexHistoryReader({ homeDir: home }).read(sessionId, undefined);
    expect(result.fullLog?.file).toBe(good);
    expect(result.entries.some((e) => e.text.includes("WRONG SESSION"))).toBe(false);
  });

  it("rejects unknown sessions with session_not_found", async () => {
    const home = await makeHome();
    await fixture(home);
    await expectNotFound(createCodexHistoryReader({ homeDir: home }), "00000000-0000-0000-0000-000000000000");
  });
});
