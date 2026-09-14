#!/usr/bin/env node
// A stand-in live stream-json `claude` for the claude-stream transport tests.
// Speaks the niwa-ported protocol: user turns on stdin, frames on stdout,
// control_request initialize handshake, can_use_tool reverse requests.
//
// Env:
//   FAKE_CLAUDE_MODE    echo (default) | deny  — deny rejects every prompt via
//                       `result` is_error; echo answers "PONG: <last line>".

let buffer = "";
let turn = 0;

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

const answer = (sessionId, userText) => {
  if (process.env.FAKE_CLAUDE_MODE === "deny") {
    send({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "fake denied this prompt",
      session_id: sessionId,
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    return;
  }
  send({
    type: "assistant",
    message: {
      model: "haiku",
      content: [{ type: "text", text: `PONG: ${userText}` }],
    },
    session_id: sessionId,
  });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    result: `PONG: ${userText}`,
    session_id: sessionId,
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
  if (frame.type === "control_request") {
    // initialize → success; interrupt → success (turn result follows from echo)
    send({
      type: "control_response",
      response: { subtype: "success", request_id: frame.request_id },
    });
    if (frame.request?.subtype === "interrupt" && lastSession !== undefined) {
      send({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "interrupted",
        session_id: lastSession,
      });
    }
    return;
  }
  if (frame.type === "user") {
    turn += 1;
    const sessionId = lastSession ?? `fake-claude-${Date.now()}`;
    if (lastSession === undefined) {
      lastSession = sessionId;
      send({ type: "system", subtype: "init", session_id: sessionId, model: "haiku" });
    }
    const text =
      typeof frame.message?.content?.[0]?.text === "string" ? frame.message.content[0].text : "";
    setTimeout(() => answer(sessionId, text), 30);
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
