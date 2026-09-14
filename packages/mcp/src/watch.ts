/**
 * watch.ts — the `${prefix}_watch` tool: compressed history polling for
 * background sessions.
 *
 * The polling loop the tool serves:
 *  1. the caller starts a session and leaves it running in the background;
 *  2. first `${prefix}_watch` call (no cursor) → compressed summary of
 *     EVERYTHING since the session start;
 *  3. later calls (with the returned cursor) → only the NEW events since the
 *     previous poll; `wait_ms` lets the caller sleep inside the call ("give
 *     me the compressed history in a minute").
 *
 * Deltas below the raw threshold come back almost raw (rendered in our entry
 * format, with @L anchors) — spinning up the compressor for three lines would
 * cost more than it saves. Bigger deltas go to the COMPRESSOR: a separate
 * session of a cheap backend (KAGERO_COMPRESS_BACKEND / KAGERO_COMPRESS_MODEL)
 * that implements the agenttrace pass-1 contract (see @kagero/core digest).
 *
 * Cache economy: one compressor session per watched session, resumed across
 * polls. The instructions sit in the first turn, every later turn appends only
 * the new window, so the provider prompt cache reuses the whole prefix and
 * each poll pays tokens just for its own delta.
 */

import {
  type Agent,
  asDigestOutput,
  buildDigestWindows,
  buildFileIndex,
  type DigestOutput,
  type DigestWindow,
  extractFacts,
  extractJsonObject,
  formatFileIndex,
  type HistoryEntry,
  MAX_HISTORY_PAGE_SIZE,
  renderDigestBlocks,
  renderRawEntries,
  renderSessionFacts,
  repairDigestOutput,
  substituteFileRefs,
  validateDigestOutput,
} from "@kagero/core";
import { z } from "zod";
import { emptyWatchState, loadWatchState, saveWatchState, type WatchState } from "./watch-state.js";

export interface WatchConfig {
  /** Backend the compressor runs on (a cheap model). */
  readonly backend: string;
  /** Optional model override for the compressor runs. */
  readonly modelId?: string;
  /** Upper bound for wait_ms. Default 600000 (10 min). */
  readonly maxWaitMs: number;
  /** Deltas under this many raw chars skip the compressor. Default 1500. */
  readonly rawThresholdChars: number;
}

/** Read the watch configuration from the environment; undefined = feature off. */
export function readWatchConfig(env: NodeJS.ProcessEnv = process.env): WatchConfig | undefined {
  const backend = env["KAGERO_COMPRESS_BACKEND"];
  if (backend === undefined || backend.trim() === "") return undefined;
  const model = env["KAGERO_COMPRESS_MODEL"];
  const num = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    backend: backend.trim(),
    ...(model !== undefined && model.trim() !== "" ? { modelId: model.trim() } : {}),
    maxWaitMs: num("KAGERO_WATCH_MAX_WAIT_MS", 600_000),
    rawThresholdChars: num("KAGERO_WATCH_RAW_THRESHOLD_CHARS", 1_500),
  };
}

