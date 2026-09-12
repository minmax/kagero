/**
 * codexSpec — OpenAI Codex CLI (`codex exec`).
 *
 * Interface facts from the live probe (docs/reviews/codex-cli-interface.md):
 *  - print fresh: `exec --json --skip-git-repo-check [(--model M)]
 *    [--dangerously-bypass-approvals-and-sandbox] <prompt>` — the prompt is
 *    the last positional. The working directory comes from the process cwd
 *    (runProcess), not `-C`. exec has NO `--full-auto` and no approval flag;
 *    headless approval is `never` by default.
 *  - resume: `exec resume <sessionId> [(--model M)] <prompt>` — resume has NO
 *    `-C/-s` flags: cwd and sandbox are inherited from the recorded session.
 *  - parse: JSONL events — thread.started{thread_id} → sessionId,
 *    item.completed agent_message (last one) → text, turn.completed{usage} →
 *    usage (cached_input_tokens → cacheReadTokens). No factual model id and
 *    no duration in the stream: modelId is the requested echo only
 *    (modelSource "requested"), duration is measured by the backend.
 *  - history: the rollout reader over `~/.codex/sessions/**`.
 *  - No timeout and no max-turns flag exist; the backend's wrapper timeout is
 *    the only deadline.
 */

import { createCodexHistoryReader } from "../history-readers/codex.js";
import { parseCodexJsonl } from "../parse/codex-jsonl.js";
import type { CliSpec, PromptContext } from "../spec.js";

const codexSpec: CliSpec = {
  name: "codex",
  binary: "codex",
  displayName: "Codex CLI",
  defaultTransport: "print",

  print: {
    resumeCapable: true,
    args(ctx: PromptContext): string[] {
      const modelArgs = ctx.opts.modelId === undefined ? [] : ["--model", ctx.opts.modelId];
      if (ctx.mode === "resume" && ctx.sessionId !== undefined) {
        // resume has no -C/-s: cwd and sandbox are inherited from the session.
        // --json must ride along: without it the resume run prints human text
        // and the JSONL parser would find nothing. --skip-git-repo-check is
        // accepted by `exec resume` too; without it a resume outside a trusted
        // git repo fails with "Not inside a trusted directory".
        return [
          "exec",
          "resume",
          ctx.sessionId,
          "--json",
          "--skip-git-repo-check",
          ...modelArgs,
          ctx.prompt,
        ];
      }
      return [
        "exec",
        "--json",
        "--skip-git-repo-check",
        ...modelArgs,
        ...(ctx.opts.approvalMode === "yolo" ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
        ctx.prompt,
      ];
    },
    parse: (stdout) => parseCodexJsonl(stdout),
  },

  history: createCodexHistoryReader(),
};

export default codexSpec;
