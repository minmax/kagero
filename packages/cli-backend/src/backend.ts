/**
 * backend.ts — CliSpecAgent: an Agent over a CliSpec.
 *
 * One run at a time per session key. prompt/resume resolve the workspace
 * (core), build argv (spec.print) or open an ACP conversation (spec.acp), run
 * the CLI via core runProcess / AcpClient, parse, and map the outcome honestly:
 *  - print: RunStatus "exit-error"/"spawn-failed" throw AgentError
 *    ("cli_error"/"spawn_failed" with the stderr head); "aborted" and
 *    "timed-out" resolve with status "aborted"/"timed-out" and meta.partial —
 *    the session stays resumable, a checkpoint never looks like success.
 *  - ACP: stopReason "end_turn" → completed; "cancelled"/"canceled" → aborted
 *    (meta.partial); anything else (max_tokens, refusal, …) → completed with
 *    meta.partial — the CLI said why it stopped, and the text it produced is
 *    real. An expired deadline resolves "timed-out" after the in-protocol
 *    cancel the client already sent.
 *  - modelId echoes the requested id with modelSource "requested" only when
 *    the CLI stayed silent; otherwise the reported id wins.
 *  - onStream receives RAW stdout chunks (best-effort), exactly as
 *    PromptOptions.onStream documents. Semantic streaming exists
 *    (parse/claude-lineage.ts `claudeLineageStream`) for callers that parse
 *    themselves; the backend does not re-assemble text from print streams.
 *
 * Lifecycle events go to subscribers of the run's session id ("*" receives
 * everything): session-start when the session identity is first known
 * (upfront for resume and newSessionId specs and for ACP once the session
 * opens; after the final envelope for print runs that let the CLI name the
 * session), user-prompt at run start, session-end with reason completed /
 * killed / timed-out / errored, error on every throw.
 *
 * abort(sessionId) stops the in-flight run answerable under that id:
 * AbortController on print (the core stop ladder runs), in-protocol
 * session/cancel on ACP. No active run → no-op. Idempotent.
 *
 * send(sessionId, message, kind) goes through the live ACP client for the
 * session — clients stay in a session-keyed map after their run settles, so a
 * follow-up can be queued right after a turn ends — and gates on
 * capabilities.steer / capabilities.followUp; print-only specs get
 * unsupported_capability.
 *
 * listModels/listSessions run their spec command (probe budget, default 60s);
 * history delegates to spec.history.read; anything without a strategy throws
 * unsupportedCapability — honest refusal, never an empty success.
 *
 * dispose() aborts every active run, disposes the ACP clients (stop ladder),
 * and clears subscriptions.
 */

import { randomUUID } from "node:crypto";
import type {
  AcpSessionConfig,
  Agent,
  AgentCapabilities,
  AgentEvent,
  AgentResponse,
  HistoryOptions,
  HistoryResult,
  MidRunCommand,
  ModelInfo,
  PromptOptions,
  RunResult,
  SessionInfo,
} from "@kagero/core";
import {
  AcpClient,
  AgentError,
  resolveBinary,
  resolveWorkspace,
  runProcess,
  unsupportedCapability,
} from "@kagero/core";
import type { CliSpec, ParsedRun, PrintParser, PromptContext } from "./spec.js";
import { defaultBinaryEnvVar, deriveCapabilities } from "./spec.js";

export interface CliSpecAgentOptions {
  /** Default per-call timeout when PromptOptions omit one. Undefined = no deadline. */
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  /** Wall clock for one models/sessions probe. Default 60 000. */
  readonly probeTimeoutMs?: number;
}

/** Head of stderr in error messages — enough to diagnose, small enough to read. */
const STDERR_HEAD = 2_000;
const DEFAULT_PROBE_TIMEOUT_MS = 60_000;

/** An AgentEvent without the `at` stamp; the backend adds it on emit. */
type WithoutAt<T> = T extends { at: string } ? Omit<T, "at"> : never;
type AgentEventDraft = WithoutAt<AgentEvent>;

interface RunHandle {
  /** Registry key: the resume id, the generated upfront id, or a run uuid. */
  key: string;
  controller: AbortController;
  /** Set for ACP runs — abort/send go through the client. */
  client: AcpClient | null;
  /** Every session id this run answers under (requested + reported). */
  sessionIds: Set<string>;
  startEmitted: boolean;
}

