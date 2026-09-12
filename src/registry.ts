/**
 * Root composition — the backends kagero ships with.
 *
 * The pi backends live in @kagero/pi-backend; CLI wrappers are data-driven
 * CliSpecs from @kagero/cli-backend and get registered here as they land
 * (see docs/LIB-PLAN.md §6). Nothing else may hardcode backend names.
 */

import { AgentError, createRegistry, type BackendRegistry } from "@kagero/core";

export const registry: BackendRegistry = createRegistry();

registry.register("pi-sdk", async () => {
  const mod = await import("@kagero/pi-backend");
  return new mod.PiSdkAgent();
});

registry.register("pi-rpc", async () => {
  const mod = await import("@kagero/pi-backend");
  return new mod.PiRpcAgent();
});

/** Names of every registered backend, sorted. */
export function availableBackends(): string[] {
  return registry.names().sort();
}

/** Select a backend by name; unknown names are a user error. */
export async function select(name: string) {
  if (!registry.has(name)) {
    throw new AgentError(
      "unknown_backend",
      `Unknown backend: ${name}. Available: ${availableBackends().join(", ")}`,
      "user",
    );
  }
  return registry.select(name);
}
