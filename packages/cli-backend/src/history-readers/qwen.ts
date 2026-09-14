/**
 * qwen.ts — history reader for qwen-code (`~/.qwen/projects`).
 *
 * Layout: `~/.qwen/projects/<enc-cwd>/chats/<sessionId>.jsonl` (enc-cwd:
 * every non-`[a-zA-Z0-9]` char → `-`, so it is not decodable — the lookup
 * scans all project dirs for an exactly named file, newest wins).
 *
 * File format: claude-like rows, gemini-style content:
 *  - `type: "user"` → user entry (`message.parts` text parts);
 *  - `type: "assistant"` (`message.role: "model"`) → assistant entry plus one
 *    tool entry per `{"functionCall":{"id","name","args"}}` part;
 *  - `type: "tool_result"` → `functionResponse` parts merged into their call
 *    entry by id, or a standalone tool record; `toolOk` is set only when the
 *    response carries an explicit `isError`/`error` field;
 *  - `type: "system"` rows are service records and are skipped;
 *  - `at` comes from the row's ISO `timestamp`.
 *
 * Unknown session → rejects with AgentError("session_not_found").
 */

import * as path from "node:path";
import type { HistoryOptions, HistoryResult } from "@kagero/core";
import {
  argsToText,
  asString,
  fileExists,
  HistoryCollector,
  type HistoryReader,
  type HistoryReaderOptions,
  homeRoot,
  isRecord,
  isSafeSessionId,
  listSubdirs,
  makeEntry,
  newestPath,
  readJsonlRows,
  recordAt,
  sessionNotFoundError,
  textFromContentParts,
  thinkingFromContentParts,
} from "./shared.js";

function projectsRoot(opts: HistoryReaderOptions | undefined): string {
  return path.join(homeRoot(opts), ".qwen", "projects");
}

async function findSessionFile(root: string, sessionId: string): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const project of await listSubdirs(root)) {
    const candidate = path.join(root, project, "chats", `${sessionId}.jsonl`);
    if (await fileExists(candidate)) candidates.push(candidate);
  }
  return await newestPath(candidates);
}

/** Extract toolOk only from explicit error markers; never fabricate one. */
function toolOkFromResponse(response: unknown): boolean | undefined {
  if (!isRecord(response)) return undefined;
  const isError = response.isError;
  if (typeof isError === "boolean") return !isError;
  return response.error === undefined || response.error === null ? undefined : false;
}

async function read(
  sessionId: string,
  opts: HistoryOptions | undefined,
  readerOpts: HistoryReaderOptions | undefined,
): Promise<HistoryResult> {
  if (!isSafeSessionId(sessionId)) throw sessionNotFoundError("qwen", sessionId);
  const file = await findSessionFile(projectsRoot(readerOpts), sessionId);
  if (file === undefined) throw sessionNotFoundError("qwen", sessionId);

  const collector = new HistoryCollector();
  for (const row of await readJsonlRows(file)) {
    if (!isRecord(row.value)) continue;
    const type = asString(row.value.type);
    const message = isRecord(row.value.message) ? row.value.message : undefined;
    if (type === undefined || message === undefined) continue;
    const at = asString(row.value.timestamp);
    const parts = Array.isArray(message.parts) ? message.parts : [];

    if (type === "user") {
      const text = textFromContentParts(parts);
      if (text !== "") collector.push(makeEntry({ role: "user", text, line: row.line, at }));
    } else if (type === "assistant") {
      const text = textFromContentParts(parts);
      const thinking = thinkingFromContentParts(parts);
      if (text !== "" || thinking !== undefined) {
        collector.push(makeEntry({ role: "assistant", text, line: row.line, at, thinking }));
      }
      for (const part of parts) {
        const call = recordAt(part, "functionCall");
        if (call === undefined) continue;
        collector.pushTool(
          asString(call.id),
          makeEntry({
            role: "tool",
            text: argsToText(call.args),
            line: row.line,
            at,
            toolName: asString(call.name) ?? "unknown",
          }),
        );
      }
    } else if (type === "tool_result") {
      for (const part of parts) {
        const response = recordAt(part, "functionResponse");
        if (response === undefined) continue;
        const result = response.response;
        collector.mergeOrPushToolResult({
          callId: asString(response.id),
          toolOk: toolOkFromResponse(result),
          text: argsToText(isRecord(result) ? result.output : undefined),
          line: row.line,
          at,
          toolName: asString(response.name),
        });
      }
    }
    // "system" rows (model switches and other service records) are skipped.
  }
  return collector.buildResult(sessionId, file, opts);
}

/** History reader over qwen-code session logs. */
export function createQwenHistoryReader(opts?: HistoryReaderOptions): HistoryReader {
  return {
    read: (sessionId, historyOpts) => read(sessionId, historyOpts, opts),
  };
}
