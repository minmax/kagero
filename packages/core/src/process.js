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
/**
 * Resolve a binary: `envVar` (when set and the file exists) wins, otherwise a
 * PATH search. Throws AgentError("binary_not_found") with a hint naming the
 * env var when nothing is found.
 */
export function resolveBinary(binary, envVar) {
    void binary;
    void envVar;
    throw new Error("not implemented");
}
/** Spawn and supervise one run to completion. Never throws for run outcomes —
 * failures are statuses; only programming errors throw. */
export function runProcess(binary, args, opts = {}) {
    void binary;
    void args;
    void opts;
    throw new Error("not implemented");
}
//# sourceMappingURL=process.js.map