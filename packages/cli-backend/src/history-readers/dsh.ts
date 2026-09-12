/**
 * dsh.ts — history reader for DeepSeek Harness (`~/.dsh`).
 *
 * Layout: `~/.dsh/sessions/<cwd-slug>/<session-id>/session.v3.jsonl.zstd`
 * (the slug dirs look like `--Users-x-y--`, `/tmp` → `--private-tmp--`; the
 * session dir name matches the id, e.g. `session-<uuid>` for headless runs).
 * The lookup scans the slug dirs for the session dir — the slug cannot be
 * derived from the id alone.
 *
 * The log is MULTI-FRAME zstd: every append writes its own zstd frame
 * (concatenated frames, each starting with the magic 0x28B52FFD; skippable
 * frames carry the same magic). `zlib.zstdDecompressSync` on the whole file
 * yields ONLY the first frame — so the file is split on the magic and each
 * frame is decompressed separately, then the pieces are concatenated back
 * into the JSONL stream. Requires node ≥ 22.16 (zstd in node:zlib); anything
 * older rejects with a clear AgentError, never a silent empty history.
 *
 * Event model (session.v3, observed live; see reviews/dsh-real-interface.md):
 *  - `session` header, `turn/*`, `step/*`, `request/*`, `session/title`,
 *    `sandbox/*`, `approval/*`, `permission/*`, `agent/inbox/spliced` and
 *    `tool/ptc-*` rows are metadata — no entries;
 *  - `system/message` → role "system" (the harness system prompt);
 *  - `user/message` with `data.source.kind === "user"` → role "user";
 *    other sources (plugin, agent-instructions, skill-catalog) are per-boot
 *    harness plumbing — skipped, the full log carries them;
 *  - `assistant/message` → role "assistant" from the text content parts
 *    (reasoning and tool-call parts are dropped — tool calls have their own
 *    `tool/call` rows below);
 *  - `tool/call` {callId, name, arguments} → role "tool" entry;
 *  - `tool/result` {message.source.callId, message.content[].tool-result
 *    {isError, content}} → merged into the call entry by id, `toolOk =
 *    !isError`; orphan results become standalone tool records;
 *  - `at` from the row `time` (unix ms).
 *
 * `fullLog.line` numbers lines of the DECOMPRESSED JSONL stream; `file` is
 * the .zstd log itself. Unknown session → AgentError("session_not_found");
 * an existing but undecodable log → AgentError("cli_error").
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { HistoryOptions, HistoryResult } from "@kagero/core";
import { AgentError } from "@kagero/core";
import {
  argsToText,
  asArray,
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
  type JsonlRow,
  listSubdirs,
  makeEntry,
  newestPath,
  recordAt,
  sessionNotFoundError,
  textFromContentParts,
} from "./shared.js";

/** zstd frame magic (little-endian 0xFD2FB528) — every frame starts with it. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function dshRoot(opts: HistoryReaderOptions | undefined): string {
  return path.join(homeRoot(opts), ".dsh");
}

async function findSessionFile(root: string, sessionId: string): Promise<string | undefined> {
  const sessionsRoot = path.join(root, "sessions");
  const candidates: string[] = [];
  for (const slug of await listSubdirs(sessionsRoot)) {
    const slugPath = path.join(sessionsRoot, slug);
    for (const name of await listSubdirs(slugPath)) {
      if (name !== sessionId) continue;
      const file = path.join(slugPath, name, "session.v3.jsonl.zstd");
      if (await fileExists(file)) candidates.push(file);
    }
  }
  return await newestPath(candidates);
}

/** Split a concatenated zstd stream into its frames (skippables included). */
export function splitZstdFrames(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let index = buf.indexOf(ZSTD_MAGIC);
  while (index !== -1) {
    const next = buf.indexOf(ZSTD_MAGIC, index + ZSTD_MAGIC.length);
    frames.push(next === -1 ? buf.subarray(index) : buf.subarray(index, next));
    index = next;
  }
  return frames;
}

