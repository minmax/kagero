// sanitizeDiagnostic / extractStructuredError: bounded, redacted child-output excerpts.
import { describe, expect, it, vi } from "vitest";
import {
  extractStructuredError,
  MAX_DIAGNOSTIC_CHARS,
  redactSecrets,
  SUPPRESSED_MARKER,
  sanitizeDiagnostic,
} from "../packages/core/src/diagnostics.js";

describe("redactSecrets", () => {
  it("redacts bearer tokens, vendor keys, JWTs, key=value pairs and URL credentials", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh";
    const input = [
      "Authorization: Bearer abcdef0123456789tokenvalue",
      "key sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ and ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      `jwt ${jwt}`,
      "AWS AKIAABCDEFGHIJKLMNOP",
      "export OPENAI_API_KEY=plainsecretvalue",
      '{"api_key": "json-secret-value", "password":"pw-value"}',
      "fetch https://user:pa55word@example.com/path failed",
      `digest ${"a1".repeat(30)}`,
    ].join("\n");
    const out = redactSecrets(input);
    for (const secret of [
      "abcdef0123456789tokenvalue",
      "sk-ant-api03-ZZZZ",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      jwt,
      "AKIAABCDEFGHIJKLMNOP",
      "plainsecretvalue",
      "json-secret-value",
      "pw-value",
      "pa55word",
      "a1".repeat(30),
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain("https://[REDACTED]@example.com/path");
  });

  it("redacts Cookie and Set-Cookie headers with several pairs and attributes", () => {
    const input = [
      "> Cookie: session=COOKIEVAL1; csrftoken=COOKIEVAL2; theme=dark",
      "< Set-Cookie: sid=COOKIEVAL3; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT; HttpOnly; Secure; SameSite=Lax",
      "< set-cookie: refresh=COOKIEVAL4; Max-Age=3600",
      'curl -H "Cookie: a=COOKIEVAL5; b=COOKIEVAL6" https://example.com',
      "COOKIE: upper=COOKIEVAL7",
      "after the headers: still visible",
    ].join("\n");
    const out = redactSecrets(input);
    for (let n = 1; n <= 7; n++) expect(out).not.toContain(`COOKIEVAL${n}`);
    for (const attribute of ["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age", "theme=dark"]) {
      expect(out).not.toContain(attribute);
    }
    expect(out).toContain("Cookie: [REDACTED]");
    expect(out).toContain("Set-Cookie: [REDACTED]");
    expect(out).toContain("after the headers: still visible");
  });

  it("redacts JSON and key=value cookie fields, including escaped and quoted lists", () => {
    const input = [
      '{"cookie":"a=COOKIEVAL1; b=COOKIEVAL2","next":"kept"}',
      "{'Set-Cookie': 'sid=COOKIEVAL3; Path=/', 'x': 1}",
      "cookie=sid=COOKIEVAL4; theme=COOKIEVAL5",
      'session_cookie = "COOKIEVAL6"',
      '{"headers":"{\\"cookie\\":\\"sid=COOKIEVAL7; b=COOKIEVAL8\\"}"}',
      'Cookie: "a=COOKIEVAL9"; c=COOKIEVAL10',
    ].join("\n");
    const out = redactSecrets(input);
    for (let n = 1; n <= 10; n++) expect(out).not.toContain(`COOKIEVAL${n}`);
    expect(out).toContain('"next":"kept"');
  });

  it("redacts Authorization and Proxy-Authorization values of any length", () => {
    const input = [
      "Authorization: Basic abc",
      "Proxy-Authorization: Bearer xy12",
      "proxy-authorization: Digest user=a, response=SHORTSECRET",
      'curl -H "Authorization: Bearer ab"',
      '{"authorization":"Basic a=","next":"kept"}',
      "Authorization: Basic\n  FOLDEDSECRET",
      "plain basic usage and a bearer of news stay",
    ].join("\n");
    const out = redactSecrets(input);
    for (const leaked of ["abc", "xy12", "SHORTSECRET", "Bearer ab", "a=", "FOLDEDSECRET"]) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('"next":"kept"');
    expect(out).toContain("plain basic usage and a bearer of news stay");
  });

  it("redacts folded Set-Cookie / Cookie continuation lines", () => {
    const input = [
      "Set-Cookie: sid=COOKIESECRET1;",
      "  Path=/; Secure;",
      "\tHttpOnly; token2=COOKIESECRET2",
      "Cookie: a=COOKIESECRET3;\r\n b=COOKIESECRET4",
      "next: still visible",
    ].join("\n");
    const out = redactSecrets(input);
    for (let n = 1; n <= 4; n++) expect(out).not.toContain(`COOKIESECRET${n}`);
    expect(out).not.toContain("HttpOnly");
    expect(out).toContain("next: still visible");
  });

  it("redacts CRLF/LF folded continuation lines after QUOTED Cookie, Set-Cookie and Authorization values", () => {
    const input = [
      'Cookie: "a=COOKIEQ1"\r\n  b=COOKIEQ2; c=COOKIEQ3\r\n\td=COOKIEQ4',
      "Set-Cookie: 'sid=COOKIEQ5; Path=/' \r\n  HttpOnly; x=COOKIEQ6\nnext1: visible",
      'Authorization: "Basic abc"\r\n  FOLDEDAUTH1\r\n\tFOLDEDAUTH2',
      "Proxy-Authorization: 'Bearer ab'\n   FOLDEDAUTH3\nnext2: visible",
      'Cookie: "a=COOKIEQ7" ; z=COOKIEQ8',
    ].join("\n");
    const out = redactSecrets(input);
    for (let n = 1; n <= 8; n++) expect(out).not.toContain(`COOKIEQ${n}`);
    for (let n = 1; n <= 3; n++) expect(out).not.toContain(`FOLDEDAUTH${n}`);
    expect(out).not.toContain("HttpOnly");
    expect(out).toContain("next1: visible");
    expect(out).toContain("next2: visible");
  });

  it("still keeps the next JSON field after a quoted credential value followed by a comma", () => {
    const out = redactSecrets('{"cookie":"a=COOKIEJ1",\r\n  "next":"kept","authorization":"Basic x"\r\n}');
    expect(out).not.toContain("COOKIEJ1");
    expect(out).not.toContain("Basic x");
    expect(out).toContain('"next":"kept"');
  });

  it("keeps ordinary diagnostics: paths, token counters, plain words", () => {
    const input = 'cwd=/Users/dev/.codex/worktrees/launcher-s3-publish/isekai "input_tokens": 11 lock held';
    expect(redactSecrets(input)).toBe(input);
  });
});

describe("sanitizeDiagnostic", () => {
  it("redacts the exact prompt (also trimmed) before anything else", () => {
    const prompt = "  refactor the billing module  ";
    const out = sanitizeDiagnostic(`error while running: ${prompt.trim()}!`, { redact: [prompt] });
    expect(out).toBe("error while running: [PROMPT]!");
  });

  it("redacts aligned fragments of a long prompt echoed in truncated form", () => {
    const prompt = `${"alpha beta gamma ".repeat(10)}END`;
    const out = sanitizeDiagnostic(`cli saw: ${prompt.slice(0, 90)}…`, { redact: [prompt] });
    expect(out).not.toContain("alpha beta gamma alpha");
    expect(out).toContain("[PROMPT]");
  });

  it("redacts both ends of a prompt longer than one fragment sample", () => {
    const prompt = `START-OF-PROMPT ${"ordinary words ".repeat(450)}TAIL-SECRET-123456`;
    expect(prompt.length).toBeGreaterThan(6 * 1024);
    expect(prompt.length).toBeLessThan(12 * 1024);
    const out = sanitizeDiagnostic(`Error: ${prompt.slice(-800)}`, { redact: [prompt] });
    expect(out).not.toContain("TAIL-SECRET-123456");
    expect(out).toContain("[PROMPT]");
  });

  it("suppresses diagnostics when a long prompt exceeds bounded fragment coverage", () => {
    const prompt = `${"ordinary words ".repeat(900)}MIDDLE-SECRET-123456 ${"ordinary words ".repeat(900)}`;
    expect(prompt.length).toBeGreaterThan(12 * 1024);
    const out = sanitizeDiagnostic(`Error: ${prompt.slice(6_000, 6_800)}`, { redact: [prompt] });
    expect(out).toBe(SUPPRESSED_MARKER);
    expect(out).not.toContain("MIDDLE-SECRET-123456");
  });

  it("suppresses diagnostics for prompts above the bounded fragment coverage", () => {
    const prompt = Array.from(
      { length: 6_000 },
      (_, index) => `segment${String(index).padStart(5, "0")} `,
    ).join("");
    expect(prompt.length).toBeGreaterThan(64 * 1024);
    expect(prompt.length).toBeLessThan(128 * 1024);
    const echoedTail = prompt.slice(-4_992);
    const out = sanitizeDiagnostic(echoedTail, { from: "tail", redact: [prompt] });
    expect(out).toBe(SUPPRESSED_MARKER);
    expect(out).not.toContain(echoedTail.slice(2_500, 2_524));
  });

  it("redacts a multi-line prompt echoed in its JSON-escaped form", () => {
    const prompt = "first line of the task\nsecond line with detail";
    const echoed = JSON.stringify({ content: prompt });
    expect(sanitizeDiagnostic(echoed, { redact: [prompt] })).toBe('{"content":"[PROMPT]"}');
  });

  it("redacts a one-character prompt at token boundaries only", () => {
    const text = "x failed; (x) exit, xray max x.\nX again; prefix_x x_suffix";
    expect(sanitizeDiagnostic(text, { redact: ["x"] })).toBe(
      "[PROMPT] failed; ([PROMPT]) exit, xray max [PROMPT].\n[PROMPT] again; prefix_x x_suffix",
    );
    // Surrounding whitespace of the prompt does not matter.
    expect(sanitizeDiagnostic("got x here", { redact: ["  x\n"] })).toBe("got [PROMPT] here");
  });

  it("redacts a two-character prompt at token boundaries only", () => {
    const text = "got ab here, cab, abc, ab-ab, AB!";
    expect(sanitizeDiagnostic(text, { redact: ["ab"] })).toBe(
      "got [PROMPT] here, cab, abc, [PROMPT]-[PROMPT], [PROMPT]!",
    );
    expect(sanitizeDiagnostic("exit code 12 or 1", { redact: ["12"] })).toBe("exit code [PROMPT] or 1");
  });

  it("redacts a common five-character prompt without mangling diagnostic words", () => {
    expect(
      sanitizeDiagnostic("error: rebuilding the builder failed; request: debug", { redact: ["debug"] }),
    ).toBe("error: rebuilding the builder failed; request: [PROMPT]");
  });

  it("redacts a punctuation-only short prompt wherever it occurs", () => {
    expect(sanitizeDiagnostic("why? ok?!", { redact: ["?"] })).toBe("why[PROMPT] ok[PROMPT]!");
    expect(sanitizeDiagnostic("a.b (c)", { redact: ["."] })).toBe("a[PROMPT]b (c)");
  });

  it("ignores empty and whitespace-only prompts", () => {
    expect(sanitizeDiagnostic("some text here", { redact: ["", "   "] })).toBe("some text here");
  });

  it("strips ANSI escapes and control characters", () => {
    expect(sanitizeDiagnostic("\u001b[31mred\u001b[0m\u0007 text")).toBe("red text");
  });

  it("caps head and tail output at maxChars, marker included", () => {
    const text = `START ${"line\n".repeat(2_000)} END`;
    const head = sanitizeDiagnostic(text);
    const tail = sanitizeDiagnostic(text, { from: "tail" });
    expect(head.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS);
    expect(tail.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS);
    expect(head.startsWith("START")).toBe(true);
    expect(head.endsWith("…[truncated]")).toBe(true);
    expect(tail.endsWith("END")).toBe(true);
    expect(tail.startsWith("[truncated]…")).toBe(true);
    expect(sanitizeDiagnostic(text, { maxChars: 50 }).length).toBeLessThanOrEqual(50);
  });

  it("ignores everything beyond the raw window of a huge stream", () => {
    const huge = `${"a ".repeat(100_000)}sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ`;
    expect(sanitizeDiagnostic(huge).length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS);
    expect(sanitizeDiagnostic(huge, { from: "tail", maxChars: 100 })).not.toContain("ZZZZZZZZ");
  });

  it("drops the whole partial first line of a cut tail, not just the first token", () => {
    // The cut removed the "Cookie:" label: the rest of the line no longer looks like a header.
    const cutTail = "ant-api03-ZZZZZZZZZZZZZZZZZZZZ; csrftoken=COOKIESECRET2; theme=dark\nnext line";
    expect(sanitizeDiagnostic(cutTail, { from: "tail", edgeCut: true })).toBe("next line");
    // Folded continuation lines of the dropped partial line go with it.
    const folded =
      "chunk=COOKIESECRET1;\n  c=COOKIESECRET2;\n\td=COOKIESECRET3\nkept line\n  indented but kept";
    expect(sanitizeDiagnostic(folded, { from: "tail", edgeCut: true })).toBe(
      "kept line\n  indented but kept",
    );
    // A head cut drops the partial last line; text without any line break leaves nothing safe.
    expect(sanitizeDiagnostic("keep this\nhalf-wri", { edgeCut: true })).toBe("keep this");
    expect(sanitizeDiagnostic("only-a-partial-line", { from: "tail", edgeCut: true })).toBe("");
  });

  it("drops a cut Cookie line whose label fell outside the raw window (>64 KiB)", () => {
    const text = `Cookie: ${"sid=COOKIESECRET-WINDOW; ".repeat(10_000)}\nafter line\n`;
    expect(text.length).toBeGreaterThan(64 * 1024);
    const out = sanitizeDiagnostic(text, { from: "tail" });
    expect(out).toBe("after line");
    expect(out).not.toContain("COOKIESECRET");
  });

  it("redacts a long Cookie header (>4 KiB) that is still labelled", () => {
    const text = `Cookie: ${"sid=COOKIESECRET-LONG; ".repeat(300)}\nafter line`;
    expect(text.length).toBeGreaterThan(4 * 1024);
    expect(sanitizeDiagnostic(text)).toBe("Cookie: [REDACTED]\nafter line");
  });

  it("redacts a prompt of exactly four characters case-insensitively as a whole token", () => {
    expect(sanitizeDiagnostic("HELP me, help! Help? helpful; 'help'", { redact: ["help"] })).toBe(
      "[PROMPT] me, [PROMPT]! [PROMPT]? helpful; '[PROMPT]'",
    );
    expect(sanitizeDiagnostic("echo: HELP", { redact: ["help "] })).toBe("echo: [PROMPT]");
    // Five characters and more keep plain-substring replacement.
    expect(sanitizeDiagnostic("a helpx b", { redact: ["helpx"] })).toBe("a [PROMPT] b");
  });

  it("redacts JSON-escaped forms of short prompts as whole tokens, case-insensitively", () => {
    // A 3-character prompt containing a newline: the stream-json echo has a literal backslash-n.
    expect(sanitizeDiagnostic('{"p":"a\\nb","q":"A\\nB"}', { redact: ["a\nb"] })).toBe(
      '{"p":"[PROMPT]","q":"[PROMPT]"}',
    );
    // A quoted short prompt echoed with escaped quotes.
    expect(sanitizeDiagnostic('{"p":"\\"x\\""}', { redact: ['"x"'] })).toBe('{"p":"[PROMPT]"}');
    // Non-ASCII: raw and \uXXXX forms (either hex case).
    expect(sanitizeDiagnostic("raw é, esc \\u00e9 and \\u00E9", { redact: ["é"] })).toBe(
      "raw [PROMPT], esc [PROMPT] and [PROMPT]",
    );
    // A backslash prompt: its escaped form is a double backslash.
    expect(sanitizeDiagnostic('{"p":"\\\\"}', { redact: ["\\"] })).toBe('{"p":"[PROMPT]"}');
  });

  it("redacts the short token of a whitespace-padded prompt that bounded sampling can still establish", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const startedAt = Date.now();
      // Up to twice the window the trimmed prompt is known exactly.
      const leading = `${" ".repeat(100_000)}x${" ".repeat(5)}`;
      const trailing = `x${"\n".repeat(100_000)}`;
      expect(sanitizeDiagnostic("got x here, xray, X!", { redact: [leading] })).toBe(
        "got [PROMPT] here, xray, [PROMPT]!",
      );
      expect(sanitizeDiagnostic("got x here, xray, X!", { redact: [trailing] })).toBe(
        "got [PROMPT] here, xray, [PROMPT]!",
      );
      const padded = `${"\t".repeat(120_000)}help`;
      expect(sanitizeDiagnostic('say HELP and "help\\n"', { redact: [padded] })).toBe(
        'say [PROMPT] and "[PROMPT]\\n"',
      );
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      for (const call of stringify.mock.calls) {
        expect(String(call[0]).length).toBeLessThanOrEqual(128 * 1024);
      }
    } finally {
      stringify.mockRestore();
    }
  });

  it("suppresses the whole diagnostic when padding hides the short prompt from bounded sampling", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const startedAt = Date.now();
      // Content between more than 64 KiB of leading AND trailing whitespace: neither end shows it.
      const hidden = `${" ".repeat(70_000)}help${" ".repeat(70_000)}`;
      const echoed = 'cli said: help; HELP! and "help\\n" (also Help)';
      const out = sanitizeDiagnostic(echoed, { redact: [hidden] });
      expect(out).toBe(SUPPRESSED_MARKER);
      expect(out.toLowerCase()).not.toContain("help");
      // Same for a tail-only or head-only token beyond the exactly-trimmed range.
      expect(sanitizeDiagnostic("got x here", { redact: [`${" ".repeat(300_000)}x`] })).toBe(
        SUPPRESSED_MARKER,
      );
      expect(sanitizeDiagnostic("got x here", { redact: [`x${" ".repeat(300_000)}`] })).toBe(
        SUPPRESSED_MARKER,
      );
      // A cap smaller than the marker still bounds it.
      expect(sanitizeDiagnostic(echoed, { redact: [hidden], maxChars: 20 }).length).toBeLessThanOrEqual(20);
      // The structured-error path surfaces nothing either.
      const envelope = JSON.stringify({ type: "result", is_error: true, result: "help me" });
      expect(extractStructuredError(`${envelope}\n`, { redact: [hidden] })).toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      for (const call of stringify.mock.calls) {
        expect(String(call[0]).length).toBeLessThanOrEqual(128 * 1024);
      }
    } finally {
      stringify.mockRestore();
    }
  });

  it("suppresses diagnostics for a prompt whose middle is outside the bounded samples", () => {
    const prompt = `ab${" ".repeat(200_000)}${"A long tail sentence that is echoed back ".repeat(3)}`;
    const out = sanitizeDiagnostic("ab says: A long tail sentence that is echoed back", { redact: [prompt] });
    expect(out).toBe(SUPPRESSED_MARKER);
    expect(out).not.toContain("long tail sentence");
  });

  it("suppresses diagnostics for a huge prompt without serializing it", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const prompt = `START-OF-PROMPT-MARKER-TEXT-HERE ${"pad ".repeat(5_000_000)} END-OF-PROMPT-DISTINCT-TAIL-TEXT`;
      expect(prompt.length).toBeGreaterThan(16 * 1024 * 1024);
      const startedAt = Date.now();
      const out = sanitizeDiagnostic(
        "cli echoed START-OF-PROMPT-MARKER-TEXT-HERE and ... END-OF-PROMPT-DISTINCT-TAIL-TEXT done",
        { redact: [prompt] },
      );
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(out).toBe(SUPPRESSED_MARKER);
      expect(out).not.toContain("START-OF-PROMPT-MARKER");
      expect(out).not.toContain("DISTINCT");
      for (const call of stringify.mock.calls) {
        expect(String(call[0]).length).toBeLessThanOrEqual(64 * 1024);
      }
    } finally {
      stringify.mockRestore();
    }
  });

  it("suppresses diagnostics for prompts above the bounded trim budget", () => {
    const prompt = `${" ".repeat(200_000)}secret task text here`;
    expect(sanitizeDiagnostic("saw: secret task text here!", { redact: [prompt] })).toBe(SUPPRESSED_MARKER);
  });
});

