/**
 * diagnostics.ts — bounded, sanitized excerpts of child-process output.
 *
 * A child's stderr/stdout is useful for diagnosing a failed run, but it can
 * also carry credentials (a rejected Authorization header, an env dump) or an
 * echo of the user's prompt, and it can be arbitrarily large. Anything that
 * reaches a thrown message, AgentError.context, a task receipt or a log goes
 * through `sanitizeDiagnostic` first:
 *   1. only a bounded raw window is considered (never the whole stream);
 *   2. ANSI escapes and control characters are stripped;
 *   3. exact prompt substrings (and aligned fragments of a long prompt) are
 *      replaced, then common bearer/token/key formats are redacted; prompt
 *      handling is bounded by the window size, never by the prompt's length;
 *   4. the result is capped at `maxChars`, marker included.
 * Redaction runs BEFORE the final cap, and the whole partial line (plus its
 * folded continuation lines) at a cut edge is dropped, so a cut can never
 * expose the unlabelled remainder of a header or half of a secret.
 */

/** Default cap for one surfaced diagnostic field. */
export const MAX_DIAGNOSTIC_CHARS = 2_000;
/** Raw window looked at before redaction (the rest of a huge stream is ignored). */
const RAW_WINDOW_CHARS = 64 * 1024;
/**
 * Prompts of up to this many characters would mangle ordinary words if replaced
 * as plain substrings ("x" inside "exit"), so they are redacted as whole tokens,
 * case-insensitively ("help" also removes "HELP").
 */
const SHORT_PROMPT_MAX_CHARS = 4;
/**
 * Prompt text considered at all: an echo cannot be longer than the raw window,
 * so trimming/escaping/fragmenting an unbounded prompt buys nothing. Prompts up
 * to twice this are sampled directly; longer ones are sampled at both ends.
 */
const PROMPT_PROCESS_CHARS = RAW_WINDOW_CHARS;
/** Long prompts are also matched by aligned fragments of this size. */
const PROMPT_FRAGMENT_CHARS = 24;
const MAX_PROMPT_FRAGMENTS = 256;
/** Both ends are sampled; larger trimmed prompts leave an unsampled middle. */
const MAX_SAMPLED_PROMPT_CHARS = PROMPT_FRAGMENT_CHARS * MAX_PROMPT_FRAGMENTS * 2;
const REDACTED = "[REDACTED]";
const PROMPT_MARKER = "[PROMPT]";
/** Shown instead of child output when the prompt cannot be matched safely (see planPrompt). */
export const SUPPRESSED_MARKER = "[diagnostic suppressed: prompt could not be matched safely]";
const HEAD_MARKER = "…[truncated]";
const TAIL_MARKER = "[truncated]…";

const ESC = String.fromCharCode(27);
const ANSI_PREFIX = `${ESC}[`;

/** Remove ANSI CSI escapes and control characters other than \n, \r and \t. */
function stripTerminalNoise(text: string): string {
  let result = "";
  let index = 0;
  while (index < text.length) {
    if (text.startsWith(ANSI_PREFIX, index)) {
      index += ANSI_PREFIX.length;
      // CSI: parameter/intermediate bytes (0x20-0x3f), then one final byte (0x40-0x7e).
      while (index < text.length && text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x3f) index++;
      if (index < text.length) index++;
      continue;
    }
    const code = text.charCodeAt(index);
    if (code >= 0x20 && code !== 0x7f) result += text.charAt(index);
    else if (code === 0x09 || code === 0x0a || code === 0x0d) result += text.charAt(index);
    index++;
  }
  return result;
}

/**
 * Value of a credential-bearing header or field: a quoted value goes whole when
 * a JSON delimiter or the line end follows it (so `Cookie: "a=b"; c=d` is not
 * cut short); otherwise the rest of the line. Either way folded continuation
 * lines (a line starting with space/tab continues the previous header, with LF
 * or CRLF breaks) go too. A quoted value followed by `,` keeps the next JSON
 * field.
 */
