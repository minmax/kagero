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
import { AgentError, unsupportedCapability } from "@kagero/core";

// Type alias for the SDK's AgentSession — we don't import the module
// statically so missing peer-dep doesn't break the build.
type SdkSession = {
  prompt: (text: string, options?: unknown) => Promise<unknown>;
  steer: (text: string) => Promise<unknown>;
  followUp: (text: string) => Promise<unknown>;
  subscribe: (listener: (event: unknown) => void) => () => void;
  isStreaming: boolean;
  abort: () => Promise<void>;
  dispose: () => void;
  getSessionFile?: () => string;
  getModel?: () => { id?: string } | undefined;
};

type SdkFactory = (opts?: unknown) => Promise<{ session: SdkSession }>;

export class PiSdkAgent implements Agent {
  public readonly name = "pi-sdk";

  public readonly capabilities: AgentCapabilities = {
    resume: true,
    models: true,
    sessions: false,
    history: false,
    subscribe: true,
    abort: true,
    steer: true,
    followUp: true,
    limits: { timeout: false, maxTurns: false, maxToolCalls: false },
    workspaceCreate: true,
  };

  private session: SdkSession | null = null;
  private subscribers = new Map<string, Set<(e: AgentEvent) => void>>();

  async init(): Promise<void> {
    if (this.session) return;
    try {
      // @ts-expect-error: peer-dep is optional; only present if user installed it
      const mod = await import("@earendil-works/pi-coding-agent");
      const factory = (mod as { createAgentSession?: SdkFactory }).createAgentSession;
      if (typeof factory !== "function") {
        throw new Error("createAgentSession is not exported by @earendil-works/pi-coding-agent");
      }
      const { session } = await factory();
      this.session = session;

      // Forward SDK events to our AgentEvent
      session.subscribe((rawEvent: unknown) => {
        const ev = rawEvent as { type?: string; [k: string]: unknown };
        const at = new Date().toISOString();
        const sessionId = this.sessionIdFor(ev);
        if (!sessionId) return;
        switch (ev.type) {
          case "message_update": {
            const inner = ev.assistantMessageEvent as { type?: string; delta?: string } | undefined;
            if (inner?.type === "text_delta" && typeof inner.delta === "string") {
              this.collectedText += inner.delta;
              this.emit(sessionId, { type: "assistant-text", content: inner.delta, at });
            }
            break;
          }
          case "tool_call": {
            this.emit(sessionId, {
              type: "tool-call",
              name: String((ev as { name?: string }).name ?? ""),
              args: (ev as { args?: unknown }).args,
              at,
            });
            break;
          }
          case "tool_result": {
            this.emit(sessionId, {
              type: "tool-result",
              name: String((ev as { name?: string }).name ?? ""),
              result: (ev as { result?: unknown }).result,
              at,
            });
            break;
          }
          case "error": {
            this.emit(sessionId, {
              type: "error",
              message: String((ev as { message?: string }).message ?? "unknown"),
              at,
            });
            break;
          }
          default:
            // Ignore other events for now
            break;
        }
      });
    } catch (err) {
      throw new AgentError(
        "backend_unavailable",
        `pi-sdk backend requires @earendil-works/pi-coding-agent to be installed. ` +
          `Run: npm install @earendil-works/pi-coding-agent. Underlying error: ${(err as Error).message}`,
        "user",
        { hint: "npm install @earendil-works/pi-coding-agent" },
      );
    }
  }

  async prompt(prompt: string, _opts: PromptOptions = {}): Promise<AgentResponse> {
    await this.init();
    const session = this.requireSession();
    const start = Date.now();
    await session.prompt(prompt);
    const m = session.getModel?.()?.id;
    return {
      status: "completed",
      text: this.collectText(),
      durationMs: Date.now() - start,
      ...(m ? { modelId: m, modelSource: "reported" as const } : {}),
    };
  }

  async resume(sessionId: string, prompt: string, _opts: PromptOptions = {}): Promise<AgentResponse> {
    await this.init();
    const session = this.requireSession();
    const start = Date.now();
    // The pi SDK doesn't have a clean "resume by id" — for now we use followUp
    await session.followUp(prompt);
    const m = session.getModel?.()?.id;
    return {
      status: "completed",
      text: this.collectText(),
      sessionId,
      durationMs: Date.now() - start,
      ...(m ? { modelId: m, modelSource: "reported" as const } : {}),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    await this.init();
    const session = this.requireSession();
    const model = session.getModel?.();
    if (!model?.id) return [];
    return [
      {
        id: model.id,
        displayName: model.id,
        provider: "pi",
        contextWindow: 32768,
        supportsTools: true,
        supportsVision: false,
      },
    ];
  }

  async listSessions(): Promise<SessionInfo[]> {
    // The pi SDK manages sessions via files in ~/.pi/agent/sessions/.
    // We could enumerate them, but for v0 we return empty.
    return [];
  }

  subscribe(sessionId: string, onEvent: (e: AgentEvent) => void): () => void {
    let set = this.subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sessionId, set);
    }
    set.add(onEvent);
    return () => {
      set?.delete(onEvent);
      if (set && set.size === 0) this.subscribers.delete(sessionId);
    };
  }

  async send(sessionId: string, message: string, kind: MidRunCommand = "steer"): Promise<void> {
    void sessionId;
    const session = this.requireSession();
    if (kind === "follow_up") await session.followUp(message);
    else await session.steer(message);
  }

  async history(_sessionId: string, _opts?: HistoryOptions): Promise<HistoryResult> {
    throw unsupportedCapability("history", "pi sessions live inside the SDK process in v0.2.");
  }

  async abort(_sessionId: string): Promise<void> {
    const session = this.requireSession();
    await session.abort();
  }

  async dispose(): Promise<void> {
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
    this.subscribers.clear();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireSession(): SdkSession {
    if (!this.session) throw new AgentError("not_initialized", "PiSdkAgent not initialized", "protocol");
    return this.session;
  }

  private collectedText = "";

  private collectText(): string {
    const out = this.collectedText;
    this.collectedText = "";
    return out;
  }

  private sessionIdFor(_event: unknown): string {
    // For now everything is "default" — pi's session model is a single
    // per-process tree, not multi-session. Override later if needed.
    return "default";
  }

  private emit(sessionId: string, event: AgentEvent): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(event);
      } catch {
        // ignore
      }
    }
  }
}
