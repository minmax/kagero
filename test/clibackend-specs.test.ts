// Spec-level tests: honest capability derivation per built-in spec, exact argv
// shapes for dsh/claude/codex/qwen/grok/kimi/mcode, and the parser behaviors
// each spec relies on. No real CLI is executed.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AgentError } from "@kagero/core";
import { deriveCapabilities } from "@kagero/cli-backend";
import type { PromptContext } from "@kagero/cli-backend";
import claudeSpec from "../packages/cli-backend/src/specs/claude.js";
import codexSpec from "../packages/cli-backend/src/specs/codex.js";
import dshSpec from "../packages/cli-backend/src/specs/dsh.js";
import grokSpec from "../packages/cli-backend/src/specs/grok.js";
import kimiSpec from "../packages/cli-backend/src/specs/kimi.js";
import mcodeSpec from "../packages/cli-backend/src/specs/mcode.js";
import { qwenPromptArg } from "../packages/cli-backend/src/specs/qwen.js";
import qwenSpec from "../packages/cli-backend/src/specs/qwen.js";
import { parseClaudeLineage } from "../packages/cli-backend/src/parse/claude-lineage.js";
import { parseCodexJsonl } from "../packages/cli-backend/src/parse/codex-jsonl.js";
import { parseMcodeExec } from "../packages/cli-backend/src/parse/mcode-exec.js";

const ctx = (overrides: Partial<PromptContext> & { prompt: string }): PromptContext => ({
  opts: {},
  mode: "prompt",
  workspace: "/ws",
  ...overrides,
});

describe("deriveCapabilities — honest defaults per built-in spec", () => {
  it("dsh: print-only, no resume/models/sessions/history, wrapper timeout", () => {
    const caps = deriveCapabilities(dshSpec);
    expect(caps).toMatchObject({
      resume: false,
      models: false,
      sessions: false,
      history: false,
      abort: true,
      steer: false,
      followUp: false,
      workspaceCreate: true,
    });
    expect(caps.limits).toEqual({ timeout: true, maxTurns: false, maxToolCalls: false });
  });

  it("claude/codex: resume via print, history reader, maxTurns only for claude", () => {
    for (const spec of [claudeSpec, codexSpec]) {
      const caps = deriveCapabilities(spec);
      expect(caps.resume).toBe(true);
      expect(caps.history).toBe(true);
      expect(caps.steer).toBe(false);
      expect(caps.followUp).toBe(false);
      expect(caps.models).toBe(false);
      expect(caps.limits.timeout).toBe(true);
    }
    expect(deriveCapabilities(claudeSpec).limits.maxTurns).toBe(true);
    expect(deriveCapabilities(codexSpec).limits.maxTurns).toBe(false);
  });

  it("qwen/grok/kimi/mcode: ACP default implies steer/followUp/resume", () => {
    for (const spec of [qwenSpec, grokSpec, kimiSpec, mcodeSpec]) {
      const caps = deriveCapabilities(spec);
      expect(spec.defaultTransport).toBe("acp");
      expect(caps.resume).toBe(true);
      expect(caps.steer).toBe(true);
      expect(caps.followUp).toBe(true);
      expect(caps.abort).toBe(true);
      expect(caps.subscribe).toBe(true);
      expect(caps.limits.timeout).toBe(true);
    }
  });

  it("models capability follows the models strategy", () => {
    expect(deriveCapabilities(qwenSpec).models).toBe(false);
    expect(deriveCapabilities(grokSpec).models).toBe(true);
    expect(deriveCapabilities(kimiSpec).models).toBe(true);
    expect(deriveCapabilities(mcodeSpec).models).toBe(true);
  });

  it("explicit spec.capabilities win over the derivation", () => {
    const caps = deriveCapabilities({
      name: "x",
      binary: "x",
      capabilities: { resume: true, models: false },
      print: {
        resumeCapable: false,
        args: (c) => [c.prompt],
        parse: () => ({ text: "" }),
      },
    });
    expect(caps.resume).toBe(true);
    expect(caps.models).toBe(false);
  });
});

// --- dsh ---------------------------------------------------------------------------

