// Tests for CLI-based backends using a fake binary.
// Pattern from dsh-cli-mcp/test/cancellation.test.ts: write a shell script
// that parses args, validates them, and returns proper output.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DshAgent } from "../src/backends/dsh.js";
import { QwenAgent } from "../src/backends/qwen.js";

const FAKE_BIN_BODY = `
#!/bin/sh
# Smart fake binary for kagero tests.
# Parses args, validates them, returns tab-separated model list or "ok: <prompt>".

case "$1" in
  --list-models)
    cat <<'EOF'
fake-model-1	Fake Model 1	fakeprovider	8192	true	false
fake-model-2	Fake Model 2	fakeprovider	4096	false	true
EOF
    exit 0
    ;;
  --print)
    shift
    # Capture prompt (the rest of argv)
    PROMPT="$*"
    if [ -z "$PROMPT" ]; then
      echo "empty prompt" >&2
      exit 2
    fi
    echo "ok: $PROMPT"
    exit 0
    ;;
  *)
    echo "unknown mode: $1" >&2
    exit 1
    ;;
esac
`;

function makeFakeBin(): { dir: string; bin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "kagero-fake-"));
  const bin = join(dir, "fake-cli");
  const script = `#!/bin/sh\n${FAKE_BIN_BODY}\n`;
  writeFileSync(bin, script, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return {
    dir,
    bin,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("DshAgent (CLI backend, fake binary)", () => {
  let fake: ReturnType<typeof makeFakeBin> | undefined;
  beforeAll(() => {
    fake = makeFakeBin();
    process.env["DSH_MCP_BIN"] = fake.bin;
  });
  afterAll(() => {
    fake?.cleanup();
    delete process.env["DSH_MCP_BIN"];
  });

  it("runs a prompt and parses output", async () => {
    const agent = new DshAgent();
    try {
      const res = await agent.prompt("hello world");
      expect(res.text).toBe("ok: hello world\n");
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await agent.dispose();
    }
  });

  it("lists models with parsed metadata", async () => {
    const agent = new DshAgent();
    try {
      const models = await agent.listModels();
      expect(models).toHaveLength(2);
      expect(models[0]?.id).toBe("fake-model-1");
      expect(models[0]?.provider).toBe("fakeprovider");
      expect(models[0]?.contextWindow).toBe(8192);
      expect(models[0]?.supportsTools).toBe(true);
      expect(models[1]?.supportsVision).toBe(true);
    } finally {
      await agent.dispose();
    }
  });

  it("resumes a session", async () => {
    const agent = new DshAgent();
    try {
      const res = await agent.resume("sess-1", "follow up");
      // The fake echoes back all args, so --session sess-1 is included
      expect(res.text).toContain("ok: follow up");
      expect(res.text).toContain("sess-1");
      expect(res.sessionId).toBe("sess-1");
    } finally {
      await agent.dispose();
    }
  });
});

describe("QwenAgent (CLI backend, fake binary)", () => {
  let fake: ReturnType<typeof makeFakeBin> | undefined;
  beforeAll(() => {
    fake = makeFakeBin();
    process.env["QWEN_MCP_BIN"] = fake.bin;
  });
  afterAll(() => {
    fake?.cleanup();
    delete process.env["QWEN_MCP_BIN"];
  });

  it("runs a prompt and parses output", async () => {
    const agent = new QwenAgent();
    try {
      const res = await agent.prompt("hello");
      expect(res.text).toBe("ok: hello\n");
    } finally {
      await agent.dispose();
    }
  });
});
