/**
 * qwenSpec — qwen-code CLI (qwen-code / qwen lineage).
 *
 * Flags ported from the proven qwen-cli-mcp transport (src/transport/args.ts,
 * print.ts, acp.ts — file-level comments there record the reasons):
 *  - print: `[-model M] [-approval-mode A] [-session-id id | -resume id]` plus
 *    the prompt tail. A dash-leading prompt parses as a flag; yargs' equals
 *    form defeats that (`--prompt=-text` arrives intact, a separate `-p` does
 *    not), and prompts over argv size (~100k chars, their ARGV_PROMPT_LIMIT)
 *    are refused with a pointer at the ACP transport, which carries prompts of
 *    any size inside its stdin protocol.
 *  - The session id is always named upfront: fresh runs generate a UUID and
 *    pass `--session-id` (CliSpec.newSessionId), resumes pass `--resume`.
 *  - ACP: `qwen --acp`, initialize protocolVersion is the integer 1,
 *    session/set_mode carries the approval mode, session/set_config_option
 *    `model` applies the model, and fresh sessions request their id through
 *    the `qwen-code/sessionId` _meta key.
 *  - Models: qwen's real probe is a stream-json control-plane conversation
 *    (initialize + get_available_models), not a plain command — it does not
 *    fit a ModelsCommand, so there is no models strategy here.
 *  - `--allowed-tools` / `--append-system-prompt` have no PromptOptions
 *    counterpart yet; they stay a qwen-mcp-only surface.
 *
 * Default transport ACP, like qwen-mcp's own DEFAULT_TRANSPORT.
 */

import { randomUUID } from "node:crypto";

import { AgentError } from "@kagero/core";
import { createQwenHistoryReader } from "../history-readers/index.js";
import { parseClaudeLineage } from "../parse/claude-lineage.js";
import type { CliSpec, PromptContext } from "../spec.js";

/** qwen-code acp-bridge REQUESTED_SESSION_ID_META_KEY (their acp.ts). */
const REQUESTED_SESSION_ID_META_KEY = "qwen-code/sessionId";

/** print-mode argv tops out around this many chars (their config.ts). */
const ARGV_PROMPT_LIMIT = 100_000;

/**
 * The argv tail that delivers the prompt in print mode. Ported verbatim from
 * qwen-mcp printPromptArg: the equals form must stand alone — a dash-leading
 * prompt after a separate `-p` breaks the run.
 */
export function qwenPromptArg(prompt: string): string[] {
  if (prompt.length > ARGV_PROMPT_LIMIT) {
    throw new AgentError(
      "prompt_too_large",
      `prompt is ${prompt.length} chars; print-mode argv tops out around ${ARGV_PROMPT_LIMIT}. ` +
        'Use transport "acp" (the default), which delivers prompts of any size.',
      "user",
      { promptChars: prompt.length, limit: ARGV_PROMPT_LIMIT },
    );
  }
  if (prompt.startsWith("-")) {
    return [`--prompt=${prompt}`];
  }
  return ["-p", prompt];
}

const qwenSpec: CliSpec = {
  name: "qwen",
  binary: "qwen",
  displayName: "qwen-code",
  defaultTransport: "acp",
  newSessionId: () => randomUUID(),

  print: {
    resumeCapable: true,
    args(ctx: PromptContext): string[] {
      const args: string[] = [];
      if (ctx.opts.modelId !== undefined) {
        args.push("--model", ctx.opts.modelId);
      }
      if (ctx.opts.approvalMode === "yolo") {
        args.push("--approval-mode", "yolo");
      }
      if (ctx.mode === "resume" && ctx.sessionId !== undefined) {
        args.push("--resume", ctx.sessionId);
      } else if (ctx.runSessionId !== undefined) {
        args.push("--session-id", ctx.runSessionId);
      }
      args.push(...qwenPromptArg(ctx.prompt));
      return args;
    },
    parse: (stdout) => parseClaudeLineage(stdout, { usageStyle: "grok" }),
  },

  acp: {
    args: ["--acp"],
    protocolVersion: 1,
    sessionMeta: (ctx) =>
      ctx.mode === "resume"
        ? undefined // session/load needs no requested id — the id IS the request
        : { [REQUESTED_SESSION_ID_META_KEY]: ctx.runSessionId ?? "" },
    modeId: (ctx) => (ctx.opts.approvalMode === "yolo" ? "yolo" : undefined),
    configOptions: (ctx) =>
      ctx.opts.modelId === undefined ? [] : [{ configId: "model", value: ctx.opts.modelId }],
  },

  history: createQwenHistoryReader(),
};

export default qwenSpec;
