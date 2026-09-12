import type { Agent, AgentEvent, AgentResponse, ModelInfo, PromptOptions, SessionInfo } from "@kagero/core";
export declare class PiRpcAgent implements Agent {
    readonly name = "pi-rpc";
    private proc;
    private nextId;
    private pending;
    private subscribers;
    private buffer;
    private collectedText;
    private start;
    private resolveBinary;
    private ingest;
    private forwardEvent;
    private call;
    prompt(prompt: string, opts?: PromptOptions): Promise<AgentResponse>;
    resume(sessionId: string, prompt: string, opts?: PromptOptions): Promise<AgentResponse>;
    listModels(_opts?: PromptOptions): Promise<ModelInfo[]>;
    listSessions(_opts?: PromptOptions): Promise<SessionInfo[]>;
    subscribe(sessionId: string, onEvent: (e: AgentEvent) => void): () => void;
    abort(_sessionId: string): Promise<void>;
    dispose(): Promise<void>;
    private collectText;
    private emit;
}
//# sourceMappingURL=pi-rpc.d.ts.map