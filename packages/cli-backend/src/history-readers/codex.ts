/**
 * codex.ts — history reader for codex (`~/.codex/sessions`).
 *
 * Layout: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`
 * (local-time ts with `-` instead of `:`). The lookup walks the date tree for
 * `rollout-*-<id>.jsonl` (exact suffix — old `.jsonl.pass1.jsonl` sidecars
 * never match) and takes the newest; a candidate is accepted only when its
 * first `session_meta` row is absent or carries `payload.session_id === id`.
 *
 * File format: rows `{timestamp, ordinal, type, payload}`:
 *  - `response_item` with `payload.type: "message"` → entry; `payload.role`
 *    `user`/`assistant` map directly, `developer` maps to `system`; text comes
 *    from `input_text`/`output_text` content parts;
 *  - `response_item` with `payload.type: "function_call"` `{call_id, name,
 *    arguments}` → tool entry; `"function_call_output"` `{call_id, output}`
 *    merges into its call entry by id — the format carries no structured
 *    error flag, so `toolOk` stays unset for codex;
 *  - `response_item` `reasoning` and all `event_msg` UI events are skipped
 *    (canonical data lives in response_item rows);
 *  - `at` comes from the row's ISO `timestamp`.
 *
 * Unknown session → rejects with AgentError("session_not_found").
 */

import * as path from "node:path";
import type { HistoryOptions, HistoryResult } from "@kagero/core";
import {
  argsToText,
  asString,
  HistoryCollector,
  type HistoryReader,
  type HistoryReaderOptions,
  homeRoot,
  isRecord,
  isSafeSessionId,
  type JsonlRow,
  makeEntry,
  readJsonlRows,
  sessionNotFoundError,
  walkFiles,
} from "./shared.js";

function sessionsRoot(opts: HistoryReaderOptions | undefined): string {
  return path.join(homeRoot(opts), ".codex", "sessions");
}

async function findRolloutCandidates(root: string, sessionId: string): Promise<string[]> {
  const suffix = `-${sessionId}.jsonl`;
  const candidates: string[] = [];
  for (const file of await walkFiles(root, 4)) {
    const name = path.basename(file);
    if (name.startsWith("rollout-") && name.endsWith(suffix)) candidates.push(file);
  }
  // Newest first.
  return candidates.sort((a, b) => b.localeCompare(a));
}

/** session_meta must not contradict the requested id (absent meta = accept). */
function metaSessionId(rows: readonly JsonlRow[]): string | undefined {
  for (const row of rows) {
    if (!isRecord(row.value) || row.value.type !== "session_meta") continue;
    const payload = isRecord(row.value.payload) ? row.value.payload : undefined;
    return payload === undefined ? undefined : asString(payload.session_id);
  }
  return undefined;
}

async function read(
  sessionId: string,
  opts: HistoryOptions | undefined,
  readerOpts: HistoryReaderOptions | undefined,
): Promise<HistoryResult> {
  if (!isSafeSessionId(sessionId)) throw sessionNotFoundError("codex", sessionId);
  const root = sessionsRoot(readerOpts);
  for (const file of await findRolloutCandidates(root, sessionId)) {
    const rows = await readJsonlRows(file);
    const metaId = metaSessionId(rows);
    if (metaId === undefined || metaId === sessionId) return assemble(file, rows, sessionId, opts);
  }
  throw sessionNotFoundError("codex", sessionId);
}

function assemble(
  file: string,
  rows: readonly JsonlRow[],
  sessionId: string,
  opts: HistoryOptions | undefined,
): HistoryResult {
  const collector = new HistoryCollector();
  for (const row of rows) {
    if (!isRecord(row.value) || row.value.type !== "response_item") continue;
    const payload = isRecord(row.value.payload) ? row.value.payload : undefined;
    if (payload === undefined) continue;
    const at = asString(row.value.timestamp);
    const payloadType = asString(payload.type);

    if (payloadType === "message") {
      const role = asString(payload.role);
      // Codex "developer" rows are system-level instructions.
      const historyRole = role === "developer" ? "system" : role;
      if (historyRole !== "user" && historyRole !== "assistant" && historyRole !== "system") continue;
      const parts: string[] = [];
      const content = Array.isArray(payload.content) ? payload.content : [];
      for (const part of content) {
        if (!isRecord(part)) continue;
        const partType = asString(part.type);
        if (partType !== "input_text" && partType !== "output_text") continue;
        const text = asString(part.text);
        if (text !== undefined) parts.push(text);
      }
      const text = parts.join("\n");
      if (text !== "") collector.push(makeEntry({ role: historyRole, text, line: row.line, at }));
    } else if (payloadType === "function_call") {
      collector.pushTool(
        asString(payload.call_id),
        makeEntry({
          role: "tool",
          text: argsToText(payload.arguments),
          line: row.line,
          at,
          toolName: asString(payload.name) ?? "unknown",
        }),
      );
    } else if (payloadType === "function_call_output") {
      collector.mergeOrPushToolResult({
        callId: asString(payload.call_id),
        // No structured error flag in the format — toolOk stays unset.
        toolOk: undefined,
        text: asString(payload.output) ?? "",
        line: row.line,
        at,
      });
    }
    // "reasoning" items and event_msg UI events are skipped.
  }
  return collector.buildResult(sessionId, file, opts);
}

/** History reader over codex rollout logs. */
export function createCodexHistoryReader(opts?: HistoryReaderOptions): HistoryReader {
  return {
    read: (sessionId, historyOpts) => read(sessionId, historyOpts, opts),
  };
}
