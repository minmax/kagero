/**
 * Agent — common interface for any agentic backend.
 *
 * Every concrete backend (pi SDK, dsh CLI, qwen CLI, ...) implements this
 * interface. The MCP server and CLI both depend only on this contract.
 *
 * The shape mirrors what pi SDK provides, so the SDK is the "canonical"
 * implementation. CLI backends adapt to fit.
 */
/** Standardized error. */
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
//# sourceMappingURL=agent.js.map