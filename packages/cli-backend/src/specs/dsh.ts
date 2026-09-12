/**
 * dshSpec — DeepSeek Harness CLI (dsh), headless profile.
 *
 * Interface facts from the live probe (reviews/dsh-real-interface.md, re-run
 * 2026-09-12 against dsh 0.1.5-rc.1):
 *  - One-shot: `dsh --profile headless "<task>"` — the headless app interface
 *    has a positional variadic `task` and ONLY `-h/--help`: no --model, no
 *    --resume, no --timeout, no --max-tokens. An empty/whitespace task is a
 *    usage error on stderr, exit 1.
 *  - stdout is ONLY the final answer text (one trailing "\n"); stderr is
 *    diagnostics (the `dsh: reasoning:` stream, fatal load failures,
 *    `dsh: CODE: message`) and is never mixed into the answer. Exit 0 ⇔ the
 *    turn completed.
 *  - Non-zero exits never reach the parser: the backend raises
 *    AgentError("cli_error") whose message carries the stderr head, so dsh's
 *    `dsh: CODE: …` line lands there (reasoning noise may precede it — the
 *    CODE line is search text, not a fixed position).
 *  - Model choice has no CLI surface: it lives in
 *    `~/.dsh/settings.yaml` (`agent-default-model`, optionally
 *    `llm-pi-ai.providers.<route>.apiKeyEnv`) or a one-shot `--patch`
 *    overlay. A requested modelId is therefore an honest
 *    unsupported_capability pointing at those paths, never a silent ignore;
 *    the CLI does not echo the active model either.
 *  - No resume/session passing in headless — every run is a cold new session.
 *    Sessions ARE persisted: the listing comes from the on-disk projection
 *    (`~/.dsh/storages/session_projcache/sessions/*.json`, see
 *    history-readers/dsh-sessions.ts) and history from the multi-frame zstd
 *    logs (`~/.dsh/sessions/<cwd-slug>/<session-id>/session.v3.jsonl.zstd`,
 *    see history-readers/dsh.ts). Both are best-effort file reads of an
 *    undocumented-but-stable layout — there is no CLI for either, which is
 *    exactly why they are readers and not probe commands.
 *  - dsh has no timeout flag; the backend's wrapper timeout is the only
 *    deadline, which is why limits stays empty yet capabilities.limits.timeout
 *    is true.
 *  - Known environment trap (review §1): a stale Node (< 22.22.2 without
 *    zstd) makes dsh a SILENT no-op with exit 0 — pin the binary through
 *    DSH_BIN when in doubt.
 */

import { unsupportedCapability } from "@kagero/core";
import { createDshHistoryReader, readDshSessions } from "../history-readers/index.js";
import type { CliSpec, PromptContext } from "../spec.js";

const dshSpec: CliSpec = {
  name: "dsh",
  binary: "dsh",
  displayName: "DeepSeek Harness (headless)",
  defaultTransport: "print",

  sessionsReader: readDshSessions,
  history: createDshHistoryReader(),

  print: {
    resumeCapable: false,
    args(ctx: PromptContext): string[] {
      if (ctx.opts.modelId !== undefined) {
        // dsh has no model flag; selection lives in settings.yaml / --patch.
        throw unsupportedCapability(
          "model selection",
          "dsh headless has no --model flag. Set agent-default-model in ~/.dsh/settings.yaml or pass a `--patch` overlay.",
        );
      }
      return ["--profile", "headless", ctx.prompt];
    },
    parse: (stdout) => {
      // stdout = the answer, minus the single trailing newline the runner adds.
      // Non-zero exits never reach the parser: the backend turns them into
      // AgentError("cli_error") with the stderr head (where the
      // `dsh: CODE: …` line lands). stderr itself is diagnostics
      // (reasoning stream, errors) — never the answer.
      const text = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
      return { text };
    },
  },
};

export default dshSpec;
