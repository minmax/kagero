#!/usr/bin/env node
// A stand-in live stream-json `claude` for the claude-stream transport tests.
// Speaks the niwa-ported protocol: user turns on stdin, frames on stdout,
// control_request initialize handshake, can_use_tool reverse requests,
// native control subtypes (echoed back with success + the requested subtype).
//
// Env:
//   FAKE_CLAUDE_MODE    echo (default) | deny  — deny rejects every prompt via
//                       `result` is_error; echo answers "PONG: <last line>".

import { appendFileSync } from "node:fs";

const record = (event) => {
  if (process.env.FAKE_CLAUDE_FRAME_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_FRAME_LOG, `${event}\n`);
  }
};

let buffer = "";
let turn = 0;
let reverseSeq = 0;
let lastReverseRequestId;
let lastReverseReply;

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const sessionField = (sessionId) => (process.env.FAKE_CLAUDE_NO_SESSION === "1" ? {} : { session_id: sessionId });

const answer = (sessionId, userText) => {
  if (process.env.FAKE_CLAUDE_MODE === "deny") {
    send({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "fake denied this prompt",
      ...sessionField(sessionId),
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    return;
  }
  // Tag the answer with the reply the boundary sent for our reverse
  // control_request, so tests can assert the response shape end-to-end.
  const reverseTag =
    lastReverseReply === undefined
      ? ""
      : ` [reverse:${lastReverseReply.subtype}:${lastReverseReply.error ?? ""}]`;
  send({
    type: "assistant",
    message: {
      model: "haiku",
      content: [{ type: "text", text: `PONG: ${userText}${reverseTag}` }],
    },
    ...sessionField(sessionId),
  });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `PONG: ${userText}`,
    ...sessionField(sessionId),
    usage: { input_tokens: 10, output_tokens: 2 },
  });
};

const onLine = (line) => {
  if (line.trim() === "") return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (frame.type === "control_response") {
    // A reply to OUR reverse control_request — record it for the answer tag.
    if (lastReverseRequestId !== undefined && frame.response?.request_id === lastReverseRequestId) {
      lastReverseReply = frame.response;
    }
    return;
  }
  if (frame.type === "control_request") {
    const subtype = frame.request?.subtype;
    if (subtype === "interrupt") record("interrupt");
    // interrupt → success receipt (only when cancel_queued rode the wire)
    // plus the result frame the cancelled turn delivers on its own.
    if (subtype === "interrupt") {
      const receipt =
        frame.request?.cancel_queued === true
          ? { still_queued: [], cancelled: ["fake-msg-interrupted"] }
          : {};
      send({
        type: "control_response",
        response: { subtype: "success", request_id: frame.request_id, response: receipt },
      });
      if (lastSession !== undefined) {
        send({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "interrupted",
          ...sessionField(lastSession),
        });
      }
      return;
    }
    // Generic echo: success + the requested subtype, so tests can prove which
    // control shape hit the wire.
    send({
      type: "control_response",
      response: { subtype: "success", request_id: frame.request_id, echoed_subtype: subtype },
    });
    if (subtype === "initialize") {
      // Poke one reverse control_request the boundary must classify.
      reverseSeq += 1;
      lastReverseRequestId = `fake-reverse-${reverseSeq}`;
      send({
        type: "control_request",
        request_id: lastReverseRequestId,
        request: { subtype: "hook_callback", hook_name: "PreToolUse" },
      });
    }
    if (subtype === "set_model" && typeof frame.request?.model === "string") {
      const sessionId = lastSession ?? `fake-claude-${Date.now()}`;
      lastSession = sessionId;
      send({
        type: "assistant",
        message: {
          model: frame.request.model,
          content: [{ type: "text", text: `[model set: ${frame.request.model}]` }],
        },
        ...sessionField(sessionId),
      });
    }
    return;
  }
  if (frame.type === "user") {
    record("user");
    turn += 1;
    const sessionId = lastSession ?? `fake-claude-${Date.now()}`;
    if (lastSession === undefined) {
      lastSession = sessionId;
      send({ type: "system", subtype: "init", ...sessionField(sessionId), model: "haiku" });
    }
    const text =
      typeof frame.message?.content?.[0]?.text === "string" ? frame.message.content[0].text : "";
    const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 30);
    setTimeout(() => answer(sessionId, text), delayMs);
  }
};

let lastSession;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    onLine(line);
  }
});
process.stdin.on("end", () => {
  // Grace: flush pending answer timers before dying.
  setTimeout(() => process.exit(0), 1500);
});
