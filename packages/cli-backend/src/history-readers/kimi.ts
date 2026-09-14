/**
 * kimi.ts — history reader for kimi-code (`~/.kimi-code`).
 *
 * Layout: `~/.kimi-code/session_index.jsonl` maps
 * `{sessionId, sessionDir, workDir}`; the conversation lives in
 * `<sessionDir>/agents/main/wire.jsonl`. Fallback when the index misses:
 * scan `~/.kimi-code/sessions/<workspace>/` for a session dir named `<id>` or
 * ending `_<id>` (legacy `session_<uuid>` vs new `ses_<uuid>`), newest wins.
 *
 * wire.jsonl is a wire-protocol event stream, not a message log:
 *  - `context.append_message` → user/assistant entry from content text parts
 *    (assistant `think` parts are captured as `thinking`);
 *  - `context.append_loop_event` with `event.type`:
 *      - `content.part` with `part.type: "text"` → appended to the open
 *        assistant entry (consecutive text parts merge); `think` parts are
 *        captured as the open assistant entry's `thinking`;
 *      - `tool.call` `{toolCallId, name, args}` → tool entry (seals any open
 *        assistant entry);
 *      - `tool.result` `{toolCallId, result:{output, isError?}}` → merged by
 *        id, `toolOk = !isError` (absent isError means success);
 *  - everything else (usage.record, llm.request, config.update, …) is skipped;
 *  - `at` comes from the envelope `time` (unix ms) when present.
 *
 * Unknown session → rejects with AgentError("session_not_found").
 */

import * as path from "node:path";
import type { HistoryOptions, HistoryResult } from "@kagero/core";
import {
  argsToText,
  asNumber,
  asString,
  fileExists,
  HistoryCollector,
  type HistoryReader,
  type HistoryReaderOptions,
  homeRoot,
  isoFromMs,
  isRecord,
  isSafeSessionId,
  listSubdirs,
  makeEntry,
  newestPath,
  readJsonlRows,
  sessionNotFoundError,
  textFromContentParts,
  thinkingFromContentParts,
} from "./shared.js";

interface OpenAssistant {
  readonly parts: string[];
  thinking?: string | undefined;
  readonly line: number;
  readonly at?: string | undefined;
}

function kimiRoot(opts: HistoryReaderOptions | undefined): string {
  return path.join(homeRoot(opts), ".kimi-code");
}

async function findSessionDir(root: string, sessionId: string): Promise<string | undefined> {
  const indexFile = path.join(root, "session_index.jsonl");
  if (await fileExists(indexFile)) {
    for (const row of await readJsonlRows(indexFile)) {
      if (!isRecord(row.value)) continue;
      if (asString(row.value.sessionId) !== sessionId) continue;
      const dir = asString(row.value.sessionDir);
      if (dir !== undefined && (await fileExists(path.join(dir, "agents", "main", "wire.jsonl")))) {
        return dir;
      }
    }
  }
  // Fallback: scan workspace dirs for a session dir named after the id.
  const sessionsRoot = path.join(root, "sessions");
  const candidates: string[] = [];
  for (const workspace of await listSubdirs(sessionsRoot)) {
    const workspacePath = path.join(sessionsRoot, workspace);
    for (const name of await listSubdirs(workspacePath)) {
      if (name === sessionId || name.endsWith(`_${sessionId}`)) {
        candidates.push(path.join(workspacePath, name));
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
  if (!isSafeSessionId(sessionId)) throw sessionNotFoundError("kimi", sessionId);
  const dir = await findSessionDir(kimiRoot(readerOpts), sessionId);
  if (dir === undefined) throw sessionNotFoundError("kimi", sessionId);
  const file = path.join(dir, "agents", "main", "wire.jsonl");

  const collector = new HistoryCollector();
  let open: OpenAssistant | undefined;
  const sealAssistant = (): void => {
    if (open === undefined) return;
    collector.push(
      makeEntry({
        role: "assistant",
        text: open.parts.join("\n"),
        line: open.line,
        at: open.at,
        thinking: open.thinking,
      }),
    );
    open = undefined;
  };

  for (const row of await readJsonlRows(file)) {
    if (!isRecord(row.value)) continue;
    const type = asString(row.value.type);
    const timeMs = asNumber(row.value.time);
    const at = timeMs !== undefined ? isoFromMs(timeMs) : undefined;

    if (type === "context.append_message") {
      const message = isRecord(row.value.message) ? row.value.message : undefined;
      if (message === undefined) continue;
      const role = asString(message.role);
      const content = Array.isArray(message.content) ? message.content : [];
      const text = textFromContentParts(content);
      if (text === "") continue;
      if (role === "user" || role === "assistant") {
        const thinking = role === "assistant" ? thinkingFromContentParts(content) : undefined;
        sealAssistant();
        collector.push(makeEntry({ role, text, line: row.line, at, thinking }));
      }
    } else if (type === "context.append_loop_event") {
      const event = isRecord(row.value.event) ? row.value.event : undefined;
      if (event === undefined) continue;
      const eventType = asString(event.type);

      if (eventType === "content.part") {
        const part = isRecord(event.part) ? event.part : undefined;
        if (part === undefined) continue;
        const text = part.type === "text" ? asString(part.text) : undefined;
        if (text !== undefined) {
          if (open !== undefined) open.parts.push(text);
          else open = { parts: [text], line: row.line, at };
          continue;
        }
        const thought = thinkingFromContentParts([part]);
        if (thought === undefined) continue; // other part types are dropped
        if (open !== undefined) {
          open.thinking = open.thinking === undefined ? thought : `${open.thinking}\n${thought}`;
        } else {
          open = { parts: [], thinking: thought, line: row.line, at };
        }
      } else if (eventType === "tool.call") {
        sealAssistant();
        collector.pushTool(
          asString(event.toolCallId),
          makeEntry({
            role: "tool",
            text: argsToText(event.args),
            line: row.line,
            at,
            toolName: asString(event.name) ?? "unknown",
          }),
        );
      } else if (eventType === "tool.result") {
        const result = isRecord(event.result) ? event.result : undefined;
        const isError = result?.isError;
        const output = result?.output;
        collector.mergeOrPushToolResult({
          callId: asString(event.toolCallId),
          toolOk: typeof isError === "boolean" ? !isError : true,
          text:
            typeof output === "string" ? output : textFromContentParts(Array.isArray(output) ? output : []),
          line: row.line,
          at,
        });
      }
    }
    // All other wire events (usage, llm.request, config, interaction, …) are skipped.
  }
  sealAssistant();
  return collector.buildResult(sessionId, file, opts);
}

/** History reader over kimi-code wire logs. */
export function createKimiHistoryReader(opts?: HistoryReaderOptions): HistoryReader {
  return {
    read: (sessionId, historyOpts) => read(sessionId, historyOpts, opts),
  };
}
