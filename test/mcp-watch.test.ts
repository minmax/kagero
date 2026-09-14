// Tests for the watch compressor surface after the 7-tool rework: the
// `${prefix}_watch` tool is gone — its polling loop lives on as the exported
// handleWatch (tested directly below), while run replies carry the session
// report, kagero_history prepends the digest header and kagero_task_output
// can include the compressed blocks. Coverage kept: raw fallback, compressor
// invocation with session reuse (prefix cache), cursor paging,
// validation-repair fallback, honest degradation on broken replies.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  type AgentCapabilities,
  type AgentResponse,
  type BackendRegistry,
  createRegistry,
  type DigestOutput,
  type HistoryEntry,
  type HistoryOptions,
  type HistoryResult,
  type PromptOptions,
  quoteId,
  resolveHistoryPage,
} from "@kagero/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createKageroMcpServer } from "../packages/mcp/src/index.js";
import { handleWatch, type WatchConfig, type WatchDeps } from "../packages/mcp/src/watch.js";
import { loadWatchState, saveWatchState } from "../packages/mcp/src/watch-state.js";

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
  };
}

function entry(index: number, text: string, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    at: "2026-09-13T10:00:00Z",
    line: index * 3,
    ...extra,
    index,
    role: extra.role ?? "assistant",
    text,
  };
}

/** A valid pass-1 contract output, for planting journal state in tests. */
function digestOutput(blocks = 1): DigestOutput {
  return {
    blocks: Array.from({ length: blocks }, (_, i) => ({
      turnIndex: i + 1,
      anchor: { fromLine: (i + 1) * 3, toLine: (i + 1) * 3 + 2 },
      action: `move ${i + 1} compressed`,
      thoughts: [],
    })),
    digest: { goal: "test goal", currentBelief: "test belief", openHypotheses: [] },
    report: {
      status: "working",
      progress: "halfway through",
      next: "continuing",
      rejected: [],
      leftOpen: [],
    },
  };
}

/**
 * History agent whose history() pages a mutable entry list exactly like the
 * real paginated surface (resolveHistoryPage over the whole list).
 */
class HistoryAgent implements Agent {
  readonly name = "orig";
  readonly capabilities = fullCapabilities();
  readonly entries: HistoryEntry[] = [];

  async prompt(prompt: string): Promise<AgentResponse> {
    return { status: "completed", text: prompt, durationMs: 1, sessionId: "orig-session" };
  }
  async resume(sessionId: string): Promise<AgentResponse> {
    return { status: "completed", text: "", durationMs: 1, sessionId };
  }
  async listModels() {
    return [];
  }
  async listSessions() {
    return [];
  }
  async history(sessionId: string, opts?: HistoryOptions): Promise<HistoryResult> {
    void sessionId;
    const total = this.entries.length;
    const window = resolveHistoryPage(total, opts);
    const slice = this.entries.slice(window.skip, window.skip + window.take);
    return {
      sessionId,
      entries: slice,
      totalEntries: total,
      truncated: total > window.take,
      page: { index: window.page, size: window.size, totalPages: window.totalPages },
      ...(window.page + 1 < window.totalPages ? { older: { page: window.page + 1 } } : {}),
    };
  }
  subscribe() {
    return () => {};
  }
  async send(): Promise<void> {}
  async abort(): Promise<void> {}
  async dispose(): Promise<void> {}
}

/** Compressor agent that answers the pass-1 contract for whatever window it gets. */
class CompressorAgent implements Agent {
  readonly name = "cheap";
  readonly capabilities = fullCapabilities();
  readonly promptCalls: string[] = [];
  readonly resumeCalls: string[] = [];
  /** When set, the agent replies with this instead of a valid contract answer. */
  brokenReply: string | undefined;

