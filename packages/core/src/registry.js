/**
 * registry.ts — the open backend registry.
 *
 * Backends register by string name; there is no closed union of names, so
 * adding claude or codex never touches the core. The registry owns instance
 * caching: one Agent per name, single-flight creation per name, and a failed
 * creation never poisons later attempts.
 */
import { AgentError } from "./agent.js";
export class BackendRegistry {
    /** Register a factory under `name`. Throws AgentError("backend_exists") on duplicates. */
    register(name, factory) {
        void name;
        void factory;
        throw new Error("not implemented");
    }
    has(name) {
        void name;
        throw new Error("not implemented");
    }
    names() {
        throw new Error("not implemented");
    }
    /** Get-or-create the Agent for `name`, cached per name. */
    select(name) {
        void name;
        throw new Error("not implemented");
    }
    /** Dispose every live agent and forget the cache. */
    async disposeAll() {
        throw new Error("not implemented");
    }
}
export function createRegistry() {
    return new BackendRegistry();
}
/** Re-exported for callers that only want the error shape. */
export { AgentError };
//# sourceMappingURL=registry.js.map