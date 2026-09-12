// Unit tests for the open backend registry: caching, single-flight, failure
// isolation, duplicate refusal, parallel dispose.

import type { Agent } from "@kagero/core";
import { AgentError, BackendRegistry, createRegistry } from "@kagero/core";
import { describe, expect, it, vi } from "vitest";

const unused = async (): Promise<never> => {
  throw new Error("not used in registry tests");
};

const makeAgent = (name: string, dispose?: Agent["dispose"]): Agent => ({
  name,
  capabilities: {
    resume: false,
    models: false,
    sessions: false,
    history: false,
    subscribe: false,
    abort: false,
    steer: false,
    followUp: false,
    limits: { timeout: false, maxTurns: false, maxToolCalls: false },
    workspaceCreate: false,
  },
  prompt: vi.fn(unused),
  resume: vi.fn(unused),
  listModels: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  history: vi.fn(unused),
  subscribe: vi.fn(() => () => {}),
  send: vi.fn(async () => {}),
  abort: vi.fn(async () => {}),
  dispose: dispose ?? vi.fn(async () => {}),
});

describe("BackendRegistry — register/has/names", () => {
  it("registers open-ended names and reports them sorted", () => {
    const registry = new BackendRegistry();
    registry.register("zeta", () => makeAgent("zeta"));
    registry.register("alpha", () => makeAgent("alpha"));
    expect(registry.has("zeta")).toBe(true);
    expect(registry.has("missing")).toBe(false);
    expect(registry.names()).toEqual(["alpha", "zeta"]);
  });

  it("refuses duplicates with AgentError('backend_exists')", () => {
    const registry = new BackendRegistry();
    registry.register("dup", () => makeAgent("dup"));
    let caught: unknown;
    try {
      registry.register("dup", () => makeAgent("dup"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentError);
    const agentError = caught as AgentError;
    expect(agentError.code).toBe("backend_exists");
    expect(agentError.kind).toBe("user");
    expect(agentError.context).toEqual({ name: "dup" });
  });
});

describe("BackendRegistry — select", () => {
  it("caches one Agent per name (factory called once)", async () => {
    const factory = vi.fn(() => makeAgent("cached"));
    const registry = new BackendRegistry();
    registry.register("cached", factory);
    const first = await registry.select("cached");
    const second = await registry.select("cached");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("single-flights concurrent selects for the same name", async () => {
    let calls = 0;
    const registry = new BackendRegistry();
    registry.register("slow", () => {
      calls += 1;
      return new Promise<Agent>((resolve) => setTimeout(() => resolve(makeAgent("slow")), 25));
    });
    const [first, second, third] = await Promise.all([
      registry.select("slow"),
      registry.select("slow"),
      registry.select("slow"),
    ]);
    expect(calls).toBe(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("a failed creation does not poison later attempts", async () => {
    let calls = 0;
    const registry = new BackendRegistry();
    registry.register("flaky", () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("backend boot failed"));
      return Promise.resolve(makeAgent("flaky"));
    });
    await expect(registry.select("flaky")).rejects.toThrow("backend boot failed");
    const agent = await registry.select("flaky");
    expect(calls).toBe(2);
    expect(agent.name).toBe("flaky");
  });

  it("rejects with AgentError('backend_not_found') for unknown names", async () => {
    const registry = createRegistry();
    await expect(registry.select("nope")).rejects.toMatchObject({
      code: "backend_not_found",
      kind: "user",
    });
  });
});

describe("BackendRegistry — disposeAll", () => {
  it("disposes all live agents in parallel and forgets the cache", async () => {
    const first = makeAgent("one");
    const second = makeAgent("two");
    const factories: string[] = [];
    const registry = new BackendRegistry();
    registry.register("one", () => {
      factories.push("one");
      return first;
    });
    registry.register("two", async () => {
      factories.push("two");
      return second;
    });
    await registry.select("one");
    await registry.select("two");

    await registry.disposeAll();
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).toHaveBeenCalledTimes(1);

    // Cache is forgotten: select builds a fresh instance.
    await registry.select("one");
    await registry.select("two");
    expect(factories).toEqual(["one", "two", "one", "two"]);
  });

  it("ignores dispose errors", async () => {
    const broken = makeAgent(
      "broken",
      vi.fn(async () => {
        throw new Error("dispose exploded");
      }),
    );
    const healthy = makeAgent("healthy");
    const registry = new BackendRegistry();
    registry.register("broken", () => broken);
    registry.register("healthy", () => healthy);
    await registry.select("broken");
    await registry.select("healthy");

    await expect(registry.disposeAll()).resolves.toBeUndefined();
    expect(healthy.dispose).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on an empty registry", async () => {
    await expect(createRegistry().disposeAll()).resolves.toBeUndefined();
  });
});
