/**
 * Registry — selects and instantiates a concrete Agent backend.
 *
 * Backends are loaded lazily (only if the required peer-dep is installed).
 */

import type { Agent } from "./agent.js";
import { AgentError } from "./agent.js";

export type BackendName = "pi-sdk" | "pi-rpc" | "dsh" | "qwen" | "grok" | "kimi" | "mcode";

/** Backend factories. Throws if required peer-dep is missing. */
type BackendFactory = () => Agent | Promise<Agent>;

const factories: Record<BackendName, BackendFactory | undefined> = {
  "pi-sdk": async () => {
    try {
      const mod = await import("./backends/pi-sdk.js");
      return new mod.PiSdkAgent();
    } catch (err) {
      throw new AgentError(
        "backend_unavailable",
        `pi-sdk backend requires @earendil-works/pi-coding-agent. ${(err as Error).message}`,
        "user",
      );
    }
  },
  "pi-rpc": async () => {
    const mod = await import("./backends/pi-rpc.js");
    return new mod.PiRpcAgent();
  },
  dsh: async () => {
    const mod = await import("./backends/dsh.js");
    return new mod.DshAgent();
  },
  qwen: async () => {
    const mod = await import("./backends/qwen.js");
    return new mod.QwenAgent();
  },
  grok: async () => {
    const mod = await import("./backends/grok.js");
    return new mod.GrokAgent();
  },
  kimi: async () => {
    const mod = await import("./backends/kimi.js");
    return new mod.KimiAgent();
  },
  mcode: async () => {
    const mod = await import("./backends/mcode.js");
    return new mod.McodeAgent();
  },
};

/**
 * Select a backend by name and instantiate it.
 *
 * @throws AgentError if the name is unknown or the backend can't be loaded.
 */
export async function select(name: BackendName | string): Promise<Agent> {
  const factory = factories[name as BackendName];
  if (!factory) {
    throw new AgentError(
      "unknown_backend",
      `Unknown backend: ${name}. Available: ${Object.keys(factories).join(", ")}`,
      "user",
    );
  }
  return factory();
}

/** List available backend names. */
export function availableBackends(): string[] {
  return Object.keys(factories);
}
