#!/usr/bin/env node
// test/helpers/fake-acp-server.mjs — a stand-in ACP agent for AcpClient tests.
//
// Speaks ACP JSON-RPC as NDJSON over stdio. Controlled by env:
//   FAKE_ACP_LOG               every recorded call is appended here as one
//                              NDJSON line; lines are flushed immediately so
//                              records survive even a hard kill of the fake
//   FAKE_ACP_MODE=answer       (default) prompt → two agent_message_chunk
//                              updates ("Hello ", "world") + {stopReason:"end_turn"}
//   FAKE_ACP_MODE=wait         the first prompt holds until session/cancel,
//                              which settles it with {stopReason:"cancelled"};
//                              every later prompt answers "steered:<text>"
//   FAKE_ACP_ASK_PERMISSION=1  send session/request_permission before the first
//                              turn's updates; wait for and log the client's answer
//   FAKE_ACP_STDERR=<text>     written to stderr (plus a newline) when `initialize`
//                              arrives — with FAKE_ACP_HANG_INITIALIZE=1 this is a child
//                              that logs a diagnostic and then never answers
//   FAKE_ACP_RECORD_PID=1      the initialize record also carries {pid} so a test can
//                              check the child is gone after the stop ladder
//   FAKE_ACP_TOOL_CALL=1       also emit one tool_call update before the chunks

import { appendFileSync } from "node:fs";

// `--sid <id>` on argv names the session session/new hands out (default
// sess-fake-1), so concurrent fakes can be told apart.
const sidFlag = process.argv.indexOf("--sid");
const newSessionIdValue = sidFlag === -1 ? "sess-fake-1" : (process.argv[sidFlag + 1] ?? "sess-fake-1");

const mode = process.env.FAKE_ACP_MODE ?? "answer";
const logFile = process.env.FAKE_ACP_LOG;

let sessionId = null;
let promptCount = 0;
let permissionAsked = false;
let pendingPermission = null; // the held turn play, waiting for the permission answer
let heldPromptId = null; // wait mode: the prompt waiting for session/cancel
let permissionId = 1000;

const PERMISSION_OPTIONS = [
  { optionId: "approve_once", name: "Allow once", kind: "allow_once" },
  { optionId: "approve_always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
];

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const rpc = (id, result) => out({ jsonrpc: "2.0", id, result });
const notify = (method, params) => out({ jsonrpc: "2.0", method, params });

const record = (entry) => {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch {
    // A broken log file must not kill the fake.
  }
};

const chunk = (text) =>
  notify("session/update", {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });

const toolCall = () =>
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      toolName: "Write",
      title: "Write a note",
      kind: "edit",
      status: "completed",
      rawInput: { path: "note.md", content: "hi" },
    },
  });

const promptText = (message) =>
  Array.isArray(message.params?.prompt) ? message.params.prompt.map((part) => part?.text ?? "").join("") : "";

const playTurn = (id) => {
  if (process.env.FAKE_ACP_TOOL_CALL === "1") toolCall();
  chunk("Hello ");
  chunk("world");
  rpc(id, { stopReason: "end_turn" });
};

const askPermissionThen = (play) => {
  if (process.env.FAKE_ACP_ASK_PERMISSION === "1" && !permissionAsked) {
    permissionAsked = true;
    permissionId += 1;
    record({ permissionRequest: { id: permissionId, options: PERMISSION_OPTIONS } });
    out({
      jsonrpc: "2.0",
      id: permissionId,
      method: "session/request_permission",
      params: { sessionId, options: PERMISSION_OPTIONS },
    });
    pendingPermission = play;
    return;
  }
  play();
};

function handleRequest(message) {
  const { id, method } = message;
  if (method === "initialize") {
    record({
      method,
      params: message.params ?? null,
      ...(process.env.FAKE_ACP_RECORD_PID === "1" ? { pid: process.pid } : {}),
    });
    if (process.env.FAKE_ACP_STDERR !== undefined) process.stderr.write(`${process.env.FAKE_ACP_STDERR}\n`);
    if (process.env.FAKE_ACP_HANG_INITIALIZE === "1") return;
    rpc(id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    return;
  }
  if (method === "session/new") {
    sessionId = newSessionIdValue;
    record({ method, params: message.params ?? null });
    rpc(id, { sessionId, configOptions: [] });
    return;
  }
  if (method === "session/load") {
    sessionId = message.params?.sessionId ?? sessionId;
    record({ method, params: message.params ?? null });
    rpc(id, { sessionId, configOptions: [] });
    return;
  }
  if (method === "session/set_mode" || method === "session/set_config_option") {
    record({ method, params: message.params ?? null });
    rpc(id, {});
    return;
  }
  if (method === "session/prompt") {
    promptCount += 1;
    const text = promptText(message);
    record({ method, text, notification: id === undefined });
    if (id === undefined) return; // follow_up notification — nothing to settle
    if (mode === "wait") {
      if (promptCount === 1) {
        heldPromptId = id; // hold until session/cancel
      } else {
        chunk(`steered:${text}`);
        rpc(id, { stopReason: "end_turn" });
      }
      return;
    }
    askPermissionThen(() => playTurn(id));
    return;
  }
  if (method === "session/cancel") {
    record({ method, params: message.params ?? null });
    if (heldPromptId !== null) {
      rpc(heldPromptId, { stopReason: "cancelled" });
      heldPromptId = null;
    }
    return;
  }
  out({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(method)}` } });
}

function handleResponse(message) {
  if (pendingPermission !== null && message.id === permissionId) {
    record({ permissionResponse: message.result ?? message.error ?? null });
    const play = pendingPermission;
    pendingPermission = null;
    play();
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  buffer += data;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line !== "") ingest(line);
  }
});

function ingest(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message.method === "string") handleRequest(message);
  else handleResponse(message);
}

process.on("SIGTERM", () => process.exit(0));
