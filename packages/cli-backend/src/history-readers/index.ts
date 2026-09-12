/**
 * history-readers — one session-log reader factory per CLI. Composition
 * layers import them from here (or through the @kagero/cli-backend barrel,
 * which re-exports this module as the `historyReaders` namespace).
 */

export { createClaudeHistoryReader } from "./claude.js";
export { createCodexHistoryReader } from "./codex.js";
export { createGrokHistoryReader } from "./grok.js";
export { createKimiHistoryReader } from "./kimi.js";
export { createMcodeHistoryReader } from "./mcode.js";
export { createPiHistoryReader } from "./pi.js";
export { createQwenHistoryReader } from "./qwen.js";
