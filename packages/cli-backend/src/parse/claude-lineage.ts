/**
 * claude-lineage.ts — ONE parser for the stream-json envelope family shared by
 * the claude lineage of CLIs (claude, qwen, grok, kimi, mcode).
 *
 * Every one of them prints NDJSON envelopes of the same shape (verified against
 * the proven parsers in kimi-cli-mcp / qwen-cli-mcp / grok-cli-mcp /
 * mcode-mcp and the claude-code interface review):
 *
 *   {"type":"system","subtype":"init","session_id":"…","model":"…"}
 *   {"type":"assistant","message":{"role":"assistant","model":"…",
 *      "content":[{"type":"text","text":"…"}|{"type":"tool_use",…}],
 *      "usage":{"input_tokens":…,"output_tokens":…}}}
 *   {"type":"user", …}                        — tool results; never the answer
 *   {"type":"result","subtype":"success","is_error":false,"result":"…",
 *    "session_id":"…","usage":{…},"duration_ms":…}
 *
 * Ported semantics (from the reference accumulators):
 *  - The answer is the terminal `result` envelope, full stop. Never the raw
 *    stdout, never a user line. Without a result envelope the last assistant
 *    text stands in and `partial: true` says so.
 *  - A result envelope with `is_error` throws AgentError("cli_error") — a CLI
 *    that reports its own failure must surface as a failure, not as text.
 *  - `modelId` is what the CLI REPORTED: the single `modelUsage` key (claude),
 *    then `model` / `model_id` on the result, then the last assistant
 *    message's model, then the `system/init` model.
 *  - Lines that do not parse as JSON are skipped (CLI noise on stdout), and
 *    unknown envelope types are ignored — never guessed into the answer.
 *
 * Usage styles (`usageStyle`):
 *  - "claude" — result envelope carries `usage.input_tokens`, `output_tokens`,
 *    `cache_read_input_tokens` → cacheReadTokens,
 *    `cache_creation_input_tokens` → cacheWriteTokens,
 *    `output_tokens_details.thinking_tokens` → reasoningTokens, and a
 *    top-level `total_cost_usd` → costUsd.
 *  - "pi" — nested pi-ai shape `usage.input.{tokens,cacheRead,cacheWrite}` /
 *    `usage.output.tokens`, falling back to the flat `input_tokens` /
 *    `output_tokens` names. Best-effort for pi-lineage CLIs.
 *  - "grok" — flat `input_tokens` / `output_tokens` only (kimi, qwen, grok,
 *    mcode report exactly these two); cache/cost fields are absent, and none
 *    are fabricated.
 */

import { AgentError } from "@kagero/core";
import type { UsageTelemetry } from "@kagero/core";
import type { ParsedRun } from "../spec.js";

export type ClaudeLineageUsageStyle = "claude" | "pi" | "grok";

export interface ClaudeLineageOptions {
  /** How the CLI's usage object maps onto UsageTelemetry. Default "claude". */
  readonly usageStyle?: ClaudeLineageUsageStyle;
}

type RpcRecord = Record<string, unknown>;

/** Incremental parser callback: fired per assistant text block, in order. */
export type OnText = (text: string) => void;

function asRecord(value: unknown): RpcRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RpcRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// --- usage styles -------------------------------------------------------------

interface RawUsage {
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  reasoning?: number | undefined;
  costUsd?: number | undefined;
}

function readUsage(value: unknown, style: ClaudeLineageUsageStyle, costUsd?: number): RawUsage | null {
  const usage = asRecord(value);
  if (usage === null && costUsd === undefined) return null;

  const input = asFiniteNumber(usage?.["input_tokens"]);
  const output = asFiniteNumber(usage?.["output_tokens"]);
  if (style === "grok" || style === "pi") {
    const flat: RawUsage = {
      input: input,
      output: output,
    };
    if (style === "pi") {
      // pi-ai nested shape wins when present; flat names are the fallback.
      const nestedInput = asRecord(usage?.["input"]);
      const nestedOutput = asRecord(usage?.["output"]);
      if (nestedInput !== null) {
        flat.input = asFiniteNumber(nestedInput["tokens"]) ?? flat.input;
        flat.cacheRead = asFiniteNumber(nestedInput["cacheRead"]);
        flat.cacheWrite = asFiniteNumber(nestedInput["cacheWrite"]);
      }
      if (nestedOutput !== null) {
        flat.output = asFiniteNumber(nestedOutput["tokens"]) ?? flat.output;
      }
    }
    if (Object.values(flat).every((n) => n === undefined || n === 0)) return null;
    return flat;
  }
  // "claude"
  const details = asRecord(usage?.["output_tokens_details"]);
  const mapped: RawUsage = {
    input: input,
    output: output,
    cacheRead: asFiniteNumber(usage?.["cache_read_input_tokens"]),
    cacheWrite: asFiniteNumber(usage?.["cache_creation_input_tokens"]),
    reasoning: asFiniteNumber(details?.["thinking_tokens"]),
    costUsd: costUsd,
  };
  if (Object.values(mapped).every((n) => n === undefined)) return null;
  return mapped;
}