const stderrHead = (stderr: string): string => {
  const text = stderr.trim();
  return text.length <= STDERR_HEAD ? text : text.slice(0, STDERR_HEAD);
};

export class CliSpecAgent implements Agent {
  public readonly name: string;
  public readonly capabilities: AgentCapabilities;
  public readonly spec: CliSpec;

  private readonly defaults: CliSpecAgentOptions;
  private readonly activeRuns = new Map<string, RunHandle>();
  /** Live ACP clients by session id — they outlive the run that opened them. */
  private readonly acpClients = new Map<string, AcpClient>();
  private readonly listeners = new Map<string, Set<(e: AgentEvent) => void>>();
  private disposed = false;

  constructor(spec: CliSpec, opts: CliSpecAgentOptions = {}) {
    this.spec = spec;
    this.name = spec.name;
    this.defaults = opts;
    this.capabilities = deriveCapabilities(spec);
  }

  // --- prompting ---------------------------------------------------------------

  async prompt(prompt: string, opts: PromptOptions = {}): Promise<AgentResponse> {
    return this.runPrompt(prompt, opts, "prompt");
  }

  async resume(sessionId: string, prompt: string, opts: PromptOptions = {}): Promise<AgentResponse> {
    if (!this.capabilities.resume) {
      throw unsupportedCapability(
        "resume",
        `${this.name} cannot continue a session; run a fresh prompt instead.`,
      );
    }
    return this.runPrompt(prompt, { ...opts, sessionId }, "resume");
  }

  private async runPrompt(
    prompt: string,
    opts: PromptOptions,
    mode: "prompt" | "resume",
  ): Promise<AgentResponse> {
    this.assertNotDisposed();
    const transport: "print" | "acp" =
      this.spec.defaultTransport ?? (this.spec.acp !== undefined ? "acp" : "print");
    const workspace = await resolveWorkspace(opts.workspace, opts.cwd);

    const baseCtx: PromptContext = {
      prompt,
      opts,
      mode,
      ...(opts.sessionId === undefined ? {} : { sessionId: opts.sessionId }),
      workspace: workspace.cwd,
    };
    const runSessionId = opts.sessionId ?? this.spec.newSessionId?.(baseCtx);
    const ctx: PromptContext = runSessionId === undefined ? baseCtx : { ...baseCtx, runSessionId };

    const handle: RunHandle = {
      key: runSessionId ?? randomUUID(),
      controller: new AbortController(),
      client: null,
      sessionIds: new Set<string>(),
      startEmitted: false,
    };
    handle.sessionIds.add(handle.key);
    this.activeRuns.set(handle.key, handle);

    try {
      // Print transports with an upfront id already know the session; ACP
      // reports its (authoritative) id when the session opens, and print runs
      // without an upfront id learn it from the CLI's output.
      if (transport === "print" && (mode === "resume" || runSessionId !== undefined)) {
        this.emitSessionStart(handle, handle.key);
      }
      this.emit(handle, { type: "user-prompt", content: prompt });

      const response =
        transport === "acp" && this.spec.acp !== undefined
          ? await this.runAcp(ctx, handle)
          : await this.runPrint(ctx, handle);

      this.emit(handle, {
        type: "session-end",
        reason:
          response.status === "completed"
            ? "completed"
            : response.status === "aborted"
              ? "killed"
              : "timed-out",
      });
      return response;
    } catch (err) {
      this.emit(handle, { type: "error", message: err instanceof Error ? err.message : String(err) });
      this.emit(handle, { type: "session-end", reason: "errored" });
      throw err;
    } finally {
      this.activeRuns.delete(handle.key);
    }
  }

