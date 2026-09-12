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
export type { RenderHistoryOptions } from "./history.js";
export { renderHistory, truncateForHistory } from "./history.js";
export type { ResolvedBinary, RunOptions, RunResult, RunStatus } from "./process.js";
export { resolveBinary, runProcess } from "./process.js";
export type { BackendFactory } from "./registry.js";
export { BackendRegistry, createRegistry } from "./registry.js";
export type { WorkspaceInfo } from "./workspace.js";
export { resolveWorkspace } from "./workspace.js";