  private reply(prompt: string): string {
    if (this.brokenReply !== undefined) return this.brokenReply;
    const turns = [...prompt.matchAll(/TURN b(\d+) \[lines (\d+)–(\d+)\]/g)].map((m) => ({
      index: Number(m[1]),
      fromLine: Number(m[2]),
      toLine: Number(m[3]),
    }));
    if (turns.length === 0)
      console.error("STUB SAW NO TURNS; head:", prompt.slice(prompt.indexOf("WINDOW"), 400));
    const firstQ = prompt.match(/\[(q[0-9a-f]{6})\]/)?.[1];
    const reportItem = firstQ === undefined ? [] : [{ text: "an approach that was dropped", q: firstQ }];
    return JSON.stringify({
      blocks: turns.map((turn) => ({
        turnIndex: turn.index,
        anchor: { fromLine: turn.fromLine, toLine: turn.toLine },
        action: `move ${turn.index} compressed`,
        // quote-ids are window-scoped, so citing the first one is always valid
        thoughts:
          firstQ === undefined
            ? []
            : [{ kind: "H", source: "thinking", text: "the essential pivot", q: firstQ }],
      })),
      digest: { goal: "test goal", currentBelief: "test belief", openHypotheses: [] },
      report: {
        status: "working",
        progress: "halfway through",
        next: "continuing",
        rejected: reportItem,
        leftOpen: [],
      },
    });
  }

  async prompt(prompt: string, _opts?: PromptOptions): Promise<AgentResponse> {
    this.promptCalls.push(prompt);
    return {
      status: "completed",
      text: this.reply(prompt),
      durationMs: 1,
      sessionId: `cheap-${this.promptCalls.length}`,
    };
  }
  async resume(sessionId: string, prompt: string, _opts?: PromptOptions): Promise<AgentResponse> {
    this.resumeCalls.push(prompt);
    return { status: "completed", text: this.reply(prompt), durationMs: 1, sessionId };
  }
  async listModels() {
    return [];
  }
  async listSessions() {
    return [];
  }
  async history(): Promise<HistoryResult> {
    throw new Error("compressor has no history");
  }
  subscribe() {
    return () => {};
  }
  async send(): Promise<void> {}
  async abort(): Promise<void> {}
  async dispose(): Promise<void> {}
}

interface Harness {
  client: Client;
  registry: BackendRegistry;
  original: HistoryAgent;
  compressor: CompressorAgent;
  stateDir: string;
}

