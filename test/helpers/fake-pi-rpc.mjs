#!/usr/bin/env node
// test/helpers/fake-pi-rpc.mjs — a stand-in `pi --mode rpc` for PiRpcAgent
// tests. Speaks the real pi rpc wire (rpc.md): one NDJSON command per stdin
// line, every command answered by a correlated
// `{id, type:"response", command, success}` ack, prompt turns streamed as
// scripted events until `agent_settled`. The fake logs EVERY line it receives
// to FAKE_PI_LOG so tests can assert the exact frames the client wrote
// (ids, params, extension_ui_response).
//
// Controlled by env:
//   FAKE_PI_LOG              received stdin lines are appended here as NDJSON
//   FAKE_PI_ARGV_LOG         the received argv is appended here once at startup
//   FAKE_PI_FAIL             comma-separated command types to reject
//                            (success:false) with FAKE_PI_FAIL_ERROR
//   FAKE_PI_FAIL_ERROR       the error text for rejected commands
//                            (default "rejected by fake pi")
//   FAKE_PI_SETTLE_DELAY_MS  delay the scripted turn events by this long
//                            (keeps the agent "streaming" for steer tests)
//   FAKE_PI_UI_REQUEST=1     emit an extension_ui_request dialog right after
//                            the prompt ack (the client must auto-cancel it)

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const logFile = process.env.FAKE_PI_LOG;
const argvLogFile = process.env.FAKE_PI_ARGV_LOG;
const failCommands = new Set(
  (process.env.FAKE_PI_FAIL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const failError = process.env.FAKE_PI_FAIL_ERROR ?? "rejected by fake pi";
const settleDelayMs = Number(process.env.FAKE_PI_SETTLE_DELAY_MS ?? "0");
const emitUiRequest = process.env.FAKE_PI_UI_REQUEST === "1";

const append = (file, entry) => {
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // A broken log file must not kill the fake.
  }
};
append(argvLogFile, { args });

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

// get_available_models catalog: one image-capable model WITH a context window
// and one text-only model WITHOUT one (the client maps that to 0).
const CATALOG = [
  {
    id: "agnes/agnes-3.0-flash",
    name: "Agnes 3.0 Flash",
    provider: "bifrost",
    contextWindow: 200000,
    input: ["text", "image"],
    reasoning: true,
  },
  {
    id: "fake/fake-model",
    name: "Fake Model",
    provider: "fake",
    input: ["text"],
  },
];

function runTurn(message) {
  const emit = () => {
    out({ type: "agent_start" });
    out({ type: "turn_start" });
    out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: message } });
    // Exercise the client's parse-and-discard path: queue states have no mapping.
    out({ type: "queue_update", steering: [], followUp: [] });
    out({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: message }],
        stopReason: "stop",
        model: "fake/fake-model",
        usage: { input: 10, output: 5, reasoning: 2 },
      },
    });
    out({ type: "agent_settled" });
  };
  if (settleDelayMs > 0) setTimeout(emit, settleDelayMs);
  else emit();
}

function respond(cmd, success, extra = {}) {
  out({ id: cmd.id, type: "response", command: cmd.type, success, ...extra });
}

function handleCommand(cmd) {
  if (failCommands.has(cmd.type)) {
    respond(cmd, false, { error: failError });
    return;
  }
  switch (cmd.type) {
    case "prompt": {
      respond(cmd, true);
      if (emitUiRequest) {
        out({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow?" });
      }
      runTurn(cmd.message ?? "");
      return;
    }
    case "get_available_models":
      respond(cmd, true, { data: { models: CATALOG } });
      return;
    case "set_model":
      respond(cmd, true, { data: { id: cmd.modelId, name: cmd.modelId, provider: cmd.provider } });
      return;
    case "get_state":
      respond(cmd, true, {
        data: { isStreaming: false, model: null, messageCount: 0, sessionId: "fake-state" },
      });
      return;
    case "get_session_stats":
      respond(cmd, true, { data: { totalMessages: 2, cost: 0.01 } });
      return;
    case "get_last_assistant_text":
      respond(cmd, true, { data: { text: "last text" } });
      return;
    case "switch_session":
      respond(cmd, true, { data: { cancelled: false } });
      return;
    default:
      respond(cmd, true);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  // rpc.md framing: strict JSONL, split on LF only.
  let nl = buffer.indexOf("\n");
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf("\n");
    if (line === "") continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    append(logFile, cmd);
    if (cmd.type === "extension_ui_response") continue; // logged, nothing to answer
    handleCommand(cmd);
  }
});
process.stdin.on("end", () => process.exit(0));
