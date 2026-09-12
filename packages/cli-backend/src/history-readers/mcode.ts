/**
 * mcode.ts — history reader for MiniMax Code (`~/.minimax/v2/sessions`).
 *
 * Layout: `~/.minimax/v2/sessions/YYYY/MM/DD/<HH-mm-ss-fff>-session_<id>/`
 * where `<id>` is the base64url (unpadded) encoding of the sessionId
 * (ASCII ids are identical in plain base64). The lookup walks the date tree
 * and decodes each `-session_` directory name back to compare with the
 * requested id, so both encodings match; newest wins.
 *
 * messages.jsonl rows are pi-like: `{message_id, turn_id, message}` with
 *  - `role: "user"` → user entry (text parts);
 *  - `role: "assistant"` → assistant entry (text parts; thinking dropped) plus
 *    one tool entry per `{"type":"toolCall","id","name","arguments"}` block;
 *  - `role: "toolResult"` → merged into its call entry by `toolCallId`
 *    (`toolOk = !isError`), or a standalone tool record;
 *  - `role: "custom"` → skipped (internal service records);
 *  - `at` comes from `message.timestamp` (unix ms) when present.
 *
 * Unknown session → rejects with AgentError("session_not_found").
 */

import * as path from "node:path";
import type { HistoryOptions, HistoryResult } from "@kagero/core";
import {
  argsToText,
  asNumber,
  asString,
  HistoryCollector,
  type HistoryReader,
  type HistoryReaderOptions,
  homeRoot,
  isoFromMs,
  isRecord,
  isSafeSessionId,
  makeEntry,
  newestPath,
  readJsonlRows,
  sessionNotFoundError,
  textFromContentParts,
  walkDirs,
} from "./shared.js";

function sessionsRoot(opts: HistoryReaderOptions | undefined): string {
  return path.join(homeRoot(opts), ".minimax", "v2", "sessions");
}

/** Decode a directory-name payload back to the session id (base64url or base64). */
function decodeIdSegment(segment: string): string {
  return Buffer.from(segment, "base64url").toString("utf8");
}

async function findSessionDir(root: string, sessionId: string): Promise<string | undefined> {
  const expectedSuffix = `-session_${Buffer.from(sessionId, "utf8").toString("base64url")}`;
  const candidates: string[] = [];
  for (const dir of await walkDirs(root, 4)) {
    const name = path.basename(dir);
    if (name === expectedSuffix) {
      candidates.push(dir);
      continue;
    }
    const marker = name.indexOf("-session_");
    if (marker === -1) continue;
    if (decodeIdSegment(name.slice(marker + "-session_".length)) === sessionId) candidates.push(dir);
  }
  return await newestPath(candidates);
}

async function read(
  sessionId: string,
  opts: HistoryOptions | undefined,
  readerOpts: HistoryReaderOptions | undefined,
): Promise<HistoryResult> {
  if (!isSafeSessionId(sessionId)) throw sessionNotFoundError("mcode", sessionId);
  const dir = await findSessionDir(sessionsRoot(readerOpts), sessionId);
  if (dir === undefined) throw sessionNotFoundError("mcode", sessionId);
  const file = path.join(dir, "messages.jsonl");

  const collector = new HistoryCollector();
  for (const row of await readJsonlRows(file)) {
    const message = isRecord(row.value) && isRecord(row.value.message) ? row.value.message : undefined;
    if (message === undefined) continue;
    const role = asString(message.role);
    const content = Array.isArray(message.content) ? message.content : [];
    const timeMs = asNumber(message.timestamp);
    const at = timeMs !== undefined ? isoFromMs(timeMs) : undefined;

    if (role === "user") {
      const text = textFromContentParts(content);
      if (text !== "") collector.push(makeEntry({ role: "user", text, line: row.line, at }));
    } else if (role === "assistant") {
      const text = textFromContentParts(content);
      if (text !== "") collector.push(makeEntry({ role: "assistant", text, line: row.line, at }));
      for (const part of content) {
        if (!isRecord(part) || part.type !== "toolCall") continue;
        collector.pushTool(
          asString(part.id),
          makeEntry({
            role: "tool",
            text: argsToText(part.arguments),
            line: row.line,
            at,
            toolName: asString(part.name) ?? "unknown",
          }),
        );
      }
    } else if (role === "toolResult") {
      collector.mergeOrPushToolResult({
        callId: asString(message.toolCallId),
        toolOk: message.isError === undefined ? undefined : message.isError !== true,
        text: textFromContentParts(content),
        line: row.line,
        at,
        toolName: asString(message.toolName),
      });
    }
    // "custom" rows (background tasks and other internals) are skipped.
  }
  return collector.buildResult(sessionId, file, opts);
}

/** History reader over MiniMax Code (mcode) session logs. */
export function createMcodeHistoryReader(opts?: HistoryReaderOptions): HistoryReader {
  return {
    read: (sessionId, historyOpts) => read(sessionId, historyOpts, opts),
  };
}
