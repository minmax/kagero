/**
 * digest.ts — the session compressor contract (ported from agenttrace).
 *
 * A cheap "compressor" agent reads one window of a session's history —
 * rendered as TURN blocks in the agenttrace pass-1 input format — and returns
 * a JSON digest: per-move blocks (action + distilled reasoning) plus a rolling
 * digest. The mechanism is ported, not the campaign machinery: this module
 * owns the window builder (HistoryEntry stream → turns → worker text), the
 * q-id anchoring, the output contract validator, and the reply renderer.
 *
 * Origin: github.com/minmax/agenttrace (src/pipeline/{turns,render-turn,
 * anchors,contracts}.ts), license MIT. Format decisions recorded there:
 *  - a turn is one assistant move ([thinking] [narration] [tools+results]);
 *    user messages are their own turns; turns are atomic;
 *  - thinking goes to the worker INTACT; tool results lose their middle
 *    (head+tail) with an explicit truncation mark pointing at the source line;
 *  - every thinking/narration entry gets a stable quote-id (q + 6 hex FNV-1a);
 *    thoughts must cite those ids — no verbatim text ships to or from the model;
 *  - @L<line> anchors address the original log, so a compressed block always
 *    stays linked to the raw data it summarizes.
 */

import { createHash } from "node:crypto";
import type { HistoryEntry } from "./agent.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DigestThoughtKind = "H" | "ALT" | "?" | "PIVOT" | "INSIGHT" | "ERR-R";
export type DigestThoughtSource = "thinking" | "narration";

export interface DigestThought {
  readonly kind: DigestThoughtKind;
  readonly source: DigestThoughtSource;
  readonly text: string;
  /** Quote-id of the source entry; required for source thinking|narration. */
  readonly q?: string;
}

export interface DigestBlock {
  /** Global HistoryEntry index of the move's first entry. */
  readonly turnIndex: number;
  /** Source-log line range, when the entries carry lines. */
  readonly anchor: { readonly fromLine?: number; readonly toLine?: number };
  /** ≤240 chars: what was done on the move (third person, English). */
  readonly action: string;
  readonly thoughts: readonly DigestThought[];
}

export interface Digest {
  /** ≤200 chars: what the session is trying to achieve. */
  readonly goal: string;
  /** ≤300 chars: what the agent currently believes is true. */
  readonly currentBelief: string;
  readonly openHypotheses: readonly string[];
  /**
   * deepseek-style checkpoint skeleton (agenttrace cb848cc): each section
   * ≤600 chars, empty string = "(none)". The relay CONSOLIDATES it across
   * windows (keep the true, drop the stale, add the new — not verbatim).
   */
  readonly checkpoint?: DigestCheckpoint;
}

export interface DigestCheckpoint {
  readonly intent: string;
  readonly concepts: string;
  readonly files: string;
  readonly errors: string;
  readonly pending: string;
  readonly current: string;
  readonly next: string;
  readonly critical: string;
}

const CHECKPOINT_FIELDS = [
  "intent",
  "concepts",
  "files",
  "errors",
  "pending",
  "current",
  "next",
  "critical",
] as const;
/** Per-section cap of the digest checkpoint. */
export const CHECKPOINT_SECTION_MAX = 600;

/** One distilled "beneath the surface" line: a rejected approach or unfinished work. */
export interface ReportItem {
  /** ≤200 chars: the essence, third person. */
  readonly text: string;
  /** Quote-id of the thinking/narration the item came from. */
  readonly q: string;
}

/**
 * The orchestrator-facing verdict over a window: what the agent will NOT say
 * in its final text — how it is actually doing, which approaches it tried and
 * dropped (with reasons), what it silently left unfinished.
 */
export interface SessionReport {
  /** working | blocked | done | failed. */
  readonly status: "working" | "blocked" | "done" | "failed";
  /** ≤240 chars: what has actually been accomplished so far. */
  readonly progress: string;
  /** ≤200 chars: what the agent is doing next / waiting on; "—" when terminal. */
  readonly next: string;
  /** Approaches considered and dropped, with the reason (≤3). */
  readonly rejected: readonly ReportItem[];
  /** Promised-but-undone work and unresolved threads (≤3). */
  readonly leftOpen: readonly ReportItem[];
}

/** The compressor's reply for one window. */
export interface DigestOutput {
  readonly blocks: readonly DigestBlock[];
  readonly digest: Digest;
  readonly report?: SessionReport;
}

// ---------------------------------------------------------------------------
// Cheap, deterministic helpers (ports)
// ---------------------------------------------------------------------------

/** ~chars/4 — the same estimator agenttrace uses; traces are compared, not billed. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Short stable id of an entry text: `q` + 6 hex chars of FNV-1a. */
export function quoteId(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h = Math.imul(h ^ normalized.charCodeAt(i), 0x01000193) >>> 0;
  }
  return `q${h.toString(16).padStart(8, "0").slice(0, 6)}`;
}

// ---------------------------------------------------------------------------
// Center truncation with recovery arithmetic (ported from agenttrace
// core/text.ts truncateCentered — commit 4324e32):
//  - outcome-aware asymmetry: errors in the tail region shift the kept
//    budget 70/30 → 30/70 (errors live at the end of output);
//  - the marker counts inside the budget; cuts snap to line boundaries;
//    oversized kept lines are capped in place;
//  - the marker carries full recovery arithmetic: original→kept chars, the
//    anchor into the original log, and a content hash for verification;
//  - idempotent: already-truncated text passes through untouched;
//  - no-shrink guard: if the wrapped text is not smaller than the original,
//    the original is returned (truncation must shrink).
// ---------------------------------------------------------------------------

