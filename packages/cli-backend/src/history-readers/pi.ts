/**
 * pi.ts — history reader for pi (`~/.pi/agent/sessions`).
 *
 * Layout: `~/.pi/agent/sessions/--<enc-cwd>--/<ISO-ts>_<sessionId>.jsonl`
 * (enc-cwd: leading slash stripped, `/\\:` → `-`, dots kept). The session id
 * is the file-name suffix after the last `_`, so the lookup scans every
 * encoded-cwd directory for `*_<id>.jsonl` and takes the newest match.
 *
 * File format: one JSON event per line (`session`, `model_change`, …,
 * `message`). Only `message` events become entries:
 *  - `role: "user"` → user entry (text parts);
 *  - `role: "assistant"` → assistant entry (text parts; thinking dropped) and
 *    one tool entry per `{"type":"toolCall","id","name","arguments"}` block;
 *  - `role: "toolResult"` → merged into its call entry by `toolCallId`
 *    (`toolOk = !isError`), or a standalone tool record when the call was
 *    not seen;
 *  - `at` comes from the event's top-level ISO `timestamp`.
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
  listDirectory,
  listSubdirs,
  makeEntry,
  newestPath,
  readJsonlRows,
  sessionNotFoundError,
  textFromContentParts,
  thinkingFromContentParts,
} from "./shared.js";

function sessionsRoot(opts: HistoryReaderOptions | undefined): string {
  return path.join(homeRoot(opts), ".pi", "agent", "sessions");
}

async function findSessionFile(root: string, sessionId: string): Promise<string | undefined> {
  const suffix = `_${sessionId}.jsonl`;
  const candidates: string[] = [];
  for (const dir of await listSubdirs(root)) {
    const dirPath = path.join(root, dir);
    for (const dirent of await listDirectory(dirPath)) {
      if (dirent.isFile() && dirent.name.endsWith(suffix)) {
        candidates.push(path.join(dirPath, dirent.name));
      }
    }
  }
  return await newestPath(candidates);
}

async function read(
  sessionId: string,
  opts: HistoryOptions | undefined,
  readerOpts: HistoryReaderOptions | undefined,
): Promise<HistoryResult> {
  if (!isSafeSessionId(sessionId)) throw sessionNotFoundError("pi", sessionId);
  const file = await findSessionFile(sessionsRoot(readerOpts), sessionId);
  if (file === undefined) throw sessionNotFoundError("pi", sessionId);

  const collector = new HistoryCollector();
  for (const row of await readJsonlRows(file)) {
    if (!isRecord(row.value) || row.value.type !== "message") continue;
    const message = isRecord(row.value.message) ? row.value.message : undefined;
    if (message === undefined) continue;
    const at = asString(row.value.timestamp);
    const content = Array.isArray(message.content) ? message.content : [];
    const role = asString(message.role);

    if (role === "user") {
      const text = textFromContentParts(content);
      if (text !== "") collector.push(makeEntry({ role: "user", text, line: row.line, at }));
    } else if (role === "assistant") {
      const text = textFromContentParts(content);
      const thinking = thinkingFromContentParts(content);
      if (text !== "" || thinking !== undefined) {
        collector.push(makeEntry({ role: "assistant", text, line: row.line, at, thinking }));
      }
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
  }
  return collector.buildResult(sessionId, file, opts);
}

/** History reader over pi session logs. */
export function createPiHistoryReader(opts?: HistoryReaderOptions): HistoryReader {
  return {
    read: (sessionId, historyOpts) => read(sessionId, historyOpts, opts),
  };
}
