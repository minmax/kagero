/**
 * stream-compressor.ts — the always-on traffic reducer for runs started by
 * this server (x_prompt / x_resume).
 *
 * The tap (the pi-mcp pattern: stand between the agent's event stream and
 * its delivery): the factory hands every event of the selected backend's
 * runs to subscribers; the hub subscribes once per backend agent —
 * `session-start` names a session, then a per-session subscription routes
 * that session's events to its accumulator. Events keep flowing to all
 * other subscribers unchanged.
 *
 * Per session the accumulator:
 *  - minimizes every event (deterministic, lossy, anchored) and hands the
 *    line to `onLiveLine` — the server forwards it as a logging notification,
 *    so the orchestrator sees a LIVE but already squeezed stream;
 *  - accumulates the RAW events in memory only (the CLI writes its own log);
 *  - whenever one window-worth is buffered (token budget; a move is never
 *    split — an oversized move forms its own batch), the batch goes to the
 *    cheap compressor agent in the background, and the rolling digest/report
 *    is checkpointed into the persistent journal after every window.
 *
 * Print-transport backends emit no semantic live events (backend docs), so
 * there the hub sees only session lifecycle and compresses at session-end.
 */

import {
  type Agent,
  type AgentCapabilities,
  type AgentEvent,
  buildDigestWindows,
  type DigestWindow,
  type HistoryEntry,
  renderDigestBlocks,
} from "@kagero/core";
import {
  COMPRESSOR_SYSTEM_PROMPT,
  compressDelta,
  isCompressorOwnedSession,
  lastCompressorFailure,
  type WatchConfig,
} from "./watch.js";
import { emptyWatchState, loadWatchState, saveWatchState, type WatchState } from "./watch-state.js";

/** The compressor's own turns start with this — sessions carrying it are never re-compressed. */
const COMPRESSOR_PROMPT_MARKER = COMPRESSOR_SYSTEM_PROMPT.slice(0, 60);

/** Deterministic token budget of one stream window (~chars/4). */
const WINDOW_BUDGET_TOKENS = 40_000;
/** Live-notification text cap per event (the deterministic minimizer cut). */
const LIVE_LINE_MAX_CHARS = 240;
/** Tool-result head/tail in the live feed. */
const TOOL_HEAD = 400;
const TOOL_TAIL = 160;

function argsToText(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return String(args);
  }
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(+${text.length - max} chars)`;
}

/** Deterministic minimized view of an already-buffered entry (fallback feed). */
function minimizeRawEntry(entry: HistoryEntry): string {
  const ref = entry.line === undefined ? `#${entry.index}` : ` @L${entry.line}`;
  const role = entry.role === "assistant" ? "ASST" : entry.role === "user" ? "USER" : "TOOL";
  if (entry.role === "tool" && entry.toolResult !== undefined && entry.toolResult !== "") {
    const raw = entry.toolResult;
    const body = raw.length <= 400 ? raw : `${raw.slice(0, 400)} …⟨cut⟩ ${raw.slice(-160)}`;
    return `RESULT ${entry.toolName ?? "unknown"} ${body.replace(/\s+\n/g, " ")}${ref}`;
  }
  return `${role}${ref}: ${cap(entry.text, 240)}`;
}

/** The deterministic minimizer: one AgentEvent → one compact line. */
export function minimizeEvent(event: AgentEvent): string {
  switch (event.type) {
    case "session-start":
      return `session started: ${event.sessionId}`;
    case "user-prompt":
      return `USER: ${cap(event.content, LIVE_LINE_MAX_CHARS)}`;
    case "assistant-text":
      return `ASST: ${cap(event.content, LIVE_LINE_MAX_CHARS)}`;
    case "tool-call":
      return `CALL ${event.name} ${cap(argsToText(event.args), LIVE_LINE_MAX_CHARS)}`;
    case "tool-result": {
      const raw = argsToText(event.result);
      const body =
        raw.length <= TOOL_HEAD + TOOL_TAIL
          ? raw
          : `${raw.slice(0, TOOL_HEAD)} …⟨cut⟩ ${raw.slice(-TOOL_TAIL)}`;
      return `RESULT ${event.name} ${body.replace(/\s+\n/g, " ")}`;
    }
    case "error":
      return `ERROR: ${cap(event.message, LIVE_LINE_MAX_CHARS)}`;
    case "session-end":
      return `session ended (${event.reason})`;
  }
}