/** The compressor's standing instructions — the stable prefix the cache keeps. */
export const COMPRESSOR_SYSTEM_PROMPT = `You are a session-compressor worker. You read windows of a coding agent's session —
TURN blocks with [USER]/[THINKING]/[ASSISTANT]/[CALL]/[RESULT] lines and [q...] quote ids —
and reply with ONE JSON object and nothing else (no prose, no code fences around it):

{"blocks":[{"turnIndex":N,"anchor":{"fromLine":F,"toLine":T},"action":"...","thoughts":[...]}],
 "digest":{"goal":"...","currentBelief":"...","openHypotheses":[{"text":"..."}],
  "checkpoint":{"intent":"...","concepts":"...","files":"...","errors":"...",
                "pending":"...","current":"...","next":"...","critical":"..."}}},
 "report":{"status":"working|blocked|done|failed","progress":"...","next":"...",
           "rejected":[{"text":"...","q":"..."}],"leftOpen":[{"text":"...","q":"..."}]}}

Rules (validated mechanically; violations are rejected with an error list to fix):
- Cover EVERY turn of the window exactly once. Merge runs of insignificant moves
  (routine reads/checks without thinking) into ONE block whose anchor spans them;
  turns with thinking, errors or decisions get their own block.
- anchor: fromLine/toLine exactly from the turn header; toLine >= fromLine.
- A move whose header says MANDATORY (it has [THINKING] with a q-id) MUST carry
  1-3 thoughts, source="thinking", q = the id of the most essential thought
  (pivot / hypothesis / discovery). Without thinking -> thoughts: [] (or
  source="narration" citing an [ASSISTANT] q-id when it carries real reasoning).
- Never invent thoughts from tool results. Third person, intentions not quotes.
- Tool lines: [CALL name args] + [RESULT ok|ERR]. The action says what the tools
  were FOR and what their results ESTABLISHED, not the commands verbatim; merge
  repeated loop moves into one ERR-R thought about the cycle.
- report — the part the agent will NOT say in its final message. status is how
  the work is ACTUALLY going (blocked = waiting on something / stuck on a
  wall; failed = the goal cannot be reached this way). progress: only real
  accomplishments. next: what the agent is doing next, "—" when terminal.
  rejected: approaches considered in thinking and DROPPED, with the reason
  (0-3; empty when none). leftOpen: work the agent promised or half-started
  in thinking but did NOT finish in this window, unresolved threads (0-3).
  Every rejected/leftOpen text MUST cite the q-id of the thinking it came
  from. Do not invent items to fill the arrays; empty arrays are correct.
- digest.checkpoint — the 8-section skeleton (intent / concepts / files /
  errors / pending / current / next / critical; each <= 600 chars, empty
  string = "(none)"). CONSOLIDATE with the PREVIOUS checkpoint when the
  carry block shows one: keep what is still TRUE, drop what is STALE, add
  what is NEW — never copy it verbatim. The checkpoint chain must read as
  one self-sufficient session picture.
- LANGUAGE: action / thoughts / digest / report in English only, even if the
  session is not.
- Length caps: action <= 240, thought text <= 320, goal <= 200,
  currentBelief <= 300, progress <= 240, next <= 200, report item text <= 200,
  checkpoint section <= 600. The whole reply must be MUCH shorter than the
  window text.`;

// ---------------------------------------------------------------------------
// Cursor: stateless position token (entry index), like the history cursors
// ---------------------------------------------------------------------------

interface WatchCursor {
  v: 1;
  s: string;
  i: number;
}

export function encodeWatchCursor(cursor: WatchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeWatchCursor(raw: string, sessionId: string): { i: number } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return { error: "invalid watch cursor" };
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "invalid watch cursor" };
  const rec = parsed as Record<string, unknown>;
  if (rec["v"] !== 1 || rec["s"] !== sessionId)
    return { error: "watch cursor belongs to a different session" };
  if (typeof rec["i"] !== "number" || !Number.isInteger(rec["i"]) || rec["i"] < 0) {
    return { error: "invalid watch cursor" };
  }
  return { i: rec["i"] };
}

// ---------------------------------------------------------------------------
// Delta collection over the paginated history surface
// ---------------------------------------------------------------------------

/** Hard cap on one poll's delta; larger sessions page through poll by poll. */
const MAX_DELTA_ENTRIES = 1_000;
const MAX_HISTORY_PAGES = 50;
/** Compression windows per poll — bounds one call to a few minutes. */
const MAX_WINDOWS_PER_POLL = 3;

/**
 * Entries newer than `sinceIndex`, ascending. Reads pages from the newest end
 * until the cursor position is covered or the log head is reached.
 */
export async function collectDelta(
  agent: Agent,
  sessionId: string,
  sinceIndex: number,
): Promise<{ entries: HistoryEntry[]; truncated: boolean }> {
  const pages: HistoryEntry[][] = [];
  let truncated = false;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const result = await agent.history(sessionId, { page, pageSize: MAX_HISTORY_PAGE_SIZE });
    const fresh = result.entries.filter((entry) => entry.index > sinceIndex);
    pages.unshift(fresh);
    if (fresh.length < result.entries.length) break; // page reached past the cursor
    if (result.truncated === false) break; // reached the log head
  }
  let entries = pages.flat();
  if (entries.length > MAX_DELTA_ENTRIES) {
    entries = entries.slice(entries.length - MAX_DELTA_ENTRIES);
    truncated = true;
  }
  return { entries, truncated };
}