function toTelemetry(usage: RawUsage | undefined): UsageTelemetry | undefined {
  if (usage === undefined) return undefined;
  const out: Record<string, number> = {};
  if (usage.input !== undefined) out["inputTokens"] = usage.input;
  if (usage.output !== undefined) out["outputTokens"] = usage.output;
  if (usage.cacheRead !== undefined) out["cacheReadTokens"] = usage.cacheRead;
  if (usage.cacheWrite !== undefined) out["cacheWriteTokens"] = usage.cacheWrite;
  if (usage.reasoning !== undefined) out["reasoningTokens"] = usage.reasoning;
  if (usage.costUsd !== undefined) out["costUsd"] = usage.costUsd;
  return Object.keys(out).length > 0 ? (out as UsageTelemetry) : undefined;
}

// --- envelope readers -----------------------------------------------------------

/** Text blocks of one assistant envelope, joined; tool_use blocks are noted but never the answer. */
function readAssistantText(envelope: RpcRecord): string | undefined {
  const inner = asRecord(envelope["message"]);
  if (inner === null || inner["role"] !== "assistant") return undefined;
  const blocks = Array.isArray(inner["content"]) ? inner["content"] : [];
  const texts: string[] = [];
  for (const raw of blocks) {
    const block = asRecord(raw);
    if (block === null || block["type"] !== "text") continue;
    const text = asString(block["text"]);
    if (text !== undefined) texts.push(text.trim());
  }
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}

function readAssistantModel(envelope: RpcRecord): string | undefined {
  const inner = asRecord(envelope["message"]);
  return inner === null ? undefined : asString(inner["model"]);
}

function readAssistantUsage(envelope: RpcRecord, style: ClaudeLineageUsageStyle): RawUsage | null {
  const inner = asRecord(envelope["message"]);
  return inner === null ? null : readUsage(inner["usage"], style);
}

/**
 * The claude result envelope carries `modelUsage` keyed by the full factual
 * model ids. One key → that model. Several keys (fallbacks, subagents) → the
 * caller asked for one answer, so fall through to the last assistant model
 * instead of guessing which key dominates.
 */
function readModelUsageSingleKey(envelope: RpcRecord): string | undefined {
  const modelUsage = asRecord(envelope["modelUsage"]);
  if (modelUsage === null) return undefined;
  const keys = Object.keys(modelUsage);
  return keys.length === 1 ? (keys[0] ?? undefined) : undefined;
}

// --- folding state ----------------------------------------------------------------

interface FoldState {
  style: ClaudeLineageUsageStyle;
  onText: OnText | undefined;
  initModel: string | undefined;
  lastAssistantModel: string | undefined;
  lastAssistantText: string | undefined;
  accumulated: RawUsage | null;
  sessionId: string | undefined;
  /** The terminal envelope, when one arrived. */
  result: RpcRecord | null;
}

