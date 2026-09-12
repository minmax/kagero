/**
 * backend.ts — CliSpecAgent: an Agent over a CliSpec.
 *
 * Implementation notes (for the implementer):
 *  - prompt/resume resolve the workspace (core), build argv (spec.print or
 *    ACP), run via core runProcess / ACP client, parse, and map RunStatus to
 *    AgentResponse.status honestly. modelId echoes requested with
 *    modelSource "requested" only when the CLI stayed silent.
 *  - listModels/listSessions/history throw unsupportedCapability when the
 *    spec has no strategy for them.
 *  - subscribe emits lifecycle AgentEvents around runs (session-start,
 *    session-end, error); streaming assistant-text arrives only from ACP
 *    sessions or specs that opt into onStream.
 *  - abort cancels the in-flight run for the session key (AbortController
 *    map) and the run resolves with status "aborted".
 *  - send supports steer/follow_up only on ACP transports.
 */

import type {
  Agent,
  AgentCapabilities,
  AgentEvent,
  AgentResponse,
  HistoryOptions,
  HistoryResult,
  MidRunCommand,
  ModelInfo,
  PromptOptions,
  SessionInfo,
} from "@kagero/core";
import { deriveCapabilities } from "./spec.js";
import type { CliSpec } from "./spec.js";

export interface CliSpecAgentOptions {
  /** Default per-call timeout passed to runProcess when PromptOptions omit one. */
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export class CliSpecAgent implements Agent {
  public readonly name: string;
  public readonly capabilities: AgentCapabilities;
  public readonly spec: CliSpec;

  constructor(spec: CliSpec, opts: CliSpecAgentOptions = {}) {
    this.spec = spec;
    this.name = spec.name;
    this.capabilities = deriveCapabilities(spec);
    void opts;
  }

  async prompt(_prompt: string, _opts: PromptOptions = {}): Promise<AgentResponse> {
    throw new Error("not implemented");
  }

  async resume(_sessionId: string, _prompt: string, _opts: PromptOptions = {}): Promise<AgentResponse> {
    throw new Error("not implemented");
  }

  async listModels(): Promise<ModelInfo[]> {
    throw new Error("not implemented");
  }

  async listSessions(): Promise<SessionInfo[]> {
    throw new Error("not implemented");
  }

  async history(_sessionId: string, _opts?: HistoryOptions): Promise<HistoryResult> {
    throw new Error("not implemented");
  }

  subscribe(_sessionId: string, _onEvent: (e: AgentEvent) => void): () => void {
    throw new Error("not implemented");
  }

  async send(_sessionId: string, _message: string, _kind?: MidRunCommand): Promise<void> {
    throw new Error("not implemented");
  }

  async abort(_sessionId: string): Promise<void> {
    throw new Error("not implemented");
  }

  async dispose(): Promise<void> {
    throw new Error("not implemented");
  }
}
