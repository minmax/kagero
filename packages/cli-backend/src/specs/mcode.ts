/**
 * mcodeSpec — MiniMax Code CLI.
 *
 * Flags ported from the proven mcode-mcp transport (src/transport/args.ts,
 * acp.ts, print.ts — file-level comments there record the reasons):
 *  - print: `exec --output-format stream-json --cwd <workspace>
 *    [(--permission P)] [(--model M)] [resume: --session id]
 *    [(--timeout <ms>ms)] -- <prompt>`. The prompt goes last after `--` so a
 *    leading dash cannot parse as an option. Approval mapping: yolo →
 *    `--permission full` (bypass), "default" → nothing (the CLI's own default).
 *  - ACP: `mcode acp`, initialize protocolVersion is the integer 1,
 *    session/set_config_option `permissionMode` (their mapping: smart → auto,
 *    full → bypassPermissions; here yolo → full → bypassPermissions),
 *    `model` and `thinkingEffort` (PromptOptions has no effort field yet).
 *  - models: `mcode provider list --json` → providers with model lists; ids
 *    render as `providerId/modelId`. Numbers mcode does not report stay at
 *    "not reported" placeholders.
 *
 * Default transport ACP, like mcode-mcp's own DEFAULT_TRANSPORT.
 */

import type { ModelInfo } from "@kagero/core";
import { parseMcodeExec } from "../parse/mcode-exec.js";
import { createMcodeHistoryReader } from "../history-readers/mcode.js";
import type { AcpConfigOption, CliSpec, PromptContext } from "../spec.js";

/** ACP `permissionMode` config values (their acpPermissionMode). */
export function mcodeAcpPermissionMode(approvalMode: "default" | "yolo" | undefined): string | undefined {
  if (approvalMode === "yolo") return "bypassPermissions";
  return undefined;
}

function mcodePermissionArgs(approvalMode: "default" | "yolo" | undefined): string[] {
  return approvalMode === "yolo" ? ["--permission", "full"] : [];
}

const mcodeSpec: CliSpec = {
  name: "mcode",
  binary: "mcode",
  displayName: "MiniMax Code",
  defaultTransport: "acp",

  print: {
    resumeCapable: true,
    args(ctx: PromptContext): string[] {
      const args: string[] = [
        "exec",
        "--output-format",
        "stream-json",
        "--cwd",
        ctx.workspace,
        ...mcodePermissionArgs(ctx.opts.approvalMode),
      ];
      if (ctx.opts.modelId !== undefined) {
        args.push("--model", ctx.opts.modelId);
      }
      if (ctx.mode === "resume" && ctx.sessionId !== undefined) {
        args.push("--session", ctx.sessionId);
      }
      if (ctx.opts.timeoutMs !== undefined) {
        args.push("--timeout", `${ctx.opts.timeoutMs}ms`);
      }
      args.push("--", ctx.prompt);
      return args;
    },
    parse: (stdout) => parseMcodeExec(stdout),
  },

  acp: {
    args: ["acp"],
    protocolVersion: 1,
    configOptions: (ctx): AcpConfigOption[] => {
      const options: AcpConfigOption[] = [];
      const permissionMode = mcodeAcpPermissionMode(ctx.opts.approvalMode);
      if (permissionMode !== undefined) {
        options.push({ configId: "permissionMode", value: permissionMode });
      }
      if (ctx.opts.modelId !== undefined) {
        options.push({ configId: "model", value: ctx.opts.modelId });
      }
      return options;
    },
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
      const providers = (parsed as { providers?: unknown }).providers;
      if (!Array.isArray(providers)) return [];
      const infos: ModelInfo[] = [];
      for (const rawProvider of providers) {
        if (typeof rawProvider !== "object" || rawProvider === null) continue;
        const provider = rawProvider as { providerId?: unknown; models?: unknown };
        const providerId = typeof provider.providerId === "string" ? provider.providerId : "unknown";
        if (!Array.isArray(provider.models)) continue;
        for (const rawModel of provider.models) {
          // Entries are plain ids or {modelId, selected} records.
          const modelId =
            typeof rawModel === "string"
              ? rawModel
              : typeof (rawModel as { modelId?: unknown } | null)?.modelId === "string"
                ? (rawModel as { modelId: string }).modelId
                : undefined;
          if (modelId === undefined) continue;
          const id = `${providerId}/${modelId}`;
          infos.push({
            id,
            displayName: id,
            provider: providerId,
            // The catalog carries ids only; 0/false = "not reported".
            contextWindow: 0,
            supportsTools: false,
            supportsVision: false,
          });
        }
      }
      return infos;
    },
  },

  history: createMcodeHistoryReader(),

  limits: {
    timeout: (ms) => ["--timeout", `${ms}ms`],
  },
};

export default mcodeSpec;
