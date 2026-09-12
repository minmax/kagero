/**
 * workspace.ts — uniform workspace handling for every backend.
 *
 * A run's cwd is either inherited, an explicit directory, or a fresh scratch
 * directory created for the run (isolated workspace). The resolved path is
 * echoed back on every AgentResponse so a caller can find the artifacts.
 */
import type { WorkspaceOption } from "./agent.js";
export interface WorkspaceInfo {
    /** Absolute cwd for the run. */
    readonly cwd: string;
    /** The directory itself (same as cwd; kept for clarity at call sites). */
    readonly path: string;
    /** True when this call created the directory. */
    readonly created: boolean;
}
/**
 * Resolve the workspace for a run.
 *  - undefined → `fallbackCwd ?? process.cwd()`, never created.
 *  - `{path}` → mkdir -p the directory; `created` reflects whether it existed.
 *  - `{create: true}` → fresh mkdtemp under `parent ?? os.tmpdir()`, prefix
 *    "kagero-ws-"; `created` is always true.
 */
export declare function resolveWorkspace(opt: WorkspaceOption | undefined, fallbackCwd?: string): Promise<WorkspaceInfo>;
//# sourceMappingURL=workspace.d.ts.map