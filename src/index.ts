/**
 * kagero — public API. Re-exports the core contract plus the root registry.
 */

export * from "@kagero/core";
export { availableBackends, registry, select } from "./registry.js";
