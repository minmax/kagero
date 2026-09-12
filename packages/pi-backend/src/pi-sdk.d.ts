/**
 * pi-sdk backend — in-process integration with @earendil-works/pi-coding-agent.
 *
 * This is the "canonical" backend: it uses the AgentSession interface
 * directly, no subprocess, full streaming, real events.
 *
 * The peer-dep is OPTIONAL — this module is loaded lazily. If the
 * @earendil-works/pi-coding-agent package is not installed, instantiating
 * PiSdkAgent throws a clear error.
 */
import type { Agent, AgentCapabilities, AgentEvent, AgentResponse, HistoryOptions, HistoryResult, MidRunCommand, ModelInfo, PromptOptions, SessionInfo } from "@kagero/core";
export declare class PiSdkAgent implements Agent {
    readonly name = "pi-sdk";
    readonly capabilities: AgentCapabilities;
    private session;
    private subscribers;
    init(): Promise<void>;
    prompt(prompt: string, _opts?: PromptOptions): Promise<AgentResponse>;
    resume(sessionId: string, prompt: string, _opts?: PromptOptions): Promise<AgentResponse>;
    listModels(): Promise<ModelInfo[]>;
    listSessions(): Promise<SessionInfo[]>;
    subscribe(sessionId: string, onEvent: (e: AgentEvent) => void): () => void;
    send(sessionId: string, message: string, kind?: MidRunCommand): Promise<void>;
    history(_sessionId: string, _opts?: HistoryOptions): Promise<HistoryResult>;
    abort(_sessionId: string): Promise<void>;
    dispose(): Promise<void>;
    private requireSession;
    private collectedText;
    private collectText;
    private sessionIdFor;
    private emit;
}
//# sourceMappingURL=pi-sdk.d.ts.map