/**
 * history.ts — the ONE canonical compact history renderer.
 *
 * Rules (user-facing contract):
 *  - Never dump a whole conversation. Entries render as one line each:
 *      `#12 asst 03:14:22 | Fixed the race in getAgent …(+1.2k chars)`
 *  - A cut entry shows `…(+N chars)` so nothing disappears silently.
 *  - Exactly one trailing pointer line names the full log file (and a line
 *    hint when known): `— full history: /path/to/log.jsonl (from line 1)`.
 *  - A short header carries session id, counts and the page position; no
 *    other prose.
 *  - When older entries exist, exactly one "older" footer line tells the
 *    caller how to reach them: `— older entries: page=N` (entry-counted
 *    sources) or `— older entries: cursor="<token>"` (byte-addressed ones).
 */

import type { HistoryEntry, HistoryOptions, HistoryResult } from "./agent.js";

export interface RenderHistoryOptions {
  /** Character budget per entry before the "+N chars" cut. Default 200. */
  readonly maxCharsPerLine?: number;
  /** Omit the header line. Default false. */
  readonly header?: boolean;
}

/** Entries per history page when the caller does not choose a size. */
export const DEFAULT_HISTORY_PAGE_SIZE = 20;
/** Hard cap on entries per page — a page must never flood the reply. */
export const MAX_HISTORY_PAGE_SIZE = 200;

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

/** Byte count as a compact human string: 980 B / 1.2 MB / 3.4 GB. */
export function formatHistoryBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "? B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${units[unit]}`;
}

/** Where one page of `total` entries sits inside the full entry list. */
export interface HistoryPageWindow {
  /** 0-based page index counted from the newest end. */
  readonly page: number;
  /** Entries per page (clamped to [1, MAX_HISTORY_PAGE_SIZE]). */
  readonly size: number;
  /** Entries to skip from the oldest side before the page starts. */
  readonly skip: number;
  /** Entries actually in the page (≤ size, may be 0 on an empty log). */
  readonly take: number;
  readonly totalPages: number;
}

/**
 * Resolve the page window for a history call: `page` counts from the newest
 * end (0 = most recent), `pageSize` defaults to DEFAULT_HISTORY_PAGE_SIZE and
 * is capped at MAX_HISTORY_PAGE_SIZE. `last` (legacy) pins the page size and
 * forces page 0.
 */
export function resolveHistoryPage(total: number, opts: HistoryOptions | undefined): HistoryPageWindow {
  const requested = opts?.last ?? opts?.pageSize;
  const size = Math.min(
    Math.max(1, Math.trunc(requested ?? DEFAULT_HISTORY_PAGE_SIZE)),
    MAX_HISTORY_PAGE_SIZE,
  );
  const page = Math.max(0, Math.trunc(opts?.page ?? 0));
  const totalPages = Math.max(1, Math.ceil(total / size));
  const index = Math.min(page, totalPages - 1);
  const skip = Math.max(0, total - (index + 1) * size);
  const take = Math.min(size, total - skip);
  return { page: index, size, skip, take, totalPages };
}

/** Render the compact single-format history view. */
export function renderHistory(result: HistoryResult, opts: RenderHistoryOptions = {}): string {
  const maxChars = opts.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE;
  const lines: string[] = [];

  if (opts.header !== true) {
    const truncatedMark = result.truncated ? " (truncated)" : "";
    const pageMark =
      result.page === undefined
        ? ""
        : ` · page ${result.page.index + 1}${result.page.totalPages !== undefined ? `/${result.page.totalPages}` : ""}`;
    lines.push(
      `session ${result.sessionId} — ${result.entries.length}/${result.totalEntries} entries${truncatedMark}${pageMark}`,
    );
  }

  for (const entry of result.entries) {
    const { text, cutChars } = truncateForHistory(entry.text, maxChars);
    const cutMark = cutChars > 0 ? `…(+${cutChars} chars)` : "";
    lines.push(`#${entry.index} ${roleLabel(entry.role)} ${clockOf(entry.at)} | ${text}${cutMark}`.trimEnd());
  }

  if (result.fullLog !== undefined) {
    const fromLine = result.fullLog.line !== undefined ? ` (from line ${result.fullLog.line})` : "";
    const size =
      result.fullLog.totalBytes !== undefined
        ? ` · log ${formatHistoryBytes(result.fullLog.totalBytes)}`
        : "";
    lines.push(`— full history: ${result.fullLog.file}${fromLine}${size}`);
  }

  if (result.page?.bytes !== undefined) {
    const { start, end, total } = result.page.bytes;
    lines.push(`— shown bytes ${start}–${end} of ${formatHistoryBytes(total)}`);
  }

  if (result.older?.page !== undefined) {
    lines.push(`— older entries: page=${result.older.page}`);
  } else if (result.older?.cursor !== undefined) {
    lines.push(`— older entries: cursor="${result.older.cursor}"`);
  }

  return lines.join("\n");
}

/** Cut `text` to `maxChars`, returning the kept part and how many chars were dropped. */
export function truncateForHistory(text: string, maxChars: number): { text: string; cutChars: number } {
  const budget = Math.max(0, maxChars);
  if (text.length <= budget) return { text, cutChars: 0 };
  return { text: text.slice(0, budget), cutChars: text.length - budget };
}
