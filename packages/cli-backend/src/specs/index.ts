/**
 * specs — the seven built-in CLI specs. Each module exports its spec as a
 * named const plus a default; this barrel is the one import site for
 * composition layers (the registry, the MCP server, thin per-CLI wrappers).
 */

import claudeSpec from "./claude.js";
import codexSpec from "./codex.js";
import dshSpec from "./dsh.js";
import grokSpec from "./grok.js";
import kimiSpec from "./kimi.js";
import mcodeSpec from "./mcode.js";
import qwenSpec from "./qwen.js";

export { claudeSpec, codexSpec, dshSpec, grokSpec, kimiSpec, mcodeSpec, qwenSpec };
export default [claudeSpec, codexSpec, dshSpec, grokSpec, kimiSpec, mcodeSpec, qwenSpec] as const;
