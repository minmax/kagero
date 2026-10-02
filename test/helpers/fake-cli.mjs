#!/usr/bin/env node
// test/helpers/fake-cli.mjs — a stand-in headless CLI for CliSpecAgent tests.
//
// Speaks the claude-lineage stream-json (mode "claude"), codex exec JSONL
// (mode "codex"), plain-text (mode "dsh"), or just sleeps (mode "sleep").
// Controlled by env:
//   FAKE_CLI_ARGV_LOG         the received argv (+ cwd) is appended here as
//                             one NDJSON line, immediately, so records
//                             survive even a killed fake
//   FAKE_CLI_MODE=claude      (default) stream-json envelopes: system/init,
//                             assistant text, result with usage; the answer
//                             echoes the prompt so tests can assert delivery
//   FAKE_CLI_MODE=codex       codex JSONL: thread.started, item.completed
//                             agent_message, turn.completed with usage
//   FAKE_CLI_MODE=dsh         dsh-headless-bridge RunReport: one JSON line
//                             ({status,text,sessionId,model,durationMs}) on
//                             stdout; status "error" with FAKE_CLI_RESULT_ERROR
//   FAKE_CLI_MODE=claude-error  claude stream-json that FAILS: assistant text, then a
//                             `result` envelope with is_error whose `result` is
//                             FAKE_CLI_ERROR_TEXT + the prompt echo + FAKE_CLI_ERROR_PAD
//                             filler; stderr stays empty (pair with FAKE_CLI_EXIT_CODE=1)
//   FAKE_CLI_MODE=sleep       hold for FAKE_CLI_SLEEP_MS ms, then print "late"
//   FAKE_CLI_REPORT_MODEL=0   emit no model anywhere (requested-echo test)
//   FAKE_CLI_NO_RESULT=1      omit the result envelope (partial test)
//   FAKE_CLI_RESULT_ERROR=1   result envelope with is_error (AgentError test)
//   FAKE_CLI_EXIT_CODE        exit with this code after printing (exit-error)
//   FAKE_CLI_STDERR           text to write to stderr before exiting

import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_CLI_MODE ?? "claude";
const logFile = process.env.FAKE_CLI_ARGV_LOG;
const args = process.argv.slice(2);

const record = (entry) => {
  if (!logFile) return;
  try {
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
  } catch {
    // A broken log file must not kill the fake.
  }
};
record({ cwd: process.cwd(), args });

const out = (text) => process.stdout.write(text);
const flagValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

function claudeStream() {
  const resume = flagValue("--resume");
  const sessionId = resume ?? flagValue("--session-id") ?? "sess-fake-1";
  const model = flagValue("--model");
  const prompt = args[args.length - 1] ?? "FAKE-ANSWER";
  const reportModel = process.env.FAKE_CLI_REPORT_MODEL !== "0";
  const reportedModel = model ?? "fake-default-model";

  const lines = [];
  lines.push({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    ...(reportModel ? { model: reportedModel } : {}),
  });
  lines.push({
    type: "assistant",
    message: {
      role: "assistant",
      ...(reportModel ? { model: reportedModel } : {}),
      content: [{ type: "text", text: prompt }],
    },
    session_id: sessionId,
  });
  if (process.env.FAKE_CLI_NO_RESULT !== "1") {
    const isError = process.env.FAKE_CLI_RESULT_ERROR === "1";
    lines.push({
      type: "result",
      subtype: isError ? "error_max_turns" : "success",
      is_error: isError,
      ...(isError ? { error: { message: "reached the turn limit" } } : { result: prompt }),
      session_id: sessionId,
      duration_ms: 5,
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      },
      ...(reportModel
        ? {
            modelUsage: {
              [reportedModel]: {
                inputTokens: 11,
                outputTokens: 7,
                cacheReadInputTokens: 3,
                cacheCreationInputTokens: 4,
                costUSD: 0.01,
              },
            },
          }
        : {}),
      ...(reportModel ? { total_cost_usd: 0.01 } : {}),
    });
  }
  out(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

function codexStream() {
  const prompt = args[args.length - 1] ?? "CODEX-ANSWER";
  const threadId = "thr-fake-1";
  const lines = [
    { type: "thread.started", thread_id: threadId },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "agent_message", text: prompt } },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 20,
        cached_input_tokens: 5,
        cache_write_input_tokens: 2,
        output_tokens: 9,
        reasoning_output_tokens: 4,
      },
    },
  ];
  out(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

if (mode === "claude") {
  claudeStream();
} else if (mode === "codex") {
  codexStream();
} else if (mode === "dsh") {
  // dsh-headless-bridge contract: bridge flags first, the variadic task last,
  // exactly one RunReport JSON line on stdout.
  const flagWithValue = new Set(["--profile", "--model", "--session", "--patch"]);
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (flagWithValue.has(args[i])) {
      i += 1;
      continue;
    }
    if (args[i] === "--json") continue;
    positional.push(args[i]);
  }
  const task = positional.join(" ") || "no task";
  const report =
    process.env.FAKE_CLI_RESULT_ERROR === "1"
      ? { status: "error", text: "", error: { code: "fake", message: "fake dsh error" } }
      : {
          status: "completed",
          text: task,
          sessionId: "fake-dsh-session",
          ...(process.env.FAKE_CLI_REPORT_MODEL === "0"
            ? {}
            : { model: { provider: "minimax", model: "MiniMax-M3" } }),
          durationMs: 1,
        };
  out(`${JSON.stringify(report)}\n`);
} else if (mode === "claude-error") {
  const prompt = args[args.length - 1] ?? "";
  const pad = "x".repeat(Number(process.env.FAKE_CLI_ERROR_PAD ?? "0"));
  const lines = [
    { type: "system", subtype: "init", session_id: "sess-fake-err" },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "ASSISTANT-TEXT-NOT-AN-ERROR-FIELD" }] },
    },
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: `${process.env.FAKE_CLI_ERROR_TEXT ?? "failed"} [prompt: ${prompt}] ${pad}`,
      session_id: "sess-fake-err",
    },
  ];
  out(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
} else if (mode === "sleep") {
  const ms = Number(process.env.FAKE_CLI_SLEEP_MS ?? "2000");
  // NOTE: no .unref() — the whole point is to keep the process alive.
  setTimeout(() => out("late\n"), ms);
} else {
  out("unknown mode\n");
}

if (process.env.FAKE_CLI_STDERR !== undefined) {
  process.stderr.write(process.env.FAKE_CLI_STDERR);
}
const exitCode = process.env.FAKE_CLI_EXIT_CODE;
if (exitCode !== undefined) {
  process.exit(Number(exitCode));
}
