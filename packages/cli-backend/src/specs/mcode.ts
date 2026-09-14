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
import { createMcodeHistoryReader } from "../history-readers/index.js";
import { parseMcodeExec } from "../parse/mcode-exec.js";
import type { AcpConfigOption, CliSpec, PromptContext } from "../spec.js";

/** ACP `permissionMode` config values (their acpPermissionMode). */
export function mcodeAcpPermissionMode(approvalMode: "default" | "yolo" | undefined): string | undefined {
  if (approvalMode === "yolo") return "bypassPermissions";
  return undefined;
}

function mcodePermissionArgs(approvalMode: "default" | "yolo" | undefined): string[] {
  return approvalMode === "yolo" ? ["--permission", "full"] : [];
}


/**
 * Convert our public model id ("provider/model" or "provider/model#variant")
 * into mcode's ACP model-option wire record (chunk run-acp-command: tr/Vg).
 */
export function mcodeModelOptionValue(modelId: string): string {
  const [modelPart = modelId, variant] = modelId.split("#", 2);
  const separator = modelPart.indexOf("/");
  if (separator === -1) return `m:${encodeURIComponent(modelPart)}:u`;
  const provider = modelPart.slice(0, separator);
  const model = modelPart.slice(separator + 1);
  // Advertised option values use ":v:" with an EMPTY variant for the bare
  // model (live: "m:minimax:MiniMax-M3:v:") — ":u" is never advertised.
  const variantSuffix = variant === undefined || variant === "" ? "v:" : `v:${encodeURIComponent(variant)}`;
  return `m:${encodeURIComponent(provider)}:${encodeURIComponent(model)}:${variantSuffix}`;
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
    // mcode maps any other request_permission optionId to DENY
    // (run-acp-command chunk: allow-once → allowOnce, else deny).
    permissionOptions: { once: "allow-once", always: "allow-always" },
    // Extension gate: without it mcode offers no steer/queue/goal/delegation
    // methods or notifications (chunk run-acp-command: mo(de) reads
    // clientCapabilities._meta["minimax-code/extensions"]).
    clientCapabilitiesMeta: { "minimax-code/extensions": { version: 1, notifications: true } },
    nativeSteer: "mcode/session/steer",
    nativeFollowUp: "mcode/session/queue/enqueue",
    nativeMethods: [
      "session/list",
      "session/fork",
      "session/resume",
      "session/close",
      "session/activate",
      "mcode/session/steer",
      "mcode/session/queue/list",
      "mcode/session/queue/enqueue",
      "mcode/session/queue/update",
      "mcode/session/queue/delete",
      "mcode/session/queue/steer",
      "mcode/session/goal/get",
      "mcode/session/goal/create",
      "mcode/session/goal/patch",
      "mcode/session/goal/clear",
      "mcode/session/delegation/get",
      "mcode/session/delegation/stop",
    ],
    configOptions: (ctx): AcpConfigOption[] => {
      const options: AcpConfigOption[] = [];
      const permissionMode = mcodeAcpPermissionMode(ctx.opts.approvalMode);
      if (permissionMode !== undefined) {
        options.push({ configId: "permissionMode", value: permissionMode });
      }
      if (ctx.opts.modelId !== undefined) {
        // ACP `model` option value is a compact provider:model[:variant] record
        // ("m:<enc(provider)>:<enc(model)>:u", variant ":v:<enc(variant)>") —
        // a bare "provider/model" is rejected with -32602 (live-probed).
        options.push({ configId: "model", value: mcodeModelOptionValue(ctx.opts.modelId) });
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
