/**
 * claude.ts — history reader for claude-code (`~/.claude/projects`).
 *
 * Layout: `~/.claude/projects/<enc-cwd>/<sessionId>.jsonl` (enc-cwd: every
 * non-`[a-zA-Z0-9]` char → `-`, not decodable — the lookup scans all project
 * dirs for an exactly named file). The name match is STRICTLY
 * `<sessionId>.jsonl`: project dirs also hold foreign sidecar files such as
 * `<id>.jsonl.pass1.jsonl`, which must never be picked up.
 *
 * File format: claude rows `{type, uuid, timestamp, message, isSidechain, …}`:
 *  - `type: "user"` → user entry from a string content or `text` blocks;
 *    `tool_result` blocks in the same row merge into their call entry by
 *    `tool_use_id` (`toolOk = !is_error`), or become standalone tool records;
 *  - `type: "assistant"` → assistant entry from `text` blocks (`thinking`
 *    dropped) plus one tool entry per `tool_use {id, name, input}` block;
 *  - other row types (`system`, `summary`, `last-prompt`, …) are skipped;
 *  - sidechain (subagent) rows are kept — they are part of the conversation;
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
  sessionNotFoundError,
  textFromContentParts,
} from "./shared.js";

function projectsRoot(opts: HistoryReaderOptions | undefined): string {
  return path.join(homeRoot(opts), ".claude", "projects");
}

async function findSessionFile(root: string, sessionId: string): Promise<string | undefined> {
  const fileName = `${sessionId}.jsonl`;
  const candidates: string[] = [];
  for (const project of await listSubdirs(root)) {
    const candidate = path.join(root, project, fileName);
    if (await fileExists(candidate)) candidates.push(candidate);
  }
  return await newestPath(candidates);
}

/** Tool-result payload: string content or a list of text parts. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return textFromContentParts(content);
  return "";
}

async function read(
  sessionId: string,
  opts: HistoryOptions | undefined,
  readerOpts: HistoryReaderOptions | undefined,
): Promise<HistoryResult> {
  if (!isSafeSessionId(sessionId)) throw sessionNotFoundError("claude", sessionId);
  const file = await findSessionFile(projectsRoot(readerOpts), sessionId);
  if (file === undefined) throw sessionNotFoundError("claude", sessionId);

  const collector = new HistoryCollector();
  for (const row of await readJsonlRows(file)) {
    if (!isRecord(row.value)) continue;
    const type = asString(row.value.type);
    const message = isRecord(row.value.message) ? row.value.message : undefined;
    if ((type !== "user" && type !== "assistant") || message === undefined) continue;
    const at = asString(row.value.timestamp);
    const content = message.content;
    const blocks = Array.isArray(content) ? content : [];

    if (type === "user") {
      const texts: string[] = [];
      for (const block of blocks) {
        if (!isRecord(block)) continue;
        if (block.type === "text") {
          const text = asString(block.text);
          if (text !== undefined) texts.push(text);
        } else if (block.type === "tool_result") {
          const isError = block.is_error;
          collector.mergeOrPushToolResult({
            callId: asString(block.tool_use_id),
            toolOk: typeof isError === "boolean" ? !isError : undefined,
            text: resultText(block.content),
            line: row.line,
            at,
          });
        }
      }
      const text = typeof content === "string" ? content : texts.join("\n");
      if (text !== "") collector.push(makeEntry({ role: "user", text, line: row.line, at }));
    } else {
      const texts: string[] = [];
      const toolEntries: { id: string | undefined; block: Record<string, unknown> }[] = [];
      for (const block of blocks) {
        if (!isRecord(block)) continue;
        if (block.type === "text") {
          const text = asString(block.text);
          if (text !== undefined) texts.push(text);
        } else if (block.type === "tool_use") {
          toolEntries.push({ id: asString(block.id), block });
        }
        // "thinking" blocks are dropped.
      }
      const text = texts.join("\n");
      if (text !== "") collector.push(makeEntry({ role: "assistant", text, line: row.line, at }));
      for (const { id, block } of toolEntries) {
        collector.pushTool(
          id,
          makeEntry({
            role: "tool",
            text: argsToText(block.input),
            line: row.line,
            at,
            toolName: asString(block.name) ?? "unknown",
          }),
        );
      }
    }
  }
  return collector.buildResult(sessionId, file, opts);
}

/** History reader over claude-code session logs. */
export function createClaudeHistoryReader(opts?: HistoryReaderOptions): HistoryReader {
  return {
    read: (sessionId, historyOpts) => read(sessionId, historyOpts, opts),
  };
}
