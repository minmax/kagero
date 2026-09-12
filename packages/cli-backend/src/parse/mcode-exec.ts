/**
 * mcode-exec.ts — parser for `mcode exec --output-format stream-json`.
 *
 * mcode's official events carry schemaVersion/sequence plus a dotted type, not
 * the claude-lineage envelopes. Ported from the proven mcode-mcp conversion
 * (src/transport/print.ts, verified against 0.3.x):
 *
 *   {"type":"session.started"|"session.resumed", "sessionId":"…"}
 *   {"type":"item.completed","item":{"type":"agent_message","content":"…"}}
 *   {"type":"item.completed","item":{"type":"tool_call","toolCall":{…}}}
 *   {"type":"exec.completed","result":{"status":"succeeded","sessionId":"…",
 *        "output":…, "usage":{"inputTokens":…,"outputTokens":…},
 *        "durationMs":…, "model":{"providerId":…,"modelId":…}| "…",
 *        "error":{"message":…}}}
 *
 * The lines are converted to claude-lineage envelopes and folded by the shared
 * claude-lineage parser (`usageStyle: "grok"` — mcode reports exactly
 * input/output tokens), so the answer selection, partial handling and error
 * mapping are the same code path for the whole lineage. `status` maps like the
 * reference: succeeded → success; limit_exceeded → error_max_turns;
 * failed/timeout/cancelled → error (AgentError via the shared is_error path).
 */

import type { ParsedRun } from "../spec.js";
import type { ClaudeLineageOptions } from "./claude-lineage.js";
import { claudeLineageStream } from "./claude-lineage.js";

type RpcRecord = Record<string, unknown>;

function asRecord(value: unknown): RpcRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RpcRecord) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `model` is a "provider/model" ref or {providerId, modelId}; format it as a string. */
function formatModelRef(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct !== undefined) return direct;
  const rec = asRecord(value);
  if (rec === null) return undefined;
  const provider = asString(rec["providerId"]);
  const model = asString(rec["modelId"]);
  if (provider !== undefined && model !== undefined) return `${provider}/${model}`;
  return model ?? provider;
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** One official exec event → one claude-lineage envelope, or null when irrelevant. */
export function convertExecLine(raw: string): RpcRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // stdout noise
  }
  const rec = asRecord(parsed);
  if (rec === null) return null;

  if (rec["type"] === "exec.result") return convertExecResult(asRecord(rec["result"]));
  if (rec["type"] === "exec.completed") return convertExecResult(asRecord(rec["result"]));

  const sessionId = asString(rec["sessionId"]);

  if (rec["type"] === "session.started" || rec["type"] === "session.resumed") {
    return { type: "system", subtype: "init", session_id: sessionId };
  }

  if (rec["type"] === "item.started" || rec["type"] === "item.updated" || rec["type"] === "item.completed") {
    return convertItem(asRecord(rec["item"]), sessionId, rec["type"] === "item.completed");
  }

  return null;
}

function convertItem(
  item: RpcRecord | null,
  sessionId: string | undefined,
  completed: boolean,
): RpcRecord | null {
  if (item === null) return null;

  if (item["type"] === "agent_message") {
    if (!completed) return null;
    const text = asString(item["content"]);
    if (text === undefined) return null;
    return {
      type: "assistant",
      session_id: sessionId,
      message: { role: "assistant", content: [{ type: "text", text }] },
    };
  }

  if (item["type"] === "tool_call") {
    const call = asRecord(item["toolCall"]) ?? item;
    const name = asString(call["toolName"]) ?? asString(call["name"]) ?? asString(call["title"]) ?? "tool";
    const input = asRecord(call["rawInput"]) ?? asRecord(call["input"]) ?? {};
    return {
      type: "assistant",
      session_id: sessionId,
      message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
    };
  }

  return null;
}

function convertExecResult(result: RpcRecord | null): RpcRecord | null {
  if (result === null) return null;
  const status = asString(result["status"]);
  if (status === undefined) return null;

  const sessionId = asString(result["sessionId"]);
  const usage = asRecord(result["usage"]);
  const durationMs = asFiniteNumber(result["durationMs"]) ?? 0;
  const model = formatModelRef(result["model"]);
  const error = asRecord(result["error"]);
  const errorMessage = asString(error?.["message"]);

  const subtype =
    status === "succeeded"
      ? "success"
      : status === "limit_exceeded"
        ? "error_max_turns"
        : status === "failed" || status === "timeout" || status === "cancelled"
          ? "error_during_execution"
          : status;

  const ok = subtype === "success";
  const output = stringifyOutput(result["output"]);
  return {
    type: "result",
    subtype,
    is_error: !ok,
    result: ok ? output : (errorMessage ?? output),
    session_id: sessionId,
    ...(model !== undefined ? { model } : {}),
    duration_ms: durationMs,
    usage: {
      input_tokens: asFiniteNumber(usage?.["inputTokens"]) ?? asFiniteNumber(usage?.["input_tokens"]),
      output_tokens: asFiniteNumber(usage?.["outputTokens"]) ?? asFiniteNumber(usage?.["output_tokens"]),
    },
    ...(ok ? {} : { error: { message: errorMessage ?? `mcode exec status ${status}` } }),
  };
}

/**
 * Incremental variant: feed stdout line by line, get the ParsedRun at the end.
 */
export function mcodeExecStream(
  opts: ClaudeLineageOptions & { readonly onText?: (text: string) => void } = {},
): { pushLine(line: string): void; finish(): ParsedRun } {
  const inner = claudeLineageStream({
    usageStyle: opts.usageStyle ?? "grok",
    ...(opts.onText === undefined ? {} : { onText: opts.onText }),
  });
  return {
    pushLine(line: string): void {
      const trimmed = line.trim();
      if (trimmed === "") return;
      const envelope = convertExecLine(trimmed);
      if (envelope !== null) inner.pushLine(JSON.stringify(envelope));
    },
    finish(): ParsedRun {
      return inner.finish();
    },
  };
}

/** Parse one `mcode exec --output-format stream-json` run's stdout into a ParsedRun. */
export function parseMcodeExec(stdout: string, opts: ClaudeLineageOptions = {}): ParsedRun {
  const stream = mcodeExecStream(opts);
  for (const line of stdout.split("\n")) stream.pushLine(line);
  return stream.finish();
}
