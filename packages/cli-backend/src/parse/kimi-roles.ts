/**
 * kimi-roles.ts — parser for kimi's print stream (`kimi -p --output-format
 * stream-json`). This is NOT the claude-lineage envelope family: kimi prints
 * NDJSON role-lines (verified against the proven kimi-cli-mcp print transport,
 * src/transport/print.ts + test/fixtures/fake-kimi.mjs, CLI 0.41.x):
 *
 *   {"role":"meta","type":"system.version","version":"0.41.0"}
 *   {"role":"meta","type":"session.resume_hint","session_id":"…",
 *    "command":"kimi -S …","content":"To resume this session: kimi -S …"}
 *   {"role":"assistant","content":"…plain text…",
 *    "tool_calls":[{"type":"function","id":"…","function":{"name":"…",
 *      "arguments":"{…json string…}"}}]}
 *   {"role":"tool","tool_call_id":"…","content":"…"}
 *
 * Ported semantics (from kimi-cli-mcp):
 *  - There is NO result envelope in this format. The last assistant `content`
 *    is the answer; thinking is dropped by the CLI, tool results (`role:
 *    "tool"`) are never the answer. An assistant line carrying only
 *    `tool_calls` must not replace the remembered text.
 *  - The session is named by the `meta` `session.resume_hint` line
 *    (`session_id`); a later hint overwrites an earlier one, like the
 *    reference transport. A stream without one yields no sessionId — the
 *    backend decides whether that is a failure, the parser does not guess.
 *  - Usage and model are not part of the print contract (the reference reads
 *    the model from its own override, never from the stream). When kimi does
 *    attach a kimi-shaped `usage` {input_tokens, output_tokens} to an
 *    assistant line or a `model` string to any line, they are reported;
 *    nothing is fabricated. Usage is summed across assistant lines.
 *  - Fail-closed: non-JSON lines (stdout noise), records without a string
 *    `role`, unknown roles, and unknown `meta` types (`system.version`,
 *    anything else) are skipped silently — their semantics stay the CLI's.
 */

import type { UsageTelemetry } from "@kagero/core";
import type { ParsedRun } from "../spec.js";

type RpcRecord = Record<string, unknown>;

/** Incremental parser callback: fired per assistant text, in order. */
export type OnText = (text: string) => void;

export interface KimiRolesOptions {
  /** Fired per assistant text as it arrives. */
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

/** Kimi usage names (`input_tokens` / `output_tokens`), summed across lines. */
function readUsage(value: unknown): UsageTelemetry | undefined {
  const usage = asRecord(value);
  if (usage === null) return undefined;
  const input = asFiniteNumber(usage["input_tokens"]);
  const output = asFiniteNumber(usage["output_tokens"]);
  if (input === undefined && output === undefined) return undefined;
  const out: Record<string, number> = {};
  if (input !== undefined) out["inputTokens"] = input;
  if (output !== undefined) out["outputTokens"] = output;
  return out as UsageTelemetry;
}

interface FoldState {
  onText: OnText | undefined;
  sessionId: string | undefined;
  lastAssistantText: string | undefined;
  model: string | undefined;
  usage: UsageTelemetry | undefined;
  sawAssistantText: boolean;
}

function foldLine(state: FoldState, line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // not a message line — stdout noise, skipped
  }
  const message = asRecord(parsed);
  if (message === null) return;

  const model = asString(message["model"]);
  if (model !== undefined) state.model = model;

  switch (message["role"]) {
    case "meta": {
      if (asString(message["type"]) !== "session.resume_hint") return; // system.version, … — not the session
      state.sessionId = asString(message["session_id"]) ?? state.sessionId;
      return;
    }
    case "assistant": {
      const text = asString(message["content"]);
      if (text === undefined) return; // tool_calls-only line — never replaces the answer
      state.lastAssistantText = text;
      state.sawAssistantText = true;
      state.onText?.(text);
      const usage = readUsage(message["usage"]);
      if (usage !== undefined) {
        state.usage = {
          inputTokens: (state.usage?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
          outputTokens: (state.usage?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
        };
      }
      return;
    }
    default:
      return; // tool results (role "tool") and unknown roles — never the answer
  }
}

/**
 * Incremental variant: feed stdout line by line, get the ParsedRun at the end.
 * The format has no terminal envelope, so a stream that produced assistant
 * text is complete; a stream without any is `partial: true` — nothing stood in
 * for the answer.
 */
export function kimiRolesStream(opts: KimiRolesOptions = {}): {
  pushLine(line: string): void;
  finish(): ParsedRun;
} {
  const state: FoldState = {
    onText: opts.onText,
    sessionId: undefined,
    lastAssistantText: undefined,
    model: undefined,
    usage: undefined,
    sawAssistantText: false,
  };
  return {
    pushLine(line: string): void {
      const trimmed = line.trim();
      if (trimmed !== "") foldLine(state, trimmed);
    },
    finish(): ParsedRun {
      return {
        text: state.lastAssistantText ?? "",
        ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
        ...(state.model === undefined ? {} : { modelId: state.model }),
        ...(state.usage === undefined ? {} : { usage: state.usage }),
        ...(state.sawAssistantText ? {} : { partial: true }),
      };
    },
  };
}

/** Parse one kimi print run's stdout (the whole stream) into a ParsedRun. */
export function parseKimiRoles(stdout: string, opts: KimiRolesOptions = {}): ParsedRun {
  const stream = kimiRolesStream(opts);
  for (const line of stdout.split("\n")) stream.pushLine(line);
  return stream.finish();
}