async function makeHarness(
  watchConfig: WatchConfig | undefined,
  stateDir: string = mkdtempSync(join(tmpdir(), "kagero-watch-state-")),
): Promise<Harness> {
  process.env["KAGERO_WATCH_STATE_DIR"] = stateDir;
  const original = new HistoryAgent();
  const compressor = new CompressorAgent();
  const registry = createRegistry();
  registry.register("orig", () => original);
  registry.register("cheap", () => compressor);
  const { server } = createKageroMcpServer({
    name: "kagero-watch-test",
    version: "0.0.0-test",
    registry,
    defaultBackend: "orig",
    watch: watchConfig,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, registry, original, compressor, stateDir };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const result = await client.callTool({ name, arguments: args });
  if (typeof result === "object" && result !== null && "content" in result) return result as CallToolResult;
  throw new Error(`unexpected tool result: ${JSON.stringify(result)}`);
}

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function jsonOf(result: CallToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

/** Deps for a direct handleWatch poll against the harness registry. */
function watchDeps(h: Harness, config: WatchConfig): WatchDeps {
  return {
    selectAgent: (backend) => h.registry.select(backend ?? "orig"),
    defaultBackend: "orig",
    config,
  };
}

const WATCH_CONFIG: WatchConfig = { backend: "cheap", maxWaitMs: 1_000, rawThresholdChars: 200 };

describe("kagero tool surface with the watch compressor", () => {
  it("registers exactly the seven tools, with or without compressor config", async () => {
    const expected = [
      "kagero_history",
      "kagero_info",
      "kagero_run",
      "kagero_send_message",
      "kagero_task_list",
      "kagero_task_output",
      "kagero_task_stop",
    ];
    for (const config of [undefined, WATCH_CONFIG]) {
      const h = await makeHarness(config);
      const { tools } = await h.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(expected);
      expect(tools.map((t) => t.name)).not.toContain("kagero_watch");
    }
  });
});

describe("handleWatch (the old watch tool loop, now a library entry point)", () => {
  it("returns the raw delta below the threshold and advances the cursor", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    h.original.entries.push(entry(1, "tiny"));
    const first = await handleWatch(watchDeps(h, WATCH_CONFIG), { session_id: "s1" });
    expect(first.isError).toBe(false);
    expect(first.text).toContain("below the compression threshold");
    expect(first.text).toContain("#1 asst");
    expect(first.text).toContain("@L3");

    const cursor = first.text.match(/— watch cursor: (\S+)/)?.[1] ?? "";
    expect(cursor).not.toBe("");
    const second = await handleWatch(watchDeps(h, WATCH_CONFIG), { session_id: "s1", cursor });
    expect(second.text).toContain("no new events");
  });

  it("compresses a large delta, then resumes the SAME compressor session for the next delta", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    h.original.entries.push(entry(1, "please fix the race", { role: "user" }));
    for (let i = 2; i <= 6; i++) {
      h.original.entries.push(
        entry(i, `narration ${i} with enough bulk to exceed the raw threshold. `.repeat(4), {
          ...(i === 2 ? { thinking: "thinking for move 2" } : {}),
        }),
      );
    }

    const first = await handleWatch(watchDeps(h, WATCH_CONFIG), { session_id: "s1" });
    expect(first.isError).toBe(false);
    expect(first.text).toContain("compressed by cheap");
    expect(first.text).toContain("digest goal: test goal");
    expect(first.text).toContain("- b1 @L3");
    expect(h.compressor.promptCalls).toHaveLength(1);
    expect(h.compressor.resumeCalls).toHaveLength(0);
    // the first prompt carries the standing instructions (the cache prefix)
    expect(h.compressor.promptCalls[0]).toContain("session-compressor worker");

    const cursor = first.text.match(/— watch cursor: (\S+)/)?.[1] ?? "";
    h.original.entries.push(entry(7, "narration 7 with enough bulk. ".repeat(60)));

    const second = await handleWatch(watchDeps(h, WATCH_CONFIG), { session_id: "s1", cursor });
    expect(second.text).toContain("compressed by cheap");
    expect(second.text).toContain("move 1 compressed"); // only the NEW window
    expect(second.text).toContain("@L21");
    expect(h.compressor.resumeCalls).toHaveLength(1);
    // the resumed turn must NOT repeat the instructions — the cache keeps them
    expect(h.compressor.resumeCalls[0]).not.toContain("session-compressor worker");
  });

  it("degrades to the raw view when the compressor reply stays invalid", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    h.compressor.brokenReply = "no json here at all";
    for (let i = 1; i <= 4; i++) {
      h.original.entries.push(entry(i, `narration ${i} bulk bulk bulk bulk bulk. `.repeat(6)));
    }
    const result = await handleWatch(watchDeps(h, WATCH_CONFIG), { session_id: "s1" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("failed validation");
    expect(result.text).toContain("reply contained no JSON object");
    // the position still advances — a poll never loses events
    expect(result.text).toMatch(/— watch cursor: \S+/);
  });

  it("rejects a cursor from another session", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    h.original.entries.push(entry(1, "tiny"));
    const result = await handleWatch(watchDeps(h, WATCH_CONFIG), {
      session_id: "s1",
      cursor: Buffer.from(JSON.stringify({ v: 1, s: "other", i: 3 }), "utf8").toString("base64url"),
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("belongs to a different session");
  });

  it("the reply cites the window's q-id for thinking moves", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    h.original.entries.push(entry(1, "please fix the race", { role: "user" }));
    const thinking = "stale snapshot on retry — the pivot";
    h.original.entries.push(entry(2, "narration with bulk. ".repeat(60), { thinking }));
    const result = await handleWatch(watchDeps(h, WATCH_CONFIG), { session_id: "s1" });
    expect(result.text).toContain(`· H (thinking, ${quoteId(thinking)})`);
  });

  it("renders the report header with rejected/left-open items", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    h.original.entries.push(entry(1, "please fix the race", { role: "user" }));
    const thinking = "approach A re-enters stale — dropped; do B instead";
    h.original.entries.push(entry(2, "narration with bulk. ".repeat(60), { thinking }));
    const result = await handleWatch(watchDeps(h, WATCH_CONFIG), { session_id: "s1" });
    expect(result.text).toContain("status: working · progress: halfway through · next: continuing");
    expect(result.text).toContain(`rejected (${quoteId(thinking)}): an approach that was dropped`);
  });
});

