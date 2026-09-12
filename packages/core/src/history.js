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
/** Render the compact single-format history view. */
export function renderHistory(result, opts = {}) {
    void result;
    void opts;
    throw new Error("not implemented");
}
/** Cut `text` to `maxChars`, returning the kept part and how many chars were dropped. */
export function truncateForHistory(text, maxChars) {
    void text;
    void maxChars;
    throw new Error("not implemented");
}
//# sourceMappingURL=history.js.map