/** Raw event → accumulator entry (tool results are the fat part; keep whole here). */
function eventToEntry(event: AgentEvent): HistoryEntry | undefined {
  switch (event.type) {
    case "user-prompt":
      return { index: 0, role: "user", text: event.content };
    case "assistant-text":
      return { index: 0, role: "assistant", text: event.content };
    case "tool-call":
      return { index: 0, role: "tool", text: argsToText(event.args), toolName: event.name };
    case "tool-result":
      return {
        index: 0,
        role: "tool",
        text: `result ${event.name}`,
        toolName: event.name,
        toolResult: argsToText(event.result),
      };
    case "error":
      return { index: 0, role: "system", text: `error: ${event.message}` };
    default:
      return undefined;
  }
}

const entryTokens = (entry: HistoryEntry): number =>
  Math.ceil(Math.max(1, entry.text.length + (entry.toolResult?.length ?? 0)) / 4);

export interface StreamHubDeps {
  selectAgent: (backend: string | undefined) => Promise<Agent>;
  readonly config: WatchConfig;
  /** One minimized live line; the server forwards it as a logging notification. */
  onLiveLine(backend: string, sessionId: string, line: string): void;
}

/** One running session's in-memory accumulator + background compressor chain. */
class SessionStreamCompressor {
  private readonly buffer: HistoryEntry[] = [];
  private bufferTokens = 0;
  /** True once the session is recognized as the compressor's own run. */
  private suppressed = false;
  private queue: Promise<void> = Promise.resolve();
  private state: WatchState;
  private readonly backendName: string;
  readonly sessionId: string;
  private readonly deps: StreamHubDeps;

  constructor(backendName: string, sessionId: string, deps: StreamHubDeps) {
    this.backendName = backendName;
    this.sessionId = sessionId;
    this.deps = deps;
    this.state = loadWatchState(backendName, sessionId) ?? emptyWatchState(backendName, sessionId);
  }

  /** Feed one event (never session-start/session-end — the hub routes those). */
  push(event: AgentEvent): void {
    // Recursion guard, belt: the ownership tap knows the exact ids of the
    // compressor's own sessions; suspend them (and drop what was buffered).
    if (isCompressorOwnedSession(this.backendName, this.sessionId)) {
      if (!this.suppressed) {
        this.suppressed = true;
        this.buffer.length = 0;
        this.bufferTokens = 0;
      }
      return;
    }
    if (event.type === "user-prompt") {
      // Recursion guard, suspenders: content-addressed — the compressor's own
      // turn announces itself, its first prompt IS the standing instructions.
      if (event.content.startsWith(COMPRESSOR_PROMPT_MARKER)) {
        this.suppressed = true;
      }
    }
    if (this.suppressed) return;
    const entry = eventToEntry(event);
    if (entry === undefined) {
      // Lifecycle/error events are not buffered, but errors are compressed
      // with the current batch (they are exactly the tail signal).
      if (event.type === "error") this.bufferTokens += 16;
      return;
    }

    // A move is never split: the buffer flushes when a NEW move starts and
    // the window budget is reached. Every batch (including the first) goes
    // through the LLM compressor — the live feed carries only AI-squeezed
    // text, so the first emission lands after batch one is compressed.
    const moveStartsHere = event.type === "assistant-text" || event.type === "user-prompt";
    if (moveStartsHere && this.bufferTokens >= WINDOW_BUDGET_TOKENS) this.flushWindow();

    const streamCursorIndex = (this.state.streamCursorIndex ?? 0) + 1;
    this.state.streamCursorIndex = streamCursorIndex;
    this.buffer.push({ ...entry, index: streamCursorIndex });
    this.bufferTokens += entryTokens(this.buffer[this.buffer.length - 1] as HistoryEntry);
  }

  /** Force-compress everything buffered right now ("дай сейчас"). */
  flush(): Promise<void> {
    if (this.buffer.length === 0) return Promise.resolve();
    const batch = this.buffer.splice(0);
    this.bufferTokens = 0;
    return this.enqueue(batch);
  }

  private flushWindow(): void {
    const batch = this.buffer.splice(0);
    this.bufferTokens = 0;
    void this.enqueue(batch);
  }

