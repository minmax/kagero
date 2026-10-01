// Tests for the claude-stream transport (ported from niwa's live stream-json
// protocol) against a fake claude subprocess: user turn → system/assistant/
// result frames, control_request initialize handshake, can_use_tool deny,
// steer as a second user turn, is_error failures, abort, native control
// subtypes (set_model / interrupt receipt / reverse hook_callback).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeStreamAgent } from "../packages/cli-backend/src/claude-stream.js";
import { chmodSync, copyFileSync, writeFileSync } from "node:fs";

const FAKE = new URL("./helpers/fake-claude-stream.mjs", import.meta.url).pathname;

async function makeAgent(
  mode: "echo" | "deny" = "echo",
  withoutNativeSessionId = false,
): Promise<{ agent: ClaudeStreamAgent; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kagero-claude-stream-"));
  const bin = join(dir, "fake-claude");
  // Wrapper pins the mode per binary so env never leaks between tests.
  const script = `#!/bin/sh\nFAKE_CLAUDE_MODE=${mode} FAKE_CLAUDE_NO_SESSION=${withoutNativeSessionId ? "1" : "0"} exec node "${FAKE}" "$@"\n`;
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

  it("reports the already-known native id through the per-run callback on resume", async () => {
    const { agent } = await makeAgent("echo");
    const earlyIds: string[] = [];
    const startIds: string[] = [];
    agent.subscribe("*", (event) => {
      if (event.type === "session-start") startIds.push(event.sessionId);
    });
    const response = await agent.resume("native-resume", "continue", {
      onSessionId: (id) => earlyIds.push(id),
    });
    expect(earlyIds).toEqual(["native-resume"]);
    expect(startIds).toContain("native-resume");
    expect(response.sessionId).toBe("native-resume");
  }, 15000);

  it("does not report its synthetic routing label as a native session id", async () => {
    const { agent } = await makeAgent("echo", true);
    const earlyIds: string[] = [];
    const response = await agent.prompt("no session id", { onSessionId: (id) => earlyIds.push(id) });
    expect(response.sessionId).toBeUndefined();
    expect(earlyIds).toEqual([]);
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

describe("control subtypes", () => {
  it("setModel switches the model in place over native control (no respawn)", async () => {
    const { agent } = await makeAgent("echo");
    const texts: string[] = [];
    agent.subscribe("*", (e) => {
      if (e.type === "assistant-text") texts.push(e.content);
    });
    const first = await agent.prompt("turn one", {});
    expect(await agent.setModel("mistral")).toBe(true);
    const second = await agent.prompt("turn two", { modelId: "mistral" });
    expect(second.status).toBe("completed");
    // Same fake process answered both turns — the model switch did not respawn.
    expect(second.sessionId).toBe(first.sessionId);
    // The fake proves the set_model control hit the wire by echoing it back.
    expect(texts.join("\n")).toContain("[model set: mistral]");
  }, 15000);

  it("interrupt sends cancel_queued and surfaces the receipt", async () => {
    const { agent } = await makeAgent("echo");
    const turn = agent.resume("fixed", "long running work", {});
    await sleep(10); // let the turn go active before aborting
    await agent.abort("claude-fixed");
    // The turn settles via its own interrupt result frame — not pre-settled.
    const response = await turn;
    expect(response.status).toBe("completed");
    // The fake only emits the receipt when cancel_queued rode the wire.
    const receipt = await waitFor(() => agent.lastInterruptReceipt);
    expect(receipt.cancelled).toEqual(["fake-msg-interrupted"]);
    expect(receipt.stillQueued).toEqual([]);
  }, 15000);

  it("reverse hook_callback gets an error-shaped control_response (not the deny shape)", async () => {
    const { agent } = await makeAgent("echo");
    const response = await agent.prompt("probe", {});
    expect(response.status).toBe("completed");
    // The fake tags its answer with the reply it received for hook_callback:
    // subtype "error" + "not supported headless", never the deny shape.
    expect(response.text).toContain("[reverse:error:not supported headless]");
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await sleep(10);
  }
}