/** Multi-frame zstd → the original JSONL text; single-frame files degrade fine. */
export function decompressSessionLog(file: string, buf: Buffer): string {
  if (typeof zstdDecompressSync !== "function") {
    throw new AgentError(
      "cli_error",
      `dsh history needs node >= 22.16 (node:zlib zstd) to decompress ${file}`,
      "tool",
      {},
    );
  }
  const frames = splitZstdFrames(buf);
  if (frames.length === 0) {
    throw new AgentError("cli_error", `dsh session log is not a zstd stream: ${file}`, "tool", {});
  }
  try {
    let text = "";
    for (const frame of frames) text += zstdDecompressSync(frame).toString("utf8");
    return text;
  } catch (err) {
    throw new AgentError(
      "cli_error",
      `dsh session log failed to decompress: ${file}: ${err instanceof Error ? err.message : String(err)}`,
      "tool",
      {},
    );
  }
}

/** Parse the decompressed stream; blank and unparseable lines are skipped. */
function parseJsonl(text: string): JsonlRow[] {
  const rows: JsonlRow[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    try {
      rows.push({ line: i + 1, value: JSON.parse(line) as unknown });
    } catch {
      // Corrupt line: skip it rather than losing the whole history.
    }
  }
  return rows;
}

/** Tool-result parts: `[{type:"tool-result", isError?, content:[{type:"text",…}]}]`. */
function toolResultParts(value: unknown): { readonly text: string; readonly isError?: boolean | undefined } {
  let text = "";
  let isError: boolean | undefined;
  for (const part of asArray(value)) {
    if (!isRecord(part) || part.type !== "tool-result") continue;
    if (typeof part.isError === "boolean") isError = part.isError;
    const partText = textFromContentParts(asArray(part.content));
    if (partText !== "") text = text === "" ? partText : `${text}\n${partText}`;
  }
  return { text, isError };
}

async function read(
  sessionId: string,
  opts: HistoryOptions | undefined,
  readerOpts: HistoryReaderOptions | undefined,
): Promise<HistoryResult> {
  if (!isSafeSessionId(sessionId)) throw sessionNotFoundError("dsh", sessionId);
  const root = dshRoot(readerOpts);
  const file = await findSessionFile(root, sessionId);
  if (file === undefined) throw sessionNotFoundError("dsh", sessionId);

  const buf = await readFile(file);
  const rows = parseJsonl(decompressSessionLog(file, buf));

  const collector = new HistoryCollector();
  for (const row of rows) {
    if (!isRecord(row.value)) continue;
    const type = asString(row.value.type);
    const data = recordAt(row.value, "data");
    const timeMs = asNumber(row.value.time);
    const at = timeMs !== undefined ? isoFromMs(timeMs) : undefined;

    if (type === "system/message") {
      const text = textFromContentParts(asArray(recordAt(data, "message")?.content));
      if (text === "") continue;
      collector.push(makeEntry({ role: "system", text, line: row.line, at }));
    } else if (type === "user/message") {
      // Only the human turn is conversation; plugin/agent-instructions/
      // skill-catalog injections are harness plumbing — skipped.
      if (asString(recordAt(data, "source")?.kind) !== "user") continue;
      const text = textFromContentParts(asArray(data?.content));
      if (text === "") continue;
      collector.push(makeEntry({ role: "user", text, line: row.line, at }));
    } else if (type === "assistant/message") {
      // text parts only: reasoning is dropped, tool-call parts have dedicated
      // `tool/call` rows and would otherwise double as entries.
      const text = textFromContentParts(asArray(recordAt(data, "message")?.content));
      if (text === "") continue;
      collector.push(makeEntry({ role: "assistant", text, line: row.line, at }));
    } else if (type === "tool/call") {
      collector.pushTool(
        asString(data?.callId),
        makeEntry({
          role: "tool",
          text: argsToText(data?.arguments),
          line: row.line,
          at,
          toolName: asString(data?.name) ?? "unknown",
        }),
      );
    } else if (type === "tool/result") {
      const message = recordAt(data, "message");
      const result = toolResultParts(message?.content);
      collector.mergeOrPushToolResult({
        callId: asString(recordAt(message, "source")?.callId),
        toolOk: result.isError === undefined ? undefined : !result.isError,
        text: result.text,
        line: row.line,
        at,
      });
    }
    // Every other row kind is session metadata — skipped (see header).
  }
  return collector.buildResult(sessionId, file, opts);
}

/** History reader over dsh multi-frame zstd session logs. */
export function createDshHistoryReader(opts?: HistoryReaderOptions): HistoryReader {
  return {
    read: (sessionId, historyOpts) => read(sessionId, historyOpts, opts),
  };
}
