/**
 * @kagero/cli-backend — data-driven CLI backends.
 *
 * The barrel is the one import site for composition layers: the CliSpecAgent
 * plus the seven built-in specs, the stream-json parse helpers, and the
 * per-CLI history readers (as the `historyReaders` namespace).
 */

export type { CliSpecAgentOptions } from "./backend.js";
export { CliSpecAgent } from "./backend.js";
export * as historyReaders from "./history-readers/index.js";
export type { ClaudeLineageOptions, ClaudeLineageUsageStyle } from "./parse/claude-lineage.js";
export { claudeLineageStream, parseClaudeLineage } from "./parse/claude-lineage.js";
export type { CodexJsonlOptions } from "./parse/codex-jsonl.js";
export { codexJsonlStream, parseCodexJsonl } from "./parse/codex-jsonl.js";
export { convertExecLine, mcodeExecStream, parseMcodeExec } from "./parse/mcode-exec.js";
export type {
  AcpConfigOption,
  AcpTransportSpec,
  CliSpec,
  HistoryReader,
  LimitsSupport,
  ModelsCommand,
  ParsedRun,
  PrintParser,
  PrintTransport,
  PromptContext,
  SessionsCommand,
} from "./spec.js";
export {
  defaultBinaryEnvVar,
  deriveCapabilities,
} from "./spec.js";
export { claudeSpec, codexSpec, dshSpec, grokSpec, kimiSpec, mcodeSpec, qwenSpec } from "./specs/index.js";
