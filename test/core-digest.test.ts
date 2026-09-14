// Unit tests for the digest compressor contract (ported from agenttrace):
// window building over HistoryEntry streams, q-id anchoring, the output
// validator, and the renderers.

import {
  buildDigestWindow,
  type DigestBlock,
  estimateTokens,
  extractFacts,
  extractJsonObject,
  type HistoryEntry,
  quoteId,
  renderDigestBlocks,
  renderRawEntries,
  renderSessionFacts,
  validateDigestOutput,
} from "@kagero/core";
import { describe, expect, it } from "vitest";

function entry(
  partial: Partial<HistoryEntry> & { index: number; role: HistoryEntry["role"]; text: string },
): HistoryEntry {
  return {
    at: "2026-09-13T10:00:00Z",
    ...partial,
  };
}

describe("buildDigestWindow", () => {
  it("makes user messages standalone turns and groups tools into the assistant move", () => {
    const entries: HistoryEntry[] = [
      entry({ index: 1, role: "user", text: "fix the race", line: 4 }),
      entry({ index: 2, role: "assistant", text: "I will inspect the lock order first.", line: 8 }),
      entry({
        index: 3,
        role: "tool",
        text: '{"cmd":"grep -n mutex src"}',
        line: 9,
        toolName: "Bash",
        toolOk: true,
        toolResult: "src/a.ts:12: mutex",
      }),
      entry({ index: 4, role: "assistant", text: "Found it — the unlock order is inverted.", line: 20 }),
    ];
    const window = buildDigestWindow(entries);

    expect(window.turns.map((t) => t.kind)).toEqual(["user", "assistant", "assistant"]);
    expect(window.turns[1]?.toolNames).toEqual(["Bash"]);
    expect(window.turns[1]?.entryFrom).toBe(2);
    expect(window.turns[1]?.entryTo).toBe(3);
    // line anchors come from the source log
    expect(window.fromLine).toBe(4);
    expect(window.toLine).toBe(20);
    // the merged tool result is rendered with its status
    expect(window.turns[1]?.text).toContain("[CALL] Bash");
    expect(window.turns[1]?.text).toContain("[RESULT ok] src/a.ts:12: mutex");
  });

  it("keeps thinking intact, flags the turn MANDATORY and registers the q-id", () => {
    const thinking = "The retry loop re-enters with a stale snapshot — that is the pivot.";
    const entries: HistoryEntry[] = [
      entry({ index: 7, role: "assistant", text: "Trying a different angle now.", line: 30, thinking }),
    ];
    const window = buildDigestWindow(entries);

    expect(window.turns[0]?.hasThinking).toBe(true);
    expect([...window.thinkingTurnIndexes]).toEqual([1]);
    expect(window.quoteIds.has(quoteId(thinking))).toBe(true);
    expect(window.turns[0]?.text).toContain(`[THINKING] [${quoteId(thinking)}]`);
    expect(window.turns[0]?.text).toContain(thinking); // intact — never cut
    expect(window.turns[0]?.text).toContain("MANDATORY");
  });

  it("truncates oversized tool results with an explicit @L cut mark", () => {
    const big = "x".repeat(6_000);
    const entries: HistoryEntry[] = [
      entry({
        index: 2,
        role: "tool",
        text: '{"cmd":"cat big.log"}',
        line: 44,
        toolName: "Bash",
        toolOk: true,
        toolResult: big,
      }),
    ];
    const window = buildDigestWindow(entries, { resultHead: 100, resultTail: 40 });
    expect(window.turns[0]?.text).toContain("⟨truncated: 6000→");
    expect(window.turns[0]?.text).toContain("@L44");
    expect(window.turns[0]?.text).toContain("sha:#");
    expect(window.turns[0]?.text.length).toBeLessThan(400);
  });

  it("falls back to entry-index anchors when the reader has no line numbers", () => {
    const entries: HistoryEntry[] = [
      entry({ index: 5, role: "assistant", text: "no lines here" }),
      entry({ index: 6, role: "tool", text: "{}", toolName: "Read", toolOk: true }),
    ];
    const window = buildDigestWindow(entries);
    expect(window.turns[0]?.fromLine).toBeUndefined();
    expect(window.turns[0]?.text).toContain("TURN b1 [entries #5–#6]");
  });
});

