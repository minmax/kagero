/**
 * dsh-sessions.ts — on-disk session listing for DeepSeek Harness (`~/.dsh`).
 *
 * dsh headless exposes no session-listing command (review §5: only the web
 * layer can query sessions), but every run persists a projection record:
 *
 *   ~/.dsh/storages/session_projcache/sessions/<session-id>.json
 *
 * Observed format (version 7 records; ids are `session-<uuid>` for headless
 * runs, bare `<uuid>` for tui/web profiles):
 *
 *   { "version": 7, "record": {
 *       "identity": { "formatVersion": 3, "createdAt": <epoch ms>, "cwd": … },
 *       "rows": {
 *         "title":               { "val": "PONG reply request" },
 *         "sessionListMetadata": { "val": { "blank": false, "lastPromptAt": <epoch ms> } },
 *         "tokenUsage":          { "val": { "totals": { … } } }, … } } }
 *
 * Mapping to SessionInfo:
 *  - id from the file name (matches the session-log directory name and the
 *    `session` header id inside session.v3.jsonl.zstd);
 *  - lastUsedAt = sessionListMetadata.lastPromptAt, falling back to the file
 *    mtime (records are rewritten on activity) and then identity.createdAt;
 *  - summary = rows.title, once the title LLM has produced one;
 *  - messageCount = 0 — the projection carries no message count (same
 *    "unknown → 0" convention as pi-rpc).
 *
 * Newest-first, capped at 200 records; torn/corrupt records are skipped, not
 * fatal. This is a best-effort read of an undocumented-but-stable projection.
 */

import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { SessionInfo } from "@kagero/core";
import { asNumber, asString, homeRoot, isoFromMs, listDirectory, recordAt } from "./shared.js";

/** Listing cap — the projection grows without bound, one file per session ever. */
const DEFAULT_SESSIONS_LIMIT = 200;

async function readRecord(file: string, id: string): Promise<SessionInfo | undefined> {
  let raw: string;
  let mtimeMs: number | undefined;
  try {
    raw = await readFile(file, "utf8");
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return undefined; // vanished or unreadable between scan and read — skip
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined; // torn write mid-session — skip, never crash the listing
  }
  const record = recordAt(value, "record");
  const identity = recordAt(record, "identity");
  const rows = recordAt(record, "rows");
  const createdAtMs = asNumber(identity?.createdAt);
  if (createdAtMs === undefined) return undefined;

  const lastPromptAt = asNumber(recordAt(recordAt(rows, "sessionListMetadata"), "val")?.lastPromptAt);
  const title = asString(recordAt(rows, "title")?.val);

  return {
    id,
    createdAt: isoFromMs(createdAtMs),
    lastUsedAt: isoFromMs(lastPromptAt ?? mtimeMs ?? createdAtMs),
    cwd: asString(identity?.cwd) ?? "",
    summary: title ?? "",
    messageCount: 0,
  };
}

/** List dsh sessions from the projcache projection, newest first. */
export async function readDshSessions(opts?: { readonly homeDir?: string }): Promise<SessionInfo[]> {
  const sessionsDir = path.join(homeRoot(opts), ".dsh", "storages", "session_projcache", "sessions");
  const found: SessionInfo[] = [];
  for (const dirent of await listDirectory(sessionsDir)) {
    if (!dirent.isFile()) continue;
    if (!dirent.name.endsWith(".json")) continue;
    const record = await readRecord(
      path.join(sessionsDir, dirent.name),
      dirent.name.slice(0, -".json".length),
    );
    if (record !== undefined) found.push(record);
  }
  // ISO timestamps compare lexicographically — newest first.
  found.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  return found.slice(0, DEFAULT_SESSIONS_LIMIT);
}
