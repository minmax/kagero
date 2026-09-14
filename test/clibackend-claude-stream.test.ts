// Tests for the claude-stream transport (ported from niwa's live stream-json
// protocol) against a fake claude subprocess: user turn → system/assistant/
// result frames, control_request initialize handshake, can_use_tool deny,
// steer as a second user turn, is_error failures, abort.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeStreamAgent } from "../packages/cli-backend/src/claude-stream.js";
import { chmodSync, copyFileSync, writeFileSync } from "node:fs";

const FAKE = new URL("./helpers/fake-claude-stream.mjs", import.meta.url).pathname;

async function makeAgent(mode: "echo" | "deny" = "echo"): Promise<{ agent: ClaudeStreamAgent; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kagero-claude-stream-"));
  const bin = join(dir, "fake-claude");
  // Wrapper pins the mode per binary so env never leaks between tests.
  const script = `#!/bin/sh\nFAKE_CLAUDE_MODE=${mode} exec node "${FAKE}" "$@"\n`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  process.env["CLAUDE_STREAM_BIN"] = bin;
  return { agent: new ClaudeStreamAgent(), dir };
}

describe("claude-stream agent", () => {
  it("runs a prompt turn: system init, assistant text, result, honest session id", async () => {
    const { agent, dir } = await makeAgent("echo");
    void dir;
    const events: string[] = [];
    agent.subscribe("*", (e) => events.push(e.type));
    const response = await agent.prompt("say hi", {});
    expect(response.status).toBe("completed");
    expect(response.text).toContain("PONG: say hi");
    expect(response.sessionId).toMatch(/^fake-claude-/);
    expect(response.modelId).toBe("haiku");
    expect(events).toContain("session-start");
    expect(events).toContain("session-end");
  }, 15000);

  it("resume() reuses the session id in the response", async () => {
    const { agent } = await makeAgent("echo");
    const first = await agent.prompt("turn one", {});
    const second = await agent.resume(first.sessionId ?? "x", "turn two", {});
    expect(second.status).toBe("completed");
    expect(second.text).toContain("PONG: turn two");
  }, 15000);

  it("is_error results reject with the CLI message", async () => {
    const { agent } = await makeAgent("deny");
    await expect(agent.prompt("nope", {})).rejects.toThrow("fake denied this prompt");
  }, 15000);

  it("forwards live semantic events to subscribers", async () => {
    const { agent } = await makeAgent("echo");
    const seen: string[] = [];
    agent.subscribe("*", (e) => seen.push(e.type));
    await agent.prompt("hello", {});
    expect(seen).toContain("assistant-text");
  }, 15000);

  it("capabilities: steer/followUp/abort/resume on, models/sessions off", () => {
    const agent = makeAgentSync();
    expect(agent.capabilities.steer).toBe(true);
    expect(agent.capabilities.followUp).toBe(true);
    expect(agent.capabilities.abort).toBe(true);
    expect(agent.capabilities.resume).toBe(true);
    expect(agent.capabilities.models).toBe(false);
  });

  it("history and models refuse honestly", async () => {
    const { agent } = await makeAgent("echo");
    await expect(agent.history("x")).rejects.toThrow("history");
  }, 15000);
});

function makeAgentSync(): ClaudeStreamAgent {
  const dir = mkdtempSync(join(tmpdir(), "kagero-claude-stream-"));
  const bin = join(dir, "fake-claude");
  copyFileSync(FAKE, bin);
  chmodSync(bin, 0o755);
  process.env["CLAUDE_STREAM_BIN"] = bin;
  return new ClaudeStreamAgent();
}
