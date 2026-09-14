// Tests for the kagero_watch tool: raw fallback, compressor invocation with
// session reuse (prefix cache), cursor paging, validation-repair fallback, and
// honest degradation when the compressor reply is broken.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  type AgentCapabilities,
  type AgentResponse,
  createRegistry,
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
  original: HistoryAgent;
  compressor: CompressorAgent;
  stateDir: string;
}

async function makeHarness(
  watchConfig:
    | { backend: string; modelId?: string; maxWaitMs: number; rawThresholdChars: number }
    | undefined,
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
  return { client, original, compressor, stateDir };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const result = await client.callTool({ name, arguments: args });
  if (typeof result === "object" && result !== null && "content" in result) return result as CallToolResult;
  throw new Error(`unexpected tool result: ${JSON.stringify(result)}`);
}

function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

const WATCH_CONFIG = { backend: "cheap", maxWaitMs: 1_000, rawThresholdChars: 200 };

describe("kagero_watch", () => {
  it("is not registered when no watch config is provided", async () => {
    const { client } = await makeHarness(undefined);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("kagero_watch");
  });

  it("is registered when a watch config is provided", async () => {
    const { client } = await makeHarness(WATCH_CONFIG);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("kagero_watch");
  });

  it("returns the raw delta below the threshold and advances the cursor", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    h.original.entries.push(entry(1, "tiny"));
    const first = await call(h.client, "kagero_watch", { session_id: "s1" });
    expect(first.isError).toBeFalsy();
    expect(textOf(first)).toContain("below the compression threshold");
    expect(textOf(first)).toContain("#1 asst");
    expect(textOf(first)).toContain("@L3");

    const cursor = textOf(first).match(/— watch cursor: (\S+)/)?.[1] ?? "";
    expect(cursor).not.toBe("");
    const second = await call(h.client, "kagero_watch", { session_id: "s1", cursor });
    expect(textOf(second)).toContain("no new events");
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

    const first = await call(h.client, "kagero_watch", { session_id: "s1" });
    expect(first.isError).toBeFalsy();
    const firstText = textOf(first);
    expect(firstText).toContain("compressed by cheap");
    expect(firstText).toContain("digest goal: test goal");
    expect(firstText).toContain("- b1 @L3");
    expect(h.compressor.promptCalls).toHaveLength(1);
    expect(h.compressor.resumeCalls).toHaveLength(0);
    // the first prompt carries the standing instructions (the cache prefix)
    expect(h.compressor.promptCalls[0]).toContain("session-compressor worker");

    const cursor = firstText.match(/— watch cursor: (\S+)/)?.[1] ?? "";
    h.original.entries.push(entry(7, "narration 7 with enough bulk. ".repeat(60)));

    const second = await call(h.client, "kagero_watch", { session_id: "s1", cursor });
    const secondText = textOf(second);
    expect(secondText).toContain("compressed by cheap");
    expect(secondText).toContain("move 1 compressed"); // only the NEW window
    expect(secondText).toContain("@L21");
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
    const result = await call(h.client, "kagero_watch", { session_id: "s1" });
    expect(result.isError).toBeFalsy();
    const text = textOf(result);
    expect(text).toContain("failed validation");
    expect(text).toContain("reply contained no JSON object");
    // the position still advances — a poll never loses events
    expect(text).toMatch(/— watch cursor: \S+/);
  });

  it("rejects a cursor from another session", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    h.original.entries.push(entry(1, "tiny"));
    const result = await call(h.client, "kagero_watch", {
      session_id: "s1",
      cursor: Buffer.from(JSON.stringify({ v: 1, s: "other", i: 3 }), "utf8").toString("base64url"),
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("belongs to a different session");
  });

  it("the reply cites the window's q-id for thinking moves", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    h.original.entries.push(entry(1, "please fix the race", { role: "user" }));
    const thinking = "stale snapshot on retry — the pivot";
    h.original.entries.push(entry(2, "narration with bulk. ".repeat(60), { thinking }));
    const result = await call(h.client, "kagero_watch", { session_id: "s1" });
    const text = textOf(result);
    expect(text).toContain(`· H (thinking, ${quoteId(thinking)})`);
  });
});

describe("kagero_watch report header", () => {
  it("renders the report header with rejected/left-open items", async () => {
    const h = await makeHarness(WATCH_CONFIG);
    h.original.entries.push(entry(1, "please fix the race", { role: "user" }));
    const thinking = "approach A re-enters stale — dropped; do B instead";
    h.original.entries.push(entry(2, "narration with bulk. ".repeat(60), { thinking }));
    const result = await call(h.client, "kagero_watch", { session_id: "s1" });
    const text = textOf(result);
    expect(text).toContain("status: working · progress: halfway through · next: continuing");
    expect(text).toContain(`rejected (${quoteId(thinking)}): an approach that was dropped`);
  });
});

describe("prompt/resume session report", () => {
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
    const result = await call(h.client, "kagero_prompt", { prompt: "fix the race", session_id: "s1" });
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
    const result = await call(h.client, "kagero_prompt", { prompt: "fix the race", session_id: "s1" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("fix the race");
  });
});
