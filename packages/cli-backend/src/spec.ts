/**
 * spec.ts — CliSpec: a CLI backend as DATA, not as a class.
 *
 * A spec declares the binary, how to run one prompt (print transport), how to
 * hold a live conversation (ACP transport), how to discover models/sessions/
 * history, and which limits the CLI actually supports. `CliSpecAgent` turns a
 * spec into an Agent. Nothing here is dsh- or qwen-specific.
 */

import type {
  AgentCapabilities,
  HistoryOptions,
  HistoryResult,
  ModelInfo,
  PromptOptions,
  SessionInfo,
  UsageTelemetry,
} from "@kagero/core";
import type { RunResult } from "@kagero/core";

/** Everything a print transport needs to know about one call. */
export interface PromptContext {
  readonly prompt: string;
  readonly opts: PromptOptions;
  readonly mode: "prompt" | "resume";
  /** Set in resume mode. */
  readonly sessionId?: string;
  /** Resolved workspace (absolute cwd) for the run. */
  readonly workspace: string;
}

/** What a parsed CLI run produced. Fields stay absent when the CLI is silent. */
export interface ParsedRun {
  readonly text: string;
  readonly sessionId?: string;
  /** The model as REPORTED by the CLI (never the requested echo). */
  readonly modelId?: string;
  readonly usage?: UsageTelemetry;
  readonly partial?: boolean;
}

/** Turn full process output into a ParsedRun. */
export type PrintParser = (stdout: string, stderr: string, run: RunResult) => ParsedRun;

export interface PrintTransport {
  /** Build argv for one call. The prompt must be delivered injection-safe. */
  args(ctx: PromptContext): string[];
  parse: PrintParser;
}

export interface ModelsCommand {
  args(): string[];
  parse(stdout: string): ModelInfo[];
}

export interface SessionsCommand {
  args(): string[];
  parse(stdout: string): SessionInfo[];
}

/** Per-backend reader over the CLI's on-disk conversation logs. */
export interface HistoryReader {
  read(sessionId: string, opts: HistoryOptions | undefined): Promise<HistoryResult>;
}

/** Which limit flags the CLI accepts, and how to build them. */
export interface LimitsSupport {
  timeout?(ms: number): string[];
  maxTurns?(n: number): string[];
  maxToolCalls?(n: number): string[];
}

export interface AcpConfigOption {
  readonly configId: string;
  readonly value: unknown;
}

export interface AcpTransportSpec {
  /** argv of the ACP invocation, e.g. ["--acp"] or ["agent", "stdio"]. */
  readonly args: readonly string[];
  /** `initialize` protocolVersion — some CLIs want a number, some a string. */
  readonly protocolVersion: number | string;
  /** Extra argv appended to the ACP invocation (e.g. passthrough flags). */
  extraArgs?(ctx: PromptContext): string[];
  /** _meta merged into session/new and session/load params (grok yoloMode). */
  sessionMeta?(ctx: PromptContext): Record<string, unknown> | undefined;
  /** session/set_config_option calls applied after the session opens, in order. */
  configOptions?(ctx: PromptContext): readonly AcpConfigOption[];
  /** modeId for session/set_mode (kimi). Undefined = skip the call. */
  modeId?(ctx: PromptContext): string | undefined;
}

export interface CliSpec {
  readonly name: string;
  readonly binary: string;
  /** Env var overriding the binary path. Default: NAME upper-cased, non-alnum → "_", + "_BIN". */
  readonly binaryEnvVar?: string;
  readonly displayName?: string;
  readonly print?: PrintTransport;
  readonly acp?: AcpTransportSpec;
  readonly models?: ModelsCommand;
  readonly sessions?: SessionsCommand;
  readonly history?: HistoryReader;
  readonly limits?: LimitsSupport;
  /** Explicit capability overrides; otherwise derived from which spec parts exist. */
  readonly capabilities?: Partial<AgentCapabilities>;
  /** Default transport when both exist. Default: "acp" when an acp spec exists, else "print". */
  readonly defaultTransport?: "print" | "acp";
}

/**
 * Derive the honest capability set from a spec: resume needs a resume-capable
 * print transport or ACP; models/sessions/history exist only when their
 * strategies exist; steer/followUp only on ACP; workspaceCreate is always
 * true (core owns directory creation); limits follow LimitsSupport.
 */
export function deriveCapabilities(spec: CliSpec): AgentCapabilities {
  void spec;
  throw new Error("not implemented");
}

/** Default binaryEnvVar for a spec name. */
export function defaultBinaryEnvVar(name: string): string {
  return `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BIN`;
}
