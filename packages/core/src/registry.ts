/**
 * registry.ts — the open backend registry.
 *
 * Backends register by string name; there is no closed union of names, so
 * adding claude or codex never touches the core. The registry owns instance
 * caching: one Agent per name, single-flight creation per name, and a failed
 * creation never poisons later attempts.
 */

import { type Agent, AgentError } from "./agent.js";

export type BackendFactory = () => Agent | Promise<Agent>;

export class BackendRegistry {
  readonly #factories = new Map<string, BackendFactory>();
  readonly #instances = new Map<string, Agent>();
  readonly #creating = new Map<string, Promise<Agent>>();

  /** Register a factory under `name`. Throws AgentError("backend_exists") on duplicates. */
  register(name: string, factory: BackendFactory): void {
    if (this.#factories.has(name)) {
      throw new AgentError("backend_exists", `Backend "${name}" is already registered.`, "user", { name });
    }
    this.#factories.set(name, factory);
  }

  has(name: string): boolean {
    return this.#factories.has(name);
  }

  names(): string[] {
    return [...this.#factories.keys()].sort();
  }

  /** Get-or-create the Agent for `name`, cached per name. */
  select(name: string): Promise<Agent> {
    const cached = this.#instances.get(name);
    if (cached !== undefined) return Promise.resolve(cached);

    const inFlight = this.#creating.get(name);
    if (inFlight !== undefined) return inFlight;

    const factory = this.#factories.get(name);
    if (factory === undefined) {
      return Promise.reject(
        new AgentError("backend_not_found", `No backend registered under "${name}".`, "user", { name }),
      );
    }

    const pending: Promise<Agent> = (async () => {
      try {
        const agent = await factory();
        this.#instances.set(name, agent);
        return agent;
      } finally {
        // A failed creation leaves no trace: the next select retries the factory.
        this.#creating.delete(name);
      }
    })();
    this.#creating.set(name, pending);
    return pending;
  }

  /** Dispose every live agent and forget the cache. */
  async disposeAll(): Promise<void> {
    const agents = [...this.#instances.values()];
    this.#instances.clear();
    await Promise.allSettled(agents.map((agent) => agent.dispose()));
  }
}

export function createRegistry(): BackendRegistry {
  return new BackendRegistry();
}

/** Re-exported for callers that only want the error shape. */
export { AgentError };