describe("validateDigestOutput", () => {
  const entries: HistoryEntry[] = [
    entry({ index: 1, role: "user", text: "do the thing", line: 2 }),
    entry({
      index: 2,
      role: "assistant",
      text: "on it",
      line: 6,
      thinking: "plan: check the cache first",
    }),
    entry({
      index: 3,
      role: "tool",
      text: '{"cmd":"ls"}',
      line: 8,
      toolName: "Bash",
      toolOk: true,
      toolResult: "a.ts b.ts",
    }),
  ];
  const window = buildDigestWindow(entries);
  const q = quoteId("plan: check the cache first");

  /** One block per turn, contract-clean by construction. */
  function validBlocks(): DigestBlock[] {
    return window.turns.map((turn) => ({
      turnIndex: turn.index,
      anchor: { fromLine: turn.fromLine ?? 1, toLine: turn.toLine ?? 2 },
      action: "moved the task forward",
      thoughts:
        turn.hasThinking && turn.index === 2
          ? [{ kind: "H" as const, source: "thinking" as const, text: "cache before recompute", q }]
          : [],
    }));
  }

  function validReply() {
    return {
      blocks: validBlocks(),
      digest: { goal: "fix the thing", currentBelief: "cache is the culprit", openHypotheses: [] },
      report: {
        status: "done",
        progress: "cache order fixed, 14/14 green",
        next: "—",
        rejected: [{ text: "retry-first approach — re-enters stale", q }],
        leftOpen: [],
      },
    };
  }

  it("accepts a contract-clean reply", () => {
    const reply = { ...validReply() };
    expect(validateDigestOutput(reply, { window })).toEqual([]);

    // report.status must be one of the four verbs
    const badStatus = { ...validReply(), report: { ...validReply().report, status: "excellent" } };
    expect(
      validateDigestOutput(badStatus, { window }).some((e) => e.includes("report.status must be one of")),
    ).toBe(true);

    // report items must cite window q-ids
    const badQ = {
      ...validReply(),
      report: { ...validReply().report, leftOpen: [{ text: "unfinished", q: "qnope" }] },
    };
    expect(validateDigestOutput(badQ, { window }).some((e) => e.includes("does not match any [q-id]"))).toBe(
      true,
    );

    // missing report is a contract error
    const noReport = { blocks: validBlocks(), digest: validReply().digest };
    expect(
      validateDigestOutput(noReport, { window }).some((e) => e.includes("missing object 'report'")),
    ).toBe(true);
  });

  it("rejects uncovered turns and double coverage", () => {
    const blocks = validBlocks().slice(0, 1);
    const reply = {
      blocks,
      digest: { goal: "g", currentBelief: "b", openHypotheses: [] },
    };
    const errors = validateDigestOutput(reply, { window });
    expect(errors.some((e) => e.includes("not covered by any block"))).toBe(true);

    const doubled = { ...reply, blocks: [...blocks, blocks[0]] };
    const errors2 = validateDigestOutput(doubled, { window });
    expect(errors2.some((e) => e.includes("covered twice"))).toBe(true);
  });

  it("enforces thoughts on thinking turns and q-id membership", () => {
    const blocks = validBlocks().map((b) => (b.turnIndex === 2 ? { ...b, thoughts: [] } : b));
    const errors = validateDigestOutput(
      { blocks, digest: { goal: "g", currentBelief: "b", openHypotheses: [] } },
      { window },
    );
    expect(errors.some((e) => e.includes("thoughts must not be empty"))).toBe(true);

    const badQ = validBlocks().map((b) =>
      b.turnIndex === 2 ? { ...b, thoughts: [{ kind: "H", source: "thinking", text: "x", q: "qnope" }] } : b,
    );
    const errors2 = validateDigestOutput(
      { blocks: badQ, digest: { goal: "g", currentBelief: "b", openHypotheses: [] } },
      { window },
    );
    expect(errors2.some((e) => e.includes("does not match any [q-id]"))).toBe(true);
  });

  it("enforces length caps and anchor ranges", () => {
    const blocks = validBlocks().map((b) => ({ ...b, action: "a".repeat(241) }));
    const errors = validateDigestOutput(
      { blocks, digest: { goal: "g".repeat(201), currentBelief: "b", openHypotheses: [] } },
      { window },
    );
    expect(errors.some((e) => e.includes("action exceeds 240"))).toBe(true);
    expect(errors.some((e) => e.includes("goal exceeds 200"))).toBe(true);

    const outOfRange = validBlocks().map((b) => ({
      ...b,
      anchor: { fromLine: 999, toLine: 1000 },
    }));
    const errors2 = validateDigestOutput(
      { blocks: outOfRange, digest: { goal: "g", currentBelief: "b", openHypotheses: [] } },
      { window },
    );
    expect(errors2.some((e) => e.includes("outside the move's lines"))).toBe(true);
  });
});

