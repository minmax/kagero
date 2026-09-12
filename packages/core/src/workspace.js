/**
 * workspace.ts — uniform workspace handling for every backend.
 *
 * A run's cwd is either inherited, an explicit directory, or a fresh scratch
 * directory created for the run (isolated workspace). The resolved path is
 * echoed back on every AgentResponse so a caller can find the artifacts.
 */
/**
 * Resolve the workspace for a run.
 *  - undefined → `fallbackCwd ?? process.cwd()`, never created.
 *  - `{path}` → mkdir -p the directory; `created` reflects whether it existed.
 *  - `{create: true}` → fresh mkdtemp under `parent ?? os.tmpdir()`, prefix
 *    "kagero-ws-"; `created` is always true.
 */
export async function resolveWorkspace(opt, fallbackCwd) {
    void opt;
    void fallbackCwd;
    throw new Error("not implemented");
}
//# sourceMappingURL=workspace.js.map