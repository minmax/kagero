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
import type { Agent, AgentEvent, AgentResponse, ModelInfo, PromptOptions, SessionInfo } from "@kagero/core";
export declare class PiSdkAgent implements Agent {
    readonly name = "pi-sdk";
    private session;
    private subscribers;
    init(): Promise<void>;
    prompt(prompt: string, _opts?: PromptOptions): Promise<AgentResponse>;
    resume(sessionId: string, prompt: string, _opts?: PromptOptions): Promise<AgentResponse>;
    listModels(): Promise<ModelInfo[]>;
    listSessions(): Promise<SessionInfo[]>;
    subscribe(sessionId: string, onEvent: (e: AgentEvent) => void): () => void;
    abort(_sessionId: string): Promise<void>;
    dispose(): Promise<void>;
    private requireSession;
    private collectedText;
    private collectText;
    private sessionIdFor;
    private emit;
}
//# sourceMappingURL=pi-sdk.d.ts.map