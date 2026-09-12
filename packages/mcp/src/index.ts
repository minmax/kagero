/**
 * @kagero/mcp — MCP server factory over the Agent contract.
 *
 * Zero kagero backends here: the registry is injected by the caller.
 */

export type { KageroMcpServerOptions } from "./server.js";
export { createKageroMcpServer } from "./server.js";