  /** Print transport: one process, parse the stream, map the status honestly. */
  private async runPrint(ctx: PromptContext, handle: RunHandle): Promise<AgentResponse> {
    const print = this.spec.print;
    if (print === undefined) {
      throw unsupportedCapability("prompting", `spec "${this.spec.name}" declares no print transport.`);
    }
    const binary = resolveBinary(
      this.spec.binary,
      this.spec.binaryEnvVar ?? defaultBinaryEnvVar(this.spec.name),
    );
    const timeoutMs = ctx.opts.timeoutMs ?? this.defaults.timeoutMs;
    const args = print.args(ctx);

    let run: RunResult;
    try {
      run = await runProcess(binary.path, args, {
        cwd: ctx.workspace,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(this.defaults.maxOutputBytes === undefined
          ? {}
          : { maxOutputBytes: this.defaults.maxOutputBytes }),
        signal: handle.controller.signal,
        ...(ctx.opts.onStream === undefined ? {} : { onStdoutChunk: ctx.opts.onStream }),
      });
    } finally {
      if (print.cleanup !== undefined) {
        try {
          print.cleanup(ctx, args);
        } catch {
          // Cleanup is best-effort; it must never mask the run's outcome.
        }
      }
    }

    if (run.status === "exit-error" || run.status === "spawn-failed") {
      const head = stderrHead(run.stderr);
      const detail =
        run.status === "spawn-failed"
          ? `failed to spawn ${this.spec.binary}`
          : `${this.spec.binary} exited with code ${String(run.exitCode)}${run.signal === null ? "" : ` (signal ${run.signal})`}`;
      throw new AgentError(
        run.status === "spawn-failed" ? "spawn_failed" : "cli_error",
        head === "" ? detail : `${detail}: ${head}`,
        "tool",
        {
          exitCode: run.exitCode,
          signal: run.signal,
          stderrHead: head,
          binary: this.spec.binary,
        },
      );
    }

    const notCompleted = run.status !== "completed";
    const parsed = this.parsePrintSafely(print.parse, run);
    if (parsed.sessionId !== undefined) this.emitSessionStart(handle, parsed.sessionId);

    const modelId = parsed.modelId ?? ctx.opts.modelId;
    const responseSessionId = parsed.sessionId ?? ctx.sessionId ?? ctx.runSessionId;
    return {
      status: run.status === "aborted" ? "aborted" : run.status === "timed-out" ? "timed-out" : "completed",
      text: parsed.text,
      ...(responseSessionId === undefined ? {} : { sessionId: responseSessionId }),
      ...(modelId === undefined
        ? {}
        : {
            modelId,
            modelSource: parsed.modelId !== undefined ? ("reported" as const) : ("requested" as const),
          }),
      workspace: ctx.workspace,
      durationMs: run.durationMs,
      ...(parsed.usage === undefined ? {} : { usage: parsed.usage }),
      meta: {
        ...(notCompleted || parsed.partial === true ? { partial: true } : {}),
        ...(run.truncated ? { truncated: true } : {}),
      },
    };
  }

  /**
   * Parse a (possibly partial) print stream. A parser reporting the CLI's own
   * failure throws AgentError. Parsing a partial/aborted stream must not blow
   * up — a broken partial stream degrades to empty text while the status from
   * RunStatus stays honest.
   */
  private parsePrintSafely(parse: PrintParser, run: RunResult): ParsedRun {
    try {
      return parse(run.stdout, run.stderr, run);
    } catch (err) {
      if (err instanceof AgentError) throw err;
      if (run.status === "completed") {
        throw new AgentError(
          "cli_error",
          `could not parse ${this.spec.name} output: ${err instanceof Error ? err.message : String(err)}`,
          "tool",
          { stderrHead: stderrHead(run.stderr) },
        );
      }
      return { text: "" };
    }
  }

