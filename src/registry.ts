/**
 * Root composition — the backends kagero ships with.
 *
 * The pi backends live in @kagero/pi-backend; the seven CLI wrappers are
 * data-driven CliSpecs from @kagero/cli-backend, each registered as a
 * CliSpecAgent over its spec (see docs/LIB-PLAN.md §6). Nothing else may
 * hardcode backend names.
 */

import { AgentError, type BackendRegistry, createRegistry } from "@kagero/core";

export const registry: BackendRegistry = createRegistry();

registry.register("pi-sdk", async () => {
  const mod = await import("@kagero/pi-backend");
  return new mod.PiSdkAgent();
});

registry.register("pi-rpc", async () => {
  const mod = await import("@kagero/pi-backend");
  return new mod.PiRpcAgent();
});

registry.register("claude", async () => {
  const { CliSpecAgent, claudeSpec } = await import("@kagero/cli-backend");
  return new CliSpecAgent(claudeSpec);
});

registry.register("codex", async () => {
  const { CliSpecAgent, codexSpec } = await import("@kagero/cli-backend");
  return new CliSpecAgent(codexSpec);
});

registry.register("dsh", async () => {
  const { CliSpecAgent, dshSpec } = await import("@kagero/cli-backend");
  return new CliSpecAgent(dshSpec);
});

registry.register("grok", async () => {
  const { CliSpecAgent, grokSpec } = await import("@kagero/cli-backend");
  return new CliSpecAgent(grokSpec);
});

registry.register("kimi", async () => {
  const { CliSpecAgent, kimiSpec } = await import("@kagero/cli-backend");
  return new CliSpecAgent(kimiSpec);
});

registry.register("mcode", async () => {
  const { CliSpecAgent, mcodeSpec } = await import("@kagero/cli-backend");
  return new CliSpecAgent(mcodeSpec);
});

registry.register("qwen", async () => {
  const { CliSpecAgent, qwenSpec } = await import("@kagero/cli-backend");
  return new CliSpecAgent(qwenSpec);
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