describe("extractJsonObject", () => {
  it("extracts from prose and fences", () => {
    expect(extractJsonObject('here: {"a":1} done')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    // a fenced non-object is authoritative — no brace scavenging
    expect(extractJsonObject('```json\n[1,2]\n``` {"a":1}')).toBeUndefined();
  });
});

describe("renderers", () => {
  it("renders digest blocks with anchors and thoughts", () => {
    const entries: HistoryEntry[] = [entry({ index: 3, role: "user", text: "hi", line: 9 })];
    const window = buildDigestWindow(entries);
    const output = {
      blocks: [
        {
          turnIndex: 1,
          anchor: { fromLine: 9, toLine: 9 },
          action: "greeted the operator",
          thoughts: [
            { kind: "H" as const, source: "thinking" as const, text: "keep it short", q: "qabc123" },
          ],
        },
      ],
      digest: { goal: "greet", currentBelief: "fresh session", openHypotheses: ["maybe a test"] },
    };
    const text = renderDigestBlocks(output, window);
    expect(text).toContain("compressed 3–3 (@L9–@L9,");
    expect(text).toContain("digest goal: greet");
    expect(text).toContain("open: maybe a test");
    expect(text).toContain("- b1 @L9–@L9 greeted the operator");
    expect(text).toContain("· H (thinking, qabc123): keep it short");
  });

  it("renders raw fallback entries with line anchors", () => {
    const text = renderRawEntries([
      { index: 12, role: "user", text: "short", line: 31 },
      { index: 13, role: "assistant", text: "y".repeat(300), line: 35 },
    ]);
    expect(text).toContain("#12 user --:--:-- @L31 | short");
    expect(text).toContain("#13 asst --:--:-- @L35 | ");
    expect(text).toContain("…(+100 chars)");
  });

  it("estimates tokens as chars/4", () => {
    expect(estimateTokens("x".repeat(9))).toBe(3);
  });
});

describe("extractFacts", () => {
  it("collects files from first-level path args and flags exact repeats", () => {
    const entries: HistoryEntry[] = [
      entry({ index: 1, role: "user", text: "go" }),
      entry({
        index: 2,
        role: "tool",
        text: JSON.stringify({ path: "/repo/src/a.ts" }),
        toolName: "edit_file",
      }),
      entry({
        index: 3,
        role: "tool",
        text: JSON.stringify({ file_path: "/repo/src/b.ts" }),
        toolName: "write",
      }),
      entry({
        index: 4,
        role: "tool",
        text: JSON.stringify({ cmd: "grep -rn mutex src" }),
        toolName: "Bash",
      }),
      // exact repeat of the same Bash call three times → loop
      entry({
        index: 5,
        role: "tool",
        text: JSON.stringify({ cmd: "grep -rn mutex src" }),
        toolName: "Bash",
      }),
      entry({
        index: 6,
        role: "tool",
        text: JSON.stringify({ cmd: "grep -rn mutex src" }),
        toolName: "Bash",
      }),
    ];
    const facts = extractFacts(entries);
    expect(facts.files).toEqual(["/repo/src/a.ts", "/repo/src/b.ts"]);
    expect(facts.loops).toEqual([{ tool: "Bash", repeats: 3, sample: '{"cmd":"grep -rn mutex src"}' }]);
    expect(renderSessionFacts(facts)).toBe(
      `files: /repo/src/a.ts, /repo/src/b.ts\nloop: Bash ${JSON.stringify('{"cmd":"grep -rn mutex src"}')} ×3`,
    );
  });

  it("ignores non-JSON args and caps the file list", () => {
    const entries: HistoryEntry[] = Array.from({ length: 14 }, (_, i) =>
      entry({
        index: i + 1,
        role: "tool",
        text: JSON.stringify({ path: `/repo/f${i}.ts` }),
        toolName: "write",
      }),
    );
    entries.push(entry({ index: 99, role: "tool", text: "plain string args", toolName: "Bash" }));
    const facts = extractFacts(entries);
    expect(facts.files).toHaveLength(11);
    expect(facts.files[10]).toBe("+4 more");
    expect(facts.loops).toEqual([]);
  });
});
