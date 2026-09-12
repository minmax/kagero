// Parser tests for kimi's print transport (`kimi -p --output-format
// stream-json`): kimi emits NDJSON role-lines, not claude-lineage envelopes.
// Every fixture line below is copied from the proven kimi-cli-mcp fake
// (test/fixtures/fake-kimi.mjs) and its print transport
// (src/transport/print.ts). No real CLI is executed.
import { describe, expect, it } from "vitest";
import { parseKimiRoles } from "../packages/cli-backend/src/parse/kimi-roles.js";
import kimiSpec from "../packages/cli-backend/src/specs/kimi.js";

// fake-kimi.mjs happyPrint(): version meta, resume hint, narration + tool
// call, tool result, then the answer.
const HAPPY_STREAM = [
  JSON.stringify({ role: "meta", type: "system.version", version: "0.41.0" }),
  JSON.stringify({
    role: "meta",
    type: "session.resume_hint",
    session_id: "session_abc123",
    command: "kimi -S session_abc123",
    content: "To resume this session: kimi -S session_abc123",
  }),
  JSON.stringify({
    role: "assistant",
    content: "NARRATION: I'll check that for you.",
    tool_calls: [
      { type: "function", id: "c1", function: { name: "Write", arguments: '{"path":"note.md"}' } },
    ],
  }),
  JSON.stringify({ role: "tool", tool_call_id: "c1", content: "wrote note.md" }),
  JSON.stringify({ role: "assistant", content: "FINAL ANSWER" }),
].join("\n");

describe("parseKimiRoles", () => {
  it("answers with the LAST assistant content and takes the session from resume_hint", () => {
    const run = parseKimiRoles(HAPPY_STREAM);
    expect(run.text).toBe("FINAL ANSWER");
    expect(run.sessionId).toBe("session_abc123");
    // No result envelope exists in this format — assistant text means complete.
    expect(run.partial).toBeUndefined();
    expect(run.modelId).toBeUndefined();
    expect(run.usage).toBeUndefined();
  });

  it("parses the last line without a trailing newline (kimi EOF-terminated streams)", () => {
    const stdout = `${HAPPY_STREAM}\n${JSON.stringify({ role: "assistant", content: "EOF TERMINATED ANSWER" })}`;
    const run = parseKimiRoles(stdout);
    expect(run.text).toBe("EOF TERMINATED ANSWER");
    expect(run.sessionId).toBe("session_abc123");
  });

  it("reports usage and model only when kimi attaches them to assistant lines", () => {
    const stdout = [
      JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "s1" }),
      JSON.stringify({
        role: "assistant",
        content: "part one",
        model: "k2",
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
      JSON.stringify({
        role: "assistant",
        content: "part two",
        usage: { input_tokens: 50, output_tokens: 5 },
      }),
    ].join("\n");
    const run = parseKimiRoles(stdout);
    expect(run.text).toBe("part two");
    expect(run.modelId).toBe("k2");
    expect(run.usage).toEqual({ inputTokens: 150, outputTokens: 15 });
  });

  it("skips unknown meta types, unknown roles and stdout noise without failing", () => {
    // fake-kimi.mjs unknown_result mode emits {"role":"meta","type":"exploded"}.
    const stdout = [
      "this is not json",
      JSON.stringify({ role: "meta", type: "exploded" }),
      JSON.stringify({ role: "user", content: "SECRET_PROMPT_BODY" }),
      JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "s2" }),
      JSON.stringify({
        role: "assistant",
        tool_calls: [{ type: "function", id: "c1", function: { name: "Bash", arguments: "{}" } }],
      }),
      JSON.stringify({ role: "assistant", content: "RECOVERED" }),
    ].join("\n");
    const run = parseKimiRoles(stdout);
    expect(run.text).toBe("RECOVERED");
    expect(run.sessionId).toBe("s2");
    expect(run.partial).toBeUndefined();
  });

  it("treats an empty or garbage stream as an empty partial run with no session", () => {
    for (const stdout of ["", "neither is this\nnor this"]) {
      const run = parseKimiRoles(stdout);
      expect(run.text).toBe("");
      expect(run.sessionId).toBeUndefined();
      expect(run.partial).toBe(true);
    }
  });

  it("spec wiring: kimi print.parse reads role-lines (not claude-lineage envelopes)", () => {
    const parse = kimiSpec.print?.parse;
    if (parse === undefined) throw new Error("kimi spec declares no print transport");
    const run = parse(HAPPY_STREAM, "", {
      status: "completed",
      exitCode: 0,
      signal: null,
      stdout: HAPPY_STREAM,
      stderr: "",
      durationMs: 1,
      truncated: false,
    });
    expect(run.text).toBe("FINAL ANSWER");
    expect(run.sessionId).toBe("session_abc123");
  });
});