describe("extractStructuredError", () => {
  it("summarizes the last error envelope and ignores assistant text", () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "SECRET-ASSISTANT-TEXT" }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "model not found; Bearer abcdef0123456789tokenvalue",
        api_error_status: 404,
      }),
    ].join("\n");
    const out = extractStructuredError(stdout) ?? "";
    expect(out).toContain("subtype=error_during_execution");
    expect(out).toContain("api_error_status=404");
    expect(out).toContain("model not found");
    expect(out).not.toContain("abcdef0123456789tokenvalue");
    expect(out).not.toContain("SECRET-ASSISTANT-TEXT");
  });

  it("reads {error:{type,code,message}} objects and returns undefined without any error line", () => {
    const withError = JSON.stringify({ error: { type: "auth", code: 401, message: "bad key" } });
    expect(extractStructuredError(withError)).toBe("error=type=auth code=401 message=bad key");
    expect(extractStructuredError('{"type":"assistant"}\nplain text\n')).toBeUndefined();
  });

  it("skips a success envelope with error:null and reports the preceding real failure", () => {
    const failure = JSON.stringify({ type: "result", is_error: true, result: "quota exceeded" });
    const success = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      error: null,
      result: "done",
    });
    const out = extractStructuredError(`${failure}\n${success}\n`) ?? "";
    expect(out).toContain("result=quota exceeded");
    expect(out).not.toContain("subtype=success");
  });

  it("skips an oversized success envelope with error:null when searching for a real failure", () => {
    const failure = JSON.stringify({ type: "result", is_error: true, result: "quota exceeded" });
    const success = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      error: null,
      result: "done",
      padding: "x".repeat(100_000),
    });
    const out = extractStructuredError(`${failure}\n${success}\n`) ?? "";
    expect(out).toContain("result=quota exceeded");
    expect(out).not.toContain("subtype=success");
  });

  it("summarizes an oversized (>64 KiB) error envelope from its head and tail without JSON.parse of it", () => {
    const parse = vi.spyOn(JSON, "parse");
    try {
      const big = "y".repeat(100_000);
      const headError = JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        api_error_status: 429,
        result: `RESULTHEAD rate limited, Authorization: Bearer abcdef0123456789tokenvalue ${big}`,
        session_id: "s1",
      });
      const tailError = JSON.stringify({
        type: "result",
        result: big,
        subtype: "error_max_turns",
        is_error: true,
      });
      for (const [line, expected] of [
        [headError, ["subtype=error_during_execution", "api_error_status=429", "RESULTHEAD rate limited"]],
        [tailError, ["subtype=error_max_turns", "type=result"]],
      ] as const) {
        const stdout = `${JSON.stringify({ type: "system", subtype: "init" })}\n${line}\n`;
        const out = extractStructuredError(stdout) ?? "";
        for (const part of expected) expect(out).toContain(part);
        expect(out).toContain("envelope=exceeded the parse budget");
        expect(out).not.toContain("abcdef0123456789tokenvalue");
        expect(out.length).toBeLessThanOrEqual(2_000);
      }
      for (const call of parse.mock.calls) expect(String(call[0]).length).toBeLessThanOrEqual(64 * 1024);
    } finally {
      parse.mockRestore();
    }
  });

  it("returns undefined for an oversized non-error line and falls back to an earlier error line", () => {
    const hugeAssistant = JSON.stringify({ type: "assistant", text: "z".repeat(100_000) });
    expect(extractStructuredError(`${hugeAssistant}\n`)).toBeUndefined();
    const earlier = JSON.stringify({
      type: "result",
      subtype: "error_x",
      is_error: true,
      result: "EARLIER-ERROR",
    });
    const out = extractStructuredError(`${earlier}\n${hugeAssistant}\n`) ?? "";
    expect(out).toContain("EARLIER-ERROR");
    expect(out).not.toContain("exceeded");
  });

  it("never takes nested tool_result error fields of an oversized non-error envelope for its own", () => {
    const big = "y".repeat(100_000);
    const nestedNoise = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: true, content: "PRIVATE-TOOL-OUTPUT" },
          { type: "text", text: big },
        ],
        error: "PRIVATE-NESTED-ERROR",
        message: "PRIVATE-NESTED-MESSAGE",
      },
      session_id: "s1",
    });
    expect(nestedNoise.length).toBeGreaterThan(64 * 1024);
    // Alone, the oversized line has no top-level error: nothing is returned.
    expect(extractStructuredError(`${nestedNoise}\n`)).toBeUndefined();
    // With an earlier genuine top-level error envelope, only that one comes back.
    const genuine = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "GENUINE-TOP-LEVEL-ERROR",
    });
    const out = extractStructuredError(`${genuine}\n${nestedNoise}\n`) ?? "";
    expect(out).toContain("GENUINE-TOP-LEVEL-ERROR");
    expect(out).toContain("subtype=error_during_execution");
    expect(out).not.toContain("PRIVATE");
    expect(out).not.toContain("exceeded");
  });

  it("reads top-level error fields of an oversized envelope, including a top-level result, ignoring nested lookalikes", () => {
    const big = "y".repeat(100_000);
    const line = JSON.stringify({
      type: "result",
      debug: {
        is_error: false,
        message: "PRIVATE-DEBUG-MESSAGE",
        error: "PRIVATE-DEBUG-ERROR",
        type: "PRIVATE-TYPE",
      },
      trace: [{ is_error: true, result: "PRIVATE-TRACE-RESULT", subtype: "PRIVATE-SUBTYPE" }],
      result: `TOP-RESULT-TEXT ${big}`,
      subtype: "error_max_turns",
      api_error_status: 529,
      is_error: true,
    });
    expect(line.length).toBeGreaterThan(64 * 1024);
    const parse = vi.spyOn(JSON, "parse");
    try {
      const out = extractStructuredError(`${line}\n`) ?? "";
      expect(out).toContain("type=result");
      expect(out).toContain("subtype=error_max_turns");
      expect(out).toContain("api_error_status=529");
      expect(out).toContain("result=TOP-RESULT-TEXT");
      expect(out).toContain("envelope=exceeded the parse budget");
      expect(out).not.toContain("PRIVATE");
      for (const call of parse.mock.calls) expect(String(call[0]).length).toBeLessThanOrEqual(64 * 1024);
    } finally {
      parse.mockRestore();
    }
  });

  it("reads a top-level error object of an oversized envelope (type/code/message of that object only)", () => {
    const line = JSON.stringify({
      error: { type: "overloaded", code: 529, message: "try later", extra: { message: "PRIVATE-DEEP" } },
      padding: "z".repeat(100_000),
    });
    const out = extractStructuredError(`${line}\n`) ?? "";
    expect(out).toContain("error=type=overloaded code=529 message=try later");
    expect(out).not.toContain("PRIVATE");
  });

  it("never leaks the remainder of a quoted credential value cut by the 4 KiB field capture", () => {
    const secret = "correct horse battery staple ".repeat(300);
    for (const prefix of ["", "a", "ab", "abc", "abcd"]) {
      for (const [open, close] of [
        ['\\"', '\\"'],
        ["'", "'"],
      ] as const) {
        const line = JSON.stringify({
          type: "result",
          subtype: "error_x",
          is_error: true,
          result: `${prefix}request failed password=${open.replace("\\", "")}${secret}${close.replace("\\", "")} trailing words`,
          padding: "z".repeat(100_000),
        });
        expect(line.length).toBeGreaterThan(64 * 1024);
        const out = extractStructuredError(`${line}\n`) ?? "";
        expect(out).toContain("request failed");
        expect(out).toContain("subtype=error_x");
        for (const word of ["correct", "horse", "battery", "staple", "trailing"])
          expect(out).not.toContain(word);
        expect(out).toContain("…[truncated]");
        expect(out.length).toBeLessThanOrEqual(2_000);
      }
    }
  });

  it("drops the partial last token of a cut field and the cut mid-escape/partial \\u escape of its raw text", () => {
    // `Bearer ab` is a prefix of a longer cut token; ends in a lone backslash after the capture limit.
    const filler = "x ".repeat(2_040); // 4080 chars
    for (const tailPiece of ["Bearer ab", "key sk-ant-ap", "end\\\\", "esc \\u00e", "plain word"]) {
      const result = `${filler}${tailPiece}${"q".repeat(500)}`;
      const line = JSON.stringify({ type: "result", is_error: true, result, padding: "z".repeat(100_000) });
      const out = extractStructuredError(`${line}\n`) ?? "";
      expect(out).toContain("…[truncated]");
      expect(out).not.toContain("sk-ant-ap");
      expect(out).not.toContain("Bearer ab");
      expect(out).not.toContain("\\u00e");
    }
  });

  it("redacts a quoted credential whose closing quote never arrives on its line, in plain text too", () => {
    expect(redactSecrets('log: password="two words here')).toBe("log: password=[REDACTED]");
    expect(redactSecrets("api_key: 'abc def\nnext line")).toBe("api_key: [REDACTED]\nnext line");
    expect(redactSecrets('password="closed one" next')).toBe("password=[REDACTED] next");
  });

  it("never leaks beta from a clipped, escaped quoted credential whose cut falls inside an escaped backslash + u0", () => {
    // Raw JSON body of `password="alpha beta xxxx…\\u0zzzz…"`: the 4096-char capture ends exactly after `\\u0`
    // (an escaped backslash followed by plain `u0`, NOT a cut-off \uXXXX escape).
    const exact = `password="alpha beta ${"x".repeat(4070)}\\u0${"z".repeat(500)}"`;
    const envelope = (result: string): string =>
      JSON.stringify({
        type: "result",
        is_error: true,
        subtype: "error_x",
        result,
        padding: "z".repeat(100_000),
      });
    const check = (result: string): void => {
      const out = extractStructuredError(`${envelope(result)}\n`) ?? "";
      expect(out).not.toContain("alpha");
      expect(out).not.toContain("beta");
      // Other fields and the safe envelope marker survive; the output stays bounded.
      expect(out).toContain("type=result");
      expect(out).toContain("subtype=error_x");
      expect(out).toContain("envelope=exceeded the parse budget");
      expect(out.length).toBeLessThanOrEqual(2_000);
    };
    check(exact);
    // Adjacent parity cases: every cut offset inside / around an escaped backslash, a real \uXXXX, a control
    // character's \u0001 escape, 3 and 4 backslashes, and an escaped quote.
    for (const tail of ["\\u0", "\\\\u0", "\\\\\\u0", "\\u0001", "\u0001", "\u0002", '\\"', "\\\\"]) {
      for (let x = 4060; x <= 4080; x++) {
        check(`password="alpha beta ${"x".repeat(x)}${tail}${"z".repeat(500)}"`);
      }
    }
  });

  it("suppresses (does not echo raw) a captured string whose escapes cannot be decoded", () => {
    // A malformed escape (`\q`): the raw text must not be passed on as if it were decoded.
    const line = `{"type":"result","is_error":true,"subtype":"error_x","result":"password=\\"alpha beta \\q gamma\\"","padding":"${"z".repeat(100_000)}"}`;
    const out = extractStructuredError(`${line}\n`) ?? "";
    expect(out).toContain("result=[suppressed: undecodable string]");
    for (const word of ["alpha", "beta", "gamma"]) expect(out).not.toContain(word);
    expect(out).toContain("subtype=error_x");
    expect(out).toContain("envelope=exceeded the parse budget");
  });

  it("keeps a decodable clipped string useful: complete escapes are decoded, only the cut-off one is dropped", () => {
    const line = JSON.stringify({
      type: "result",
      is_error: true,
      result: `${"ok ".repeat(1_360)}done\u00e9 line\ntext ${"w".repeat(100)}`,
      padding: "z".repeat(100_000),
    });
    const out = extractStructuredError(`${line}\n`) ?? "";
    expect(out).toContain("result=ok ok ok");
    expect(out).toContain("…[truncated]");
    expect(out).not.toContain("[suppressed");
  });
});
