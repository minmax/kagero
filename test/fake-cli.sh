#!/bin/sh
# fake-cli shell wrapper.
#
# This is the binary that gets spawned by src/backends/base.ts when tests set
# DSH_MCP_BIN (or QWEN_MCP_BIN, …) to point at this file. It invokes the tsx
# launcher (test/fake-bin.ts) which uses FakeCli from test/fake-cli.ts.
#
# We use `npx tsx` so the launcher can be plain TypeScript. tsx is provided by
# either the global install or a devDependency.
#
# Configuration is via env vars:
#   FAKE_STATE_DIR  — directory containing _state.json (optional)
#   FAKE_VERBOSE=1  — log each call to stderr
set -e
DIR=$(dirname "$0")
exec npx tsx "$DIR/fake-bin.ts" "$@"
