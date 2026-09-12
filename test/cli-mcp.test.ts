// End-to-end MCP round trip through the SHIPPED binary: spawn
// `node dist/cli.js mcp`, speak JSON-RPC over stdio, call the kagero tools,
// and check the SIGTERM shutdown ladder.
//
// Requires a build first (`npm run -s build`) — the suite skips when
// dist/cli.js is missing, exactly like the old kagero mcp suite did.
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const CLI = resolve(process.cwd(), "dist/cli.js");
const FAKE_CLI = resolve(process.cwd(), "test/helpers/fake-cli.mjs");

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** One MCP client session over the stdio of one spawned `kagero mcp`. */
class McpClient {
  readonly child;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (r: JsonRpcResponse) => void>();

  constructor(env: Record<string, string | undefined> = {}) {
    this.child = spawn(process.execPath, [CLI, "mcp", "--backend=qwen"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.ingest(chunk));
    this.child.on("error", () => this.rejectAll("the kagero mcp process failed to spawn"));
    this.child.on("close", () => this.rejectAll("the kagero mcp process exited"));
  }

  private rejectAll(reason: string): void {
    for (const [id, settle] of [...this.pending]) {
      this.pending.delete(id);
      settle({ error: { code: -1, message: reason } });
    }
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
      if (line === "") continue;
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (typeof msg.id === "number") {
        const settle = this.pending.get(msg.id);
        if (settle) {
          this.pending.delete(msg.id);
          settle(msg);
        }
      }
    }
  }

  call(method: string, params?: unknown, timeoutMs = 10_000): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    return new Promise<JsonRpcResponse>((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        res(r);
      });
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async handshake(): Promise<JsonRpcResponse> {
    const init = await this.call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    return init;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
    return this.call("tools/call", { name, arguments: args });
  }

  textOf(response: JsonRpcResponse): string {
    return (response.result?.["content"] as Array<{ text: string }> | undefined)?.[0]?.text ?? "";
  }

  kill(signal: NodeJS.Signals): void {
    this.child.kill(signal);
  }

  onceExit(): Promise<NodeJS.Signals | null> {
    return new Promise((res) => {
      this.child.once("exit", (_code, signal) => res(signal));
    });
  }

  close(): void {
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    this.child.kill();
  }
}

/** fake-cli.mjs is not executable in the repo — copy it out with the +x bit. */
function makeFakeBin(): { dir: string; bin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kagero-cli-mcp-test-"));
  const bin = join(dir, "fake-dsh");
  copyFileSync(FAKE_CLI, bin);
  chmodSync(bin, 0o755);
  return { dir, bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

let fake: ReturnType<typeof makeFakeBin> | undefined;
afterAll(() => {
  fake?.cleanup();
});

describe.skipIf(!existsSync(CLI))("kagero mcp over stdio (dist/cli.js)", () => {
  it("completes initialize and advertises the ten kagero_* tools", { timeout: 15_000 }, async () => {
    if (!fake) fake = makeFakeBin();
    const client = new McpClient({ DSH_BIN: fake.bin });
    try {
      const init = await client.handshake();
      expect(init.result?.["serverInfo"]).toMatchObject({ name: "kagero-mcp" });

      const list = await client.call("tools/list");
      const tools = (list.result?.["tools"] as Array<{ name: string }>) ?? [];
      expect(tools.map((t) => t.name).sort()).toEqual([
        "kagero_abort",
        "kagero_backends",
        "kagero_history",
        "kagero_models",
        "kagero_prompt",
        "kagero_resume",
        "kagero_send",
        "kagero_sessions",
        "kagero_subscribe",
        "kagero_unsubscribe",
      ]);
    } finally {
      client.close();
    }
  });

  it("kagero_backends lists all nine backends with the requested default", { timeout: 15_000 }, async () => {
    if (!fake) fake = makeFakeBin();
    const client = new McpClient({ DSH_BIN: fake.bin });
    try {
      await client.handshake();
      const call = await client.callTool("kagero_backends");
      expect(call.result?.["isError"]).toBeUndefined();
      const text = client.textOf(call);
      for (const name of ["claude", "codex", "dsh", "grok", "kimi", "mcode", "pi-rpc", "pi-sdk", "qwen"]) {
        expect(text).toContain(name);
      }
      expect(text).toContain("default: qwen");
    } finally {
      client.close();
    }
  });

  it("kagero_prompt runs the substituted binary (backend override) and returns its text", {
    timeout: 15_000,
  }, async () => {
    if (!fake) fake = makeFakeBin();
    const client = new McpClient({ DSH_BIN: fake.bin, FAKE_CLI_MODE: "dsh" });
    try {
      await client.handshake();
      const call = await client.callTool("kagero_prompt", { prompt: "hello MCP", backend: "dsh" });
      expect(call.result?.["isError"]).toBeUndefined();
      expect(client.textOf(call)).toBe("hello MCP");
      expect(call.result?.["_meta"]).toMatchObject({ status: "completed" });
    } finally {
      client.close();
    }
  });

  it("shuts down cleanly on SIGTERM (exit without signal)", { timeout: 15_000 }, async () => {
    if (!fake) fake = makeFakeBin();
    const client = new McpClient({ DSH_BIN: fake.bin });
    await client.handshake();
    client.kill("SIGTERM");
    // The shutdown ladder stops the server and exits 0 on its own.
    await client.onceExit();
    expect(client.child.exitCode).toBe(0);
  });
});

describe.skipIf(!existsSync(CLI))("kagero CLI (dist/cli.js)", () => {
  it("backends prints all nine registered names", { timeout: 15_000 }, async () => {
    const child = spawn(process.execPath, [CLI, "backends"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const code = await new Promise<number | null>((res) => child.once("exit", res));
    expect(code).toBe(0);
    for (const name of ["claude", "codex", "dsh", "grok", "kimi", "mcode", "pi-rpc", "pi-sdk", "qwen"]) {
      expect(stdout).toContain(name);
    }
  });

  it("mcp --backend=<unknown> is rejected with exit code 2", { timeout: 15_000 }, async () => {
    const child = spawn(process.execPath, [CLI, "mcp", "--backend=nope"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((res) => child.once("exit", res));
    expect(code).toBe(2);
    expect(stderr).toContain("[unknown_backend] nope");
  });
});