describe("dsh spec", () => {
  it("builds the headless argv: --profile headless + positional task", () => {
    const args = dshSpec.print?.args(ctx({ prompt: "run the tests" }));
    expect(args).toEqual(["--profile", "headless", "run the tests"]);
  });

  it("refuses modelId with a settings.yaml/--patch hint", () => {
    let caught: unknown;
    try {
      dshSpec.print?.args(ctx({ prompt: "x", opts: { modelId: "MiniMax-M3" } }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentError);
    const err = caught as AgentError;
    expect(err.code).toBe("unsupported_capability");
    expect(err.message).toContain("settings.yaml");
  });

  it("takes stdout as the answer, minus the single trailing newline", () => {
    const parsed = dshSpec.print?.parse?.("Hi\n", "dsh: reasoning:\nnoise", {
      status: "completed",
      exitCode: 0,
      signal: null,
      stdout: "Hi\n",
      stderr: "",
      durationMs: 1,
      truncated: false,
    });
    expect(parsed?.text).toBe("Hi");
    expect(parsed?.sessionId).toBeUndefined();
    expect(parsed?.modelId).toBeUndefined();
  });
});

// --- claude ------------------------------------------------------------------------

describe("claude spec", () => {
  it("builds print argv: -p prompt, stream-json, model, max-turns, yolo", () => {
    const args = claudeSpec.print?.args(
      ctx({ prompt: "hi there", opts: { modelId: "haiku", maxTurns: 3, approvalMode: "yolo" } }),
    );
    expect(args).toEqual([
      "-p",
      "hi there",
      "--output-format",
      "stream-json",
      "--model",
      "haiku",
      "--max-turns",
      "3",
      "--dangerously-skip-permissions",
    ]);
  });

  it("adds nothing for approval default and no limits", () => {
    const args = claudeSpec.print?.args(ctx({ prompt: "hi" }));
    expect(args).toEqual(["-p", "hi", "--output-format", "stream-json"]);
  });

  it("resumes with --resume <id>", () => {
    const args = claudeSpec.print?.args(
      ctx({ prompt: "hi", mode: "resume", sessionId: "abc-123" }),
    );
    expect(args).toContain("--resume");
    expect(args).toContain("abc-123");
  });

  it("maps the claude usage style through the lineage parser", () => {
    const result = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done",
      session_id: "s1",
      duration_ms: 42,
      total_cost_usd: 0.05,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 20,
        output_tokens_details: { thinking_tokens: 2 },
      },
      modelUsage: { "claude-haiku-4-5-20251001": { costUSD: 0.05 } },
    });
    const parsed = parseClaudeLineage(result, { usageStyle: "claude" });
    expect(parsed.text).toBe("done");
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.modelId).toBe("claude-haiku-4-5-20251001");
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      reasoningTokens: 2,
      costUsd: 0.05,
    });
  });
});

// --- codex ---------------------------------------------------------------------------

describe("codex spec", () => {
  it("builds fresh exec argv: --json --skip-git-repo-check, yolo bypass, prompt last", () => {
    const args = codexSpec.print?.args(
      ctx({ prompt: "say hi", opts: { approvalMode: "yolo" } }),
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "say hi",
    ]);
  });

  it("builds model argv with --model before the prompt", () => {
    const args = codexSpec.print?.args(ctx({ prompt: "say hi", opts: { modelId: "gpt-5.6-luna" } }));
    expect(args).toEqual(["exec", "--json", "--skip-git-repo-check", "--model", "gpt-5.6-luna", "say hi"]);
  });

  it("resume: exec resume <id> — no cwd/sandbox flags, no bypass", () => {
    const args = codexSpec.print?.args(
      ctx({ prompt: "go on", mode: "resume", sessionId: "thr-9", opts: { approvalMode: "yolo" } }),
    );
    expect(args).toEqual(["exec", "resume", "thr-9", "go on"]);
  });

  it("parses codex JSONL: thread id, last agent_message, cumulative usage", () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thr-1" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "error", message: "noise" } }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "first" } }),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "final" } }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 20, cached_input_tokens: 5, cache_write_input_tokens: 2, output_tokens: 9, reasoning_output_tokens: 4 },
      }),
      "",
    ].join("\n");
    const parsed = parseCodexJsonl(stdout);
    expect(parsed.text).toBe("final");
    expect(parsed.sessionId).toBe("thr-1");
    expect(parsed.modelId).toBeUndefined(); // codex never reports the model in JSONL
    expect(parsed.partial).toBeUndefined();
    expect(parsed.usage).toEqual({
      inputTokens: 20,
      outputTokens: 9,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      reasoningTokens: 4,
    });
  });

  it("throws on turn.failed and marks a stream without turn.completed partial", () => {
    const failed = JSON.stringify({ type: "turn.failed", error: { message: "provider down" } });
    let caught: unknown;
    try {
      parseCodexJsonl(failed);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toContain("provider down");

    const partial = parseCodexJsonl(JSON.stringify({ type: "thread.started", thread_id: "thr-2" }));
    expect(partial.partial).toBe(true);
    expect(partial.sessionId).toBe("thr-2");
  });
});

// --- qwen / kimi / mcode / grok argv shapes --------------------------------------------

