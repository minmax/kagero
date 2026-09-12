/**
 * shared.ts — plumbing for the per-CLI history readers.
 *
 * Every reader turns one CLI's on-disk JSONL log into a HistoryResult:
 *  - entries carry through-numbered 1-based `index` positions over the FULL
 *    log (service rows and skipped events do not consume an index);
 *  - the result holds the LAST `last` (default 20) entries; `truncated` is
 *    true when the log holds more; `fullLog.line` then points at the file
 *    line where the FIRST not-shown entry starts, otherwise it is 1;
 *  - a tool call becomes a `role: "tool"` entry; its result merges into that
 *    entry by call id when the id is known (falling back to the immediately
 *    preceding unresolved tool entry when the format has no ids), otherwise
 *    the result becomes a standalone tool entry;
 *  - `at` is an ISO timestamp when the source carries a usable time and is
 *    omitted otherwise.
 *
 * Policies shared by all readers:
 *  - Unknown session → rejects with AgentError("session_not_found").
 *  - `HistoryOptions.maxChars` is accepted but intentionally unused: cutting
 *    is renderHistory's job; readers return full entry text.
 *  - Corrupt JSONL lines are skipped, not fatal.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { HistoryEntry, HistoryOptions, HistoryResult } from "@kagero/core";
import { AgentError } from "@kagero/core";

export type { HistoryReader } from "../spec.js";

/** Per-reader factory options; `homeDir` redirects ~/.<cli> for tests. */
export interface HistoryReaderOptions {
  readonly homeDir?: string;
}

export type HistoryRole = HistoryEntry["role"];

/** Resolve the HOME root a reader scans under. */
export function homeRoot(opts: HistoryReaderOptions | undefined): string {
  return opts?.homeDir ?? os.homedir();
}

// ---------------------------------------------------------------------------
// JSON narrowing helpers (logs are untrusted shape-wise; parse, don't cast).
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

/** Concatenate `{"type":"text","text":...}`-shaped parts with newlines. */
export function textFromContentParts(parts: readonly unknown[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const type = part.type;
    if (type !== undefined && type !== "text") continue;
    const text = asString(part.text);
    if (text !== undefined) chunks.push(text);
  }
  return chunks.join("\n");
}

/** Render tool arguments as compact text: strings pass through, objects as JSON. */
export function argsToText(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === undefined || args === null) return "";
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/** Unix milliseconds → ISO string. */
export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Filesystem scan helpers (missing directories are just "no candidates").
// ---------------------------------------------------------------------------

export async function listDirectory(dir: string): Promise<readonly Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function listSubdirs(dir: string): Promise<string[]> {
  const names: string[] = [];
  for (const dirent of await listDirectory(dir)) {
    if (dirent.isDirectory()) names.push(dirent.name);
  }
  return names;
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Pick the path with the newest mtime; unreadable paths are skipped. */
export async function newestPath(paths: readonly string[]): Promise<string | undefined> {
  let best: { readonly file: string; readonly mtimeMs: number } | undefined;
  for (const file of paths) {
    try {
      const mtimeMs = (await stat(file)).mtimeMs;
      if (best === undefined || mtimeMs > best.mtimeMs) best = { file, mtimeMs };
    } catch {
      // Vanished between scan and stat — skip.
    }
  }
  return best?.file;
}

/** Depth-limited recursive directory walk; returns directory paths (incl. root). */
export async function walkDirs(root: string, maxDepth: number): Promise<string[]> {
  const found: string[] = [root];
  let level = [root];
  for (let depth = 0; depth < maxDepth; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      for (const name of await listSubdirs(dir)) next.push(path.join(dir, name));
    }
    found.push(...next);
    level = next;
  }
  return found;
}