const FIELD_CONTINUATION = String.raw`(?:[ \t]*\r?\n[ \t]+[^\r\n]*)*`;
const FIELD_VALUE = String.raw`(?:"[^"\n]*"(?=[ \t]*(?:[,}\]]|\r?\n|$))${FIELD_CONTINUATION}|'[^'\n]*'(?=[ \t]*(?:[,}\]]|\r?\n|$))${FIELD_CONTINUATION}|[^\r\n]*${FIELD_CONTINUATION})`;

/** A field whose name contains `name`; a backslash or quote after the name also covers an escaped key inside a JSON-encoded string. */
const credentialField = (name: string): RegExp =>
  new RegExp(String.raw`(\b[\w.-]*${name}[\w.-]*[\\"']*\s*[:=]\s*)${FIELD_VALUE}`, "gi");

/** Secret-shaped substrings, applied in order. */
const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // Authorization / Proxy-Authorization (any scheme, any credential length):
  // the whole value goes, so a short `Basic abc` cannot slip below the 8-char
  // scheme pattern below and be left half-redacted.
  [credentialField("authorization"), `$1${REDACTED}`],
  // Authorization schemes outside a header: "Bearer <token>", "Basic <b64>".
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // JSON web tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  // Vendor key prefixes (sk-…, sk-ant-…, GitHub, Slack, AWS, Google, GitLab, npm).
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
  // Cookie / Set-Cookie headers and cookie-named JSON or key=value fields: the
  // value is a list of `name=value` pairs (and Set-Cookie attributes) separated
  // by `;`, possibly folded over several lines.
  [credentialField("cookie"), `$1${REDACTED}`],
  // key=value / "key": "value" for secret-named keys ("input_tokens" is not one).
  // A quote that never closes on its line (a value cut off, or broken by a line
  // break) takes the rest of the line instead of falling through to the bare-word branch.
  [
    /(["']?\b[\w.-]*(?:api[_-]?key|secret|token(?!s)|password|passwd|authorization|credential|private[_-]?key)[\w.-]*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|["'][^\r\n]*|[^\s,;&}]+)/gi,
    `$1${REDACTED}`,
  ],
  // user:password@ inside a URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // Long opaque blobs that mix letters and digits (hex digests, raw keys).
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}/g, REDACTED],
];

export interface SanitizeDiagnosticOptions {
  /** Cap on the returned text, markers included. Default MAX_DIAGNOSTIC_CHARS. */
  readonly maxChars?: number;
  /** Which end of the text is kept when it is too long. Default "head". */
  readonly from?: "head" | "tail";
  /** Exact strings that must not survive (the user prompt). */
  readonly redact?: readonly string[];
  /**
   * The caller already cut the text at the kept-end's opposite edge, so a
   * partial token may sit there (tail: at the start, head: at the end).
   */
  readonly edgeCut?: boolean;
}

/**
 * Drop the whole partial line at a cut edge — not just the partial token: a cut
 * can remove a header's label and leave `; csrftoken=…; theme=…` unrecognizable.
 * At the start of a tail the folded continuation lines of the dropped line go
 * too. Text without any line break is dropped entirely (nothing safe remains).
 */
