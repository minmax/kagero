/**
 * FakeCli — TypeScript mock of the kagero CLI backends (dsh, qwen, …).
 *
 * Lives at test/fake-cli.ts. The actual binary that gets spawned by
 * src/backends/base.ts is test/fake-bin.ts (a tsx-launched shim that calls
 * into this class).
 *
 * The shell-script fake we used before was a dumb echo. This class is a real
 * mock with:
 *   - argument parsing (matches kagero's CLI conventions: --list-models,
 *     --list-sessions, --print <prompt>, --session <id>)
 *   - stateful sessions (Map<id, Session>) persisted to a state file so
 *     state survives across spawns (each test runs a fresh subprocess)
 *   - validation of session-id format
 *   - configurable failure modes (slow, error, one-shot)
 *   - call records that the test can inspect via the state file
 *
 * Each test creates its own FakeCli (or state dir) and configures the fake
 * via either:
 *   (a) the FakeCli instance directly (asserting against `fake.calls`), or
 *   (b) the state file before spawning the lib (so the spawned binary
 *       picks up config from disk and writes its call records back).
 *
 * The on-disk state format (stateDir/_state.json) is a single JSON object:
 *   {
 *     "models":                ModelInfo[]
 *     "expectedSessionIds":    string[] | undefined
 *     "allowedApprovalModes":  string[] | undefined   (kagero doesn't use
 *                                                       these yet — reserved
 *                                                       for parity with dsh)
 *     "failNext":              { exitCode, stderr } | null
 *     "sleepMs":               number
 *     "calls":                 CallRecord[]
 *     "sessions":              Record<string, FakeSession>
 *   }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

export interface FakeSession {
  id: string;
  createdAt: string;
  cwd: string;
  summary: string;
  messageCount: number;
  messages: Array<{ role: "user" | "assistant"; content: string; at: string }>;
}

export interface CallRecord {
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  at: number;
}

export interface HandleResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FakeOptions {
  /** Initial set of models. Default: 2 fake models. */
  models?: ModelInfo[];
  /** Sleep this many ms before returning (every call). */
  sleepMs?: number;
  /** Return this error on the NEXT call, then clear. */
  failNext?: { exitCode: number; stderr: string };
  /** Log each call to stderr. */
  verbose?: boolean;
  /** Allowed approval modes. Reserved for future parity; kagero doesn't use. */
  allowedApprovalModes?: string[];
  /** If set, only these session ids are accepted by --session. */
  expectedSessionIds?: string[];
  /** Persist state to this directory across spawns (file: <stateDir>/_state.json). */
  stateDir?: string;
}

const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: "fake-model-1",
    displayName: "Fake Model 1",
    provider: "fakeprovider",
    contextWindow: 8192,
    supportsTools: true,
    supportsVision: false,
  },
  {
    id: "fake-model-2",
    displayName: "Fake Model 2",
    provider: "fakeprovider",
    contextWindow: 4096,
    supportsTools: false,
    supportsVision: true,
  },
];

const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

interface PersistedState {
  models: ModelInfo[];
  expectedSessionIds?: string[];
  allowedApprovalModes?: string[];
  failNext: { exitCode: number; stderr: string } | null;
  sleepMs: number;
  calls: CallRecord[];
  sessions: Record<string, FakeSession>;
}

export class FakeCli {
  private models: ModelInfo[];
  private sleepMs: number;
  private failNext: { exitCode: number; stderr: string } | null = null;
  private readonly verbose: boolean;
  private allowedApprovalModes: string[];
  private expectedSessionIds?: string[];
  private readonly stateDir?: string;
  private readonly ownedSessions = new Map<string, FakeSession>();

  /** All calls made to this fake (in order). */
  readonly calls: CallRecord[] = [];

  constructor(opts: FakeOptions = {}) {
    this.models = opts.models ?? DEFAULT_MODELS;
    this.sleepMs = opts.sleepMs ?? 0;
    if (opts.failNext !== undefined) this.failNext = opts.failNext;
    this.verbose = opts.verbose ?? false;
    this.allowedApprovalModes = opts.allowedApprovalModes ?? [];
    if (opts.expectedSessionIds !== undefined) this.expectedSessionIds = opts.expectedSessionIds;
    if (opts.stateDir !== undefined) this.stateDir = opts.stateDir;
  }

  // ==========================================================================
  // Test-side API: pre-populate, expect, retrieve
  // ==========================================================================

