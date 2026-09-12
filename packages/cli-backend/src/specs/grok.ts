/**
 * grokSpec — grok CLI.
 *
 * Flags ported from the proven grok-cli-mcp transport (src/transport/print.ts,
 * args.ts, acp.ts — file-level comments there record the reasons):
 *  - print: prompts go through `--prompt-file` (a temp file in the workspace,
 *    deleted after the run) so argv size and dash-leading text are never a
 *    problem — grok has this flag where qwen does not. Output format is
 *    `streaming-messages-json`. Approval: yolo/undefined → `--always-approve`
 *    (the product name for always-approve), "default" → `--permission-mode
 *    default`. The workspace rides on `--cwd`. Session identity is always
 *    named: `--session-id` fresh (generated UUID upfront), `--resume` after.
 *  - `--tools` / `--rules` / `--effort` have no PromptOptions counterpart yet;
 *    they stay a grok-mcp-only surface.
 *  - ACP: `grok agent [--always-approve | --permission-mode …] [(--model)] stdio`,
 *    initialize protocolVersion is the STRING "1" (grok's own client sends a
 *    string), fresh sessions carry `_meta {yoloMode: true}` (and rules when
 *    set, which PromptOptions cannot express yet).
 *  - models: `grok models` prints a markdown-ish text catalog
 *    (`- id` bullets, `*`/`(default)` marks the default) — ported from
 *    grok-mcp's probe. The catalog carries ids only; ModelInfo numbers that
 *    grok does not report stay at "not reported" placeholders.
 *
 * Default transport ACP, like grok-mcp's own DEFAULT_TRANSPORT.
 */

import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelInfo } from "@kagero/core";
import { createGrokHistoryReader } from "../history-readers/grok.js";
import { parseClaudeLineage } from "../parse/claude-lineage.js";
import type { CliSpec, PromptContext } from "../spec.js";

/**
 * Map PromptOptions.approvalMode onto grok's CLI flags (their approvalArgs):
 * yolo is the product name for always-approve; everything else is
 * `--permission-mode <mode>` with grok's own identifiers.
 */
export function grokApprovalArgs(approvalMode: "default" | "yolo" | undefined): string[] {
  if (approvalMode === undefined || approvalMode === "yolo") {
    return ["--always-approve"];
  }
  return ["--permission-mode", approvalMode];
}

const grokSpec: CliSpec = {
  name: "grok",
  binary: "grok",
  displayName: "grok-cli",
  defaultTransport: "acp",
  newSessionId: () => randomUUID(),

  print: {
    resumeCapable: true,
    args(ctx: PromptContext): string[] {
      // The temp prompt file lives in the workspace and dies with the run.
      const promptFile = join(ctx.workspace, `kagero-grok-prompt-${randomUUID()}.txt`);
      writeFileSync(promptFile, ctx.prompt);
      return [
        "--prompt-file",
        promptFile,
        "--output-format",
        "streaming-messages-json",
        ...(ctx.opts.modelId === undefined ? [] : ["--model", ctx.opts.modelId]),
        ...grokApprovalArgs(ctx.opts.approvalMode),
        "--cwd",
        ctx.workspace,
        ...(ctx.mode === "resume" && ctx.sessionId !== undefined
          ? ["--resume", ctx.sessionId]
          : ctx.runSessionId === undefined
            ? []
            : ["--session-id", ctx.runSessionId]),
      ];
    },
    cleanup: (_ctx, args) => {
      const flagIndex = args.indexOf("--prompt-file");
      const file = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
      if (file !== undefined) {
        try {
          unlinkSync(file);
        } catch {
          // Temp file cleanup is best-effort.
        }
      }
    },
    parse: (stdout) => parseClaudeLineage(stdout, { usageStyle: "grok" }),
  },

  acp: {
    args: ["agent"],
    protocolVersion: "1",
    extraArgs: (ctx) => [
      ...grokApprovalArgs(ctx.opts.approvalMode),
      ...(ctx.opts.modelId === undefined ? [] : ["--model", ctx.opts.modelId]),
      "stdio",
    ],
    sessionMeta: (ctx) => {
      // yolo (and unset — grok's own default) rides in _meta on session/new|load.
      if (ctx.opts.approvalMode !== undefined && ctx.opts.approvalMode !== "yolo") {
        return {};
      }
      return { yoloMode: true };
    },
  },

  models: {
    args: () => ["models"],
    parse: (stdout) => {
      const infos: ModelInfo[] = [];
      const seen = new Set<string>();
      for (const line of stdout.split("\n")) {
        const match = /^\s*[*+-]\s+(\S+)/.exec(line);
        const id = match?.[1];
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        infos.push({
          id,
          displayName: id,
          provider: "grok",
          // The text catalog carries ids only; 0/false = "not reported".
          contextWindow: 0,
          supportsTools: false,
          supportsVision: false,
        });
      }
      return infos;
    },
  },

  history: createGrokHistoryReader(),
};

export default grokSpec;
