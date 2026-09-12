/**
 * dshSpec — DeepSeek Harness CLI (dsh), headless profile with the
 * dsh-headless-bridge plugin.
 *
 * Interface facts (live probe reviews/dsh-real-interface.md, re-run 2026-09-12
 * against dsh 0.1.5-rc.1; flag grammar and JSON contract from the bridge repo
 * https://github.com/minmax/dsh-bridge — README.md, src/args.ts,
 * src/output.ts):
 *  - Stock headless (`dsh --profile headless "<task>"`) is one positional task
 *    and only -h/--help. Our profile has dsh-headless-bridge installed, which
 *    REPLACES the stock headless flag surface and runner with:
 *      dsh --profile headless [--model <provider|provider/model>]
 *          [--session <id>] [--json] [task...]
 *    Bridge flags first, the positional task last (commander variadic, joined
 *    by spaces). Without the bridge flags it behaves exactly like stock:
 *    answer text on stdout, `dsh: reasoning:` on stderr, exit 0 ⇔ completed.
 *  - We ALWAYS pass `--json`: machine-readable is strictly better, and the
 *    parser then expects exactly ONE JSON line on stdout (the RunReport):
 *      {"status":"completed","text":"…","sessionId":"…",
 *       "model":{"provider":"…","model":"…"},"durationMs":…,"usage"?:{…}}
 *    `status` is the turn-end reason kind ("completed" = success);
 *    `model` is the route the run's requests ACTUALLY went out with (mapped to
 *    modelId as `provider/model`); `error` appears only with status "error";
 *    the exit-code contract is unchanged (0 ⇔ status === "completed"), so
 *    non-zero exits still die in the backend as cli_error before parsing.
 *  - `--model <provider|provider/model>` selects the route for one run (a bare
 *    model id keeps the default provider). The plugin only SELECTS a route;
 *    registering one is the environment's job: e.g. minimax/MiniMax-M3 needs
 *    the `llm-pi-ai` providers section in ~/.dsh/settings.yaml (or a one-shot
 *    `--patch` overlay with the same row). The default route comes from
 *    `agent-default-model`.
 *  - `--session <id>` resumes a persisted session → print.resumeCapable is
 *    true and the derived `resume` capability is on.
 *  - stdout that is NOT a bridge JSON report means the bridge is not installed
 *    in the profile (or dsh predates the contract) — the parser refuses with
 *    an honest AgentError pointing at the install step; it never mistakes a
 *    plain-text answer for a report. A status:"error" report becomes an
 *    AgentError carrying its message.
 *  - stderr stays diagnostics (the reasoning stream) in every mode.
 *  - Sessions/history remain best-effort on-disk readers (the projcache
 *    projection, see history-readers/dsh-sessions.ts, and the multi-frame
 *    zstd logs, see history-readers/dsh.ts) — the CLI itself exposes no
 *    listing/history commands for either (`--list-sessions` of the bridge is
 *    not wired as a spec strategy; the on-disk readers carry more fields).
 *  - dsh has no timeout flag; the backend's wrapper timeout is the only
 *    deadline, which is why limits stays empty yet capabilities.limits.timeout
 *    is true.
 *  - Known environment trap (review §1): a stale Node (< 22.22.2 without
 *    zstd) makes dsh a SILENT no-op with exit 0 — pin the binary through
 *    DSH_BIN when in doubt.
 */

import { AgentError } from "@kagero/core";
import { createDshHistoryReader, readDshSessions } from "../history-readers/index.js";
import type { CliSpec, PrintParser, PromptContext } from "../spec.js";

const BRIDGE_REPO = "https://github.com/minmax/dsh-bridge";
const BRIDGE_HINT =
  `install dsh-headless-bridge into the headless profile ` +
  `(dsh plugin --profile headless add file:${BRIDGE_REPO}; repo: ${BRIDGE_REPO})`;

/** One-line excerpt of unexpected stdout for error messages. */
function excerpt(stdout: string): string {
  const flat = stdout.trim().replace(/\s+/g, " ");
  return flat.length <= 120 ? flat : `${flat.slice(0, 117)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function bridgeError(stdout: string): AgentError {
  return new AgentError(
    "cli_error",
    `dsh stdout is not a dsh-headless-bridge JSON report (got: ${excerpt(stdout)}). ${BRIDGE_HINT}`,
    "tool",
    { stdoutHead: excerpt(stdout) },
  );
}

/**
 * The print parser: stdout must be exactly one bridge JSON report line
 * (RunReport). Plain-text stdout is the stock (bridge-less) runner — refuse
 * with the install hint instead of mistaking the answer for a report.
 */
const parseBridgeReport: PrintParser = (stdout) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw bridgeError(stdout);
  }
  if (!isRecord(parsed)) throw bridgeError(stdout);
  const status = stringField(parsed, "status");
  const text = stringField(parsed, "text");
  if (status === undefined || text === undefined) throw bridgeError(stdout);

  if (status === "error") {
    const error = isRecord(parsed.error) ? parsed.error : undefined;
    const message = error === undefined ? undefined : stringField(error, "message");
    const code = error === undefined ? undefined : stringField(error, "code");
    throw new AgentError(
      "cli_error",
      message ?? 'dsh run ended with status "error" and no error message',
      "tool",
      { status: "error", ...(code === undefined ? {} : { code }) },
    );
  }

  const sessionId = stringField(parsed, "sessionId");
  const model = isRecord(parsed.model) ? parsed.model : undefined;
  const provider = model === undefined ? undefined : stringField(model, "provider");
  const modelName = model === undefined ? undefined : stringField(model, "model");
  const usage = isRecord(parsed.usage) ? parsed.usage : undefined;
  const usageToken = (key: string): number | undefined =>
    usage === undefined ? undefined : numberField(usage, key);
  const inputTokens = usageToken("inputTokens");
  const outputTokens = usageToken("outputTokens");
  const reasoningTokens = usageToken("reasoningTokens");
  const cacheReadTokens = usageToken("cacheReadTokens");

  return {
    text,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(provider === undefined || modelName === undefined ? {} : { modelId: `${provider}/${modelName}` }),
    ...(usage === undefined
      ? {}
      : {
          usage: {
            ...(inputTokens === undefined ? {} : { inputTokens }),
            ...(outputTokens === undefined ? {} : { outputTokens }),
            ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
            ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
          },
        }),
    // Any non-completed turn-end reason is a partial answer (resumable via
    // --session); "error" already died above.
    ...(status === "completed" ? {} : { partial: true }),
  };
};

const dshSpec: CliSpec = {
  name: "dsh",
  binary: "dsh",
  displayName: "DeepSeek Harness (headless)",
  defaultTransport: "print",

  sessionsReader: readDshSessions,
  history: createDshHistoryReader(),

  print: {
    resumeCapable: true,
    args(ctx: PromptContext): string[] {
      // Bridge grammar: --profile first, then the bridge flags, the positional
      // task LAST (the bridge's commander program takes `[task...]`).
      const args: string[] = ["--profile", "headless"];
      if (ctx.opts.modelId !== undefined) {
        args.push("--model", ctx.opts.modelId);
      }
      if (ctx.mode === "resume" && ctx.sessionId !== undefined) {
        args.push("--session", ctx.sessionId);
      }
      args.push("--json", ctx.prompt);
      return args;
    },
    parse: parseBridgeReport,
  },
};

export default dshSpec;
