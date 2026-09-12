// Unit tests for the canonical compact history renderer.
import { describe, expect, it } from "vitest";
import { renderHistory, truncateForHistory } from "@kagero/core";
import type { HistoryEntry, HistoryResult } from "@kagero/core";

/** Build an ISO timestamp whose local wall clock renders as the given time. */
const at = (hours: number, minutes: number, seconds: number): string =>
  new Date(2026, 0, 1, hours, minutes, seconds).toISOString();

const defaultEntries: HistoryEntry[] = [
  { index: 1, role: "user", at: at(3, 14, 20), text: "fix the bug" },
  { index: 2, role: "assistant", at: at(3, 14, 22), text: "Fixed the race in getAgent" },
];

interface ResultVariant {
  readonly entries?: HistoryEntry[];
  readonly truncated?: boolean;
  /** "none" drops the fullLog pointer entirely. */
  readonly fullLog?: HistoryResult["fullLog"] | "none";
}

const makeResult = (variant: ResultVariant = {}): HistoryResult => {
  const fullLog = variant.fullLog === "none" ? undefined : variant.fullLog ?? { file: "/tmp/kagero/sess-abc.jsonl", line: 1 };
  return {
    sessionId: "sess-abc",
    totalEntries: 5,
    truncated: variant.truncated ?? false,
    entries: variant.entries ?? defaultEntries,
    ...(fullLog !== undefined ? { fullLog } : {}),
  };
};

describe("truncateForHistory", () => {
  it("keeps short text whole with cutChars 0", () => {
    expect(truncateForHistory("short", 200)).toEqual({ text: "short", cutChars: 0 });
  });

  it("cuts exactly at maxChars and counts the dropped tail", () => {
    const text = "a".repeat(250);
    expect(truncateForHistory(text, 100)).toEqual({ text: "a".repeat(100), cutChars: 150 });
  });

  it("treats an exact fit as no cut", () => {
    const text = "b".repeat(50);
    expect(truncateForHistory(text, 50)).toEqual({ text, cutChars: 0 });
  });
});

describe("renderHistory — line format", () => {
  it("renders the documented single-line entry format", () => {
    const out = renderHistory(makeResult(), { header: true });
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("#1 user 03:14:20 | fix the bug");
    expect(lines[1]).toBe("#2 asst 03:14:22 | Fixed the race in getAgent");
    expect(lines[2]).toBe("— full history: /tmp/kagero/sess-abc.jsonl (from line 1)");
  });

  it("marks cut entries with …(+N chars)", () => {
    const long = "x".repeat(250);
    const result = makeResult({ entries: [{ index: 7, role: "assistant", at: at(23, 59, 9), text: long }] });
    const line = renderHistory(result, { header: true, maxCharsPerLine: 100 }).split("\n")[0];
    expect(line).toBe(`#7 asst 23:59:09 | ${"x".repeat(100)}…(+150 chars)`);
  });

  it("renders unknown timestamps as --:--:--", () => {
    const result = makeResult({ entries: [{ index: 3, role: "tool", text: "output" }] });
    const line = renderHistory(result, { header: true }).split("\n")[0];
    expect(line).toBe("#3 tool --:--:-- | output");
  });
});

describe("renderHistory — header and full-log pointer", () => {
  it("shows exactly one header with sessionId and counts", () => {
    const out = renderHistory(makeResult());
    const lines = out.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("session sess-abc — 2/5 entries");
    expect(lines[0]).toContain("sess-abc");
    expect(lines[0]).toContain("2/5");
  });

  it("marks a truncated history result in the header", () => {
    expect(renderHistory(makeResult({ truncated: true })).split("\n")[0]).toBe(
      "session sess-abc — 2/5 entries (truncated)",
    );
  });

  it("omits the header when asked", () => {
    const out = renderHistory(makeResult(), { header: true });
    expect(out.split("\n")[0]).toMatch(/^#1 user /);
    expect(out).not.toContain("session sess-abc");
  });

  it("emits exactly one full-history pointer line", () => {
    const out = renderHistory(makeResult());
    expect(out.match(/— full history:/g)).toHaveLength(1);
    expect(out).toContain("— full history: /tmp/kagero/sess-abc.jsonl (from line 1)");
  });

  it("emits no pointer line when fullLog is absent", () => {
    const out = renderHistory(makeResult({ fullLog: "none" }));
    expect(out).not.toContain("full history");
  });

  it("omits the line hint when fullLog.line is unknown", () => {
    const out = renderHistory(makeResult({ fullLog: { file: "/tmp/log.jsonl" } }));
    expect(out).toContain("— full history: /tmp/log.jsonl");
    expect(out).not.toContain("from line");
  });
});
