/**
 * history.ts — the ONE canonical compact history renderer.
 *
 * Rules (user-facing contract):
 *  - Never dump a whole conversation. Entries render as one line each:
 *      `#12 asst 03:14:22 | Fixed the race in getAgent …(+1.2k chars)`
 *  - A cut entry shows `…(+N chars)` so nothing disappears silently.
 *  - Exactly one trailing pointer line names the full log file (and a line
 *    hint when known): `— full history: /path/to/log.jsonl (from line 1)`.
 *  - A short header carries session id and counts; no other prose.
 */

import type { HistoryEntry, HistoryResult } from "./agent.js";

export interface RenderHistoryOptions {
  /** Character budget per entry before the "+N chars" cut. Default 200. */
  readonly maxCharsPerLine?: number;
  /** Omit the header line. Default false. */
  readonly header?: boolean;
}

const DEFAULT_MAX_CHARS_PER_LINE = 200;

const roleLabel = (role: HistoryEntry["role"]): string => (role === "assistant" ? "asst" : role);

/** Render the entry timestamp as local HH:MM:SS; "--:--:--" when unknown. */
const clockOf = (at: string | undefined): string => {
  if (at === undefined) return "--:--:--";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

/** Render the compact single-format history view. */
export function renderHistory(result: HistoryResult, opts: RenderHistoryOptions = {}): string {
  const maxChars = opts.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE;
  const lines: string[] = [];

  if (opts.header !== true) {
    const truncatedMark = result.truncated ? " (truncated)" : "";
    lines.push(
      `session ${result.sessionId} — ${result.entries.length}/${result.totalEntries} entries${truncatedMark}`,
    );
  }

  for (const entry of result.entries) {
    const { text, cutChars } = truncateForHistory(entry.text, maxChars);
    const cutMark = cutChars > 0 ? `…(+${cutChars} chars)` : "";
    lines.push(`#${entry.index} ${roleLabel(entry.role)} ${clockOf(entry.at)} | ${text}${cutMark}`.trimEnd());
  }

  if (result.fullLog !== undefined) {
    const fromLine = result.fullLog.line !== undefined ? ` (from line ${result.fullLog.line})` : "";
    lines.push(`— full history: ${result.fullLog.file}${fromLine}`);
  }

  return lines.join("\n");
}

/** Cut `text` to `maxChars`, returning the kept part and how many chars were dropped. */
export function truncateForHistory(text: string, maxChars: number): { text: string; cutChars: number } {
  const budget = Math.max(0, maxChars);
  if (text.length <= budget) return { text, cutChars: 0 };
  return { text: text.slice(0, budget), cutChars: text.length - budget };
}