const TRUNCATED_MARKER_PREFIX = "…⟨truncated:";
const ERROR_TAIL_RE = /\b(error|exception|failed|fatal|traceback|panic|exit code|errno|denied)\b/i;
const MAX_LINE_CHARS = 2_000;

export interface TruncateCenteredOptions {
  /** Chars kept from the head/tail (before the marker is accounted). */
  readonly head: number;
  readonly tail?: number;
  /** Source-log line anchor, embedded into the marker (lossless recovery). */
  readonly line?: number;
  /** Fallback anchor when the source has no line numbers (entry index). */
  readonly entryIndex?: number;
}

export interface TruncateCenteredResult {
  readonly text: string;
  readonly truncated: boolean;
}

function capLongLines(slice: string): string {
  if (!slice.includes("\n")) return slice;
  return slice
    .split("\n")
    .map((l) =>
      l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…[+${l.length - MAX_LINE_CHARS} chars]` : l,
    )
    .join("\n");
}

/** First 8 hex chars of sha256 over the full text (verification anchor). */
export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 8);
}

/**
 * Center-truncate `text` to the head+tail budget with a recovery-carrying
 * marker. See the block comment above for the full policy.
 */
export function truncateCentered(text: string, opts: TruncateCenteredOptions): TruncateCenteredResult {
  const originalChars = text.length;
  if (text.startsWith(TRUNCATED_MARKER_PREFIX)) {
    return { text, truncated: true };
  }
  const tailBudget = opts.tail ?? 0;
  const total = opts.head + tailBudget;
  if (originalChars <= total) {
    return { text, truncated: false };
  }
  const anchorRef =
    opts.line !== undefined ? ` @L${opts.line}` : opts.entryIndex !== undefined ? ` #${opts.entryIndex}` : "";
  const shaRef = `, sha:#${contentHash(text)}`;
  const sepAt = (kept: number): string =>
    `${TRUNCATED_MARKER_PREFIX} ${originalChars}→${kept} chars${anchorRef}${shaRef}⟩`;

  // outcome-aware split of the KEPT budget between head and tail
  const tailScan = text.slice(Math.max(0, originalChars - 2048));
  const headShare = ERROR_TAIL_RE.test(tailScan) ? 0.3 : 0.7;

  let sep = sepAt(total);
  let kept = total - sep.length;
  if (kept < 8) {
    // The marker alone eats the budget — emit just a head sliver + marker.
    const headSliver = Math.max(8, total - sep.length);
    return {
      text: `${text.slice(0, headSliver)}${sep}`,
      truncated: true,
    };
  }
  let head = Math.floor(kept * headShare);
  const tail = kept - head;
  let headPart = capLongLines(text.slice(0, head));
  let tailPart = tailBudget > 0 ? capLongLines(text.slice(originalChars - tail)) : "";
  // line-boundary snap: move the cut to the nearest newline when close
  const headNl = headPart.lastIndexOf("\n");
  if (headNl > head * 0.5) {
    head = headNl + 1;
    headPart = text.slice(0, head);
  }
  if (tailBudget > 0) {
    const tailNl = tailPart.indexOf("\n");
    if (tailNl !== -1 && tailNl < tail * 0.5) {
      tailPart = tailPart.slice(tailNl + 1);
    }
  }
  kept = headPart.length + tailPart.length;
  sep = sepAt(kept);
  const out = `${headPart}${sep}${tailPart}`;
  if (out.length >= originalChars) {
    // no-shrink guard: truncation must shrink
    return { text, truncated: false };
  }
  return { text: out, truncated: true };
}

// ---------------------------------------------------------------------------
// File index — declare each path once, reference by [F<n>] (agenttrace
// render-md buildFileIndex/substituteFileRefs, pi file-ops pattern).
// ---------------------------------------------------------------------------

/** Tool names whose successful call MODIFIES a file (index: lowest ids). */
const WRITE_TOOL_HINTS = ["write", "edit", "apply_patch", "str_replace", "multiedit", "notebook", "create"];
const FACT_FILE_KEYS = ["path", "file_path", "notebook_path", "absolute_path"];
const FILE_INDEX_CAP = 20;

export interface FileIndexEntry {
  readonly id: number;
  readonly path: string;
  readonly modified: boolean;
}

/**
 * Deterministic declaration table for file paths seen in tool-call args:
 * modified paths get the lowest ids (sorted), read-only follow. Calls whose
 * args are not JSON or carry no path keys are ignored, not guessed.
 */
export function buildFileIndex(entries: readonly HistoryEntry[]): FileIndexEntry[] {
  const paths = new Map<string, boolean>();
  for (const entry of entries) {
    if (entry.role !== "tool") continue;
    const file = firstFilePath(entry.text);
    if (file === undefined || file === "") continue;
    const modified = WRITE_TOOL_HINTS.some((hint) => (entry.toolName ?? "").toLowerCase().includes(hint));
    paths.set(file, (paths.get(file) ?? false) || modified);
  }
  const modified = [...paths.entries()]
    .filter(([, m]) => m)
    .map(([p]) => p)
    .sort();
  const read = [...paths.entries()]
    .filter(([, m]) => !m)
    .map(([p]) => p)
    .sort();
  const out: FileIndexEntry[] = [];
  let id = 1;
  for (const path of modified) out.push({ id: id++, path, modified: true });
  for (const path of read.slice(0, Math.max(0, FILE_INDEX_CAP - out.length)))
    out.push({ id: id++, path, modified: false });
  return out;
}

function firstFilePath(argsText: string): string | undefined {
  if (!argsText.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(argsText) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const rec = parsed as Record<string, unknown>;
    for (const key of FACT_FILE_KEYS) {
      const value = rec[key];
      if (typeof value === "string" && value !== "") return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Replace full indexed paths with `[F<n>]` refs (longest first, no prefix collisions). */
export function substituteFileRefs(text: string, fileIndex: readonly FileIndexEntry[]): string {
  if (fileIndex.length === 0) return text;
  let out = text;
  for (const entry of [...fileIndex].sort((a, b) => b.path.length - a.path.length)) {
    out = out.split(entry.path).join(`[F${entry.id}]`);
  }
  return out;
}

/** The declaration block: each indexed path exactly once, modified marked. */
export function formatFileIndex(fileIndex: readonly FileIndexEntry[]): string {
  if (fileIndex.length === 0) return "";
  const lines = fileIndex.map((f) => `[F${f.id}] ${f.path}${f.modified ? " (modified)" : ""}`);
  return `working set:\n${lines.join("\n")}`;
}

/** Self-describing recovery footer (kimi recovery-footer pattern). */
export const RECOVERY_FOOTER = [
  "recovery: `…⟨truncated: A→B chars @LN, sha:#h⟩` — middle cut, head+tail kept; full text: `sed -n 'Np' <log file>`;",
  "verify: sha256(full text) starts with `h`. `@LN` = line N of the session log under `— full history:`.",
].join("\n");

function capBlock(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}…`;
}

/** Extract the first JSON object from a model reply (fences, prose tolerated). */
export function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced !== null && fenced[1] !== undefined) {
    try {
      const parsed = JSON.parse(fenced[1].trim()) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
      return undefined; // fenced block is authoritative — non-object means failure
    } catch {
      // fenced block is not valid JSON — fall through to brace extraction
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Window builder: HistoryEntry stream → turns → worker text
// ---------------------------------------------------------------------------

export interface DigestTurn {
  /** Sequential within the window (b1, b2, …). */
  readonly index: number;
  /** Global HistoryEntry.index of the first/last entry in the move. */
  readonly entryFrom: number;
  readonly entryTo: number;
  /** Source-log line range when every entry knows its line. */
  readonly fromLine?: number;
  readonly toLine?: number;
  readonly kind: "user" | "assistant";
  readonly toolNames: readonly string[];
  readonly hasThinking: boolean;
  /** Worker-visible rendering of the whole move. */
  readonly text: string;
}

export interface DigestWindow {
  readonly turns: readonly DigestTurn[];
  /** The full worker input: all turns joined by blank lines. */
  readonly text: string;
  readonly entryFrom: number;
  readonly entryTo: number;
  readonly fromLine?: number;
  readonly toLine?: number;
  readonly tokens: number;
  /** Quote-ids the worker may cite in thoughts. */
  readonly quoteIds: ReadonlySet<string>;
  /** Turn indexes that carry thinking → their blocks MUST have thoughts. */
  readonly thinkingTurnIndexes: ReadonlySet<number>;
}

export interface DigestWindowOptions {
  /** Tool-result head/tail budget in the worker input. Default 2000/500. */
  readonly resultHead?: number;
  readonly resultTail?: number;
  /** Soft per-turn token budget; oversized turns still stay atomic. Default 8000. */
  readonly turnBudgetTokens?: number;
}

const DEFAULT_RESULT_HEAD = 2000;
const DEFAULT_RESULT_TAIL = 500;
const DEFAULT_TURN_BUDGET_TOKENS = 8_000;

/**
 * Segment a delta of HistoryEntries into assistant moves and render the
 * worker input. Entries must already be the delta only (caller slices by
 * entry index); indexes stay global so blocks anchor back to the history.
 */
export function buildDigestWindow(
  entries: readonly HistoryEntry[],
  options: DigestWindowOptions = {},
): DigestWindow {
  const resultHead = options.resultHead ?? DEFAULT_RESULT_HEAD;
  const resultTail = options.resultTail ?? DEFAULT_RESULT_TAIL;
  const turnBudget = options.turnBudgetTokens ?? DEFAULT_TURN_BUDGET_TOKENS;

  interface Acc {
    entries: HistoryEntry[];
    lines: number[];
    tokens: number;
  }
  let current: Acc | undefined;
  const turns: DigestTurn[] = [];
  const quoteIds = new Set<string>();
  const thinkingTurnIndexes = new Set<number>();

  const flush = (): void => {
    if (current === undefined || current.entries.length === 0) return;
    const items = current.entries;
    const index = turns.length + 1;
    const lines = current.lines;
    const allLined = items.every((e) => e.line !== undefined);
    const hasThinking = items.some((e) => e.thinking !== undefined && e.thinking.trim() !== "");
    if (hasThinking) thinkingTurnIndexes.add(index);

    const parts: string[] = [];
    const header =
      allLined && lines.length > 0
        ? `TURN b${index} [lines ${Math.min(...lines)}–${Math.max(...lines)}]`
        : `TURN b${index} [entries #${items[0]?.index}–#${items[items.length - 1]?.index}]`;
    parts.push(header);
    const toolNames = [
      ...new Set(items.filter((e) => e.role === "tool").map((e) => e.toolName ?? "unknown")),
    ];
    if (toolNames.length > 0) parts.push(`tools: ${toolNames.join(", ")}`);

    for (const e of items) {
      switch (e.role) {
        case "user":
          // intent is primary data: keep the multiline shape, cap gently
          parts.push("[USER]");
          parts.push(capBlock(e.text, 1200));
          break;
        case "assistant": {
          if (e.thinking !== undefined && e.thinking.trim() !== "") {
            const q = quoteId(e.thinking);
            quoteIds.add(q);
            parts.push(`[THINKING] [${q}]`);
            parts.push(e.thinking); // intact — never cut
          }
          if (e.text !== "") {
            const q = quoteId(e.text);
            quoteIds.add(q);
            parts.push(`[ASSISTANT] [${q}] ${e.text}`);
          }
          break;
        }
        case "tool": {
          const args = e.text.length > 220 ? `${e.text.slice(0, 220)}…` : e.text;
          parts.push(`[CALL] ${e.toolName ?? "unknown"} ${args}`);
          if (e.toolResult !== undefined && e.toolResult !== "") {
            const status = e.toolOk === false ? "ERR" : "ok";
            const cut = truncateCentered(e.toolResult, {
              head: resultHead,
              tail: resultTail,
              ...(e.line !== undefined ? { line: e.line } : { entryIndex: e.index }),
            });
            parts.push(`[RESULT ${status}] ${collapse(cut.text)}`);
          }
          break;
        }
        case "system":
          parts.push(`[NOTE] ${capBlock(e.text, 160)}`);
          break;
      }
    }
    if (hasThinking) {
      const qs = items
        .filter((e) => e.thinking !== undefined && e.thinking.trim() !== "")
        .map((e) => quoteId(e.thinking as string));
      parts.push(
        `MANDATORY: this move contains thinking (${[...new Set(qs)].join(", ")}) — its block MUST have ` +
          `1-3 thoughts, source="thinking", q = the id of the MOST essential thought (pivot/discovery/hypothesis).`,
      );
    }

    turns.push({
      index,
      entryFrom: items[0]?.index ?? 0,
      entryTo: items[items.length - 1]?.index ?? 0,
      ...(allLined && lines.length > 0 ? { fromLine: Math.min(...lines), toLine: Math.max(...lines) } : {}),
      kind: items.some((e) => e.role === "user") ? "user" : "assistant",
      toolNames,
      hasThinking,
      text: parts.join("\n"),
    });
    current = undefined;
  };

  for (const entry of entries) {
    if (entry.role === "user") {
      flush();
      current = { entries: [entry], lines: entry.line === undefined ? [] : [entry.line], tokens: 0 };
      flush();
      continue;
    }
    if (entry.role === "assistant") flush();
    if (current === undefined) current = { entries: [], lines: [], tokens: 0 };
    current.entries.push(entry);
    if (entry.line !== undefined) current.lines.push(entry.line);
    current.tokens += entryTokensOf(entry);
    if (current.tokens >= turnBudget) flush();
  }
  flush();

  const lined = turns.filter((t) => t.fromLine !== undefined && t.toLine !== undefined);
  const text = turns.map((t) => t.text).join("\n\n");
  return {
    turns,
    text,
    entryFrom: turns[0]?.entryFrom ?? 0,
    entryTo: turns[turns.length - 1]?.entryTo ?? 0,
    ...(lined.length > 0
      ? {
          fromLine: Math.min(...lined.map((t) => t.fromLine as number)),
          toLine: Math.max(...lined.map((t) => t.toLine as number)),
        }
      : {}),
    tokens: turns.reduce((acc, t) => acc + estimateTokens(t.text), 0),
    quoteIds,
    thinkingTurnIndexes,
  };
}

function entryTokensOf(entry: HistoryEntry): number {
  let volume = entry.text.length;
  if (entry.thinking !== undefined) volume += entry.thinking.length;
  if (entry.toolResult !== undefined) volume += entry.toolResult.length;
  // ~chars/4 like every entry; an empty entry still counts as one token.
  return Math.ceil(Math.max(volume, 1) / 4);
}

/** Raw token budget per window when a delta is split into several. Default 40k. */
export const DEFAULT_WINDOW_BUDGET_TOKENS = 40_000;

/**
 * Split a delta into window-sized slices BEFORE window building: a single
 * window over a long session overflows the compressor and wrecks its length
 * caps. Cuts fall at move starts (user/assistant entries) when possible, so a
 * move is never split across two windows.
 */
export function splitDeltaForWindows(
  entries: readonly HistoryEntry[],
  budgetTokens: number = DEFAULT_WINDOW_BUDGET_TOKENS,
): HistoryEntry[][] {
  const chunks: HistoryEntry[][] = [];
  let buffer: HistoryEntry[] = [];
  let tokens = 0;
  // Buffer index of the current move's first entry; a cut rewinds to it.
  let moveStart = 0;
  for (const entry of entries) {
    if (
      (entry.role === "user" || entry.role === "assistant") &&
      tokens >= budgetTokens &&
      buffer.length > moveStart
    ) {
      chunks.push(buffer.slice(0, moveStart));
      buffer = buffer.slice(moveStart);
      tokens = buffer.reduce((acc, e) => acc + entryTokensOf(e), 0);
      moveStart = 0;
    }
    if (entry.role === "user" || entry.role === "assistant") moveStart = buffer.length;
    buffer.push(entry);
    tokens += entryTokensOf(entry);
  }
  if (buffer.length > 0) chunks.push(buffer);
  return chunks;
}

/** Build windows for a whole delta: split by budget, one DigestWindow each. */
export function buildDigestWindows(
  entries: readonly HistoryEntry[],
  options: DigestWindowOptions & { readonly windowBudgetTokens?: number } = {},
): DigestWindow[] {
  const chunks = splitDeltaForWindows(entries, options.windowBudgetTokens ?? DEFAULT_WINDOW_BUDGET_TOKENS);
  return chunks.map((chunk) => buildDigestWindow(chunk, options));
}

function collapse(text: string): string {
  return text.replace(/\s+\n/g, "\n").trim();
}

// ---------------------------------------------------------------------------
// Output contract validator (hand-rolled, repair-loop friendly — port)
// ---------------------------------------------------------------------------

const THOUGHT_KINDS = new Set<string>(["H", "ALT", "?", "PIVOT", "INSIGHT", "ERR-R"]);
const THOUGHT_SOURCES = new Set<string>(["thinking", "narration"]);

export interface DigestValidationContext {
  readonly window: DigestWindow;
}

type Errors = string[];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Validate the compressor reply against the window. Never throws — returns
 * precise, model-fixable error strings (empty = accepted).
 */
export function validateDigestOutput(value: unknown, ctx: DigestValidationContext): Errors {
  const errors: Errors = [];
  const { window } = ctx;
  if (!isObj(value)) return ["response is not a JSON object"];
  if (!Array.isArray(value["blocks"])) return ["missing array 'blocks'"];
  if (!isObj(value["digest"])) return ["missing object 'digest'"];

  const blocks = value["blocks"] as unknown[];
  if (blocks.length === 0)
    errors.push("blocks must not be empty — one block per move (merge insignificant moves)");
  const turnIndexes = new Set(window.turns.map((t) => t.index));
  const covered = new Set<number>();

  for (const [i, raw] of blocks.entries()) {
    const label = `blocks[${i}]`;
    if (!isObj(raw)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const turnIndex = raw["turnIndex"];
    if (!isInt(turnIndex) || !turnIndexes.has(turnIndex)) {
      errors.push(
        `${label}.turnIndex must be one of the window's turn indexes (${[...turnIndexes].join(",")})`,
      );
      continue;
    }
    if (covered.has(turnIndex)) errors.push(`${label}.turnIndex ${turnIndex} is covered twice`);
    covered.add(turnIndex);

    const anchor = raw["anchor"];
    if (!isObj(anchor)) errors.push(`${label}.anchor must be an object`);
    else {
      const fromLine = anchor["fromLine"];
      const toLine = anchor["toLine"];
      if (!isInt(fromLine) || !isInt(toLine)) errors.push(`${label}.anchor.fromLine/toLine must be integers`);
      else {
        if (toLine < fromLine) errors.push(`${label}.anchor.toLine must be ≥ fromLine`);
        const turn = window.turns.find((t) => t.index === turnIndex);
        if (turn?.fromLine !== undefined && turn?.toLine !== undefined) {
          if (fromLine < turn.fromLine || fromLine > turn.toLine) {
            errors.push(
              `${label}.anchor.fromLine ${fromLine} outside the move's lines ${turn.fromLine}–${turn.toLine}`,
            );
          }
          if (toLine > turn.toLine + 2) {
            errors.push(`${label}.anchor.toLine ${toLine} beyond the move's lines (max ${turn.toLine})`);
          }
        }
      }
    }

    const action = raw["action"];
    if (!isStr(action)) errors.push(`${label}.action must be a string`);
    else if (action.length > 240) errors.push(`${label}.action exceeds 240 chars — compress it`);

    const thoughts = raw["thoughts"];
    if (!Array.isArray(thoughts)) {
      errors.push(`${label}.thoughts must be an array (empty when the move has no thinking)`);
    } else {
      if (thoughts.length > 3) errors.push(`${label}.thoughts: at most 3 events`);
      const turn = window.turns.find((t) => t.index === turnIndex);
      if (turn !== undefined && turn.hasThinking && thoughts.length === 0) {
        errors.push(
          `${label}: move ${turnIndex} contains [THINKING] — thoughts must not be empty (the main reasoning carrier)`,
        );
      }
      for (const [j, t] of thoughts.entries()) {
        const tl = `${label}.thoughts[${j}]`;
        if (!isObj(t)) {
          errors.push(`${tl} must be an object`);
          continue;
        }
        if (!isStr(t["kind"]) || !THOUGHT_KINDS.has(t["kind"])) {
          errors.push(`${tl}.kind must be one of ${[...THOUGHT_KINDS].join("|")}`);
        }
        if (!isStr(t["source"]) || !THOUGHT_SOURCES.has(t["source"])) {
          errors.push(`${tl}.source must be one of ${[...THOUGHT_SOURCES].join("|")}`);
        }
        if (!isStr(t["text"])) errors.push(`${tl}.text must be a string`);
        else if (t["text"].length > 320) errors.push(`${tl}.text exceeds 320 chars — compress it`);
        if (isStr(t["source"]) && (t["source"] === "thinking" || t["source"] === "narration")) {
          if (!isStr(t["q"])) errors.push(`${tl}.q is required when source is thinking|narration`);
          else if (!window.quoteIds.has(t["q"])) {
            errors.push(`${tl}.q "${t["q"]}" does not match any [q-id] shown in this window`);
          }
        }
      }
    }
  }

  for (const turn of window.turns) {
    if (!covered.has(turn.index)) {
      errors.push(
        `move b${turn.index} is not covered by any block — cover every move (merge the insignificant ones)`,
      );
    }
  }

  const digest = value["digest"] as Record<string, unknown>;
  const goal = digest["goal"];
  if (!isStr(goal)) errors.push("digest.goal must be a string");
  else if (goal.length > 200) errors.push("digest.goal exceeds 200 chars");
  const belief = digest["currentBelief"];
  if (!isStr(belief)) errors.push("digest.currentBelief must be a string");
  else if (belief.length > 300) errors.push("digest.currentBelief exceeds 300 chars");
  const hyp = digest["openHypotheses"];
  if (!Array.isArray(hyp)) errors.push("digest.openHypotheses must be an array");
  else {
    for (const [i, h] of hyp.entries()) {
      if (!isObj(h) || !isStr(h["text"])) errors.push(`digest.openHypotheses[${i}].text must be a string`);
    }
  }

  const checkpoint = digest["checkpoint"];
  if (checkpoint !== undefined) {
    if (!isObj(checkpoint)) errors.push("digest.checkpoint must be an object");
    else {
      for (const field of CHECKPOINT_FIELDS) {
        const val = checkpoint[field];
        if (val === undefined) continue; // absent = "(none)" on read
        if (!isStr(val)) errors.push(`digest.checkpoint.${field} must be a string`);
        else if (val.length > CHECKPOINT_SECTION_MAX) {
          errors.push(`digest.checkpoint.${field} exceeds ${CHECKPOINT_SECTION_MAX} chars`);
        }
      }
    }
  }

  const report = value["report"];
  if (!isObj(report)) {
    errors.push(
      "missing object 'report' ({status, progress, next, rejected[], leftOpen[]}) — the orchestrator-facing verdict",
    );
  } else {
    const status = report["status"];
    if (!isStr(status) || !["working", "blocked", "done", "failed"].includes(status)) {
      errors.push("report.status must be one of working|blocked|done|failed");
    }
    const progress = report["progress"];
    if (!isStr(progress)) errors.push("report.progress must be a string");
    else if (progress.length > 240) errors.push("report.progress exceeds 240 chars");
    const next = report["next"];
    if (!isStr(next)) errors.push("report.next must be a string");
    else if (next.length > 200) errors.push("report.next exceeds 200 chars");
    for (const key of ["rejected", "leftOpen"] as const) {
      const items = report[key];
      if (items === undefined) {
        errors.push(`report.${key} must be an array (empty when nothing to report)`);
        continue;
      }
      if (!Array.isArray(items)) errors.push(`report.${key} must be an array`);
      else {
        if (items.length > 3) errors.push(`report.${key}: at most 3 items`);
        for (const [i, item] of items.entries()) {
          if (!isObj(item) || !isStr(item["text"])) errors.push(`report.${key}[${i}].text must be a string`);
          else if (item["text"].length > 200) errors.push(`report.${key}[${i}].text exceeds 200 chars`);
          if (!isObj(item) || !isStr(item["q"]))
            errors.push(`report.${key}[${i}].q must cite a [q-id] from the window`);
          else if (!window.quoteIds.has(item["q"])) {
            errors.push(
              `report.${key}[${i}].q "${item["q"]}" does not match any [q-id] shown in this window`,
            );
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Trim-first repair: models keep overflowing the text caps; a 40-char
 * overshoot must not void an otherwise valid (and expensive) compression.
 * Clamps every length-capped text field to its cap with an ellipsis mark and
 * re-validates. Returns how many fields were clamped, or undefined when
 * structural errors remain (uncovered turns, bad q-ids, missing report) —
 * those cannot be repaired mechanically.
 */
export function repairDigestOutput(value: unknown, window: DigestWindow): { clamped: number } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const root = value as Record<string, unknown>;
  let clamped = 0;
  const cap = (field: unknown, max: number): unknown => {
    if (typeof field !== "string") return field;
    if (field.length <= max) return field;
    clamped += 1;
    return `${field.slice(0, max)}…`;
  };
  const normalizeKind = (field: unknown): unknown => {
    if (typeof field !== "string") return field;
    const upper = field.trim().toUpperCase();
    if (upper === field) return field;
    return upper === "?" ? "?" : upper;
  };
  const normalizeSource = (field: unknown): unknown => {
    if (typeof field !== "string") return field;
    return field.trim().toLowerCase() === field ? field : field.trim().toLowerCase();
  };

  const blocks = root["blocks"];
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      b["action"] = cap(b["action"], 240);
      if (Array.isArray(b["thoughts"])) {
        for (const thought of b["thoughts"]) {
          if (typeof thought !== "object" || thought === null) continue;
          const t = thought as Record<string, unknown>;
          t["text"] = cap(t["text"], 320);
          const kind = normalizeKind(t["kind"]);
          if (kind !== t["kind"]) {
            t["kind"] = kind;
            clamped += 1;
          }
          const source = normalizeSource(t["source"]);
          if (source !== t["source"]) {
            t["source"] = source;
            clamped += 1;
          }
        }
      }
      // Clamp anchors into the move's line range; models overshoot toLine by
      // a few lines (the next move's header) — trimming keeps the anchor true.
      const turnIndex = b["turnIndex"];
      const anchor = b["anchor"];
      if (typeof turnIndex === "number" && typeof anchor === "object" && anchor !== null) {
        const turn = window.turns.find((t) => t.index === turnIndex);
        if (turn?.fromLine !== undefined && turn?.toLine !== undefined) {
          const a = anchor as Record<string, unknown>;
          for (const key of ["fromLine", "toLine"]) {
            const value = a[key];
            if (typeof value !== "number") continue;
            const bounded = Math.min(Math.max(value, turn.fromLine), turn.toLine);
            if (bounded !== value) {
              a[key] = bounded;
              clamped += 1;
            }
          }
        }
      }
    }
  }
  const digest = root["digest"];
  if (typeof digest === "object" && digest !== null) {
    const d = digest as Record<string, unknown>;
    d["goal"] = cap(d["goal"], 200);
    d["currentBelief"] = cap(d["currentBelief"], 300);
  }
  const report = root["report"];
  if (typeof report === "object" && report !== null) {
    const r = report as Record<string, unknown>;
    r["progress"] = cap(r["progress"], 240);
    r["next"] = cap(r["next"], 200);
    for (const key of ["rejected", "leftOpen"]) {
      if (!Array.isArray(r[key])) continue;
      for (const item of r[key] as unknown[]) {
        if (typeof item !== "object" || item === null) continue;
        (item as Record<string, unknown>)["text"] = cap((item as Record<string, unknown>)["text"], 200);
      }
    }
  }

  // Re-validate: length errors are gone by construction, so anything left is
  // a real contract violation (uncovered turns, bad q-ids, missing report).
  const remaining = validateDigestOutput(value, { window });
  if (remaining.some((e) => !e.includes("exceeds"))) return undefined;
  return { clamped };
}

/** Cast a validated reply into the typed shape. */
export function asDigestOutput(value: unknown): DigestOutput {
  const v = value as {
    blocks: {
      turnIndex: number;
      anchor: { fromLine: number; toLine: number };
      action: string;
      thoughts: { kind: DigestThoughtKind; source: DigestThoughtSource; text: string; q?: string }[];
    }[];
    digest: {
      goal: string;
      currentBelief: string;
      openHypotheses: { text: string }[];
      checkpoint?: {
        intent: string;
        concepts: string;
        files: string;
        errors: string;
        pending: string;
        current: string;
        next: string;
        critical: string;
      };
    };
    report: {
      status: SessionReport["status"];
      progress: string;
      next: string;
      rejected: { text: string; q: string }[];
      leftOpen: { text: string; q: string }[];
    };
  };
  return {
    blocks: v.blocks.map((b) => ({
      turnIndex: b.turnIndex,
      anchor: { fromLine: b.anchor.fromLine, toLine: b.anchor.toLine },
      action: b.action,
      thoughts: b.thoughts.map((t) => ({
        kind: t.kind,
        source: t.source,
        text: t.text,
        ...(t.q !== undefined ? { q: t.q } : {}),
      })),
    })),
    digest: {
      goal: v.digest.goal,
      currentBelief: v.digest.currentBelief,
      openHypotheses: v.digest.openHypotheses.map((h) => h.text),
      ...(v.digest.checkpoint !== undefined
        ? {
            checkpoint: {
              intent: v.digest.checkpoint.intent ?? "",
              concepts: v.digest.checkpoint.concepts ?? "",
              files: v.digest.checkpoint.files ?? "",
              errors: v.digest.checkpoint.errors ?? "",
              pending: v.digest.checkpoint.pending ?? "",
              current: v.digest.checkpoint.current ?? "",
              next: v.digest.checkpoint.next ?? "",
              critical: v.digest.checkpoint.critical ?? "",
            },
          }
        : {}),
    },
    report: {
      status: v.report.status,
      progress: v.report.progress,
      next: v.report.next,
      rejected: v.report.rejected.map((item) => ({ text: item.text, q: item.q })),
      leftOpen: v.report.leftOpen.map((item) => ({ text: item.text, q: item.q })),
    },
  };
}

// ---------------------------------------------------------------------------
// Reply rendering (what the watch tool hands to the caller)
// ---------------------------------------------------------------------------

/** Render validated digest blocks as compact text with @L/# anchors. */
export function renderDigestBlocks(output: DigestOutput, window: DigestWindow): string {
  const lines: string[] = [];
  const range = `${window.fromLine !== undefined ? `@L${window.fromLine}` : `#${window.entryFrom}`}–${
    window.toLine !== undefined ? `@L${window.toLine}` : `#${window.entryTo}`
  }`;
  lines.push(`compressed ${window.entryFrom}–${window.entryTo} (${range}, ${window.tokens} tok in)`);
  if (output.report !== undefined) {
    lines.push(
      `status: ${output.report.status} · progress: ${output.report.progress} · next: ${output.report.next}`,
    );
    for (const rejected of output.report.rejected) {
      lines.push(`  rejected (${rejected.q}): ${rejected.text}`);
    }
    for (const leftOpen of output.report.leftOpen) {
      lines.push(`  left-open (${leftOpen.q}): ${leftOpen.text}`);
    }
  }
  lines.push(`digest goal: ${output.digest.goal}`);
  lines.push(`belief: ${output.digest.currentBelief}`);
  if (output.digest.openHypotheses.length > 0) {
    lines.push(`open: ${output.digest.openHypotheses.join(" | ")}`);
  }
  const checkpoint = output.digest.checkpoint;
  if (checkpoint !== undefined) {
    for (const field of CHECKPOINT_FIELDS) {
      const value = checkpoint[field];
      if (value !== undefined && value !== "") lines.push(`ckpt ${field}: ${value}`);
    }
  }
  let anyCut = false;
  for (const block of output.blocks) {
    const from = block.anchor.fromLine !== undefined ? `@L${block.anchor.fromLine}` : `#${block.turnIndex}`;
    const to = block.anchor.toLine !== undefined ? `–@L${block.anchor.toLine}` : "";
    const actionLine = `- b${block.turnIndex} ${from}${to} ${block.action}`;
    lines.push(actionLine);
    if (actionLine.includes(TRUNCATED_MARKER_PREFIX)) anyCut = true;
    for (const thought of block.thoughts) {
      const q = thought.q !== undefined ? `, ${thought.q}` : "";
      lines.push(`  · ${thought.kind} (${thought.source}${q}): ${thought.text}`);
    }
  }
  if (anyCut) {
    lines.push(RECOVERY_FOOTER);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Deterministic facts layer — kept deliberately minimal: only facts that are
// unambiguous to extract AND change what an orchestrator would do next.
// ---------------------------------------------------------------------------

const LOOP_MIN_REPEATS = 3;
const MAX_FACT_FILES = 10;
const MAX_FACT_LOOPS = 3;

export interface SessionFacts {
  /** Workspace files touched by tool calls (deduplicated, capped). */
  readonly files: readonly string[];
  /** Exact repeated tool calls (same tool + same args) — a stuck-agent signal. */
  readonly loops: readonly { tool: string; repeats: number; sample: string }[];
}

/**
 * Extract facts from a delta of entries. Only first-level path-like tool args
 * count as files; commands and unknown shapes are ignored, not guessed.
 */
export function extractFacts(entries: readonly HistoryEntry[]): SessionFacts {
  const files = new Set<string>();
  const repeats = new Map<string, { tool: string; repeats: number; sample: string }>();
  for (const entry of entries) {
    if (entry.role !== "tool") continue;
    const tool = entry.toolName ?? "unknown";
    for (const key of FACT_FILE_KEYS) {
      const file = firstLevelString(entry.text, key);
      if (file !== undefined && file !== "") files.add(file);
    }
    const key = `${tool}\u0000${entry.text}`;
    const seen = repeats.get(key);
    if (seen === undefined) {
      repeats.set(key, { tool, repeats: 1, sample: entry.text.slice(0, 80) });
    } else {
      seen.repeats += 1;
    }
  }
  const loops = [...repeats.values()]
    .filter((r) => r.repeats >= LOOP_MIN_REPEATS)
    .sort((a, b) => b.repeats - a.repeats)
    .slice(0, MAX_FACT_LOOPS);
  const fileList = [...files];
  return {
    files:
      fileList.length > MAX_FACT_FILES
        ? [...fileList.slice(0, MAX_FACT_FILES), `+${fileList.length - MAX_FACT_FILES} more`]
        : fileList,
    loops,
  };
}

/** First-level string field of a JSON-object-shaped args string. */
function firstLevelString(argsText: string, key: string): string | undefined {
  if (!argsText.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(argsText) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Render the facts layer as 0-2 short lines (empty string when nothing). */
export function renderSessionFacts(facts: SessionFacts): string {
  const lines: string[] = [];
  if (facts.files.length > 0) lines.push(`files: ${facts.files.join(", ")}`);
  for (const loop of facts.loops) {
    lines.push(`loop: ${loop.tool} ${JSON.stringify(loop.sample)} ×${loop.repeats}`);
  }
  return lines.join("\n");
}

/** Raw fallback view for small deltas: one line per entry, anchored. */
export function renderRawEntries(entries: readonly HistoryEntry[], maxCharsPerLine = 200): string {
  const clockOf = (at: string | undefined): string => {
    if (at === undefined) return "--:--:--";
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return "--:--:--";
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };
  const roleLabel = (role: HistoryEntry["role"]): string => (role === "assistant" ? "asst" : role);
  return entries
    .map((entry) => {
      const ref = entry.line === undefined ? "" : ` @L${entry.line}`;
      const cut =
        entry.text.length > maxCharsPerLine ? `…(+${entry.text.length - maxCharsPerLine} chars)` : "";
      return `#${entry.index} ${roleLabel(entry.role)} ${clockOf(entry.at)}${ref} | ${entry.text.slice(0, maxCharsPerLine)}${cut}`;
    })
    .join("\n");
}