  /**
   * Serialize background compressions per session. A failed batch is reported
   * honestly and its events stay buffered for the next flush — a checkpoint
   * without a digest is never written (it would claim progress it did not
   * make and poison the journal).
   */
  private enqueue(batch: HistoryEntry[]): Promise<void> {
    const run = this.queue.then(async () => {
      const windows: DigestWindow[] = buildDigestWindows(batch);
      const compressed = await compressDelta(
        {
          selectAgent: this.deps.selectAgent,
          defaultBackend: this.deps.config.backend,
          config: this.deps.config,
        },
        this.backendName,
        this.sessionId,
        windows,
        this.state,
        (next) => {
          this.state = next;
        },
      );
      if (compressed === undefined) {
        // Compressor down or contract rejected: the stream must not go dark —
        // degrade to the deterministic minimized lines for this batch and put
        // the events back for a retry on the next flush.
        const reason = lastCompressorFailure ?? "compressor unavailable";
        process.stderr.write(`kagero: stream batch NOT compressed (${reason.split("\n")[0]})\n`);
        this.deps.onLiveLine(
          this.backendName,
          this.sessionId,
          `[batch compression failed — raw fallback: ${reason.split("\n")[0]}]`,
        );
        for (const entry of batch) {
          this.deps.onLiveLine(this.backendName, this.sessionId, minimizeRawEntry(entry));
        }
        this.buffer.unshift(...batch);
        this.bufferTokens += batch.reduce((acc, e) => acc + entryTokens(e), 0);
        return;
      }
      saveWatchState(this.state);
      // The LIVE feed carries the COMPRESSED text: status line + the batch's
      // digest blocks (anchored) — orchestrator traffic stays AI-squeezed.
      const report = compressed.output.report;
      this.deps.onLiveLine(
        this.backendName,
        this.sessionId,
        `[batch compressed → entry #${this.state.streamCursorIndex ?? 0}] status: ${report?.status ?? "?"} · progress: ${report?.progress ?? "?"}`,
      );
      const blocksText = renderDigestBlocks(compressed.output, compressed.aggregate);
      for (const line of blocksText.split("\n")) {
        if (line !== "") this.deps.onLiveLine(this.backendName, this.sessionId, line);
      }
    });
    this.queue = run.catch((err) => {
      process.stderr.write(`kagero: stream batch dropped: ${(err as Error).message}\n`);
    });
    return run;
  }

  settle(): Promise<void> {
    return this.queue;
  }
}

/** True when the backend can report live events at all. */
function canSubscribe(capabilities: AgentCapabilities): boolean {
  return capabilities.subscribe;
}

/**
 * Per-agent hub: attaches at most one wildcard watcher per agent instance
 * (the registry caches instances, so this covers every run of the backend).
 * `session-start` creates the accumulator and opens the per-session
 * subscription; `session-end` flushes and closes it.
 */
export class StreamCompressorHub {
  private readonly sessions = new Map<string, { compressor: SessionStreamCompressor; detach: () => void }>();
  private readonly attached = new WeakSet<Agent>();
  private readonly deps: StreamHubDeps;

  constructor(deps: StreamHubDeps) {
    this.deps = deps;
  }

  /** Idempotently attach to a backend agent. */
  attach(agent: Agent): void {
    if (this.attached.has(agent) || !canSubscribe(agent.capabilities)) return;
    this.attached.add(agent);
    agent.subscribe("*", (event) => {
      if (event.type !== "session-start") return;
      if (this.sessions.has(event.sessionId)) return;
      const compressor = new SessionStreamCompressor(agent.name, event.sessionId, this.deps);
      const detach = agent.subscribe(event.sessionId, (sessionEvent) => {
        if (sessionEvent.type === "session-end") {
          compressor.push(sessionEvent);
          void compressor
            .flush()
            .then(() => compressor.settle())
            .finally(() => {
              detach();
              this.sessions.delete(event.sessionId);
            });
          return;
        }
        compressor.push(sessionEvent);
      });
      this.sessions.set(event.sessionId, { compressor, detach });
    });
  }

  /** "дай сейчас": compress the session's buffered events immediately. */
  flushSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry === undefined) return Promise.resolve();
    return entry.compressor.flush();
  }

  /**
   * Await every in-flight background compression, bounded — called from the
   * server's stop() so an MCP timeout/retry does not kill a half-done batch:
   * the window either checkpoints into the journal or reports its failure.
   */
  async settleAll(maxMs = 180_000): Promise<void> {
    const deadline = Date.now() + maxMs;
    for (const entry of [...this.sessions.values()]) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.race([entry.compressor.settle(), new Promise((r) => setTimeout(r, remaining))]);
    }
    this.sessions.clear();
  }
}
