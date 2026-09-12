/**
 * dshSpec — DeepSeek Harness CLI (dsh), headless profile.
 *
 * Interface facts from the live probe (docs/reviews/dsh-real-interface.md):
 *  - One-shot: `dsh --profile headless "<task>"` — the headless app interface
 *    has a positional variadic `task` and NOTHING else: no --model, no
 *    --resume, no --timeout, no --max-tokens.
 *  - stdout is ONLY the final answer text (one trailing "\n"); stderr is
 *    diagnostics (reasoning stream, fatal load failures, `dsh: CODE: …`) and
 *    is never mixed into the answer. Exit 0 ⇔ the turn completed.
 *  - No resume, no session passing, no model/session listing, no structured
 *    output. modelId is not echoed: model choice lives in
 *    ~/.dsh/settings.yaml (`agent-default-model`) or a `--patch` overlay, not
 *    in a CLI flag — so a requested modelId is an honest
 *    unsupported_capability, never a silent ignore.
 *  - dsh has no timeout flag; the backend's wrapper timeout is the only
 *    deadline, which is why limits stays empty yet capabilities.limits.timeout
 *    is true.
 *  - Known environment trap (review §1): a stale Node (< 22.22.2 without
 *    zstd) makes dsh a SILENT no-op with exit 0 — pin the binary through
 *    DSH_BIN when in doubt.
 */

import { unsupportedCapability } from "@kagero/core";
import type { CliSpec, PromptContext } from "../spec.js";

const dshSpec: CliSpec = {
  name: "dsh",
  binary: "dsh",
  displayName: "DeepSeek Harness (headless)",
  defaultTransport: "print",

  print: {
    resumeCapable: false,
    args(ctx: PromptContext): string[] {
      if (ctx.opts.modelId !== undefined) {
        // dsh has no model flag; selection lives in settings.yaml / --patch.
        throw unsupportedCapability(
          "model selection",
          'dsh headless has no --model flag. Set agent-default-model in ~/.dsh/settings.yaml or pass a `--patch` overlay.',
        );
      }
      return ["--profile", "headless", ctx.prompt];
    },
    parse: (stdout) => {
      // stdout = the answer, minus the single trailing newline the runner adds.
      // Non-zero exits never reach the parser: the backend turns them into
      // AgentError("cli_error") with the stderr tail. stderr itself is
      // diagnostics (reasoning stream, `dsh: CODE: …`) — never the answer.
      const text = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
      return { text };
    },
  },
};

export default dshSpec;
