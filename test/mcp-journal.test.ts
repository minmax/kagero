// Tests for the watch journal (ported from the DeepSeek harness session
// persistence format): concatenated independent zstd frames, structural
// scan with torn-tail detection, repair-on-append, and the header/checkpoint
// line contract used by the watch state.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendJournalLines,
  compressJournalFrame,
  decompressJournalFrame,
  initJournalFile,
  readJournalFile,
  scanJournalFrames,
} from "../packages/mcp/src/watch-journal.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kagero-journal-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("journal frames", () => {
  it("round-trips a frame through compress/decompress", () => {
    const frame = compressJournalFrame('{"a":1}\n{"b":2}\n');
    expect(frame.readUInt32LE(0)).toBe(0xfd2fb528);
    expect(decompressJournalFrame(frame).toString("utf8")).toBe('{"a":1}\n{"b":2}\n');
  });

  it("scanJournalFrames locates every appended frame and detects torn tails", () => {
    const file = join(dir, "j.jsonl.zstd");
    initJournalFile(file, { type: "header", v: 1 });
    appendJournalLines(file, [{ type: "watch-state", v: 1, cursorIndex: 10 }]);
    appendJournalLines(file, [{ type: "watch-state", v: 1, cursorIndex: 20 }]);

    const buffer = readFileSync(file);
    const scan = scanJournalFrames(buffer);
    expect(scan.frames).toHaveLength(3);
    expect(scan.tornStart).toBeUndefined();

    // Simulate a killed process mid-append: keep only a slice of frame 3.
    const thirdStart = scan.frames[2]?.start ?? 0;
    writeFileSync(file, buffer.subarray(0, thirdStart + 12));
    const torn = scanJournalFrames(readFileSync(file));
    expect(torn.frames).toHaveLength(2);
    expect(torn.tornStart).toBe(thirdStart);
  });

  it("readJournalFile parses lines across frames and reports torn tails", () => {
    const file = join(dir, "j.jsonl.zstd");
    appendJournalLines(file, [{ type: "header", v: 1 }, { seq: 1 }]);
    appendJournalLines(file, [{ seq: 2 }]);
    const result = readJournalFile(file);
    expect(result.torn).toBe(false);
    expect(result.lines).toEqual([{ type: "header", v: 1 }, { seq: 1 }, { seq: 2 }]);
  });

  it("repair-on-append truncates a torn tail and keeps committed frames", () => {
    const file = join(dir, "j.jsonl.zstd");
    appendJournalLines(file, [{ seq: 1 }]);
    const good = readFileSync(file);
    // Torn frame: half of a valid frame appended after the committed prefix.
    const half = compressJournalFrame('{"seq":2}\n').subarray(0, 7);
    writeFileSync(file, Buffer.concat([good, half]));
    expect(readJournalFile(file).torn).toBe(true);

    appendJournalLines(file, [{ seq: 3 }]);
    const after = readJournalFile(file);
    expect(after.torn).toBe(false);
    expect(after.lines).toEqual([{ seq: 1 }, { seq: 3 }]);
  });

  it("initJournalFile writes the header once and never twice", () => {
    const file = join(dir, "j.jsonl.zstd");
    initJournalFile(file, { type: "header", v: 1 });
    initJournalFile(file, { type: "header", v: 1 });
    appendJournalLines(file, [{ seq: 1 }]);
    expect(readJournalFile(file).lines).toEqual([{ type: "header", v: 1 }, { seq: 1 }]);
  });
});
