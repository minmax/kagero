/**
 * @kagero/core — the Agent contract and shared plumbing.
 *
 * Zero runtime dependencies. Nothing in here knows about concrete backends.
 */
export { AgentError, unsupportedCapability } from "./agent.js";
export { BackendRegistry, createRegistry } from "./registry.js";
export { renderHistory, truncateForHistory } from "./history.js";
export { resolveBinary, runProcess } from "./process.js";
export { resolveWorkspace } from "./workspace.js";
//# sourceMappingURL=index.js.map