function foldLine(state: FoldState, line: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // not a message line — stdout noise, skipped
  }
  const envelope = asRecord(parsed);
  if (envelope === null) return;

  const sessionId = asString(envelope["session_id"]);
  if (sessionId !== undefined) state.sessionId = sessionId;

  switch (envelope["type"]) {
    case "system": {
      if (asString(envelope["subtype"]) !== "init") return;
      state.initModel ??= asString(envelope["model"]);
      return;
    }
    case "assistant": {
      const text = readAssistantText(envelope);
      if (text !== undefined && text !== "") {
        state.lastAssistantText = text;
        state.onText?.(text);
      }
      const model = readAssistantModel(envelope);
      if (model !== undefined) state.lastAssistantModel = model;
      const usage = readAssistantUsage(envelope, state.style);
      if (usage !== null) {
        state.accumulated = {
          input: (state.accumulated?.input ?? 0) + (usage.input ?? 0),
          output: (state.accumulated?.output ?? 0) + (usage.output ?? 0),
          cacheRead: state.accumulated?.cacheRead ?? usage.cacheRead,
          cacheWrite: state.accumulated?.cacheWrite ?? usage.cacheWrite,
          reasoning: state.accumulated?.reasoning ?? usage.reasoning,
          costUsd: state.accumulated?.costUsd ?? usage.costUsd,
        };
      }
      return;
    }
    case "result": {
      state.result = envelope;
      return;
    }
    default:
      return; // user lines (tool results), rate limits, thinking tokens — never the answer
  }
}

/**
 * The answer is the terminal `result` envelope; without one, the last
 * assistant text stands in and the run is marked partial (port of the
 * reference `selectAnswer`). An `is_error` result throws — the caller sees a
 * failure, not an error message dressed up as an answer.
 */
function answer(state: FoldState): ParsedRun {
  const result = state.result;
  if (result !== null) {
    const isError = result["is_error"] === true;
    const resultText = asString(result["result"]) ?? asString(result["text"]);
    const error = asRecord(result["error"]);
    const errorMessage =
      asString(error?.["message"]) ?? resultText ?? `CLI reported ${asString(result["subtype"]) ?? "an error"}`;
    if (isError) {
      throw new AgentError("cli_error", errorMessage, "tool", {
        subtype: asString(result["subtype"]),
        sessionId: state.sessionId,
      });
    }

    const usage = readUsage(result["usage"], state.style, asFiniteNumber(result["total_cost_usd"]));
    const modelId =
      readModelUsageSingleKey(result) ??
      asString(result["model_id"]) ??
      asString(result["model"]) ??
      state.lastAssistantModel ??
      state.initModel;
    const telemetry = toTelemetry(usage ?? state.accumulated ?? undefined);
    return {
      text: resultText ?? "",
      ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
      ...(modelId === undefined ? {} : { modelId }),
      ...(telemetry === undefined ? {} : { usage: telemetry }),
    };
  }

  // No result envelope: killed, timed out, or a broken stream. The last
  // assistant text (if any) is a partial answer — never a fabricated success.
  const partialModel = state.lastAssistantModel ?? state.initModel;
  const partialUsage = toTelemetry(state.accumulated ?? undefined);
  return {
    text: state.lastAssistantText ?? "",
    ...(state.sessionId === undefined ? {} : { sessionId: state.sessionId }),
    ...(partialModel === undefined ? {} : { modelId: partialModel }),
    ...(partialUsage === undefined ? {} : { usage: partialUsage }),
    partial: true,
  };
}

/**
 * Incremental variant: feed stdout line by line, get the ParsedRun at the end.
 * `onText` fires per assistant text block as it arrives — a spec can wire it
 * to streaming; the current CliSpecAgent forwards raw stdout chunks instead
 * (see backend.ts), so this is an export for callers that parse themselves.
 */
export function claudeLineageStream(
  opts: ClaudeLineageOptions & { readonly onText?: OnText } = {},
): { pushLine(line: string): void; finish(): ParsedRun } {
  const state: FoldState = {
    style: opts.usageStyle ?? "claude",
    onText: opts.onText,
    initModel: undefined,
    lastAssistantModel: undefined,
    lastAssistantText: undefined,
    accumulated: null,
    sessionId: undefined,
    result: null,
  };
  return {
    pushLine(line: string): void {
      const trimmed = line.trim();
      if (trimmed !== "") foldLine(state, trimmed);
    },
    finish(): ParsedRun {
      return answer(state);
    },
  };
}

/** Parse one print run's stdout (the whole stream) into a ParsedRun. */
export function parseClaudeLineage(stdout: string, opts: ClaudeLineageOptions = {}): ParsedRun {
  const stream = claudeLineageStream(opts);
  for (const line of stdout.split("\n")) stream.pushLine(line);
  return stream.finish();
}