describe("qwen spec", () => {
  it("carries the prompt with -p, or the equals form for dash-leading text", () => {
    expect(qwenPromptArg("normal")).toEqual(["-p", "normal"]);
    expect(qwenPromptArg("-dash leading")).toEqual(["--prompt=-dash leading"]);
  });

  it("refuses oversize prompts with an ACP hint", () => {
    let caught: unknown;
    try {
      qwenPromptArg("x".repeat(100_001));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentError);
    expect((caught as AgentError).message).toContain('transport "acp"');
  });

  it("names the session upfront: --session-id fresh, --resume after", () => {
    const fresh = qwenSpec.print?.args(ctx({ prompt: "hi", runSessionId: "gen-1", opts: { modelId: "m" } }));
    expect(fresh).toEqual(["--model", "m", "--session-id", "gen-1", "-p", "hi"]);
    const resume = qwenSpec.print?.args(ctx({ prompt: "hi", mode: "resume", sessionId: "gen-1" }));
    expect(resume).toEqual(["--resume", "gen-1", "-p", "hi"]);
  });
});

describe("kimi spec", () => {
  it("builds print argv: [-m M] --output-format stream-json [-S id] -p prompt", () => {
    const fresh = kimiSpec.print?.args(ctx({ prompt: "hi", opts: { modelId: "k2" } }));
    expect(fresh).toEqual(["-m", "k2", "--output-format", "stream-json", "-p", "hi"]);
    const resume = kimiSpec.print?.args(ctx({ prompt: "hi", mode: "resume", sessionId: "s7" }));
    expect(resume).toEqual(["--output-format", "stream-json", "-S", "s7", "-p", "hi"]);
  });

  it("parses the provider catalog into ModelInfo ids", () => {
    const models = kimiSpec.models?.parse(
      JSON.stringify({ models: { "kimi-k2": {}, "kimi-linear": {} }, defaultModel: "kimi-k2" }),
    );
    expect(models?.map((m) => m.id)).toEqual(["kimi-k2", "kimi-linear"]);
  });
});

describe("mcode spec", () => {
  it("builds exec argv with --cwd, yolo permission, --session resume, --timeout, -- prompt", () => {
    const fresh = mcodeSpec.print?.args(
      ctx({ prompt: "do it", opts: { approvalMode: "yolo", timeoutMs: 1200 } }),
    );
    expect(fresh).toEqual([
      "exec",
      "--output-format",
      "stream-json",
      "--cwd",
      "/ws",
      "--permission",
      "full",
      "--timeout",
      "1200ms",
      "--",
      "do it",
    ]);
    const resume = mcodeSpec.print?.args(
      ctx({ prompt: "do it", mode: "resume", sessionId: "mc-1" }),
    );
    expect(resume).toEqual([
      "exec",
      "--output-format",
      "stream-json",
      "--cwd",
      "/ws",
      "--session",
      "mc-1",
      "--",
      "do it",
    ]);
  });

  it("maps approval to ACP permissionMode (yolo → bypassPermissions)", () => {
    const options = mcodeSpec.acp?.configOptions?.(ctx({ prompt: "x", opts: { approvalMode: "yolo", modelId: "m" } }));
    expect(options).toEqual([
      { configId: "permissionMode", value: "bypassPermissions" },
      { configId: "model", value: "m" },
    ]);
    expect(mcodeSpec.acp?.configOptions?.(ctx({ prompt: "x" }))).toEqual([]);
  });

  it("parses provider list --json into provider/model ids", () => {
    const models = mcodeSpec.models?.parse(
      JSON.stringify({
        providers: [
          { providerId: "minimax", name: "MiniMax", active: true, models: ["MiniMax-M3", { modelId: "M2.7", selected: true }] },
        ],
      }),
    );
    expect(models?.map((m) => m.id)).toEqual(["minimax/MiniMax-M3", "minimax/M2.7"]);
  });

  it("parses exec stream-json: answer from item.completed, model ref, usage", () => {
    const stdout = [
      JSON.stringify({ type: "session.started", sessionId: "mc-s1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", content: "the answer" } }),
      JSON.stringify({
        type: "exec.completed",
        result: {
          status: "succeeded",
          sessionId: "mc-s1",
          output: "the answer",
          usage: { inputTokens: 12, outputTokens: 3 },
          durationMs: 55,
          model: { providerId: "minimax", modelId: "MiniMax-M3" },
        },
      }),
      "",
    ].join("\n");
    const parsed = parseMcodeExec(stdout);
    expect(parsed.text).toBe("the answer");
    expect(parsed.sessionId).toBe("mc-s1");
    expect(parsed.modelId).toBe("minimax/MiniMax-M3");
    expect(parsed.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
  });

  it("maps limit_exceeded to an AgentError through the shared is_error path", () => {
    const stdout = JSON.stringify({
      type: "exec.completed",
      result: { status: "limit_exceeded", sessionId: "mc-s1", output: "partial" },
    });
    let caught: unknown;
    try {
      parseMcodeExec(stdout);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AgentError);
  });
});

