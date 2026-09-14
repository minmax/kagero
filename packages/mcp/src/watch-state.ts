/**
 * watch-state.ts — the persistent per-session watch state, shared by the
 * watch tool (reader-index cursor) and the stream compressor (stream-index
 * cursor + carry-forward digest). Backed by the multi-frame zstd journal
 * (watch-journal.ts); see its header for the on-disk format and the
 * torn-tail repair guarantees.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DigestOutput } from "@kagero/core";
import { appendJournalLines, initJournalFile, readJournalFile } from "./watch-journal.js";

/** Persistent state for one watched session. */
export interface WatchState {
  v: 1;
  backend: string;
  sessionId: string;
  /** Reader-space position (HistoryEntry.index) the digest covers up to. */
  cursorIndex: number;
  /**
   * Stream-space position (count of stream events compressed into `digest`
   * by the background compressor). Independent from `cursorIndex`: the two
   * count different things (reader rows vs live events).
   */
  streamCursorIndex?: number;
  compressorSessionId?: string;
  digest?: DigestOutput;
  updatedAt?: string;
}

function watchStateDir(): string {
  const env = process.env["KAGERO_WATCH_STATE_DIR"];
  return env !== undefined && env.trim() !== "" ? env.trim() : join(homedir(), ".kagero", "watch");
}

function stateFile(originalBackend: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return join(watchStateDir(), originalBackend, `${safe}.jsonl.zstd`);
}

export function emptyWatchState(originalBackend: string, sessionId: string): WatchState {
  return { v: 1, backend: originalBackend, sessionId, cursorIndex: 0 };
}

/** The last valid `watch-state` checkpoint in the journal, when any. */
export function loadWatchState(originalBackend: string, sessionId: string): WatchState | undefined {
  try {
    const file = stateFile(originalBackend, sessionId);
    mkdirSync(join(file, ".."), { recursive: true });
    const { lines } = readJournalFile(file);
    let state: WatchState | undefined;
    for (const line of lines) {
      if (typeof line !== "object" || line === null) continue;
      const rec = line as Record<string, unknown>;
      if (rec["type"] === "watch-state" && rec["v"] === 1 && typeof rec["cursorIndex"] === "number") {
        state = {
          v: 1,
          backend: originalBackend,
          sessionId,
          cursorIndex: rec["cursorIndex"],
          ...(typeof rec["streamCursorIndex"] === "number"
            ? { streamCursorIndex: rec["streamCursorIndex"] }
            : {}),
          ...(typeof rec["compressorSessionId"] === "string"
            ? { compressorSessionId: rec["compressorSessionId"] }
            : {}),
          ...(rec["digest"] !== undefined ? { digest: rec["digest"] as DigestOutput } : {}),
          ...(typeof rec["at"] === "string" ? { updatedAt: rec["at"] } : {}),
        };
      }
    }
    return state;
  } catch {
    // Missing journal = no state yet; unreadable = redo work from scratch.
    return undefined;
  }
}

/** Append one checkpoint; the journal format makes this crash-safe. */
export function saveWatchState(state: WatchState): void {
  try {
    const file = stateFile(state.backend, state.sessionId);
    mkdirSync(join(file, ".."), { recursive: true });
    initJournalFile(file, { type: "header", v: 1, backend: state.backend, sessionId: state.sessionId });
    appendJournalLines(file, [
      {
        type: "watch-state",
        v: 1,
        cursorIndex: state.cursorIndex,
        ...(state.streamCursorIndex !== undefined ? { streamCursorIndex: state.streamCursorIndex } : {}),
        ...(state.compressorSessionId !== undefined
          ? { compressorSessionId: state.compressorSessionId }
          : {}),
        ...(state.digest !== undefined ? { digest: state.digest } : {}),
        at: new Date().toISOString(),
      },
    ]);
  } catch (err) {
    // State persistence is an optimization: losing it only means redoing work.
    process.stderr.write(`kagero: could not persist watch state: ${(err as Error).message}\n`);
  }
}