const deltaChars = (entries: readonly HistoryEntry[]): number =>
  entries.reduce(
    (acc, entry) => acc + entry.text.length + (entry.thinking?.length ?? 0) + (entry.toolResult?.length ?? 0),
    0,
  );

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The newest entry index of a delta (the caller's cursor position after it). */
function deltaEndIndex(delta: readonly HistoryEntry[], fallback: number): number {
  return delta.length > 0 ? (delta[delta.length - 1]?.index ?? fallback) : fallback;
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export interface WatchArgs {
  session_id: string;
  backend?: string | undefined;
  wait_ms?: number | undefined;
  cursor?: string | undefined;
}

export interface WatchDeps {
  /** Resolve the ORIGINAL session's backend (default backend when unnamed). */
  selectAgent(backend: string | undefined): Promise<Agent>;
  defaultBackend: string;
  readonly config: WatchConfig;
  /** The stream hub, when present: buffered live events are compressed now. */
  hub?: { flushSession(sessionId: string): Promise<void> } | undefined;
}

export interface WatchResult {
  readonly text: string;
  readonly isError: boolean;
}

/** Build the zod schema for the watch tool (wait_ms capped by the config). */
export function watchInputSchema(config: WatchConfig) {
  return z
    .object({
      session_id: z.string(),
      backend: z.string().optional(),
      wait_ms: z.number().int().min(0).max(config.maxWaitMs).optional(),
      cursor: z.string().optional(),
    })
    .strict();
}

export const WATCH_TOOL_DESCRIPTION = (config: WatchConfig): string =>
  `Read a compressed summary of a session's events, designed for POLLING a session that runs in the background. ` +
  `Without a cursor: compressed summary of everything since the session start. With the cursor from the previous ` +
  `call: only the NEW events since that poll. wait_ms sleeps inside the call first, so "give me the digest in a ` +
  `minute" is one call with wait_ms=60000 (max ${config.maxWaitMs}). Deltas below the raw threshold come back as ` +
  `raw anchored entries instead of invoking the compressor. Compression runs on a separate cheap-agent session ` +
  `(backend "${config.backend}"${config.modelId === undefined ? "" : `, model ${config.modelId}`}) using the ` +
  `agenttrace pass-1 contract: per-move blocks with actions, distilled reasoning (thoughts citing [q...] ids) and ` +
  `a rolling digest; every block keeps @L<line> anchors into the original log, so the link to the raw data survives.`;

/**
 * One watch poll. Never throws for run outcomes — failures degrade to the raw
 * delta view with an honest note (a poll must not lose the position).
 */
export async function handleWatch(deps: WatchDeps, args: WatchArgs): Promise<WatchResult> {
  const { config } = deps;
  let sinceIndex = 0;
  if (args.cursor !== undefined && args.cursor !== "") {
    const decoded = decodeWatchCursor(args.cursor, args.session_id);
    if ("error" in decoded)
      return { text: `${decoded.error}. Pass no cursor to start from the session head.`, isError: true };
    sinceIndex = decoded.i;
  }

  if (args.wait_ms !== undefined && args.wait_ms > 0) await sleep(args.wait_ms);
  // "дай сейчас": squeeze the session's in-memory live buffer before reading.
  await deps.hub?.flushSession(args.session_id);

  let agent: Agent;
  try {
    agent = await deps.selectAgent(args.backend ?? deps.defaultBackend);
  } catch (err) {
    return { text: `watch could not select the session backend: ${(err as Error).message}`, isError: true };
  }

  const header = `watch ${agent.name}:${args.session_id}`;
  let cursorOverride: number | undefined;
  let cursor = encodeWatchCursor({ v: 1, s: args.session_id, i: sinceIndex });

  let delta: HistoryEntry[];
  let deltaTruncated: boolean;
  try {
    const collected = await collectDelta(agent, args.session_id, sinceIndex);
    delta = collected.entries;
    deltaTruncated = collected.truncated;
  } catch (err) {
    // Backends without reader history (e.g. pi-rpc): the stream compressor
    // already compressed everything into the journal — show that digest.
    const state = loadWatchState(agent.name, args.session_id);
    if (state?.digest !== undefined) {
      const aggregate: DigestWindow = {
        turns: [],
        text: "",
        entryFrom: 0,
        entryTo: state.streamCursorIndex ?? state.cursorIndex,
        tokens: 0,
        quoteIds: new Set<string>(),
        thinkingTurnIndexes: new Set<number>(),
      };
      return {
        text:
          `${header} — compressed by ${config.backend} (stream batches; this backend has no reader history):\n` +
          `${renderDigestBlocks(state.digest, aggregate)}\n— watch cursor: ${cursor}`,
        isError: false,
      };
    }
    if (loadWatchState(agent.name, args.session_id) === undefined) {
      return {
        text:
          `${header} — no compressed state yet: this backend has no reader history and the background ` +
          `compressor has not checkpointed a batch (it may still be working — retry shortly). ` +
          `Underlying error: ${(err as Error).message}`,
        isError: false,
      };
    }
    return { text: `watch could not read the session history: ${(err as Error).message}`, isError: true };
  }

  const position = deltaEndIndex(delta, sinceIndex);
  cursor = encodeWatchCursor({ v: 1, s: args.session_id, i: position });

  if (delta.length === 0) {
    return {
      text: `${header} — no new events since entry #${sinceIndex}.\n— watch cursor: ${cursor}`,
      isError: false,
    };
  }

  const rawChars = deltaChars(delta);
  if (rawChars <= config.rawThresholdChars) {
    const note = deltaTruncated ? " (older delta truncated; poll again to page through)" : "";
    return {
      text:
        `${header} — ${delta.length} new entries (${rawChars} chars, below the compression threshold)${note}:\n` +
        `${renderRawEntries(delta)}\n— watch cursor: ${cursor}`,
      isError: false,
    };
  }

  // Cap compression work per poll: a huge first poll must not hold the call
  // for half an hour. Older windows compress on the following polls — the
  // cursor stops at the last COMPRESSED window, so nothing is skipped.
  const windows = buildDigestWindows(delta);
  const slice = windows.slice(0, MAX_WINDOWS_PER_POLL);
  const pollState = loadWatchState(agent.name, args.session_id);
  const compressed = await compressDelta(deps, agent.name, args.session_id, slice, pollState, saveWatchState);
  if (compressed === undefined) {
    // Compressor unavailable or its reply kept failing validation: a poll
    // must not lose the position — degrade to the raw view honestly.
    const reason = lastCompressorFailure ?? "compressor unavailable";
    return {
      text:
        `${header} — ${delta.length} new entries (${reason}):\n` +
        `${renderRawEntries(delta)}\n— watch cursor: ${cursor}`,
      isError: false,
    };
  }
  // Re-anchor the cursor to the last compressed window, not the delta end.
  const lastWindow = slice[slice.length - 1];
  if (lastWindow !== undefined && compressed.windowCount > 0) {
    const compressTo = lastWindow.entryTo;
    if (compressTo < position) {
      cursorOverride = compressTo;
    }
  }
  const pendingWindows = windows.length - slice.length;
  const truncNote = deltaTruncated ? " (older delta truncated; poll again to page through)" : "";
  const windowNote =
    compressed.windowCount > 1
      ? ` (${compressed.windowCount}/${windows.length} windows${pendingWindows > 0 ? ` — repeat with the cursor to compress the next ${pendingWindows}` : ""})`
      : "";
  const trimNote = compressed.clamped > 0 ? `, ${compressed.clamped} over-long fields trimmed` : "";
  const effectiveCursor =
    cursorOverride !== undefined
      ? encodeWatchCursor({ v: 1, s: args.session_id, i: cursorOverride })
      : cursor;
  const fileIndex = buildFileIndex(delta);
  const indexBlock = formatFileIndex(fileIndex);
  const body = substituteFileRefs(renderDigestBlocks(compressed.output, compressed.aggregate), fileIndex);
  return {
    text:
      `${header} — compressed by ${config.backend}${windowNote}${trimNote}${truncNote}:\n` +
      `${indexBlock === "" ? "" : `${indexBlock}\n`}${body}\n— watch cursor: ${effectiveCursor}`,
    isError: false,
  };
}

/** Reason of the latest compressor failure (for honest degradation notes). */
export let lastCompressorFailure: string | undefined;

// --- compressor session ownership -------------------------------------------
// The compressor backend is often the SAME cached agent instance as a runner
// backend; its sessions must never be re-compressed (chain reaction). While a
// compression is in flight, the backend's next session-start belongs to the
// compressor — the tap records its exact id, and the stream hub consults the
// owned set on every event.

const ownedByBackend = new Map<string, Set<string>>();
const expectingByBackend = new Set<string>();
const ownershipTapped = new WeakSet<Agent>();

/** Attach (once) the session-start tap that records compressor session ids. */
export function ensureOwnershipTap(agent: Agent): void {
  if (ownershipTapped.has(agent) || !agent.capabilities.subscribe) return;
  ownershipTapped.add(agent);
  agent.subscribe("*", (event) => {
    if (event.type !== "session-start") return;
    if (!expectingByBackend.has(agent.name)) return;
    const set = ownedByBackend.get(agent.name) ?? new Set<string>();
    set.add(event.sessionId);
    ownedByBackend.set(agent.name, set);
  });
}

/** True while the session is a compressor's own run on this backend. */
export function isCompressorOwnedSession(backend: string, sessionId: string): boolean {
  return ownedByBackend.get(backend)?.has(sessionId) ?? false;
}

/** Compression result: the final (newest) output plus the aggregate window view. */
export interface CompressedDelta {
  readonly output: DigestOutput;
  readonly aggregate: DigestWindow;
  readonly windowCount: number;
  /** Fields trimmed server-side across the windows (honesty note in replies). */
  readonly clamped: number;
}

/**
 * Run the compressor over one window with session reuse and one repair round.
 * Returns the validated output, or undefined when compression failed — the
 * caller decides how to degrade.
 */
async function compressOneWindow(
  deps: WatchDeps,
  originalBackend: string,
  sessionId: string,
  window: DigestWindow,
  previous: DigestOutput | undefined,
  windowNo: number,
  windowTotal: number,
): Promise<{ output: DigestOutput; clamped: number; compressorSessionId?: string } | undefined> {
  const { config } = deps;
  const windowHeader =
    `WINDOW ${windowNo}/${windowTotal}, entries #${window.entryFrom}–#${window.entryTo}` +
    (window.fromLine !== undefined ? ` (lines @L${window.fromLine}–@L${window.toLine})` : "") +
    `, ${window.turns.length} turns — compress THIS WINDOW only.`;
  const carry =
    previous === undefined
      ? ""
      : `\n\nPREVIOUS DIGEST (windows before this one, already compressed — update it in your reply):\n` +
        `digest goal: ${previous.digest.goal}\nbelief: ${previous.digest.currentBelief}\n` +
        `open: ${previous.digest.openHypotheses.join(" | ") || "none"}\n` +
        `status: ${previous.report?.status ?? "working"} · progress: ${previous.report?.progress ?? "n/a"}\n` +
        `rejected: ${previous.report?.rejected.map((r) => r.text).join(" | ") || "none"}\n` +
        `left-open: ${previous.report?.leftOpen.map((r) => r.text).join(" | ") || "none"}\n` +
        `checkpoint: ${previous.digest.checkpoint !== undefined ? JSON.stringify(previous.digest.checkpoint) : "none"}\n` +
        `Cover ONLY the new turns in blocks; carry the digest/report/checkpoint forward — CONSOLIDATE the ` +
        `checkpoint (keep the true, drop the stale, add the new — not verbatim) as of the end of THIS window.`;
  const options = config.modelId === undefined ? {} : { modelId: config.modelId };

  let reply: string | undefined;
  try {
    const compressor = await deps.selectAgent(config.backend);
    ensureOwnershipTap(compressor);
    const known = currentCompressorSession(originalBackend, sessionId, compressor);
    const turn = `${windowHeader}${carry}\n\n${window.text}`;
    expectingByBackend.add(config.backend);
    try {
      const response =
        known === undefined
          ? await compressor.prompt(`${COMPRESSOR_SYSTEM_PROMPT}\n\n${turn}`, options)
          : await compressor.resume(known, turn, options);
      reply = response.text;
      if (response.sessionId !== undefined)
        rememberCompressorSession(originalBackend, sessionId, response.sessionId);
    } finally {
      expectingByBackend.delete(config.backend);
    }
  } catch (err) {
    lastCompressorFailure = `compressor unavailable: ${(err as Error).message}`;
    return undefined;
  }

  const parse = (text: string): { errors: string[]; value?: unknown } => {
    // Shrink-gate (agenttrace cb848cc): a digest runaway comparable to the
    // window it summarizes defeats the purpose. The absolute 4000 floor keeps
    // tiny sessions (whose contract boilerplate alone approaches the window
    // size) from false-positives.
    if (text.length > 4000 || (window.text.length > 4000 && text.length >= window.text.length)) {
      return {
        errors: [
          `reply (${text.length} chars) must be much shorter than the window (${window.text.length} chars)`,
        ],
      };
    }
    const value = extractJsonObject(text);
    if (value === undefined) return { errors: ["reply contained no JSON object"] };
    return { errors: validateDigestOutput(value, { window }), value };
  };

  let result = parse(reply);
  let clamped = 0;
  const trim = (): void => {
    if (result.value === undefined) return;
    // Trim-first: length-cap overflows and enum-case/anchor slips are fixed
    // server-side, so an expensive compression is not voided over small slips.
    const repaired = repairDigestOutput(result.value, window);
    if (repaired !== undefined) {
      result = { errors: [], value: result.value };
      clamped += repaired.clamped;
    }
  };
  trim();
  // Up to two repair rounds, mirroring agenttrace's submit-fix loop (<=3 tries).
  for (let attempt = 0; attempt < 2 && result.errors.length > 0; attempt++) {
    try {
      const compressor = await deps.selectAgent(config.backend);
      const known = currentCompressorSession(originalBackend, sessionId, compressor);
      const repair =
        known === undefined
          ? `${COMPRESSOR_SYSTEM_PROMPT}\n\n${windowHeader}${carry}\n\n${window.text}\n\n` +
            `Your previous reply failed validation:\n${result.errors.map((e) => `- ${e}`).join("\n")}\n` +
            `Fix exactly what is listed and return the corrected JSON object only.`
          : `Your previous reply failed validation:\n${result.errors.map((e) => `- ${e}`).join("\n")}\n` +
            `Fix exactly what is listed for the last window and return the corrected JSON object only. ` +
            `Hard caps: action <= 240, thought text <= 320, goal <= 200, currentBelief <= 300, ` +
            `progress <= 240, next <= 200, report item text <= 200. Every [THINKING] move needs ` +
            `1-3 thoughts with a q-id; every turn of the window must be covered by exactly one block.`;
      const response =
        known === undefined
          ? await compressor.prompt(repair, options)
          : await compressor.resume(known, repair, options);
      if (response.sessionId !== undefined)
        rememberCompressorSession(originalBackend, sessionId, response.sessionId);
      result = parse(response.text);
      trim();
    } catch {
      // keep the current validation errors
      break;
    }
  }

  if (result.errors.length > 0 || result.value === undefined) {
    lastCompressorFailure = `compressor reply failed validation:\n${result.errors.map((e) => `- ${e}`).join("\n")}`;
    return undefined;
  }
  lastCompressorFailure = undefined;
  const compressorSessionId = compressorSessions.get(compressorKey(originalBackend, sessionId));
  return {
    output: asDigestOutput(result.value),
    clamped,
    ...(compressorSessionId !== undefined ? { compressorSessionId } : {}),
  };
}

/**
 * Compress a whole delta: split into budget-sized windows (older first),
 * compress sequentially carrying the digest forward, return the final output
 * plus an aggregate window view for rendering. Progress is persisted through
 * `persist` after every window, so an interrupted run (MCP timeout, retry)
 * resumes from the saved cursor instead of redoing finished windows.
 */
export async function compressDelta(
  deps: WatchDeps,
  originalBackend: string,
  sessionId: string,
  windows: readonly DigestWindow[],
  state: WatchState | undefined,
  persist: ((state: WatchState) => void) | undefined,
): Promise<CompressedDelta | undefined> {
  let previous: DigestOutput | undefined = state?.digest !== undefined ? state.digest : undefined;
  let clamped = 0;
  for (const [i, window] of windows.entries()) {
    const result = await compressOneWindow(
      deps,
      originalBackend,
      sessionId,
      window,
      previous,
      i + 1,
      windows.length,
    );
    if (result === undefined) return undefined;
    previous = result.output;
    clamped += result.clamped;
    if (persist !== undefined) {
      persist({
        ...(state ?? emptyWatchState(originalBackend, sessionId)),
        ...state,
        cursorIndex: window.entryTo,
        ...(result.compressorSessionId !== undefined
          ? { compressorSessionId: result.compressorSessionId }
          : {}),
        digest: result.output,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  if (previous === undefined) return undefined;
  const first = windows[0];
  const last = windows[windows.length - 1];
  const aggregate: DigestWindow = {
    turns: [],
    text: "",
    entryFrom: first?.entryFrom ?? 0,
    entryTo: last?.entryTo ?? 0,
    ...(first?.fromLine !== undefined && last?.toLine !== undefined
      ? { fromLine: first.fromLine, toLine: last.toLine }
      : {}),
    tokens: windows.reduce((acc, w) => acc + w.tokens, 0),
    quoteIds: new Set<string>(),
    thinkingTurnIndexes: new Set<number>(),
  };
  return { output: previous, aggregate, windowCount: windows.length, clamped };
}

/**
 * The report appended to `prompt`/`resume` replies when the watch config is
 * present: the orchestrator-facing verdict over the WHOLE session plus the
 * minimal deterministic facts. Progress accumulates in the persistent state —
 * each run compresses only the windows added since the last one, and an
 * interrupted run (MCP timeout/retry) resumes where it stopped. Never breaks
 * the run's own reply — every failure degrades to an absent section.
 */
export async function summarizeRun(
  deps: WatchDeps,
  backend: string,
  response: AgentResponseLike,
): Promise<string | undefined> {
  if (response.sessionId === undefined) return undefined;
  const sessionId = response.sessionId;
  try {
    const agent = await deps.selectAgent(backend);
    const state = loadWatchState(agent.name, sessionId);
    const collected = await collectDelta(agent, sessionId, state?.cursorIndex ?? 0);
    if (collected.entries.length === 0) {
      // Nothing new — but if we already hold a report, re-emit it.
      if (state?.digest === undefined) return undefined;
      return renderSessionReport(deps, state.digest, [], state);
    }
    const windows = buildDigestWindows(collected.entries);
    if (windows.length === 0) {
      if (state?.digest === undefined) return undefined;
      return renderSessionReport(deps, state.digest, [], state);
    }
    const compressed = await compressDelta(deps, agent.name, sessionId, windows, state, saveWatchState);
    if (compressed === undefined) return undefined;

    return renderSessionReport(deps, compressed.output, collected.entries, {
      cursorIndex: compressed.aggregate.entryTo,
    });
  } catch {
    return undefined;
  }
}

/** Compose the appended report section: digest verdict + deterministic facts. */
function renderSessionReport(
  deps: WatchDeps,
  output: DigestOutput,
  deltaEntries: readonly HistoryEntry[],
  _state: { cursorIndex: number } | undefined,
): string {
  const lines: string[] = [`— session report (compressed by ${deps.config.backend}):`];
  const report = output.report;
  if (report !== undefined) {
    lines.push(`status: ${report.status} · progress: ${report.progress} · next: ${report.next}`);
    for (const rejected of report.rejected) lines.push(`  rejected (${rejected.q}): ${rejected.text}`);
    for (const leftOpen of report.leftOpen) lines.push(`  left-open (${leftOpen.q}): ${leftOpen.text}`);
  }
  if (deltaEntries.length > 0) {
    const factsText = renderSessionFacts(extractFacts(deltaEntries));
    if (factsText !== "") lines.push(factsText);
  }
  return lines.join("\n");
}

/** The slice of AgentResponse the report layer needs. */
export interface AgentResponseLike {
  readonly sessionId?: string;
}

// Compressor session reuse (cache economy): one cheap-agent session per watched
// session; losing it (server restart) just starts a fresh prefix.
const compressorSessions = /* @__PURE__ */ new Map<string, string>();

function compressorKey(originalBackend: string, sessionId: string): string {
  return `${originalBackend}:${sessionId}`;
}

/** The reusable compressor session: in-memory first, then the persisted state. */
function currentCompressorSession(
  originalBackend: string,
  sessionId: string,
  compressor: Agent,
): string | undefined {
  const known =
    compressorSessions.get(compressorKey(originalBackend, sessionId)) ??
    loadWatchState(originalBackend, sessionId)?.compressorSessionId;
  if (known === undefined) return undefined;
  // A compressor backend without resume support always starts a fresh prefix.
  return compressor.capabilities.resume ? known : undefined;
}

function rememberCompressorSession(
  originalBackend: string,
  sessionId: string,
  compressorSessionId: string,
): void {
  compressorSessions.set(compressorKey(originalBackend, sessionId), compressorSessionId);
}
