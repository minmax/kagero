/**
 * @kagero/mcp — MCP server factory over the Agent contract.
 *
 * Zero kagero backends here: the registry is injected by the caller.
 */

export type { KageroMcpServerOptions } from "./server.js";
export { createKageroMcpServer } from "./server.js";
export { minimizeEvent, StreamCompressorHub } from "./stream-compressor.js";
export {
  COMPRESSOR_SYSTEM_PROMPT,
  collectDelta,
  decodeWatchCursor,
  encodeWatchCursor,
  handleWatch,
  readWatchConfig,
  WATCH_TOOL_DESCRIPTION,
  type WatchArgs,
  type WatchConfig,
  type WatchDeps,
  type WatchResult,
  watchInputSchema,
} from "./watch.js";