  /** ACP transport: one conversation per run; the client stays for send/abort. */
  private async runAcp(ctx: PromptContext, handle: RunHandle): Promise<AgentResponse> {
    const acp = this.spec.acp;
    if (acp === undefined) {
      throw unsupportedCapability("prompting", `spec "${this.spec.name}" declares no ACP transport.`);
    }
    const binary = resolveBinary(
      this.spec.binary,
      this.spec.binaryEnvVar ?? defaultBinaryEnvVar(this.spec.name),
    );
    const client = new AcpClient({
      command: [binary.path, ...acp.args, ...(acp.extraArgs?.(ctx) ?? [])],
      cwd: ctx.workspace,
      onEvent: (event, sessionId) => {
        const route = sessionId !== "" ? sessionId : handle.key;
        if (sessionId !== "") handle.sessionIds.add(sessionId);
        this.dispatch(route, { ...event, at: new Date().toISOString() } as AgentEvent);
      },
      permissionOption: ctx.opts.approvalMode === "yolo" ? "approve_always" : "approve_once",
    });
    handle.client = client;

    const startedAt = Date.now();
    try {
      await client.start();
      await client.initialize();
    } catch (err) {
      throw new AgentError("spawn_failed", err instanceof Error ? err.message : String(err), "tool", {
        binary: this.spec.binary,
      });
    }

    const meta = acp.sessionMeta?.(ctx);
    const modeId = acp.modeId?.(ctx);
    const configOptions = acp.configOptions?.(ctx);
    const config: AcpSessionConfig = {
      mcpServers: [],
      ...(meta === undefined ? {} : { meta }),
      ...(modeId === undefined ? {} : { modeId }),
      ...(configOptions === undefined ? {} : { configOptions: [...configOptions] }),
    };

    try {
      if (ctx.mode === "resume" && ctx.sessionId !== undefined) {
        await client.loadSession(ctx.sessionId, config);
      } else {
        await client.newSession(config);
      }
    } catch (err) {
      throw new AgentError(
        "cli_error",
        `${this.spec.name} ACP session failed: ${err instanceof Error ? err.message : String(err)}`,
        "tool",
        { binary: this.spec.binary },
      );
    }

    const sessionId = client.sessionId;
    if (sessionId === null) {
      throw new AgentError("cli_error", `${this.spec.name} ACP session did not open`, "tool", {});
    }
    this.trackClient(sessionId, client);
    this.emitSessionStart(handle, sessionId);
    client.abortWith(handle.controller.signal);

    const timeoutMs = ctx.opts.timeoutMs ?? this.defaults.timeoutMs;
    let stopReason: string;
    let text: string;
    try {
      const turn = await client.prompt(ctx.prompt, timeoutMs);
      stopReason = turn.stopReason;
      text = turn.text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (timeoutMs !== undefined && message.includes("timed out")) {
        // Deadline: the client already cancelled the turn in-protocol.
        return this.acpResponse("timed-out", "", sessionId, ctx, startedAt, true);
      }
      throw new AgentError("cli_error", message, "tool", { sessionId, binary: this.spec.binary });
    }

    const status: AgentResponse["status"] =
      stopReason === "end_turn"
        ? "completed"
        : stopReason === "cancelled" || stopReason === "canceled"
          ? "aborted"
          : "completed";
    return this.acpResponse(status, text, sessionId, ctx, startedAt, stopReason !== "end_turn");
  }

  private acpResponse(
    status: AgentResponse["status"],
    text: string,
    sessionId: string,
    ctx: PromptContext,
    startedAt: number,
    partial: boolean,
  ): AgentResponse {
    const modelId = ctx.opts.modelId;
    return {
      status,
      text,
      sessionId,
      ...(modelId === undefined ? {} : { modelId, modelSource: "requested" as const }),
      workspace: ctx.workspace,
      durationMs: Math.max(0, Date.now() - startedAt),
      meta: partial ? { partial: true } : {},
    };
  }

  // --- discovery -----------------------------------------------------------------

  async listModels(): Promise<ModelInfo[]> {
    this.assertNotDisposed();
    const models = this.spec.models;
    if (models === undefined) {
      throw unsupportedCapability(
        "model listing",
        `${this.name} exposes no model listing command; set models in the spec.`,
      );
    }
    const result = await this.runProbe(models.args());
    if (result.status !== "completed") {
      throw new AgentError("cli_error", `${this.name} model listing failed (${result.status})`, "tool", {
        status: result.status,
        stderrHead: stderrHead(result.stderr),
      });
    }
    return models.parse(result.stdout);
  }

  async listSessions(): Promise<SessionInfo[]> {
    this.assertNotDisposed();
    const sessions = this.spec.sessions;
    if (sessions === undefined) {
      throw unsupportedCapability(
        "session listing",
        `${this.name} exposes no session listing command; set sessions in the spec.`,
      );
    }
    const result = await this.runProbe(sessions.args());
    if (result.status !== "completed") {
      throw new AgentError("cli_error", `${this.name} session listing failed (${result.status})`, "tool", {
        status: result.status,
        stderrHead: stderrHead(result.stderr),
      });
    }
    return sessions.parse(result.stdout);
  }

