// Tests for the Agent contract — common interface, error handling, registry.
import { describe, expect, it } from "vitest";
import {
  type Agent,
  AgentError,
  type AgentEvent,
  type AgentResponse,
  type ModelInfo,
  type SessionInfo,
} from "@kagero/core";
import { availableBackends, select } from "../src/registry.js";

describe("availableBackends", () => {
  it("returns the 7 expected backend names", () => {
    const names = availableBackends().sort();
    expect(names).toEqual(["dsh", "grok", "kimi", "mcode", "pi-rpc", "pi-sdk", "qwen"]);
  });
});

describe("select", () => {
  it("throws for unknown backend", async () => {
    await expect(select("nope")).rejects.toThrow(AgentError);
  });

  it("pi-sdk throws clear error when peer-dep is missing", async () => {
    try {
      const agent = await select("pi-sdk");
      // init() is called lazily, on first prompt
      await agent.prompt("test");
      expect.fail("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe("backend_unavailable");
      expect((err as AgentError).message).toMatch(/pi-coding-agent/);
    }
  });

  it("pi-rpc throws when binary is not on PATH", async () => {
    // Force not-found by pointing PI_RPC_BIN at something nonexistent
    process.env["PI_RPC_BIN"] = "/nonexistent/pi";
    try {
      const agent = await select("pi-rpc");
      // first call triggers binary resolution
      await agent.prompt("test");
      expect.fail("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe("binary_not_found");
    } finally {
      delete process.env["PI_RPC_BIN"];
    }
  });

  it("dsh throws when binary is not on PATH", async () => {
    process.env["DSH_MCP_BIN"] = "/nonexistent/dsh";
    try {
      const agent = await select("dsh");
      await agent.prompt("test");
      expect.fail("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe("binary_not_found");
    } finally {
      delete process.env["DSH_MCP_BIN"];
    }
  });
});

describe("Agent contract", () => {
  // A minimal in-memory Agent used to test the contract
  class FakeAgent implements Agent {
    readonly name = "fake";
    private subs = new Map<string, Set<(e: unknown) => void>>();
    async prompt(p: string): Promise<AgentResponse> {
      return { text: `prompted: ${p}`, durationMs: 1 };
    }
    async resume(id: string, p: string): Promise<AgentResponse> {
      return { text: `resumed: ${id}: ${p}`, sessionId: id, durationMs: 1 };
    }
    async listModels(): Promise<ModelInfo[]> {
      return [
        {
          id: "m",
          displayName: "M",
          provider: "p",
          contextWindow: 1,
          supportsTools: false,
          supportsVision: false,
        },
      ];
    }
    async listSessions(): Promise<SessionInfo[]> {
      return [];
    }
    subscribe(id: string, cb: (e: AgentEvent) => void): () => void {
      const wrapped = cb as (e: unknown) => void;
      let s = this.subs.get(id);
      if (!s) {
        s = new Set<(e: unknown) => void>();
        this.subs.set(id, s);
      }
      s.add(wrapped);
      return () => {
        s?.delete(wrapped);
      };
    }
    async abort(_id: string): Promise<void> {}
    async dispose(): Promise<void> {}
  }

  it("implements the full contract", async () => {
    const a = new FakeAgent();
    expect(a.name).toBe("fake");
    expect((await a.prompt("hi")).text).toBe("prompted: hi");
    expect((await a.resume("s1", "again")).text).toBe("resumed: s1: again");
    expect((await a.resume("s1", "again")).sessionId).toBe("s1");
    expect(await a.listModels()).toHaveLength(1);
    expect(await a.listSessions()).toHaveLength(0);
    let received: unknown = null;
    const unsub = a.subscribe("s1", (e) => {
      received = e;
    });
    expect(typeof unsub).toBe("function");
    unsub();
    expect(received).toBe(null);
    await a.abort("s1");
    await a.dispose();
  }, 5_000);
});
