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
export declare function resolveBinary(binary: string, envVar?: string): ResolvedBinary;
/** Spawn and supervise one run to completion. Never throws for run outcomes —
 * failures are statuses; only programming errors throw. */
export declare function runProcess(binary: string, args: readonly string[], opts?: RunOptions): Promise<RunResult>;
//# sourceMappingURL=process.d.ts.map