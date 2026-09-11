/**
 * fake-bin — the binary that gets spawned by src/backends/base.ts when tests
 * point DSH_MCP_BIN (or QWEN_MCP_BIN, …) at this file.
 *
 * Usage (via shell wrapper):
 *   fake-cli --list-models
 *   fake-cli --print "hello world"
 *   fake-cli --print "hello" --session sess-1
 *   fake-cli --list-sessions
 *
 * Configuration is read from environment variables:
 *   FAKE_STATE_DIR  — directory containing _state.json (optional; if absent,
 *                     the fake is purely in-memory and has no call history
 *                     visible to the test)
 *
 * Each call:
 *   1. Loads state from <FAKE_STATE_DIR>/_state.json (if present)
 *   2. Parses argv + invokes FakeCli.handle()
 *   3. Writes stdout/stderr to the subprocess streams
 *   4. Persists state back to the file (so call records accumulate)
 *   5. Exits with the returned exit code
 *
 * The "intelligence" lives in test/fake-cli.ts. This file is a thin transport.
 */

import { FakeCli } from "./fake-cli.ts";

const stateDir = process.env["FAKE_STATE_DIR"];
const verbose = process.env["FAKE_VERBOSE"] === "1";

const opts: {
  verbose?: boolean;
  stateDir?: string;
} = { verbose };
if (stateDir) opts.stateDir = stateDir;

const fake = new FakeCli(opts);
// Load any persisted state (failNext, sleepMs, sessions, prior calls) from disk
// so this invocation inherits the configured behavior.
fake.loadState();

const result = await fake.handle(process.argv.slice(2), process.env, process.cwd());

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

// Persist AFTER writing the output (so the test can read state in time).
// Only persist if a stateDir was configured — otherwise this is a one-shot.
if (stateDir) {
  try {
    fake.persistState();
  } catch {
    // best-effort
  }
}

process.exit(result.exitCode);
