/**
 * Agent — the common contract for every kagero backend.
 *
 * Every concrete backend (pi SDK, pi RPC, CLI wrappers) implements this
 * interface. The MCP server and CLI depend only on this contract.
 *
 * Contract rules (see docs/LIB-PLAN.md §4.0):
 *  - Responses always carry the final assistant `text` and, when the backend
 *    produced one, the `sessionId` — a caller must never need a second call
 *    to learn what session to resume.
 *  - `modelId` is the model as REPORTED by the backend (`modelSource:
 *    "reported"`); when the backend stays silent we echo the requested id and
 *    say so (`"requested"`). Silent model drift is the one unforgivable bug.
 *  - `usage` omits anything the backend did not report. Never fabricate zeros.
 *  - `status` is honest: a timed-out or aborted run never looks successful.
 *    The session stays resumable — a timeout is a checkpoint, not a failure
 *    of the conversation.
 */
/** Standard error for everything an Agent refuses or fails at. */
export class AgentError extends Error {
    code;
    kind;
    context;
    constructor(code, message, kind = "tool", context) {
        super(message);
        this.name = "AgentError";
        this.code = code;
        this.kind = kind;
        this.context = context;
    }
}
/** Build the canonical error for a capability the backend does not have. */
export function unsupportedCapability(capability, hint) {
    return new AgentError("unsupported_capability", `Backend does not support ${capability}.${hint ? ` ${hint}` : ""}`, "user", { capability });
}
//# sourceMappingURL=agent.js.map