describe("run session report", () => {
  it("appends the compressed report and facts to a completed run reply", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    // The run's own history: user ask + assistant move with thinking + tools.
    h.original.entries.push(entry(1, "please fix the race", { role: "user" }));
    const thinking = "retry-first re-enters stale — approach dropped";
    h.original.entries.push(entry(2, `working narration with bulk. `.repeat(12), { thinking }));
    h.original.entries.push(
      entry(3, JSON.stringify({ path: "/repo/src/lock.ts" }), {
        role: "tool",
        toolName: "edit_file",
        toolOk: true,
      }),
    );
    const result = await call(h.client, "kagero_run", { prompt: "fix the race" });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text.startsWith("fix the race\n\n— session report (compressed by cheap):")).toBe(true);
    expect(text).toContain("status: working · progress: halfway through · next: continuing");
    expect(text).toContain(`rejected (${quoteId(thinking)}): an approach that was dropped`);
    expect(text).toContain("files: /repo/src/lock.ts");
  });

  it("keeps the reply intact when the compressor is broken", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    h.compressor.brokenReply = "no json at all";
    h.original.entries.push(entry(1, "please fix the race", { role: "user" }));
    h.original.entries.push(entry(2, "narration bulk. ".repeat(12)));
    const result = await call(h.client, "kagero_run", { prompt: "fix the race" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("fix the race");
  });
});

describe("history digest header", () => {
  it("prepends the digest header to kagero_history when journal state exists", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    h.original.entries.push(entry(1, "tail entry"));
    saveWatchState({ v: 1, backend: "orig", sessionId: "s1", cursorIndex: 6, digest: digestOutput(2) });
    expect(loadWatchState("orig", "s1")?.digest).toBeDefined();

    const result = await call(h.client, "kagero_history", { session_id: "s1" });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain(
      "[watch digest] status: working · goal: test goal · belief: test belief · 2 compressed blocks (through entry #6)",
    );
    // The paged entries still render below the header.
    expect(text).toContain("#1 asst");
  });

  it("history on an older page still carries the header", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    saveWatchState({
      v: 1,
      backend: "orig",
      sessionId: "s1",
      cursorIndex: 0,
      streamCursorIndex: 11,
      digest: digestOutput(1),
    });
    const result = await call(h.client, "kagero_history", { session_id: "s1", page: 3 });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("[watch digest]");
    expect(textOf(result)).toContain("through entry #11");
  });

  it("no header without journal state", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    h.original.entries.push(entry(1, "tail entry"));
    const result = await call(h.client, "kagero_history", { session_id: "s-none" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain("[watch digest]");
  });
});

describe("background run with digest blocks", () => {
  it("task_output include_blocks prepends the planted digest blocks", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    saveWatchState({
      v: 1,
      backend: "orig",
      sessionId: "orig-session",
      cursorIndex: 6,
      digest: digestOutput(2),
    });
    const started = await call(h.client, "kagero_run", { prompt: "fix the race", run_in_background: true });
    const taskId = String(jsonOf(started)["task_id"]);
    const output = await call(h.client, "kagero_task_output", {
      task_id: taskId,
      wait_ms: 5_000,
      include_blocks: true,
    });
    expect(output.isError).toBeFalsy();
    const text = textOf(output);
    expect(text).toContain("[watch digest blocks]");
    expect(text).toContain("- b1 @L3");
    expect(text).toContain("- b2 @L6");
    expect(text).toContain("finished: succeeded");
    // The run's compressor report is stored on the task and re-emitted.
    expect(text).toContain("session report");
  });

  it("include_blocks without journal state just returns the result", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    const started = await call(h.client, "kagero_run", { prompt: "plain", run_in_background: true });
    const taskId = String(jsonOf(started)["task_id"]);
    const output = await call(h.client, "kagero_task_output", {
      task_id: taskId,
      wait_ms: 5_000,
      include_blocks: true,
    });
    expect(output.isError).toBeFalsy();
    const text = textOf(output);
    expect(text).not.toContain("[watch digest blocks]");
    expect(text).toContain("finished: succeeded");
  });
});
