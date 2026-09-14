// PiRpcAgent native RPC command tests against a fake `pi --mode rpc`
// (test/helpers/fake-pi-rpc.mjs). Real pi is never spawned: PI_RPC_BIN points
// at the fake, and the fake logs every line it receives so the tests assert
// the exact wire frames the client wrote (ids, params, acks, auto-cancels).
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentEvent } from "@kagero/core";
import { AgentError } from "@kagero/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// NOTE: import the .ts source directly — packages/pi-backend/src carries stale
// committed build artifacts (pi-rpc.js / pi-sdk.js / *.d.ts), and a `.js`
// import would resolve to those instead of the TypeScript source under vite.
import { PiRpcAgent } from "../packages/pi-backend/src/pi-rpc.ts";

const FAKE_PI = fileURLToPath(new URL("./helpers/fake-pi-rpc.mjs", import.meta.url));

const FAKE_ENV_KEYS = [
  "PI_RPC_BIN",
  "FAKE_PI_LOG",
  "FAKE_PI_ARGV_LOG",
  "FAKE_PI_FAIL",
  "FAKE_PI_FAIL_ERROR",
  "FAKE_PI_SETTLE_DELAY_MS",
  "FAKE_PI_UI_REQUEST",
];

type WireFrame = { type: string; [key: string]: unknown };

let workspaceDir: string;
let wireLog: string;
let argvLog: string;
let agent: PiRpcAgent | undefined;

const startAgent = (): PiRpcAgent => {
  process.env["FAKE_PI_LOG"] = wireLog;
  process.env["FAKE_PI_ARGV_LOG"] = argvLog;
  agent = new PiRpcAgent();
  return agent;
};

const readWire = (): WireFrame[] => {
  if (!existsSync(wireLog)) return [];
  return readFileSync(wireLog, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as WireFrame);
};

const readArgv = (): { args: string[] }[] => {
  if (!existsSync(argvLog)) return [];
  return readFileSync(argvLog, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { args: string[] });
};

/** Poll until `predicate` holds — the fake answers in-process, so this is fast. */
const waitFor = async (predicate: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "kagero-pi-rpc-"));
  wireLog = join(workspaceDir, "wire.jsonl");
  argvLog = join(workspaceDir, "argv.jsonl");
  chmodSync(FAKE_PI, 0o755);
  process.env["PI_RPC_BIN"] = FAKE_PI;
});

