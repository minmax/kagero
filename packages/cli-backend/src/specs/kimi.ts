/**
 * kimiSpec — kimi-code CLI.
 *
 * Flags ported from the proven kimi-cli-mcp transport (src/transport/args.ts,
 * acp.ts — file-level comments there record the reasons):
 *  - print: `[-m M] --output-format stream-json [resume: -S id] -p prompt`.
 *    `-p` is greedy and must come last; `-y`/`--auto`/`--plan` are omitted on
 *    purpose — the CLI rejects them with `-p`, and prompt mode already
 *    executes tools without confirmation. Kimi names fresh sessions itself;
 *    only resumes pass an id. The print stream is NDJSON ROLE-LINES
 *    ({"role":"meta"|"assistant"|"tool", …}) — NOT the claude-lineage
 *    envelope family: no `type`-tagged envelopes, no result envelope, the
 *    last assistant `content` string is the answer, and the session id lives
 *    on the `meta` `session.resume_hint` line. Parsed by parseKimiRoles
 *    (parse/kimi-roles.ts).
 *  - ACP: `kimi acp`, initialize protocolVersion is the integer 1,
 *    session/set_mode carries the approval mode (their set_mode semantics —
 *    qwen-mcp defaulted unset runs to "yolo"; here "default" leaves the CLI's
 *    own default), session/set_config_option applies `model` and `thinking`
 *    (PromptOptions has no thinking field yet, so only `model` is sent).
 *  - models: `kimi provider list --json` → `{models: {id: …}, defaultModel}`.
 *    The catalog carries ids only; ModelInfo numbers kimi does not report stay
 *    at "not reported" placeholders.
 *
 * Default transport ACP, like kimi-mcp's own DEFAULT_TRANSPORT.
 */

import type { ModelInfo } from "@kagero/core";
import { createKimiHistoryReader } from "../history-readers/index.js";
import { parseKimiRoles } from "../parse/kimi-roles.js";
import type { AcpConfigOption,  CliSpec, PromptContext } from "../spec.js";

const kimiSpec: CliSpec = {
  name: "kimi",
  binary: "kimi",
  displayName: "kimi-code",
  defaultTransport: "acp",
  thinkingEffort: true,

  print: {
    resumeCapable: true,
    args(ctx: PromptContext): string[] {
      const args: string[] = [];
      if (ctx.opts.modelId !== undefined) {
        args.push("-m", ctx.opts.modelId);
      }
      args.push("--output-format", "stream-json");
      if (ctx.mode === "resume" && ctx.sessionId !== undefined) {
        args.push("-S", ctx.sessionId);
      }
      args.push("-p", ctx.prompt);
      return args;
    },
    parse: (stdout) => parseKimiRoles(stdout),
  },

  acp: {
    args: ["acp"],
    protocolVersion: 1,
    modeId: (ctx) => (ctx.opts.approvalMode === "yolo" ? "yolo" : undefined),
    // kimi 0.42 honors additionalDirectories on session/new (server.ts:247-251).
    additionalDirectories: true,
    configOptions: (ctx) => {
      const options: AcpConfigOption[] = [];
      if (ctx.opts.modelId !== undefined) {
        options.push({ configId: "model", value: ctx.opts.modelId });
      }
      // thinking: live-verified accepted set low|high|max (server.ts:493-505;
      // medium → -32602 "Unknown thinking value").
      if (ctx.opts.thinkingEffort !== undefined) {
        options.push({ configId: "thinking", value: ctx.opts.thinkingEffort });
      }
      return options;
    },
    nativeMethods: [
      "session/list",
      "session/fork",
      "session/delete",
      "session/close",
      "session/set_model",
      "session/set_config_option",
    ],
  },

  models: {
    args: () => ["provider", "list", "--json"],
    parse: (stdout) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return [];
      }
      if (typeof parsed !== "object" || parsed === null) return [];
      const record = parsed as { models?: unknown };
      if (typeof record.models !== "object" || record.models === null) return [];
      const infos: ModelInfo[] = [];
      for (const id of Object.keys(record.models)) {
        infos.push({
          id,
          displayName: id,
          provider: "kimi",
          // The catalog carries ids only; 0/false = "not reported".
          contextWindow: 0,
          supportsTools: false,
          supportsVision: false,
        });
      }
      return infos;
    },
  },

  history: createKimiHistoryReader(),
};

export default kimiSpec;
