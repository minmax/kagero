/**
 * process.ts — the one subprocess runner for all print-style CLI transports.
 *
 * Contract (see docs/LIB-PLAN.md §4):
 *  - The child is spawned detached into its own process group; the stop
 *    ladder is SIGTERM to the group, then SIGKILL after `killGraceMs`, then a
 *    control sweep of the group. kill(-pid) is guarded to pid > 0 — killing
 *    group -0 would signal our own process group.
 *  - The binary resolves through the given env override first, then a normal
 *    PATH search. No fixed directory lists.
 *  - Output is capped at `maxOutputBytes` across stdout+stderr; when the cap
 *    is hit the tail is dropped and `truncated: true`.
 *  - Statuses are honest: `timed-out` (deadline hit), `aborted` (external
 *    signal), `spawn-failed`, `exit-error` (non-zero exit without our kill),
 *    `completed`. A killed process never reports success.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join as joinPath, delimiter as pathDelimiter } from "node:path";

import { AgentError } from "./agent.js";

const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;

/** How a finished subprocess run ended. */
export type RunStatus = "completed" | "aborted" | "timed-out" | "spawn-failed" | "exit-error";

export interface RunResult {
  readonly status: RunStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Checkpoint for the whole run; expiry drives the stop ladder and resolves
   * with status "timed-out". Undefined means no deadline.
   */
  readonly timeoutMs?: number;
  /** Byte cap across stdout+stderr. Default 50MB. */
  readonly maxOutputBytes?: number;
  /** External abort signal — expiry resolves with status "aborted". */
  readonly signal?: AbortSignal;
  /** Raw stdout chunks (utf8) as they arrive. */
  readonly onStdoutChunk?: (chunk: string) => void;
  /** SIGTERM → SIGKILL grace. Default 5000 ms. */
  readonly killGraceMs?: number;
}

export interface ResolvedBinary {
  readonly path: string;
  readonly source: "env" | "path";
}

/**
 * Resolve a binary: `envVar` (when set and the file exists) wins, otherwise a
 * PATH search. Throws AgentError("binary_not_found") with a hint naming the
 * env var when nothing is found.
 */
export function resolveBinary(binary: string, envVar?: string): ResolvedBinary {
  if (envVar !== undefined && envVar !== "") {
    const fromEnv = process.env[envVar];
    if (fromEnv !== undefined && fromEnv !== "" && existsSync(fromEnv)) {
      return { path: fromEnv, source: "env" };
    }
  }
  const searchedDirs = (process.env.PATH ?? "").split(pathDelimiter).filter((dir) => dir !== "");
  for (const dir of searchedDirs) {
    const candidate = joinPath(dir, binary);
    if (existsSync(candidate)) return { path: candidate, source: "path" };
  }
  const hint =
    envVar !== undefined && envVar !== ""
      ? ` Set ${envVar} to the full binary path, or put "${binary}" on PATH.`
      : ` Put "${binary}" on PATH.`;
  throw new AgentError("binary_not_found", `Binary "${binary}" not found (searched PATH).${hint}`, "user", {
    binary,
    envVar,
    searchedDirs: searchedDirs.length,
  });
}

/**
 * Signal the child's own process group. The group kill is guarded to
 * pid > 0: kill(-0) would signal OUR process group. When the group is
 * already gone, fall back to a direct kill of the child.
 */
const signalStop = (
  pid: number | undefined,
  childKill: (signal: NodeJS.Signals) => boolean,
  sig: NodeJS.Signals,
): void => {
  if (pid !== undefined && pid > 0) {
    try {
      process.kill(-pid, sig);
      return;
    } catch {
      // Group is already gone — fall through to the direct kill.
    }
  }
  try {
    childKill(sig);
  } catch {
    // Child is already dead; nothing to stop.
  }
};

/**
 * Spawn and supervise one run to completion. Never throws for run outcomes —
 * failures are statuses (including spawn failures like EACCES/ENOENT, which
 * resolve with status "spawn-failed"); only programming errors throw.
 */
export function runProcess(
  binary: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const startedAt = Date.now();
  const outputCap = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const graceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  // Already-expired external signal: nothing to spawn.
  if (opts.signal?.aborted === true) {
    return Promise.resolve({
      status: "aborted",
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      truncated: false,
    });
  }

  return new Promise((resolve) => {
    const stdoutParts: Buffer[] = [];
    const stderrParts: Buffer[] = [];
    let outputBytes = 0;
    let truncated = false;
    let stopReason: "timed-out" | "aborted" | null = null;
    let ladderStarted = false;
    let spawnFailed = false;
    let settled = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let graceTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;

    const onAbort = (): void => {
      startLadder("aborted");
    };

    /** Combined byte cap across stdout+stderr: keep the head, drop the tail. */
    const takeChunk = (chunk: Buffer): Buffer => {
      const room = outputCap - outputBytes;
      if (chunk.length <= room) {
        outputBytes += chunk.length;
        return chunk;
      }
      truncated = true;
      const kept = chunk.subarray(0, Math.max(0, room));
      outputBytes += kept.length;
      return kept;
    };

    function startLadder(reason: "timed-out" | "aborted"): void {
      if (ladderStarted || settled) return;
      ladderStarted = true;
      stopReason = reason;
      signalStop(child.pid, (sig) => child.kill(sig), "SIGTERM");
      graceTimer = setTimeout(() => {
        signalStop(child.pid, (sig) => child.kill(sig), "SIGKILL");
      }, graceMs);
    }

    function settle(): void {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onAbort);

      // Control sweep: after the ladder ran, make sure nothing in the child's
      // group survived the SIGKILL round (guarded to pid > 0, errors ignored).
      if (ladderStarted && child.pid !== undefined && child.pid > 0) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Group is already gone — sweep done.
        }
      }

      const status: RunStatus = spawnFailed
        ? "spawn-failed"
        : stopReason === "timed-out"
          ? "timed-out"
          : stopReason === "aborted"
            ? "aborted"
            : exitCode === 0 && exitSignal === null
              ? "completed"
              : "exit-error";

      resolve({
        status,
        exitCode,
        signal: exitSignal,
        stdout: Buffer.concat(stdoutParts).toString("utf8"),
        stderr: Buffer.concat(stderrParts).toString("utf8"),
        durationMs: Math.max(0, Date.now() - startedAt),
        truncated,
      });
    }

    const child = spawn(binary, args, {
      detached: true,
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      const kept = takeChunk(chunk);
      if (kept.length > 0) {
        stdoutParts.push(kept);
        opts.onStdoutChunk?.(kept.toString("utf8"));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrParts.push(takeChunk(chunk));
    });

    child.on("error", () => {
      // Failed to spawn (ENOENT, EACCES, …). Resolve honestly instead of throwing.
      spawnFailed = true;
      settle();
    });

    child.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal ?? null;
      settle();
    });

    if (opts.timeoutMs !== undefined) {
      deadlineTimer = setTimeout(
        () => {
          startLadder("timed-out");
        },
        Math.max(0, opts.timeoutMs),
      );
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
