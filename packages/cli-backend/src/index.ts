/**
 * @kagero/cli-backend — data-driven CLI backends.
 */

export { CliSpecAgent } from "./backend.js";
export type { CliSpecAgentOptions } from "./backend.js";
export {
  defaultBinaryEnvVar,
  deriveCapabilities,
} from "./spec.js";
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
