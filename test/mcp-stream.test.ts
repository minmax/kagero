// Tests for the stream compressor hub: the factory's own runs get their
// events minimized into live lines, accumulated in memory, and compressed
// into the persistent journal window by window (moves never split).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  type AgentCapabilities,
  type AgentEvent,
  type AgentResponse,
  createRegistry,
  type HistoryEntry,
  type HistoryOptions,
  type HistoryResult,
  type PromptOptions,
} from "@kagero/core";
import { describe, expect, it } from "vitest";
import { minimizeEvent, StreamCompressorHub } from "../packages/mcp/src/stream-compressor.js";
import { readJournalFile } from "../packages/mcp/src/watch-journal.js";
import { loadWatchState } from "../packages/mcp/src/watch-state.js";

function caps(): AgentCapabilities {
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

/** Emits recorded events to wildcard AND per-session subscribers, like the backend dispatch. */
class EventAgent implements Agent {
  readonly name = "fake";
  readonly capabilities = caps();
  readonly listeners = new Map<string, Set<(e: AgentEvent) => void>>();
  readonly promptCalls: string[] = [];

  emit(sessionId: string, event: AgentEvent): void {
    for (const key of [sessionId, "*"]) {
      for (const cb of this.listeners.get(key) ?? []) cb(event);
    }
  }

  async prompt(prompt: string, _opts?: PromptOptions): Promise<AgentResponse> {
    this.promptCalls.push(prompt);
    return { status: "completed", text: "done", durationMs: 1, sessionId: "s1" };
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
    void opts;
    return { sessionId, entries: [] as HistoryEntry[], totalEntries: 0, truncated: false };
  }
  subscribe(sessionId: string, onEvent: (e: AgentEvent) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(onEvent);
    return () => {
      set?.delete(onEvent);
    };
  }
  async send(): Promise<void> {}
  async abort(): Promise<void> {}
  async dispose(): Promise<void> {}
}

function digestReply(turnCount: number): string {
  return JSON.stringify({
    blocks: Array.from({ length: turnCount }, (_, i) => ({
      turnIndex: i + 1,
      anchor: { fromLine: i + 1, toLine: i + 1 },
      action: `move ${i + 1}`,
      thoughts: [],
    })),
    digest: { goal: "g", currentBelief: "b", openHypotheses: [] },
    report: { status: "working", progress: "p", next: "n", rejected: [], leftOpen: [] },
  });
}

function turnEvent(n: number, tokens: number): AgentEvent {
  const bulk = "x".repeat(tokens * 4);
  return { type: "assistant-text", content: `move ${n} ${bulk}`, at: new Date().toISOString() };
}

describe("minimizeEvent", () => {
  it("cuts fat tool results with an explicit cut mark", () => {
    const line = minimizeEvent({
      type: "tool-result",
      name: "Bash",
      result: "y".repeat(5000),
      at: new Date().toISOString(),
    });
    expect(line.startsWith("RESULT Bash ")).toBe(true);
    expect(line).toContain("⟨cut⟩");
    expect(line.length).toBeLessThan(800);
  });

  it("keeps user/assistant lines short", () => {
    const line = minimizeEvent({
      type: "assistant-text",
      content: "z".repeat(3000),
      at: new Date().toISOString(),
    });
    expect(line.startsWith("ASST: ")).toBe(true);
    expect(line.length).toBeLessThan(300);
  });
});

describe("StreamCompressorHub", () => {
  it("routes live lines per session, compresses a full window in the background, and checkpoints the journal", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "kagero-hub-"));
    process.env["KAGERO_WATCH_STATE_DIR"] = stateDir;
    const original = new EventAgent();
    const compressor = new EventAgent();
    compressor.prompt = async (prompt: string) => {
      compressor.promptCalls.push(prompt);
      // 5 turns per batch window → reply with 5 blocks.
      const turns = (prompt.match(/TURN b\d+/g) ?? []).length;
      return {
        status: "completed",
        text: digestReply(Math.max(turns, 1)),
        durationMs: 1,
        sessionId: "cheap-1",
      };
    };
    const registry = createRegistry();
    registry.register("fake", () => original);
    registry.register("cheap", () => compressor);

    const live: string[] = [];
    const hub = new StreamCompressorHub({
      selectAgent: (backend) => registry.select(backend ?? "fake"),
      config: { backend: "cheap", maxWaitMs: 1000, rawThresholdChars: 1500 },
      onLiveLine: (backend, sessionId, line) => live.push(`${backend}:${sessionId}:${line.slice(0, 200)}`),
    });
    hub.attach(original);

    // A run happens: session opens, 5 big moves stream by, session closes.
    original.emit("s1", { type: "session-start", sessionId: "s1", at: new Date().toISOString() });
    original.emit("s1", { type: "user-prompt", content: "go", at: new Date().toISOString() });
    for (let i = 1; i <= 5; i++) {
      original.emit("s1", turnEvent(i, 9_000)); // ~9k tok each: budget 40k crosses at move 5
      original.emit("s1", {
        type: "tool-result",
        name: "Bash",
        result: "r".repeat(100),
        at: new Date().toISOString(),
      });
    }
    // "дай сейчас": await the background compression before asserting files.
    await hub.flushSession("s1");
    original.emit("s1", { type: "session-end", reason: "completed", at: new Date().toISOString() });

    // Live lines: the COMPRESSED batch went out (no per-event minimized feed).
    expect(live.some((l) => l.includes("[batch compressed"))).toBe(true);
    expect(live.some((l) => l.includes("digest goal: g"))).toBe(true);
    expect(live.some((l) => l.includes("- b1 ") && l.includes("move 1"))).toBe(true);
    expect(live.some((l) => l.includes("USER: go"))).toBe(false);

    // The journal holds the header + checkpoints; the state is loadable.
    const file = join(stateDir, "fake", "s1.jsonl.zstd");
    const journal = readJournalFile(file);
    expect(journal.lines[0]).toMatchObject({ type: "header", backend: "fake" });
    const state = loadWatchState("fake", "s1");
    expect(state?.digest?.report?.status).toBe("working");
    expect((state?.streamCursorIndex ?? 0) >= 11).toBe(true);
  });

  it("a move is never split: the oversized move forms its own whole batch", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "kagero-hub2-"));
    process.env["KAGERO_WATCH_STATE_DIR"] = stateDir;
    const original = new EventAgent();
    const compressor = new EventAgent();
    // Both entry points record: batch 1 opens the compressor session (prompt),
    // batch 2 RESUMES it (the cache economy) — both count as compression calls.
    const compressCalls: string[] = [];
    compressor.prompt = async (prompt: string) => {
      compressCalls.push(prompt);
      const turns = (prompt.match(/TURN b\d+/g) ?? []).length;
      return {
        status: "completed",
        text: digestReply(Math.max(turns, 1)),
        durationMs: 1,
        sessionId: "cheap-1",
      };
    };
    compressor.resume = async (sessionId: string, prompt?: string) => {
      compressCalls.push(prompt ?? "");
      const turns = ((prompt ?? "").match(/TURN b\d+/g) ?? []).length;
      return { status: "completed", text: digestReply(Math.max(turns, 1)), durationMs: 1, sessionId };
    };
    const registry = createRegistry();
    registry.register("fake", () => original);
    registry.register("cheap", () => compressor);
    const hub = new StreamCompressorHub({
      selectAgent: (backend) => registry.select(backend ?? "fake"),
      config: { backend: "cheap", maxWaitMs: 1000, rawThresholdChars: 1500 },
      onLiveLine: () => {},
    });
    hub.attach(original);

    original.emit("s1", { type: "session-start", sessionId: "s1", at: new Date().toISOString() });
    // One giant move (100k tok >> 40k budget): must stay WHOLE in one batch.
    original.emit("s1", turnEvent(1, 100_000));
    original.emit("s1", turnEvent(2, 100));
    await hub.flushSession("s1");

    const prompts = compressCalls;
    expect(prompts.length).toBe(2);
    // First batch: only the giant move; second: the small one.
    expect(prompts[0]).toContain("move 1");
    expect(prompts[0]).not.toContain("move 2");
    expect(prompts[1]).toContain("move 2");
  });
});

