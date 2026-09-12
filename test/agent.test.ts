// Contract tests for the shared pieces that must hold before any backend work.

import { AgentError, unsupportedCapability } from "@kagero/core";
import { describe, expect, it } from "vitest";

describe("AgentError", () => {
  it("carries code, kind and context", () => {
    const err = new AgentError("cli_error", "boom", "tool", { exitCode: 1 });
    expect(err.code).toBe("cli_error");
    expect(err.kind).toBe("tool");
    expect(err.context).toEqual({ exitCode: 1 });
    expect(String(err)).toContain("boom");
  });

  it("defaults to kind tool", () => {
    expect(new AgentError("x", "y").kind).toBe("tool");
  });
});

describe("unsupportedCapability", () => {
  it("builds the canonical refusal", () => {
    const err = unsupportedCapability("history", "no reader for this CLI");
    expect(err).toBeInstanceOf(AgentError);
    expect(err.code).toBe("unsupported_capability");
    expect(err.message).toContain("history");
    expect(err.message).toContain("no reader for this CLI");
    expect(err.context).toEqual({ capability: "history" });
  });
});
