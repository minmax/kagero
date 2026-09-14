/**
 * grok.ts — history reader for grok (`~/.grok/sessions`).
 *
 * Layout: `~/.grok/sessions/<percent-encoded-cwd>/<sessionId>/chat_history.jsonl`
 * (very long cwds fall back to `<slug>-<blake3hex16>` dirs, which cannot be
 * reversed — the lookup scans all project dirs for the session dir named
 * exactly after the id).
 *
 * File format: OpenAI-like rows, no timestamps (file order is the only order,
 * so `at` is always omitted):
 *  - `type: "system"` / `"user"` → system/user entries (`content` is a string
 *    or `[{"type":"text","text":...}]`);
 *  - `type: "assistant"` → assistant entry plus one tool entry per
 *    `tool_calls[]` item (`{id, name, arguments}` or `{id, function:{name,
 *    arguments}}`);
 *  - `type: "reasoning"` → skipped;
 *  - `type: "tool_result"` `{tool_call_id, content, status?}` → merged into
 *    its call entry by id; `toolOk` reflects `status` only when present
 *    (`"completed"` = ok), otherwise it stays unset;
 *  - `at` is never emitted (the format carries no per-row time).
 *
 * Unknown session → rejects with AgentError("session_not_found").
 */

import * as path from "node:path";
import type { HistoryOptions, HistoryResult } from "@kagero/core";
import {
  argsToText,
  asArray,
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
  readJsonlRows,
  sessionNotFoundError,
  textFromContentParts,
} from "./shared.js";

function sessionsRoot(opts: HistoryReaderOptions | undefined): string {
  return path.join(homeRoot(opts), ".grok", "sessions");
}

async function findHistoryFile(root: string, sessionId: string): Promise<string | undefined> {
  for (const project of await listSubdirs(root)) {
    const candidate = path.join(root, project, sessionId, "chat_history.jsonl");
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

/** Content is either a plain string or a list of `{type:"text",text}` parts. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return textFromContentParts(content);
  return "";
}

async function read(
  sessionId: string,
  opts: HistoryOptions | undefined,
  readerOpts: HistoryReaderOptions | undefined,
): Promise<HistoryResult> {
  if (!isSafeSessionId(sessionId)) throw sessionNotFoundError("grok", sessionId);
  const file = await findHistoryFile(sessionsRoot(readerOpts), sessionId);
  if (file === undefined) throw sessionNotFoundError("grok", sessionId);

  const collector = new HistoryCollector();
  let pendingThinking: string | undefined;
  for (const row of await readJsonlRows(file)) {
    if (!isRecord(row.value)) continue;
    const type = asString(row.value.type);

    if (type === "system" || type === "user") {
      const text = contentText(row.value.content);
      if (text !== "") collector.push(makeEntry({ role: type, text, line: row.line }));
      if (type === "user") pendingThinking = undefined;
    } else if (type === "assistant") {
      const text = contentText(row.value.content);
      if (text !== "" || pendingThinking !== undefined) {
        collector.push(makeEntry({ role: "assistant", text, line: row.line, thinking: pendingThinking }));
      }
      pendingThinking = undefined;
      const calls = Array.isArray(row.value.tool_calls) ? row.value.tool_calls : [];
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const fn = isRecord(call.function) ? call.function : undefined;
        const args = call.arguments ?? fn?.arguments;
        collector.pushTool(
          asString(call.id),
          makeEntry({
            role: "tool",
            text: argsToText(args),
            line: row.line,
            toolName: asString(call.name) ?? (fn === undefined ? undefined : asString(fn.name)) ?? "unknown",
          }),
        );
      }
    } else if (type === "tool_result") {
      const status = asString(row.value.status);
      collector.mergeOrPushToolResult({
        callId: asString(row.value.tool_call_id),
        toolOk: status === undefined ? undefined : status === "completed",
        text: contentText(row.value.content),
        line: row.line,
      });
    } else if (type === "reasoning") {
      // Buffered here, attached to the following assistant entry. Real 1.0.25
      // rows carry the distilled thought in `summary[]
      // ({type:"summary_text",text})`; raw CoT lives in encrypted_content and
      // is never shipped. The `content` fallback is forward-compat only.
      const summary = asArray(row.value.summary);
      const thought =
        summary
          .map((part) => (isRecord(part) && part["type"] === "summary_text" ? asString(part["text"]) : undefined))
          .filter((t): t is string => t !== undefined && t !== "")
          .join("\n") || contentText(row.value.content);
      if (thought !== "") {
        pendingThinking = pendingThinking === undefined ? thought : `${pendingThinking}\n${thought}`;
      }
    }
    // Any other row type is skipped.
  }
  return collector.buildResult(sessionId, file, opts);
}

/** History reader over grok chat logs. */
export function createGrokHistoryReader(opts?: HistoryReaderOptions): HistoryReader {
  return {
    read: (sessionId, historyOpts) => read(sessionId, historyOpts, opts),
  };
}
