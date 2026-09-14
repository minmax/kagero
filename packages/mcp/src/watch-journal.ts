/**
 * watch-journal.ts — the persistent watch state as an append-only
 * multi-frame zstd JSONL journal, ported from the DeepSeek harness session
 * persistence format (~/projects/agents/deepseek-harness,
 * packages/session/session-persistence-jsonl — internal package, mechanism
 * reimplemented here):
 *
 *  - the file is a concatenation of INDEPENDENT zstd frames, one per append
 *    batch: every frame is self-contained (checksummed) and the journal grows
 *    by appending, never rewriting;
 *  - `scanJournalFrames` walks frame headers structurally (no decompression),
 *    validates the wire format and reports a torn final frame — the crash
 *    signature of a killed process mid-append;
 *  - torn tails are repaired on the next append (truncate to the last
 *    complete frame), so a "MCP timed out, retry" cycle loses nothing;
 *  - the first JSONL line is the journal header; later lines are checkpoint
 *    records — the LAST one read is the current watch state.
 */

import { closeSync, fstatSync, ftruncateSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const ZSTD_MAGIC = 0xfd2fb528;

/** Structural scan result for a concatenated zstd stream. */
export interface JournalFrameScan {
  /** [start, end) byte ranges of complete frames, in file order. */
  frames: { start: number; end: number }[];
  /** Start byte of an incomplete final frame, when EOF interrupts one. */
  tornStart?: number;
}

/**
 * Locate complete frames without decompressing them. Invalid structure
 * rejects; EOF inside the final frame returns its start for repair.
 * Port of the harness scanZstdFrames: magic → frame header → block headers
 * → optional checksum, all bounds-checked against the available bytes.
 */
export function scanJournalFrames(buffer: Buffer): JournalFrameScan {
  const frames: { start: number; end: number }[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt watch journal: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt watch journal: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt watch journal: reserved block type at byte ${offset - 3}`);
      }
      // Reserved (0x03) is rejected above; RLE blocks store one literal byte.
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/**
 * node:zlib is required lazily: a top-level named import of the zstd
 * functions would kill the whole module graph on node < 22.16 (the same trap
 * the dsh history reader had). Required at call time, the missing export
 * degrades to an honest error mentioning the node floor.
 */
const requireZlib = createRequire(import.meta.url);

function requireZstdSync(): {
  zstdCompressSync: (input: Buffer, options?: object) => Buffer;
  zstdDecompressSync: (input: Buffer, options?: object) => Buffer;
  checksumFlag: number;
} {
  // Cast through unknown: the exports exist on node >= 22.16 only.
  const zlib = requireZlib("node:zlib") as unknown as Record<string, unknown> & {
    constants: Record<string, number>;
  };
  const compress = zlib["zstdCompressSync"];
  const decompress = zlib["zstdDecompressSync"];
  if (typeof compress !== "function" || typeof decompress !== "function") {
    throw new Error("the watch journal needs node >= 22.16 (node:zlib zstd) to read or write");
  }
  return {
    zstdCompressSync: compress as (input: Buffer, options?: object) => Buffer,
    zstdDecompressSync: decompress as (input: Buffer, options?: object) => Buffer,
    checksumFlag: zlib.constants["ZSTD_c_checksumFlag"] as number,
  };
}

/** Compress one independently decodable, checksummed zstd frame. */
export function compressJournalFrame(input: Buffer | string): Buffer {
  const { zstdCompressSync, checksumFlag } = requireZstdSync();
  return zstdCompressSync(typeof input === "string" ? Buffer.from(input, "utf8") : input, {
    params: { [checksumFlag]: 1 },
  });
}

/** Decompress one complete frame; the checksum is validated by zlib. */
export function decompressJournalFrame(input: Buffer): Buffer {
  return requireZstdSync().zstdDecompressSync(input);
}

export interface JournalReadResult {
  /** Every JSONL line of the complete frames, in file order. */
  readonly lines: unknown[];
  /** True when a torn final frame was present (repaired on next append). */
  readonly torn: boolean;
}

/** Read the journal: decompress every complete frame, parse its JSONL lines. */
export function readJournalFile(file: string): JournalReadResult {
  const { frames, tornStart } = scanJournalFile(file);
  const fd = openSync(file, "r");
  try {
    const lines: unknown[] = [];
    for (const frame of frames) {
      const buf = Buffer.alloc(frame.end - frame.start);
      readSync(fd, buf, 0, buf.length, frame.start);
      for (const line of decompressJournalFrame(buf).toString("utf8").split("\n")) {
        if (line.trim() === "") continue;
        try {
          lines.push(JSON.parse(line) as unknown);
        } catch {
          throw new Error(`corrupt watch journal: unparsable line in frame at byte ${frame.start}`);
        }
      }
    }
    return { lines, torn: tornStart !== undefined };
  } finally {
    closeSync(fd);
  }
}

function scanJournalFile(file: string): JournalFrameScan {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(fstatSync(fd).size);
    readSync(fd, buffer, 0, buffer.length, 0);
    return scanJournalFrames(buffer);
  } finally {
    closeSync(fd);
  }
}

/**
 * Append one batch of lines as a single new frame. A torn final frame from a
 * killed append is truncated away first — committed frames stay intact.
 */
export function appendJournalLines(file: string, lines: readonly unknown[]): void {
  const text = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  const frame = compressJournalFrame(text);
  let repairTo: number | undefined;
  try {
    const { tornStart } = scanJournalFile(file);
    if (tornStart !== undefined) repairTo = tornStart;
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT") {
      // No journal yet — this append creates it.
    } else if (err instanceof Error && err.message.startsWith("corrupt watch journal")) {
      // Unrecoverable content: restart the journal rather than fail the write.
      repairTo = 0;
    } else {
      throw err;
    }
  }
  mkdirSync(join(file, ".."), { recursive: true });

  const appendFrame = (): void => {
    const fd = openSync(file, "a");
    try {
      writeSync(fd, frame, 0, frame.length);
    } finally {
      closeSync(fd);
    }
  };

  if (repairTo !== undefined) {
    // Truncate the torn tail, then append the fresh frame normally.
    const fd = openSync(file, "r+");
    try {
      ftruncateSync(fd, repairTo);
    } finally {
      closeSync(fd);
    }
  }
  appendFrame();
}

/** Create the journal with its header line; existing file stays untouched. */
export function initJournalFile(file: string, header: Record<string, unknown>): void {
  let existing: Buffer;
  try {
    const fd = openSync(file, "r");
    try {
      existing = Buffer.alloc(fstatSync(fd).size);
      readSync(fd, existing, 0, existing.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    appendJournalLines(file, [header]);
    return;
  }
  if (existing.length === 0) appendJournalLines(file, [header]);
}
