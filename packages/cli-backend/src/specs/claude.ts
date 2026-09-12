/**
 * claudeSpec — Claude Code CLI (headless `-p`).
 *
 * Interface facts from the live probe (docs/reviews/claude-cli-interface.md):
 *  - print: `-p <prompt> --output-format stream-json` plus `--model`,
 *    `--resume <id>`, `--max-turns <n>`, and `--dangerously-skip-permissions`
 *    for yolo ("default" adds nothing — the CLI's own defaults). `--verbose`
 *    is NOT needed: on 2.1.257 stream-json emits the full event set without
 *    it (review §5).
 *  - parse: the shared claude-lineage fold with the "claude" usage style
 *    (result envelope: `result`, `session_id`, `usage{input_tokens,
 *    output_tokens, cache_read/cache_creation_input_tokens}`, `duration_ms`,
 *    `total_cost_usd`; modelId from the single `modelUsage` key, falling back
 *    to assistant.message.model). `is_error` results throw AgentError.
 *  - history: the on-disk reader over `~/.claude/projects/<encoded-cwd>/*.jsonl`.
 *  - No timeout flag exists; the backend's wrapper timeout is the deadline.
 *  - ACP: Claude Code has no stable public ACP mode in this CLI — print only.
 */

import { createClaudeHistoryReader } from "../history-readers/claude.js";
import { parseClaudeLineage } from "../parse/claude-lineage.js";
import type { CliSpec, PromptContext } from "../spec.js";

const claudeSpec: CliSpec = {
  name: "claude",
  binary: "claude",
  displayName: "Claude Code",
  defaultTransport: "print",

  print: {
    resumeCapable: true,
    args(ctx: PromptContext): string[] {
      const args: string[] = ["-p", ctx.prompt, "--output-format", "stream-json"];
      if (ctx.opts.modelId !== undefined) {
        args.push("--model", ctx.opts.modelId);
      }
      if (ctx.mode === "resume" && ctx.sessionId !== undefined) {
        args.push("--resume", ctx.sessionId);
      }
      if (ctx.opts.maxTurns !== undefined) {
        args.push("--max-turns", String(ctx.opts.maxTurns));
      }
      if (ctx.opts.approvalMode === "yolo") {
        args.push("--dangerously-skip-permissions");
      }
      return args;
    },
    parse: (stdout) => parseClaudeLineage(stdout, { usageStyle: "claude" }),
  },

  history: createClaudeHistoryReader(),

  limits: {
    maxTurns: (n) => ["--max-turns", String(n)],
  },
};

export default claudeSpec;
