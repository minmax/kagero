/**
 * codex-jsonl.ts — parser for `codex exec --json` NDJSON events.
 *
 * Wire facts (codex-cli 0.153.x, exec_events.rs, verified live in
 * docs/reviews/codex-cli-interface.md §1.3):
 *   {"type":"thread.started","thread_id":"<uuid>"}     — first event = session id
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *   {"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,
 *        "cache_write_input_tokens":…,"output_tokens":…,
 *        "reasoning_output_tokens":…}}                 — cumulative for the thread
 *   {"type":"turn.failed","error":{"message":"…"}}     — the turn failed
 *
 * The final assistant text is the LAST `item.completed` agent_message — never
 * the raw stdout, never reasoning/command items. `turn.failed` throws
 * AgentError("cli_error"). The JSONL carries NO factual model id, so
 * `modelId` stays undefined here and the backend echoes the requested one
 * (`modelSource: "requested"`). Duration is not in the stream either — the
 * backend measures it. Without a `turn.completed` the run is `partial: true`.
 */

import type { UsageTelemetry } from "@kagero/core";
import { AgentError } from "@kagero/core";
import type { ParsedRun } from "../spec.js";

type RpcRecord = Record<string, unknown>;

/** Incremental parser callback: fired per agent_message text, in order. */
export type OnText = (text: string) => void;

export interface CodexJsonlOptions {
  /** Fired per agent_message text as it arrives. */
  readonly onText?: OnText;
}

function asRecord(value: unknown): RpcRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RpcRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readUsage(value: unknown): UsageTelemetry | undefined {
  const usage = asRecord(value);
  if (usage === null) return undefined;
  const out: Record<string, number> = {};
  const input = asFiniteNumber(usage["input_tokens"]);
  const output = asFiniteNumber(usage["output_tokens"]);
  const cacheRead = asFiniteNumber(usage["cached_input_tokens"]);
  const cacheWrite = asFiniteNumber(usage["cache_write_input_tokens"]);
  const reasoning = asFiniteNumber(usage["reasoning_output_tokens"]);
  if (input !== undefined) out["inputTokens"] = input;
  if (output !== undefined) out["outputTokens"] = output;
  if (cacheRead !== undefined) out["cacheReadTokens"] = cacheRead;
  if (cacheWrite !== undefined) out["cacheWriteTokens"] = cacheWrite;
  if (reasoning !== undefined) out["reasoningTokens"] = reasoning;
  return Object.keys(out).length > 0 ? (out as UsageTelemetry) : undefined;
}

interface FoldState {
  onText: OnText | undefined;
  threadId: string | undefined;
  lastMessage: string | undefined;
  usage: UsageTelemetry | undefined;
  sawTurnEnd: boolean;
}

function foldLine(state: FoldState, line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // not an event line — stdout noise, skipped
  }
  const event = asRecord(parsed);
  if (event === null) return;

  switch (event["type"]) {
    case "thread.started": {
      state.threadId ??= asString(event["thread_id"]);
      return;
    }
    case "item.completed": {
      const item = asRecord(event["item"]);
      if (item === null || item["type"] !== "agent_message") return;
      const text = asString(item["text"]);
      if (text !== undefined) {
        state.lastMessage = text;
        state.onText?.(text);
      }
      return;
    }
    case "turn.completed": {
      state.sawTurnEnd = true;
      state.usage = readUsage(event["usage"]) ?? state.usage;
      return;
    }
    case "turn.failed": {
      state.sawTurnEnd = true;
      const error = asRecord(event["error"]);
      throw new AgentError(
        "cli_error",
        asString(error?.["message"]) ?? "codex reported turn.failed without a message",
        "tool",
        { sessionId: state.threadId },
      );
    }
    default:
      return; // turn.started, item.started/updated, error items — not the answer
  }
}

/**
 * Incremental variant: feed stdout line by line, get the ParsedRun at the end.
 */
export function codexJsonlStream(opts: CodexJsonlOptions = {}): {
  pushLine(line: string): void;
  finish(): ParsedRun;
} {
  const state: FoldState = {
    onText: opts.onText,
    threadId: undefined,
    lastMessage: undefined,
    usage: undefined,
    sawTurnEnd: false,
  };
  return {
    pushLine(line: string): void {
      const trimmed = line.trim();
      if (trimmed !== "") foldLine(state, trimmed);
    },
    finish(): ParsedRun {
      const partial = state.sawTurnEnd ? undefined : true;
      return {
        text: state.lastMessage ?? "",
        ...(state.threadId === undefined ? {} : { sessionId: state.threadId }),
        ...(state.usage === undefined ? {} : { usage: state.usage }),
        ...(partial === undefined ? {} : { partial }),
      };
    },
  };
}

/** Parse one `codex exec --json` run's stdout into a ParsedRun. */
export function parseCodexJsonl(stdout: string, opts: CodexJsonlOptions = {}): ParsedRun {
  const stream = codexJsonlStream(opts);
  for (const line of stdout.split("\n")) stream.pushLine(line);
  return stream.finish();
}