/** Depth-limited recursive file walk. */
export async function walkFiles(root: string, maxDepth: number): Promise<string[]> {
  const files: string[] = [];
  for (const dir of await walkDirs(root, maxDepth)) {
    for (const dirent of await listDirectory(dir)) {
      if (dirent.isFile()) files.push(path.join(dir, dirent.name));
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// JSONL reading.
// ---------------------------------------------------------------------------

export interface JsonlRow {
  /** 1-based file line the row starts at. */
  readonly line: number;
  readonly value: unknown;
}

/** Read a JSONL file; blank and unparseable lines are skipped. */
export async function readJsonlRows(file: string): Promise<JsonlRow[]> {
  const raw = await readFile(file, "utf8");
  const rows: JsonlRow[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = (lines[i] ?? "").trim();
    if (text === "") continue;
    try {
      rows.push({ line: i + 1, value: JSON.parse(text) as unknown });
    } catch {
      // Corrupt line: skip it rather than losing the whole history.
    }
  }
  return rows;
}

/** Session ids are used as path segments; keep them inert. */
export function isSafeSessionId(sessionId: string): boolean {
  return sessionId !== "" && !/[/\\\0]/.test(sessionId);
}

// ---------------------------------------------------------------------------
// Entry collection and result assembly.
// ---------------------------------------------------------------------------

/** A mutable entry under assembly; frozen into HistoryEntry at the end. */
export interface MutableEntry {
  role: HistoryRole;
  text: string;
  /** 1-based file line the entry starts at. */
  line: number;
  at?: string;
  toolName?: string;
  toolOk?: boolean;
}

export interface NewEntryInit {
  readonly role: HistoryRole;
  readonly text: string;
  readonly line: number;
  /** Optional fields accept explicit undefined; they are copied only when set. */
  readonly at?: string | undefined;
  readonly toolName?: string | undefined;
  readonly toolOk?: boolean | undefined;
}

export function makeEntry(init: NewEntryInit): MutableEntry {
  const entry: MutableEntry = { role: init.role, text: init.text, line: init.line };
  if (init.at !== undefined) entry.at = init.at;
  if (init.toolName !== undefined) entry.toolName = init.toolName;
  if (init.toolOk !== undefined) entry.toolOk = init.toolOk;
  return entry;
}

export interface ToolResultInit {
  /** Tool-call id when the format carries one. */
  readonly callId?: string | undefined;
  readonly toolOk?: boolean | undefined;
  /** Result text, used only when no call entry matches. */
  readonly text: string;
  readonly line: number;
  readonly at?: string | undefined;
  readonly toolName?: string | undefined;
}

/**
 * Collects parsed entries and merges tool results into their calls.
 *
 * Merge rules: a result with a call id merges into the entry registered for
 * that id (parallel calls make strict adjacency unreliable); a result without
 * an id merges into the immediately preceding unresolved tool entry; anything
 * else becomes a standalone tool record — "results split from their call stay
 * two entries".
 */
export class HistoryCollector {
  readonly #entries: MutableEntry[] = [];
  readonly #pendingById = new Map<string, MutableEntry>();
  #lastTool: MutableEntry | undefined;

  push(entry: MutableEntry): void {
    this.#entries.push(entry);
  }

  /** Register an emitted tool-call entry so its result can merge by id. */
  pushTool(callId: string | undefined, entry: MutableEntry): void {
    this.#entries.push(entry);
    this.#lastTool = entry;
    if (callId !== undefined) this.#pendingById.set(callId, entry);
  }

  /** Route a tool result: merge into its call entry or fall back to a new one. */
  mergeOrPushToolResult(init: ToolResultInit): void {
    const byId = init.callId !== undefined ? this.#pendingById.get(init.callId) : undefined;
    const fallback =
      init.callId === undefined && this.#lastTool !== undefined && this.#lastTool.toolOk === undefined
        ? this.#lastTool
        : undefined;
    const target = byId ?? fallback;
    if (target !== undefined) {
      if (init.callId !== undefined) this.#pendingById.delete(init.callId);
      if (init.toolOk !== undefined) target.toolOk = init.toolOk;
      return;
    }
    this.push(
      makeEntry({
        role: "tool",
        text: init.text,
        line: init.line,
        at: init.at,
        toolName: init.toolName,
        toolOk: init.toolOk,
      }),
    );
  }

  /** Assemble the final HistoryResult over the collected entries. */
  buildResult(sessionId: string, file: string, opts: HistoryOptions | undefined): HistoryResult {
    const last = Math.max(0, Math.trunc(opts?.last ?? 20));
    const total = this.#entries.length;
    const truncated = total > last;
    const skip = truncated ? total - last : 0;
    const entries = this.#entries.slice(skip).map((entry, i) => toHistoryEntry(entry, skip + i + 1));
    return {
      sessionId,
      entries,
      totalEntries: total,
      truncated,
      fullLog: { file, line: truncated ? (this.#entries[0]?.line ?? 1) : 1 },
    };
  }
}

function toHistoryEntry(entry: MutableEntry, index: number): HistoryEntry {
  return {
    index,
    role: entry.role,
    ...(entry.at !== undefined ? { at: entry.at } : {}),
    text: entry.text,
    ...(entry.toolName !== undefined ? { toolName: entry.toolName } : {}),
    ...(entry.toolOk !== undefined ? { toolOk: entry.toolOk } : {}),
  };
}

/** Canonical not-found error: readers reject (never resolve empty) on miss. */
export function sessionNotFoundError(backend: string, sessionId: string): AgentError {
  return new AgentError(
    "session_not_found",
    `${backend}: no session history found for id "${sessionId}"`,
    "user",
    { sessionId },
  );
}
