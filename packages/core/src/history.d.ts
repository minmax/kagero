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
import type { HistoryResult } from "./agent.js";
export interface RenderHistoryOptions {
    /** Character budget per entry before the "+N chars" cut. Default 200. */
    readonly maxCharsPerLine?: number;
    /** Omit the header line. Default false. */
    readonly header?: boolean;
}
/** Render the compact single-format history view. */
export declare function renderHistory(result: HistoryResult, opts?: RenderHistoryOptions): string;
/** Cut `text` to `maxChars`, returning the kept part and how many chars were dropped. */
export declare function truncateForHistory(text: string, maxChars: number): {
    text: string;
    cutChars: number;
};
//# sourceMappingURL=history.d.ts.map