/**
 * @kagero/core — the Agent contract and shared plumbing.
 *
 * Zero runtime dependencies. Nothing in here knows about concrete backends.
 */

export type {
  AcpClientOptions,
  AcpConfigOption,
  AcpSessionConfig,
  AcpTurnResult,
} from "./acp.js";
export { AcpClient } from "./acp.js";
export type {
  Agent,
  AgentCapabilities,
  AgentEvent,
  AgentResponse,
  AgentRunStatus,
  HistoryEntry,
  HistoryOptions,
  HistoryResult,
  MidRunCommand,
  ModelInfo,
  PromptOptions,
  SessionInfo,
  UsageTelemetry,
  WorkspaceOption,
} from "./agent.js";
export { AgentError, unsupportedCapability } from "./agent.js";
export type {
  Digest,
  DigestBlock,
  DigestCheckpoint,
  DigestOutput,
  DigestThought,
  DigestThoughtKind,
  DigestThoughtSource,
  DigestTurn,
  DigestValidationContext,
  DigestWindow,
  DigestWindowOptions,
  FileIndexEntry,
  ReportItem,
  SessionFacts,
  SessionReport,
  TruncateCenteredOptions,
  TruncateCenteredResult,
} from "./digest.js";
export {
  asDigestOutput,
  buildDigestWindow,
  buildDigestWindows,
  buildFileIndex,
  CHECKPOINT_SECTION_MAX,
  contentHash,
  DEFAULT_WINDOW_BUDGET_TOKENS,
  estimateTokens,
  extractFacts,
  extractJsonObject,
  formatFileIndex,
  quoteId,
  RECOVERY_FOOTER,
  renderDigestBlocks,
  renderRawEntries,
  renderSessionFacts,
  repairDigestOutput,
  splitDeltaForWindows,
  substituteFileRefs,
  truncateCentered,
  validateDigestOutput,
} from "./digest.js";
export type { HistoryPageWindow, RenderHistoryOptions } from "./history.js";
export {
  DEFAULT_HISTORY_PAGE_SIZE,
  formatHistoryBytes,
  MAX_HISTORY_PAGE_SIZE,
  renderHistory,
  resolveHistoryPage,
  truncateForHistory,
} from "./history.js";
export type { ResolvedBinary, RunOptions, RunResult, RunStatus } from "./process.js";
export { resolveBinary, runProcess } from "./process.js";
export type { BackendFactory } from "./registry.js";
export { BackendRegistry, createRegistry } from "./registry.js";
export type { WorkspaceInfo } from "./workspace.js";
export { resolveWorkspace } from "./workspace.js";
