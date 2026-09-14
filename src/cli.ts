#!/usr/bin/env node

/**
 * kagero CLI — the main entry point.
 *
 * Subcommands:
 *   kagero prompt <text>      one-shot prompt
 *   kagero resume <id> <text> resume a session
 *   kagero models             list models
 *   kagero sessions           list sessions
 *   kagero backends           list backends
 *   kagero mcp [--backend=X]  run as MCP server
 *   kagero version            print version
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentError } from "@kagero/core";
import { availableBackends, registry, select } from "./registry.js";

const VERSION = readVersion();
const DEFAULT_BACKEND = process.env["KAGERO_BACKEND"] ?? "pi-sdk";

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    return 0;
  }
  if (cmd === "--version" || cmd === "version") {
    console.log(VERSION);
    return 0;
  }
  try {
    switch (cmd) {
      case "prompt":
        return await cmdPrompt(rest);
      case "resume":
        return await cmdResume(rest);
      case "models":
        return await cmdModels();
      case "sessions":
        return await cmdSessions();
      case "backends":
        return await cmdBackends();
      case "mcp":
        return await cmdMcp(rest);
      default:
        console.error(`Unknown command: ${cmd}`);
        printHelp();
        return 2;
    }
  } catch (err) {
    if (err instanceof AgentError) {
      console.error(`[${err.code}] ${err.message}`);
      if (err.context) console.error(JSON.stringify(err.context, null, 2));
    } else {
      console.error((err as Error).message);
    }
    return 1;
  }
}

async function cmdPrompt(args: string[]): Promise<number> {
  const prompt = args.join(" ").trim();
  if (!prompt) {
    console.error("usage: kagero prompt <text>");
    return 2;
  }
  const backend = process.env["KAGERO_BACKEND"] ?? DEFAULT_BACKEND;
  const agent = await select(backend);
  try {
    const res = await agent.prompt(prompt);
    console.log(res.text);
    return 0;
  } finally {
    await agent.dispose();
  }
}

async function cmdResume(args: string[]): Promise<number> {
  const [sessionId, ...rest] = args;
  const prompt = rest.join(" ").trim();
  if (!sessionId || !prompt) {
    console.error("usage: kagero resume <session_id> <text>");
    return 2;
  }
  const backend = process.env["KAGERO_BACKEND"] ?? DEFAULT_BACKEND;
  const agent = await select(backend);
  try {
    const res = await agent.resume(sessionId, prompt);
    console.log(res.text);
    return 0;
  } finally {
    await agent.dispose();
  }
}

async function cmdModels(): Promise<number> {
  const backend = process.env["KAGERO_BACKEND"] ?? DEFAULT_BACKEND;
  const agent = await select(backend);
  try {
    const models = await agent.listModels();
    for (const m of models) {
      const caps: string[] = [];
      if (m.supportsTools) caps.push("tools");
      if (m.supportsVision) caps.push("vision");
      console.log(
        `${m.id}\t${m.displayName}\t${m.provider}\t${m.contextWindow}${caps.length ? "\t" + caps.join(",") : ""}`,
      );
    }
    return 0;
  } finally {
    await agent.dispose();
  }
}

async function cmdSessions(): Promise<number> {
  const backend = process.env["KAGERO_BACKEND"] ?? DEFAULT_BACKEND;
  const agent = await select(backend);
  try {
    const sessions = await agent.listSessions();
    if (sessions.length === 0) {
      console.log("No sessions.");
      return 0;
    }
    for (const s of sessions) {
      console.log(`${s.id}\t${s.lastUsedAt}\t${s.cwd}\t${s.messageCount}\t${s.summary}`);
    }
    return 0;
  } finally {
    await agent.dispose();
  }
}

async function cmdBackends(): Promise<number> {
  const list = availableBackends();
  console.log("Available backends:");
  for (const b of list) console.log(`  ${b}`);
  console.log(`\nDefault: ${DEFAULT_BACKEND}`);
  console.log("Override with KAGERO_BACKEND env var.");
  return 0;
}

async function cmdMcp(args: string[]): Promise<number> {
  if (args[0] === "--help" || args[0] === "-h") {
    printMcpHelp();
    return 0;
  }
  const backendFlag = args.find((a) => a.startsWith("--backend="));
  const requested = backendFlag !== undefined ? backendFlag.slice("--backend=".length) : DEFAULT_BACKEND;
  const valid = availableBackends();
  if (!valid.includes(requested)) {
    console.error(`[unknown_backend] ${requested}. Available: ${valid.join(", ")}`);
    return 2;
  }
  const { createKageroMcpServer, readWatchConfig } = await import("@kagero/mcp");
  const server = createKageroMcpServer({
    name: "kagero-mcp",
    version: VERSION,
    toolPrefix: "kagero",
    registry,
    defaultBackend: requested,
    watch: readWatchConfig(),
  });
  let stopped = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    console.error(`[${signal}] shutting down kagero-mcp`);
    try {
      await server.stop();
    } catch (err) {
      console.error(`[shutdown_error] ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  await server.start();
  // Block until a shutdown signal; stop happens in the handler above.
  return new Promise<number>(() => {
    /* keep alive */
  });
}

function printMcpHelp(): void {
  console.log(`kagero mcp — run as MCP server (stdio)

Usage:
  kagero mcp [--backend=<name>]

Options:
  --backend=<name>   default backend for tools (default: $KAGERO_BACKEND or "pi-sdk")
  -h, --help         show this help

The server blocks until SIGTERM / SIGINT / SIGHUP.
`);
}

function printHelp(): void {
  console.log(`kagero-mcp v${VERSION} — MCP-bait для agentic мира.

Usage:
  kagero <command> [args]

Commands:
  prompt <text>           one-shot prompt
  resume <id> <text>      resume a session
  models                  list models
  sessions                list sessions
  backends                list available backends
  mcp [--backend=<name>]  run as MCP server (stdio)
  version                 print version

Environment:
  KAGERO_BACKEND          default backend (${availableBackends().join(" | ")})
  KAGERO_COMPRESS_BACKEND backend for the watch compressor (enables kagero_watch)
  KAGERO_COMPRESS_MODEL   model override for the compressor runs
  KAGERO_WATCH_MAX_WAIT_MS   cap for kagero_watch wait_ms (default 600000)
  KAGERO_WATCH_RAW_THRESHOLD_CHARS  deltas under this size skip the compressor (default 1500)
`);
}

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = readFileSync(join(here, "..", "package.json"), "utf8");
    const v = (JSON.parse(manifest) as { version?: unknown }).version;
    if (typeof v === "string") return v;
  } catch {
    // ignore
  }
  return "0.0.0";
}

const code = await main(process.argv.slice(2));
process.exit(code);