  async history(sessionId: string, opts?: HistoryOptions): Promise<HistoryResult> {
    this.assertNotDisposed();
    const history = this.spec.history;
    if (history === undefined) {
      throw unsupportedCapability(
        "history",
        `${this.name} has no on-disk history reader; set history in the spec.`,
      );
    }
    return history.read(sessionId, opts);
  }

  private async runProbe(args: readonly string[]): Promise<RunResult> {
    const binary = resolveBinary(
      this.spec.binary,
      this.spec.binaryEnvVar ?? defaultBinaryEnvVar(this.spec.name),
    );
    return runProcess(binary.path, args, {
      timeoutMs: this.defaults.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      ...(this.defaults.maxOutputBytes === undefined ? {} : { maxOutputBytes: this.defaults.maxOutputBytes }),
    });
  }

  // --- live control -----------------------------------------------------------------

  subscribe(sessionId: string, onEvent: (e: AgentEvent) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(onEvent);
    return () => {
      const current = this.listeners.get(sessionId);
      if (current === undefined) return;
      current.delete(onEvent);
      if (current.size === 0) this.listeners.delete(sessionId);
    };
  }

  async send(sessionId: string, message: string, kind: MidRunCommand = "steer"): Promise<void> {
    if (kind !== "steer" && kind !== "follow_up") {
      throw unsupportedCapability(String(kind), "kind must be steer or follow_up.");
    }
    if (kind === "steer" && !this.capabilities.steer) throw unsupportedCapability("steer");
    if (kind === "follow_up" && !this.capabilities.followUp) throw unsupportedCapability("followUp");

    // The live client outlives its run (follow-up right after a settled
    // turn); an in-flight run whose session has not opened yet is reachable
    // through its handle.
    const client = this.acpClients.get(sessionId) ?? this.findBySession(sessionId)?.client ?? null;
    if (client === null) {
      throw unsupportedCapability(
        kind === "steer" ? "steer" : "followUp",
        `no live ACP session for "${sessionId}" — mid-run messages need an ACP run.`,
      );
    }
    if (kind === "steer") {
      client.steer(message);
    } else {
      client.followUp(message);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const handle = this.findBySession(sessionId);
    if (handle === null) return; // nothing in flight — idempotent no-op
    if (handle.client !== null) {
      handle.client.cancel();
      return;
    }
    handle.controller.abort();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const stops: Promise<unknown>[] = [];
    for (const handle of [...this.activeRuns.values()]) {
      handle.controller.abort();
    }
    for (const client of [...this.acpClients.values()]) {
      stops.push(client.dispose());
    }
    this.activeRuns.clear();
    this.acpClients.clear();
    await Promise.allSettled(stops);
    this.listeners.clear();
  }

  // --- plumbing ------------------------------------------------------------------

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new AgentError("disposed", `${this.name} backend was disposed`, "internal", {});
    }
  }

  private findBySession(sessionId: string): RunHandle | null {
    for (const handle of this.activeRuns.values()) {
      if (handle.sessionIds.has(sessionId)) return handle;
    }
    return null;
  }

  /** Remember a live ACP client per session id; a replaced client is disposed. */
  private trackClient(sessionId: string, client: AcpClient): void {
    const previous = this.acpClients.get(sessionId);
    if (previous !== undefined && previous !== client) {
      void previous.dispose().catch(() => {
        // A dead previous client is fine — it is being replaced.
      });
    }
    this.acpClients.set(sessionId, client);
  }

  private emit(handle: RunHandle, draft: AgentEventDraft): void {
    const event = { ...draft, at: new Date().toISOString() } as AgentEvent;
    for (const sessionId of handle.sessionIds) this.dispatch(sessionId, event);
  }

  private emitSessionStart(handle: RunHandle, sessionId: string): void {
    handle.sessionIds.add(sessionId);
    if (handle.startEmitted) return;
    handle.startEmitted = true;
    this.emit(handle, { type: "session-start", sessionId });
  }

  private dispatch(sessionId: string, event: AgentEvent): void {
    for (const key of [sessionId, "*"]) {
      const set = this.listeners.get(key);
      if (set === undefined) continue;
      for (const cb of set) {
        try {
          cb(event);
        } catch {
          // A broken subscriber must not break the run.
        }
      }
    }
  }
}