  /** Pre-seed a session so the test can assert "lib resumes this session". */
  seedSession(session: FakeSession): void {
    this.ownedSessions.set(session.id, session);
    if (this.verbose) this.log(`seeded session ${session.id}`);
  }

  /** Get a session (for assertions). */
  getSession(id: string): FakeSession | undefined {
    return this.ownedSessions.get(id);
  }

  /** All sessions, sorted by createdAt desc. */
  listSessions(): FakeSession[] {
    return Array.from(this.ownedSessions.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** All call records. */
  allCalls(): readonly CallRecord[] {
    return this.calls;
  }

  /** Find calls that match a predicate. */
  callsMatching(pred: (c: CallRecord) => boolean): CallRecord[] {
    return this.calls.filter(pred);
  }

  /** True if any call's args start with the given expected args. */
  wasCalledWith(...expectedArgs: string[]): boolean {
    return this.calls.some((c) => {
      if (c.args.length < expectedArgs.length) return false;
      return expectedArgs.every((a, i) => c.args[i] === a);
    });
  }

  /** Last call (or undefined). */
  lastCall(): CallRecord | undefined {
    return this.calls[this.calls.length - 1];
  }

  /** Inject a transient failure for the next call. */
  setFailNext(exitCode: number, stderr: string): void {
    this.failNext = { exitCode, stderr };
  }

  /** Make subsequent calls slow. */
  setSleep(ms: number): void {
    this.sleepMs = ms;
  }

  // ==========================================================================
  // Subprocess side: handle one invocation. Returns {stdout, stderr, exitCode}.
  // ==========================================================================

  async handle(
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
    cwd: string,
  ): Promise<HandleResult> {
    const callRec: CallRecord = { args: [...args], env, cwd, at: Date.now() };
    this.calls.push(callRec);
    if (this.verbose) this.log(`call: ${args.join(" ")} (cwd=${cwd})`);

    const parsed = parseArgs(args);

    // Empty prompt is always an error
    if (parsed.prompt !== undefined && parsed.prompt.length === 0) {
      return { stdout: "", stderr: "empty prompt\n", exitCode: 2 };
    }

    // Failure simulation (one-shot)
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      return { stdout: "", stderr: f.stderr, exitCode: f.exitCode };
    }

    // Sleep simulation
    if (this.sleepMs > 0) {
      await new Promise((r) => setTimeout(r, this.sleepMs));
    }

    if (parsed.listModels) return this.handleListModels();
    if (parsed.listSessions) return this.handleListSessions();
    if (parsed.prompt && parsed.sessionId) {
      return this.handleResume(parsed.sessionId, parsed.prompt, cwd);
    }
    if (parsed.prompt) return this.handleOneShot(parsed.prompt);
    return { stdout: "noop\n", stderr: "", exitCode: 0 };
  }

  // ==========================================================================
  // Handlers — one per subcommand
  // ==========================================================================

  private handleListModels(): HandleResult {
    const lines = this.models.map(
      (m) =>
        `${m.id}\t${m.displayName}\t${m.provider}\t${m.contextWindow}\t${m.supportsTools}\t${m.supportsVision}`,
    );
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  }

  private handleListSessions(): HandleResult {
    const lines = this.listSessions().map((s) => `${s.id}\t${s.createdAt}\t${s.cwd}\t${s.messageCount}`);
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  }

  private handleResume(id: string, prompt: string, cwd: string): HandleResult {
    if (!SESSION_ID_RE.test(id)) {
      return { stdout: "", stderr: `bad session id: ${id}\n`, exitCode: 2 };
    }
    if (this.expectedSessionIds && !this.expectedSessionIds.includes(id)) {
      return { stdout: "", stderr: `unexpected session id: ${id}\n`, exitCode: 2 };
    }
    if (prompt.length === 0) {
      return { stdout: "", stderr: "empty prompt\n", exitCode: 2 };
    }

    let sess = this.ownedSessions.get(id);
    if (!sess) {
      sess = {
        id,
        createdAt: new Date().toISOString(),
        cwd,
        summary: prompt.slice(0, 120),
        messageCount: 0,
        messages: [],
      };
      this.ownedSessions.set(id, sess);
    }
    const now = new Date().toISOString();
    sess.messages.push({ role: "user", content: prompt, at: now });
    sess.messageCount += 1;
    const response = `[${id}/${sess.messageCount}] ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}\n`;
    sess.messages.push({ role: "assistant", content: response, at: now });
    sess.messageCount += 1;
    sess.summary = prompt.slice(0, 120);
    return { stdout: response, stderr: "", exitCode: 0 };
  }

  private handleOneShot(prompt: string): HandleResult {
    if (prompt.length === 0) {
      return { stdout: "", stderr: "empty prompt\n", exitCode: 2 };
    }
    return { stdout: `ok: ${prompt}\n`, stderr: "", exitCode: 0 };
  }

  // ==========================================================================
  // Persistence (load/persist state to <stateDir>/_state.json)
  // ==========================================================================

  private stateFile(): string {
    if (!this.stateDir) throw new Error("stateDir not set");
    return join(this.stateDir, "_state.json");
  }

  loadState(): void {
    if (!this.stateDir) return;
    const p = this.stateFile();
    if (!existsSync(p)) return;
    try {
      const data = JSON.parse(readFileSync(p, "utf8")) as Partial<PersistedState>;
      if (Array.isArray(data.models)) this.models = data.models;
      if (Array.isArray(data.expectedSessionIds)) {
        this.expectedSessionIds = [...data.expectedSessionIds];
      }
      if (Array.isArray(data.allowedApprovalModes)) {
        this.allowedApprovalModes = [...data.allowedApprovalModes];
      }
      if (data.failNext !== undefined) this.failNext = data.failNext;
      if (typeof data.sleepMs === "number") this.sleepMs = data.sleepMs;
      // REPLACE (not append) — each load represents a fresh view of disk state.
      // If you load twice, you see the same calls both times.
      if (Array.isArray(data.calls)) {
        this.calls.length = 0;
        for (const c of data.calls) this.calls.push(c);
      }
      if (data.sessions && typeof data.sessions === "object") {
        this.ownedSessions.clear();
        for (const [id, sess] of Object.entries(data.sessions)) {
          this.ownedSessions.set(id, sess);
        }
      }
      if (this.verbose) {
        this.log(`loaded state: ${this.calls.length} calls, ${this.ownedSessions.size} sessions`);
      }
    } catch {
      // Corrupt state — start fresh.
    }
  }

  persistState(): void {
    if (!this.stateDir) return;
    if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
    const state: PersistedState = {
      models: this.models,
      failNext: this.failNext,
      sleepMs: this.sleepMs,
      calls: this.calls,
      sessions: Object.fromEntries(this.ownedSessions.entries()),
    };
    if (this.expectedSessionIds) state.expectedSessionIds = this.expectedSessionIds;
    if (this.allowedApprovalModes) state.allowedApprovalModes = this.allowedApprovalModes;
    writeFileSync(this.stateFile(), JSON.stringify(state, null, 2));
  }

  /** Snapshot current state to a plain object (for tests to inspect before/after spawns). */
  snapshot(): PersistedState {
    return {
      models: [...this.models],
      failNext: this.failNext,
      sleepMs: this.sleepMs,
      calls: [...this.calls],
      sessions: Object.fromEntries(this.ownedSessions.entries()),
    };
  }

  /** Wipe the in-memory state. */
  reset(): void {
    this.models = DEFAULT_MODELS;
    this.sleepMs = 0;
    this.failNext = null;
    this.calls.length = 0;
    this.ownedSessions.clear();
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private log(msg: string): void {
    process.stderr.write(`[fake-cli] ${msg}\n`);
  }
}

// ----------------------------------------------------------------------------
// Argument parser
// ----------------------------------------------------------------------------

interface ParsedArgs {
  prompt?: string;
  sessionId?: string;
  listModels: boolean;
  listSessions: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { listModels: false, listSessions: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list-models") out.listModels = true;
    else if (a === "--list-sessions") out.listSessions = true;
    else if (a === "--print") {
      // The real CLI takes the prompt as the very next argv (kagero backends
      // do `spawn(bin, ["--print", prompt])`). We mirror that.
      const v = argv[i + 1];
      if (v !== undefined) {
        out.prompt = v;
        i += 1;
      }
    } else if (a === "--session") {
      const v = argv[i + 1];
      if (v !== undefined) {
        out.sessionId = v;
        i += 1;
      }
    }
    // unknown flags are ignored (real kagero CLIs may pass --model, etc.)
  }
  return out;
}