describe("grok spec", () => {
  it("carries the prompt via a workspace temp file and cleans it up after the run", () => {
    const workspace = mkdtempSync(join(tmpdir(), "kagero-grok-spec-"));
    try {
      const promptCtx = ctx({
        prompt: "- leading dash prompt",
        workspace,
        runSessionId: "gen-grok-1",
        opts: { modelId: "grok-4" },
      });
      const args = grokSpec.print?.args(promptCtx);
      expect(args?.[0]).toBe("--prompt-file");
      const promptFile = args?.[1] ?? "";
      expect(promptFile.startsWith(workspace)).toBe(true);
      expect(existsSync(promptFile)).toBe(true);
      expect(args).toContain("--output-format");
      expect(args).toContain("streaming-messages-json");
      expect(args).toContain("--model");
      expect(args).toContain("grok-4");
      // yolo → --always-approve; workspace rides on --cwd.
      expect(args).toContain("--always-approve");
      expect(args?.[args.indexOf("--cwd") + 1]).toBe(workspace);
      expect(args).toContain("--session-id");

      grokSpec.print?.cleanup?.(promptCtx, args ?? []);
      expect(existsSync(promptFile)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("parses the text model catalog (bullets, default marks, dedup)", () => {
    const stdout = "* grok-4.6 (default)\n- grok-4.6\n  - grok-3-mini\n";
    const models = grokSpec.models?.parse(stdout);
    expect(models?.map((m) => m.id)).toEqual(["grok-4.6", "grok-3-mini"]);
  });

  it("sends yoloMode in ACP _meta and speaks the string protocolVersion", () => {
    expect(grokSpec.acp?.protocolVersion).toBe("1");
    const meta = grokSpec.acp?.sessionMeta?.(ctx({ prompt: "x", opts: { approvalMode: "yolo" } }));
    expect(meta).toEqual({ yoloMode: true });
  });
});

// --- shared lineage parser behaviors ---------------------------------------------------

describe("claude-lineage parser (shared fold)", () => {
  it("falls back to the last assistant text and marks partial without a result envelope", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1", model: "m1" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "m2", content: [{ type: "text", text: "cut off" }] } }),
      "",
    ].join("\n");
    const parsed = parseClaudeLineage(stdout, { usageStyle: "grok" });
    expect(parsed.text).toBe("cut off");
    expect(parsed.partial).toBe(true);
    expect(parsed.modelId).toBe("m2");
  });

  it("never takes the answer from user/tool_result lines", () => {
    const stdout = [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "NOT THE ANSWER" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "answer", session_id: "s" }),
    ].join("\n");
    expect(parseClaudeLineage(stdout).text).toBe("answer");
  });

  it("reads modelUsage only when it names a single model, else the last assistant model", () => {
    const multi = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "assistant-model", content: [] } }),
      JSON.stringify({
        type: "result",
        is_error: false,
        result: "",
        session_id: "s",
        modelUsage: { "model-a": {}, "model-b": {} },
      }),
    ].join("\n");
    expect(parseClaudeLineage(multi).modelId).toBe("assistant-model");
    const single = JSON.stringify({
      type: "result",
      is_error: false,
      result: "",
      session_id: "s",
      modelUsage: { "only-model": {} },
    });
    expect(parseClaudeLineage(single).modelId).toBe("only-model");
  });

  it("understands the pi usage style (nested) with flat fallback", () => {
    const nested = parseClaudeLineage(
      JSON.stringify({ type: "result", is_error: false, result: "t", usage: { input: { tokens: 10, cacheRead: 4, cacheWrite: 2 }, output: { tokens: 3 } } }),
      { usageStyle: "pi" },
    );
    expect(nested.usage).toEqual({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 2 });
    const flat = parseClaudeLineage(
      JSON.stringify({ type: "result", is_error: false, result: "t", usage: { input_tokens: 7 } }),
      { usageStyle: "pi" },
    );
    expect(flat.usage).toEqual({ inputTokens: 7 });
  });

  it("skips non-JSON stdout noise", () => {
    const parsed = parseClaudeLineage(
      ['[claude-code:unrecognized_model] {"model":"x"}', JSON.stringify({ type: "result", is_error: false, result: "ok", session_id: "s" }), ""].join("\n"),
    );
    expect(parsed.text).toBe("ok");
  });
});