function dropPartialEdge(text: string, edge: "start" | "end"): string {
  if (edge === "end") {
    const lastBreak = text.lastIndexOf("\n");
    return lastBreak === -1 ? "" : text.slice(0, lastBreak);
  }
  const firstBreak = text.indexOf("\n");
  if (firstBreak === -1) return "";
  let rest = text.slice(firstBreak + 1);
  while (/^[ \t]/.test(rest)) {
    const next = rest.indexOf("\n");
    if (next === -1) return "";
    rest = rest.slice(next + 1);
  }
  return rest;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Forms in which a (bounded) piece of text can be echoed inside a JSON string:
 * `JSON.stringify` escaping (`\"`, `\\`, `\n`) and, when it contains non-ASCII,
 * the all-ASCII `\uXXXX` form some encoders emit.
 */
function jsonEscapedForms(text: string): string[] {
  const forms = [JSON.stringify(text).slice(1, -1)];
  const ascii = forms[0]?.replace(
    /[\u0080-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  if (ascii !== undefined && ascii !== forms[0]) forms.push(ascii);
  return forms;
}

/**
 * Redact a prompt too short for plain substring replacement: every occurrence,
 * raw or JSON-escaped, that is a whole token (case-insensitive). A prompt edge
 * that is not a letter, digit or `_` (punctuation) needs no boundary there, so
 * it goes everywhere.
 */
function redactShortPrompt(text: string, prompt: string): string {
  let result = text;
  // Escaped (longer) forms first, so `\"` is replaced as a unit before a bare `"`.
  for (const form of new Set([...jsonEscapedForms(prompt), prompt])) {
    result = redactPromptToken(result, form);
  }
  return result;
}

function redactPromptToken(text: string, prompt: string): string {
  const word = /[\p{L}\p{N}_]/u;
  const before = word.test(prompt.charAt(0)) ? "(?<![\\p{L}\\p{N}_])" : "";
  const after = word.test(prompt.charAt(prompt.length - 1)) ? "(?![\\p{L}\\p{N}_])" : "";
  return text.replace(new RegExp(`${before}${escapeRegExp(prompt)}${after}`, "giu"), PROMPT_MARKER);
}

interface PromptPlan {
  /** Bounded sampling could not establish what the prompt is: nothing child-made may be shown. */
  readonly suppress: boolean;
  /** Short pieces (≤ SHORT_PROMPT_MAX_CHARS): whole-token, case-insensitive, raw and JSON-escaped. */
  readonly shortTokens: readonly string[];
  /** Exact strings replaced wherever they occur (raw, trimmed, JSON-escaped). */
  readonly variants: readonly string[];
  /** Aligned fragments of a long prompt (a CLI may echo it truncated or wrapped). */
  readonly fragments: readonly string[];
}

/** Aligned fragments of `text`: from its start, or (`fromEnd`) counted back from its end. */
function alignedFragments(text: string, fromEnd: boolean): string[] {
  const out: string[] = [];
  const count = Math.min(Math.ceil(text.length / PROMPT_FRAGMENT_CHARS), MAX_PROMPT_FRAGMENTS);
  for (let n = 0; n < count; n++) {
    out.push(
      fromEnd
        ? text.slice(
            Math.max(0, text.length - (n + 1) * PROMPT_FRAGMENT_CHARS),
            text.length - n * PROMPT_FRAGMENT_CHARS,
          )
        : text.slice(n * PROMPT_FRAGMENT_CHARS, (n + 1) * PROMPT_FRAGMENT_CHARS),
    );
  }
  return out.filter((fragment) => fragment.trim().length >= PROMPT_FRAGMENT_CHARS / 2);
}

/** Replace the union of matching fragment ranges against the same original text. */
function redactFragments(text: string, fragments: readonly string[]): string {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const fragment of fragments) {
    if (fragment === "") continue;
    let start = text.indexOf(fragment);
    while (start !== -1) {
      ranges.push({ start, end: start + fragment.length });
      start = text.indexOf(fragment, start + 1);
    }
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  let output = "";
  let cursor = 0;
  let matchEnd = -1;
  for (const range of ranges) {
    if (range.start > matchEnd) {
      if (matchEnd !== -1) {
        output += PROMPT_MARKER;
        cursor = matchEnd;
      }
      output += text.slice(cursor, range.start);
      matchEnd = range.end;
    } else {
      matchEnd = Math.max(matchEnd, range.end);
    }
  }
  output += PROMPT_MARKER + text.slice(matchEnd);
  return output;
}

/**
 * How a prompt is redacted, decided from a bounded view of it:
 *  - input up to 2 × PROMPT_PROCESS_CHARS is trimmed directly;
 *  - when the trimmed prompt fits in both aligned-fragment samples, exact forms
 *    and fragments from both ends cover it;
 *  - if it is longer, or the input itself exceeds the processing bound, child
 *    diagnostics are suppressed because an echoed middle fragment could leak.
 */
function planPrompt(prompt: string): PromptPlan {
  return buildPromptPlan(prompt);
}

function buildPromptPlan(prompt: string): PromptPlan {
  const none: PromptPlan = { suppress: false, shortTokens: [], variants: [], fragments: [] };
  if (prompt.length > PROMPT_PROCESS_CHARS * 2) return { ...none, suppress: true };
  const candidate = prompt.trim();
  if (candidate === "") return none;
  if (candidate.length <= SHORT_PROMPT_MAX_CHARS) return { ...none, shortTokens: [candidate] };
  if (candidate.length > MAX_SAMPLED_PROMPT_CHARS) return { ...none, suppress: true };
  const variants = [...new Set([candidate, ...jsonEscapedForms(candidate), prompt])];
  if (candidate.length < PROMPT_FRAGMENT_CHARS * 2) return { ...none, variants };
  const fragments = [...alignedFragments(candidate, false), ...alignedFragments(candidate, true)];
  return { ...none, variants, fragments: [...new Set(fragments)] };
}

/** True when `prompts` contain one that bounded sampling cannot establish (see planPrompt). */
function promptsSuppressDiagnostics(prompts: readonly string[]): boolean {
  return prompts.some((prompt) => planPrompt(prompt).suppress);
}

/** The text with every prompt echo replaced; undefined when diagnostics must be suppressed. */
function redactPrompts(text: string, prompts: readonly string[]): string | undefined {
  let result = text;
  for (const prompt of prompts) {
    const plan = planPrompt(prompt);
    if (plan.suppress) return undefined;
    for (const token of plan.shortTokens) result = redactShortPrompt(result, token);
    for (const variant of plan.variants) result = redactPromptToken(result, variant);
    result = redactFragments(result, plan.fragments);
  }
  return result;
}

/** Redact common bearer/token/key formats from `text`. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

/**
 * Bounded, sanitized excerpt of untrusted child output. Safe to put in an
 * error message, AgentError.context, a receipt or a log line.
 */
export function sanitizeDiagnostic(text: string, opts: SanitizeDiagnosticOptions = {}): string {
  const maxChars = opts.maxChars ?? MAX_DIAGNOSTIC_CHARS;
  const from = opts.from ?? "head";
  let raw = text;
  let edgeCut = opts.edgeCut === true;
  if (raw.length > RAW_WINDOW_CHARS) {
    raw = from === "head" ? raw.slice(0, RAW_WINDOW_CHARS) : raw.slice(-RAW_WINDOW_CHARS);
    edgeCut = true;
  }
  if (edgeCut) raw = dropPartialEdge(raw, from === "head" ? "end" : "start");

  const promptFree = redactPrompts(stripTerminalNoise(raw), opts.redact ?? []);
  if (promptFree === undefined) return capText(SUPPRESSED_MARKER, maxChars, "head");
  return capText(redactSecrets(promptFree).trim(), maxChars, from);
}

/** Cap already-sanitized text at `maxChars`, marker included. */
function capText(text: string, maxChars: number, from: "head" | "tail"): string {
  if (text.length <= maxChars) return text;
  if (from === "head") return `${text.slice(0, Math.max(0, maxChars - HEAD_MARKER.length))}${HEAD_MARKER}`;
  return `${TAIL_MARKER}${text.slice(text.length - Math.max(0, maxChars - TAIL_MARKER.length))}`;
}

const STRUCTURED_FIELD_MAX = 600;

function structuredField(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["type", "code", "message"] as const) {
      const part = record[key];
      if (typeof part === "string" || typeof part === "number") parts.push(`${key}=${String(part)}`);
    }
    return parts.length === 0 ? undefined : parts.join(" ");
  }
  return undefined;
}

/**
 * How far into an oversized NDJSON line the top-level scanner reads. The line
 * is never JSON.parsed and never copied: the scanner walks it character by
 * character, skipping nested containers and long strings.
 */
const OVERSIZED_SCAN_CHARS = 1024 * 1024;
/** Raw characters kept of one scanned string value (sanitized and capped later). */
const SCAN_VALUE_CAPTURE_CHARS = 4 * 1024;
/** Oversized lines scanned per call; more are skipped. */
const MAX_OVERSIZED_LINES = 3;
/** Window budget charged per scanned oversized line. */
const OVERSIZED_LINE_CHARGE = 16 * 1024;
/** How many stdout lines (newest first) are looked at for an error envelope. */
const MAX_SCANNED_LINES = 200;

const SCAN_TOP_KEYS = new Set([
  "type",
  "subtype",
  "status",
  "api_error_status",
  "error",
  "message",
  "is_error",
  "result",
]);
/** Shown in place of a captured string whose raw bytes could not be decoded. */
const SUPPRESSED_FIELD = "[suppressed: undecodable string]";
const SCAN_ERROR_CHILD_KEYS = new Set(["type", "code", "message"]);

/**
 * Longest prefix of a clipped JSON string body that ends on a complete escape
 * sequence. Walks forward from the start, so the parity of preceding
 * backslashes is tracked exactly: in `\\\\u0` the `u0` is plain text after an
 * escaped backslash, in `\\u0` it is a cut-off `\\uXXXX`.
 */
function completeEscapePrefix(raw: string): string {
  let i = 0;
  while (i < raw.length) {
    if (raw.charAt(i) !== "\\") {
      i++;
      continue;
    }
    const width = raw.charAt(i + 1) === "u" ? 6 : 2;
    if (i + width > raw.length) return raw.slice(0, i);
    i += width;
  }
  return raw;
}

/**
 * Decode a JSON string body. Any failure (a malformed escape, a clip that left
 * the body invalid) yields `undefined` — malformed bytes are never passed on as
 * if they were decoded text, because redaction rules rely on the decoded form.
 */
function decodeJsonString(raw: string): string | undefined {
  try {
    const decoded: unknown = JSON.parse(`"${raw}"`);
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A scanned scalar. `truncated`: the value was longer than what the scanner
 * keeps of it. `suppressed`: its captured text could not be decoded, so no text
 * is kept at all.
 */
interface ScanValue {
  readonly text: string;
  readonly truncated: boolean;
  readonly suppressed?: boolean;
}

interface TopLevelScan {
  readonly top: ReadonlyMap<string, ScanValue>;
  /** type/code/message of a top-level `error` OBJECT. */
  readonly errorChild: ReadonlyMap<string, ScanValue>;
  /** A top-level `error` key exists (whatever its value). */
  readonly hasErrorKey: boolean;
}

/**
 * Depth-aware walk over the start of one JSON object line: records only the
 * scalar fields of the TOP-LEVEL object (plus the direct children of a
 * top-level `error` object). Anything nested deeper — a tool_result's
 * `is_error`, a nested `message` — is skipped, so it can never be mistaken for
 * the envelope's own fields. Stops at `limit` characters; fields past it are lost.
 */
function scanTopLevelFields(line: string, limit: number): TopLevelScan | undefined {
  const end = Math.min(line.length, limit);
  const containers: ("{" | "[")[] = [];
  const keys: (string | undefined)[] = [];
  const expectKey: boolean[] = [];
  const top = new Map<string, ScanValue>();
  const errorChild = new Map<string, ScanValue>();
  let hasErrorKey = false;
  let started = false;

  const record = (value: ScanValue): void => {
    const depth = containers.length;
    const key = keys[depth - 1];
    if (key === undefined) return;
    if (depth === 1 && SCAN_TOP_KEYS.has(key)) top.set(key, value);
    else if (depth === 2 && keys[0] === "error" && containers[1] === "{" && SCAN_ERROR_CHILD_KEYS.has(key)) {
      errorChild.set(key, value);
    }
    keys[depth - 1] = undefined;
  };

  let i = 0;
  while (i < end) {
    const ch = line.charAt(i);
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
      continue;
    }
    if (!started) {
      if (ch !== "{") return undefined;
      started = true;
    }
    if (ch === "{" || ch === "[") {
      containers.push(ch);
      keys.push(undefined);
      expectKey.push(ch === "{");
      i++;
      continue;
    }
    if (ch === "}" || ch === "]") {
      containers.pop();
      keys.pop();
      expectKey.pop();
      if (containers.length === 0) break;
      keys[containers.length - 1] = undefined;
      i++;
      continue;
    }
    if (ch === ",") {
      const last = containers.length - 1;
      if (last >= 0) {
        keys[last] = undefined;
        expectKey[last] = containers[last] === "{";
      }
      i++;
      continue;
    }
    if (ch === ":") {
      i++;
      continue;
    }
    const depth = containers.length;
    if (ch === '"') {
      let j = i + 1;
      while (j < line.length && j < end && line.charAt(j) !== '"') j += line.charAt(j) === "\\" ? 2 : 1;
      if (j >= end) return depth === 0 ? undefined : { top, errorChild, hasErrorKey };
      const cutAt = i + 1 + SCAN_VALUE_CAPTURE_CHARS;
      const truncated = j > cutAt;
      const raw = line.slice(i + 1, Math.min(j, cutAt));
      i = j + 1;
      if (containers[depth - 1] === "{" && expectKey[depth - 1] === true) {
        // An undecodable key matches no wanted key; its value is skipped.
        const key = decodeJsonString(raw) ?? "";
        keys[depth - 1] = key;
        expectKey[depth - 1] = false;
        if (depth === 1 && key === "error") hasErrorKey = true;
      } else {
        const decoded = decodeJsonString(truncated ? completeEscapePrefix(raw) : raw);
        record(
          decoded === undefined ? { text: "", truncated, suppressed: true } : { text: decoded, truncated },
        );
      }
      continue;
    }
    // Number / true / false / null.
    let j = i;
    while (j < end && !",}] \t\r\n".includes(line.charAt(j))) j++;
    if (depth > 0) record({ text: line.slice(i, Math.min(j, i + 64)), truncated: j - i > 64 });
    i = Math.max(j, i + 1);
  }
  return started ? { top, errorChild, hasErrorKey } : undefined;
}

/** One summary field; `truncated` values lost their tail at the scanner's capture limit, `suppressed` ones are not shown at all. */
interface SummaryField {
  readonly key: string;
  readonly value: string;
  readonly truncated?: boolean;
  readonly suppressed?: boolean;
}

/** Same `key=value` fields the parsed path reads, from a top-level scan of an oversized line. */
function oversizedEnvelopeFields(scan: TopLevelScan): SummaryField[] | undefined {
  const isError = scan.top.get("is_error")?.text === "true";
  const statusError = scan.top.get("status")?.text === "error";
  const errorValue = scan.top.get("error");
  const hasErrorValue = scan.hasErrorKey && errorValue?.text !== "null";
  const hasErrorObject = scan.hasErrorKey && errorValue === undefined && scan.errorChild.size > 0;
  if (!isError && !hasErrorValue && !hasErrorObject && !statusError) return undefined;
  const fields: SummaryField[] = [];
  const add = (key: string, value: ScanValue | undefined): void => {
    if (value === undefined || (value.text === "" && !value.truncated && value.suppressed !== true)) return;
    fields.push({
      key,
      value: value.text,
      truncated: value.truncated,
      suppressed: value.suppressed === true,
    });
  };
  for (const key of ["type", "subtype", "status", "api_error_status"] as const) add(key, scan.top.get(key));
  const errorString = scan.top.get("error");
  if (errorString !== undefined) add("error", errorString);
  else if (scan.errorChild.size > 0) {
    const children = [...scan.errorChild];
    add("error", {
      text: children
        .map(([key, child]) => `${key}=${child.suppressed === true ? SUPPRESSED_FIELD : child.text}`)
        .join(" "),
      truncated: children.some(([, child]) => child.truncated),
    });
  }
  add("message", scan.top.get("message"));
  if (isError) add("result", scan.top.get("result"));
  if (fields.length === 0) return undefined;
  fields.push({
    key: "envelope",
    value: "exceeded the parse budget; top-level fields scanned without parsing it",
  });
  return fields;
}

/**
 * Drop the last, possibly cut-off whitespace-delimited token of a value that
 * lost its tail: a partial secret (`sk-ant-ap`, `Bearer ab`) is no longer
 * recognizable once cut. A value with no whitespace is dropped entirely. The
 * unterminated-quote rule of the sanitizer covers a quoted credential whose
 * closing quote was cut away.
 */
function dropPartialToken(text: string): string {
  if (/\s$/.test(text)) return text;
  const lastBreak = text.search(/\s\S*$/);
  return lastBreak === -1 ? "" : text.slice(0, lastBreak);
}

/**
 * The structured error a CLI printed on stdout (claude-lineage `result`
 * envelopes with is_error, `{error:{…}}` objects, …), as a short sanitized
 * `key=value` summary; undefined when no stdout line carries one. Only the
 * error-bearing fields are read — assistant text and tool output are not.
 *
 * Lines are examined newest first, within a budget of MAX_SCANNED_LINES lines
 * and one raw window of characters. A line over the window (one giant
 * `result`) is not parsed: its top-level fields are read by a bounded,
 * depth-aware scan (see scanTopLevelFields), at most MAX_OVERSIZED_LINES per call.
 */
export function extractStructuredError(
  stdout: string,
  opts: { readonly redact?: readonly string[]; readonly maxChars?: number } = {},
): string | undefined {
  const redact = opts.redact ?? [];
  // Bounded sampling cannot establish this prompt: show nothing from the child's own output.
  if (promptsSuppressDiagnostics(redact)) return undefined;
  const finish = (fields: readonly SummaryField[]): string | undefined => {
    const parts = fields.map(({ key, value, truncated, suppressed }) => {
      if (suppressed === true) return `${key}=${SUPPRESSED_FIELD}`;
      const kept = truncated === true ? dropPartialToken(value) : value;
      const text = sanitizeDiagnostic(kept, { redact, maxChars: STRUCTURED_FIELD_MAX });
      return `${key}=${text}${truncated === true ? HEAD_MARKER : ""}`;
    });
    if (parts.length === 0) return undefined;
    // Each field is already sanitized on its own; re-running line-based redaction over the
    // joined summary would let one field's header-style value swallow the fields after it.
    return capText(parts.join("; "), opts.maxChars ?? MAX_DIAGNOSTIC_CHARS, "head");
  };

  let end = stdout.length;
  let budget = RAW_WINDOW_CHARS;
  let oversizedScanned = 0;
  for (let scanned = 0; end > 0 && scanned < MAX_SCANNED_LINES && budget > 0; scanned++) {
    const lineBreak = stdout.lastIndexOf("\n", end - 1);
    const start = lineBreak + 1;
    const length = end - start;
    end = lineBreak;
    if (length === 0) continue;

    // Cheap check on the line's first characters before any real work on it.
    const opening = stdout.slice(start, start + 64).trimStart();
    if (!opening.startsWith("{")) {
      budget -= Math.min(length, 64);
      continue;
    }

    if (length > RAW_WINDOW_CHARS) {
      budget -= OVERSIZED_LINE_CHARGE;
      if (oversizedScanned >= MAX_OVERSIZED_LINES) continue;
      oversizedScanned++;
      const scan = scanTopLevelFields(
        stdout.slice(start, start + Math.min(length, OVERSIZED_SCAN_CHARS)),
        OVERSIZED_SCAN_CHARS,
      );
      const fields = scan === undefined ? undefined : oversizedEnvelopeFields(scan);
      const summary = fields === undefined ? undefined : finish(fields);
      if (summary !== undefined) return summary;
      continue;
    }

    budget -= length;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.slice(start, start + length).trim());
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    const isErrorEnvelope =
      record["is_error"] === true ||
      (record["error"] !== undefined && record["error"] !== null) ||
      record["status"] === "error";
    if (!isErrorEnvelope) continue;
    const fields: SummaryField[] = [];
    for (const key of ["type", "subtype", "status", "api_error_status", "error", "message"] as const) {
      const value = structuredField(record[key]);
      if (value !== undefined && value !== "") fields.push({ key, value });
    }
    // An error `result` string (claude: the human-readable failure text).
    if (record["is_error"] === true) {
      const result = structuredField(record["result"]);
      if (result !== undefined && result !== "") fields.push({ key: "result", value: result });
    }
    const summary = finish(fields);
    if (summary !== undefined) return summary;
  }
  return undefined;
}
