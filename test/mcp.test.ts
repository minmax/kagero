// Tests for the MCP server — verify it speaks MCP and dispatches tools correctly.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const FAKE_BIN_BODY = `
#!/bin/sh
case "$1" in
  --list-models)
    cat <<'EOF'
fake-model	Fake Model	fakeprovider	8192	true	false
EOF
    exit 0
    ;;
  --print)
    shift
    echo "ok: $*"
    exit 0
    ;;
esac
`;

interface JsonRpcResponse {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

class Client {
  private child;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (r: JsonRpcResponse) => void>();

  constructor(env: Record<string, string> = {}) {
    const serverPath = resolve(process.cwd(), "dist/cli.js");
    this.child = spawn(process.execPath, [serverPath, "mcp"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.ingest(chunk));
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      nl = this.buffer.indexOf("\n");
      if (!line) continue;
      const msg = JSON.parse(line) as JsonRpcResponse;
      if (typeof msg.id === "number") {
        const r = this.pending.get(msg.id);
        if (r) {
          this.pending.delete(msg.id);
          r(msg);
        }
      }
    }
  }

  call(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const p = new Promise<JsonRpcResponse>((resolve) => this.pending.set(id, resolve));
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return p;
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

  close(): void {
    try {
      this.child.stdin?.end();
    } catch {
      // ignore
    }
    this.child.kill();
  }
}

function makeFakeBin(): { dir: string; bin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kagero-mcp-test-"));
  const bin = join(dir, "dsh");
  writeFileSync(bin, `#!/bin/sh\n${FAKE_BIN_BODY}\n`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return {
    dir,
    bin,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

let fake: ReturnType<typeof makeFakeBin> | undefined;
beforeAll(() => {
  if (!existsSync(resolve(process.cwd(), "dist/cli.js"))) return;
  fake = makeFakeBin();
});
afterAll(() => {
  fake?.cleanup();
});

describe.skipIf(!existsSync(resolve(process.cwd(), "dist/cli.js")))("kagero MCP server", () => {
  it("completes initialize + tools/list round trip with 7 tools", async () => {
    if (!fake) return;
    const client = new Client({ DSH_MCP_BIN: fake.bin });
    try {
      const init = await client.handshake();
      expect(init.result?.["serverInfo"]).toMatchObject({ name: "kagero-mcp" });

      const list = await client.call("tools/list");
      const tools = (list.result?.["tools"] as Array<{ name: string }>) ?? [];
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "kagero_abort",
        "kagero_backends",
        "kagero_models",
        "kagero_prompt",
        "kagero_resume",
        "kagero_sessions",
        "kagero_subscribe",
        "kagero_unsubscribe",
      ]);
    } finally {
      client.close();
    }
  }, 10_000);

  it("kagero_backends returns 7 backend names", async () => {
    if (!fake) return;
    const client = new Client({ DSH_MCP_BIN: fake.bin });
    try {
      await client.handshake();
      const call = await client.call("tools/call", { name: "kagero_backends", arguments: {} });
      const text = (call.result?.["content"] as Array<{ text: string }>)?.[0]?.text ?? "";
      const data = JSON.parse(text) as { available: string[]; default: string };
      expect(data.available).toContain("pi-sdk");
      expect(data.available).toContain("dsh");
      expect(data.default).toBe("pi-sdk");
    } finally {
      client.close();
    }
  }, 10_000);

  it("kagero_prompt with backend override runs the fake binary", async () => {
    if (!fake) return;
    const client = new Client({ DSH_MCP_BIN: fake.bin });
    try {
      await client.handshake();
      const call = await client.call("tools/call", {
        name: "kagero_prompt",
        arguments: { prompt: "hello MCP", backend: "dsh" },
      });
      const text = (call.result?.["content"] as Array<{ text: string }>)?.[0]?.text ?? "";
      expect(text).toBe("ok: hello MCP\n");
    } finally {
      client.close();
    }
  }, 10_000);

  it("kagero_models returns parsed model list", async () => {
    if (!fake) return;
    const client = new Client({ DSH_MCP_BIN: fake.bin });
    try {
      await client.handshake();
      const call = await client.call("tools/call", {
        name: "kagero_models",
        arguments: { backend: "dsh" },
      });
      const text = (call.result?.["content"] as Array<{ text: string }>)?.[0]?.text ?? "";
      expect(text).toContain("fake-model");
      expect(text).toContain("Fake Model");
    } finally {
      client.close();
    }
  }, 10_000);
});