describe("recursion guard", () => {
  it("ignores the compressor's own session (recognized by its first prompt)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "kagero-hub3-"));
    process.env["KAGERO_WATCH_STATE_DIR"] = stateDir;
    const original = new EventAgent();
    const compressor = new EventAgent();
    let compressorTurns = 0;
    compressor.prompt = async (prompt: string) => {
      compressorTurns += 1;
      const turns = (prompt.match(/TURN b\d+/g) ?? []).length;
      return {
        status: "completed",
        text: digestReply(Math.max(turns, 1)),
        durationMs: 1,
        sessionId: `cheap-${compressorTurns}`,
      };
    };
    const registry = createRegistry();
    registry.register("fake", () => original);
    registry.register("cheap", () => compressor);
    const live: string[] = [];
    const hub = new StreamCompressorHub({
      selectAgent: (backend) => registry.select(backend ?? "fake"),
      config: { backend: "cheap", maxWaitMs: 1000, rawThresholdChars: 200 },
      onLiveLine: (backend, sessionId, line) => live.push(`${backend}/${sessionId}: ${line.slice(0, 40)}`),
    });
    hub.attach(original);

    // The runner session does real work.
    original.emit("sr1", { type: "session-start", sessionId: "sr1", at: new Date().toISOString() });
    original.emit("sr1", { type: "user-prompt", content: "real task", at: new Date().toISOString() });
    original.emit("sr1", { type: "assistant-text", content: "working…", at: new Date().toISOString() });

    // The compressor backend starts its own session; its first prompt IS the
    // standing instructions — the hub must recognize and suppress it.
    const markerPrompt = (await import("../packages/mcp/src/watch.js")).COMPRESSOR_SYSTEM_PROMPT;
    original.emit("sc9", { type: "session-start", sessionId: "sc9", at: new Date().toISOString() });
    original.emit("sc9", { type: "user-prompt", content: markerPrompt, at: new Date().toISOString() });
    original.emit("sc9", {
      type: "assistant-text",
      content: "compressed output json",
      at: new Date().toISOString(),
    });
    original.emit("sc9", { type: "session-end", reason: "completed", at: new Date().toISOString() });

    await hub.flushSession("sr1");
    // The suppressed session produced no live lines and no compression.
    expect(live.some((l) => l.startsWith("fake/sc9:"))).toBe(false);
    expect(compressorTurns).toBe(1); // only the runner's batch, no chain reaction
  });
});