afterEach(async () => {
  await agent?.dispose();
  agent = undefined;
  for (const key of FAKE_ENV_KEYS) delete process.env[key];
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("PiRpcAgent — native rpc commands (fake pi)", () => {
  it("prompt carries an id; a failed ack fails the turn fast with pi's error text", async () => {
    process.env["FAKE_PI_FAIL"] = "prompt";
    process.env["FAKE_PI_FAIL_ERROR"] = "no slots left";
    const a = startAgent();
    const turn = a.prompt("hi");
    await expect(turn).rejects.toThrow(AgentError);
    await expect(turn).rejects.toThrow(/no slots left/);
    const frames = readWire().filter((f) => f.type === "prompt");
    expect(frames).toHaveLength(1);
    const promptFrame = frames[0];
    const id = promptFrame?.id;
    expect(typeof id).toBe("string");
    expect(String(id).length).toBeGreaterThan(0);
    expect(promptFrame?.message).toBe("hi");
  });

  it("prompt: ack + streamed turn completes with the echoed text, reported model and usage", async () => {
    const a = startAgent();
    const events: AgentEvent[] = [];
    a.subscribe("*", (e) => events.push(e));
    const response = await a.prompt("hello world");
    expect(response.status).toBe("completed");
    expect(response.text).toBe("hello world");
    expect(response.modelId).toBe("fake/fake-model");
    expect(response.modelSource).toBe("reported");
    expect(response.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, reasoningTokens: 2 });
    // Streaming deltas and the final message both arrive as assistant-text.
    expect(events.some((e) => e.type === "assistant-text")).toBe(true);
    // queue_update frames are parsed and discarded — no error leaks out.
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("setModel writes provider + modelId with an id on the wire", async () => {
    const a = startAgent();
    await a.setModel("bifrost", "agnes/agnes-3.0-flash");
    const frame = readWire().find((f) => f.type === "set_model");
    expect(frame).toMatchObject({ provider: "bifrost", modelId: "agnes/agnes-3.0-flash" });
    expect(typeof frame?.["id"]).toBe("string");
  });

  it("setModel rejects with pi's error text when pi answers success:false", async () => {
    // The fake reads its env at spawn, so the failure must be armed first.
    process.env["FAKE_PI_FAIL"] = "set_model";
    process.env["FAKE_PI_FAIL_ERROR"] = "Model not found: bifrost/nope";
    const a = startAgent();
    await expect(a.setModel("bifrost", "nope")).rejects.toThrow(/Model not found/);
  });

  it("a turn with a different modelId set_models in place instead of respawning", async () => {
    const a = startAgent();
    await a.prompt("one");
    const response = await a.prompt("two", { modelId: "agnes/agnes-3.0-flash" });
    expect(response.status).toBe("completed");
    expect(response.text).toBe("two");
    // One spawn only; the switch went over the wire, not through a restart.
    expect(readArgv()).toHaveLength(1);
    const setModel = readWire().find((f) => f.type === "set_model");
    expect(setModel).toMatchObject({ provider: "bifrost", modelId: "agnes/agnes-3.0-flash" });
    // The in-place switch needed the catalog provider lookup first.
    expect(readWire().some((f) => f.type === "get_available_models")).toBe(true);
  });

  it("set_model failure (id not in the catalog) falls back to a respawn with --model", async () => {
    const a = startAgent();
    await a.prompt("one");
    const response = await a.prompt("two", { modelId: "totally-unknown" });
    expect(response.status).toBe("completed");
    const spawns = readArgv();
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.args).toEqual(["--mode", "rpc", "--no-session", "--model", "totally-unknown"]);
    // The catalog lookup ran; no set_model was attempted for an unknown id.
    expect(readWire().some((f) => f.type === "get_available_models")).toBe(true);
    expect(readWire().some((f) => f.type === "set_model")).toBe(false);
  });

  it("steer sends with an id and resolves on the ack while the turn is streaming", async () => {
    process.env["FAKE_PI_SETTLE_DELAY_MS"] = "400";
    const a = startAgent();
    const turn = a.prompt("long running");
    await waitFor(() => readWire().some((f) => f.type === "prompt"), "the prompt to be written");
    await a.send("rpc-1", "hint", "steer");
    const steer = readWire().find((f) => f.type === "steer");
    expect(steer).toMatchObject({ message: "hint" });
    expect(typeof steer?.["id"]).toBe("string");
    await expect(turn).resolves.toMatchObject({ status: "completed", text: "long running" });
  });

  it("get_available_models maps pi's catalog to ModelInfo", async () => {
    const a = startAgent();
    const models = await a.listModels();
    expect(models).toEqual([
      {
        id: "agnes/agnes-3.0-flash",
        displayName: "Agnes 3.0 Flash",
        provider: "bifrost",
        contextWindow: 200000,
        supportsTools: true,
        supportsVision: true,
      },
      {
        id: "fake/fake-model",
        displayName: "Fake Model",
        provider: "fake",
        contextWindow: 0,
        supportsTools: true,
        supportsVision: false,
      },
    ]);
  });

  it("get_state / get_session_stats / get_last_assistant_text return the parsed data", async () => {
    const a = startAgent();
    await expect(a.getState()).resolves.toMatchObject({ isStreaming: false, messageCount: 0 });
    await expect(a.getSessionStats()).resolves.toMatchObject({ totalMessages: 2 });
    await expect(a.getLastAssistantText()).resolves.toMatchObject({ text: "last text" });
    // Every native command write carried a correlation id.
    for (const type of ["get_state", "get_session_stats", "get_last_assistant_text"]) {
      expect(readWire().find((f) => f.type === type)?.["id"]).toBeTruthy();
    }
  });

  it("a 'another turn is already in progress' rejection is reworded into a clear busy error", async () => {
    process.env["FAKE_PI_FAIL"] = "get_state";
    process.env["FAKE_PI_FAIL_ERROR"] = "another turn is already in progress";
    const a = startAgent();
    const outcome = await a.getState().then(
      () => null,
      (e: unknown) => e,
    );
    expect(outcome).toBeInstanceOf(AgentError);
    if (outcome instanceof AgentError) {
      expect(outcome.message).toMatch(/pi is busy.*another turn is already in progress/s);
      expect(outcome.message).toContain("get_state");
    }
  });

  it("extension_ui_request frames are auto-cancelled so dialogs never hang the turn", async () => {
    process.env["FAKE_PI_UI_REQUEST"] = "1";
    const a = startAgent();
    const response = await a.prompt("hi");
    expect(response.status).toBe("completed");
    await waitFor(() => readWire().some((f) => f.type === "extension_ui_response"), "the auto-cancel answer");
    expect(readWire().find((f) => f.type === "extension_ui_response")).toMatchObject({
      id: "ui-1",
      cancelled: true,
    });
  });

  it("resume loads a session file via switch_session, then runs the turn inside it", async () => {
    const a = startAgent();
    const response = await a.resume("/tmp/fake-session.jsonl", "continue");
    expect(response.status).toBe("completed");
    expect(response.text).toBe("continue");
    expect(a.capabilities.resume).toBe(true);
    const frames = readWire();
    const switchAt = frames.findIndex((f) => f.type === "switch_session");
    const promptAt = frames.findIndex((f) => f.type === "prompt");
    expect(switchAt).toBeGreaterThanOrEqual(0);
    expect(promptAt).toBeGreaterThan(switchAt);
    expect(frames[switchAt]).toMatchObject({ sessionPath: "/tmp/fake-session.jsonl" });
  });
});
