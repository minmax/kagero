/**
 * registry.ts — the open backend registry.
 *
 * Backends register by string name; there is no closed union of names, so
 * adding claude or codex never touches the core. The registry owns instance
 * caching: one Agent per name, single-flight creation per name, and a failed
 * creation never poisons later attempts.
 */
import { AgentError, type Agent } from "./agent.js";
export type BackendFactory = () => Agent | Promise<Agent>;
export declare class BackendRegistry {
    /** Register a factory under `name`. Throws AgentError("backend_exists") on duplicates. */
    register(name: string, factory: BackendFactory): void;
    has(name: string): boolean;
    names(): string[];
    /** Get-or-create the Agent for `name`, cached per name. */
    select(name: string): Promise<Agent>;
    /** Dispose every live agent and forget the cache. */
    disposeAll(): Promise<void>;
}
export declare function createRegistry(): BackendRegistry;
/** Re-exported for callers that only want the error shape. */
export { AgentError };
//# sourceMappingURL=registry.d.ts.map