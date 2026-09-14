# kagero

[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Kagero** — one `Agent` interface over coding-agent CLIs, exposed as an MCP
server and a CLI. Ten backends, ten honest tools, zero pretending: whatever a
backend cannot do comes back as an explicit `[unsupported_capability]` error,
never as a guess.

## Backends

| backend | transport | binary |
|---|---|---|
| `pi-sdk` | in-process SDK (`@earendil-works/pi-coding-agent`, optional peer dep) | — |
| `pi-rpc` | subprocess, `pi --mode rpc` | `pi` |
| `claude` | subprocess, `claude -p --output-format stream-json` | `claude` |
| `claude-stream` | long-lived subprocess, live `--input-format stream-json` protocol (steer/follow_up/interrupt) | `claude` |
| `codex` | subprocess, `codex exec --json` | `codex` |
| `dsh` | subprocess, `dsh --profile headless` (dsh-headless-bridge) | `dsh` |
| `grok` | subprocess, grok ACP + streaming print | `grok` |
| `kimi` | subprocess, `kimi acp` / print | `kimi` |
| `mcode` | subprocess, `mcode acp` / `mcode exec` | `mcode` |
| `qwen` | subprocess, `qwen --acp` / stream / print | `qwen` |

Select with `KAGERO_BACKEND` or `kagero mcp --backend=<name>`; `kagero backends`
lists what is registered.

## Install

```bash
npm install kagero-mcp
# or run without installing
npx kagero-mcp
```

The `pi-sdk` backend needs its optional peer dependency:

```bash
npm install @earendil-works/pi-coding-agent
```

## Usage

### CLI

```bash
kagero prompt "List the files in the current directory"   # one-shot
KAGERO_BACKEND=mcode kagero prompt "…"                    # pick a backend
kagero backends                                           # registered backends
kagero models                                             # active backend models
kagero sessions                                           # persistent sessions
kagero mcp --backend=mcode                                # MCP server over stdio
```

### MCP tools

`prompt`, `resume`, `models`, `sessions`, `history`, `send` (steer /
follow_up), `subscribe`, `unsubscribe`, `abort`, `backends` — plus the
optional `watch` tool when the compressor is configured.

### History

`history` returns a compact normalized view, paged from the newest end
(`page` / `page_size`, entry indexes are global across pages) with a
full-log pointer. Readers for pi, qwen, grok, kimi, mcode (MiniMax Code),
claude, codex and dsh parse each CLI's on-disk session logs, capture
thinking blocks and merge tool results into their calls.

### Session compression (optional)

Set `KAGERO_COMPRESS_BACKEND` (and optionally `KAGERO_COMPRESS_MODEL`) to
enable the `watch` tool and run reports: agent event streams are compressed
by a cheap second agent into anchored, machine-validated digests — per-move
blocks with distilled reasoning, a rolling checkpoint and a status verdict.
Compressed state persists across restarts in a crash-safe journal
(`~/.kagero/watch/`).

## Architecture

```
Agent interface (@kagero/core)
  ├─ CliSpecAgent (@kagero/cli-backend) — spec-driven print/ACP transports,
  │    history readers, stream-json parsers
  ├─ PiSdkAgent / PiRpcAgent (@kagero/pi-backend)
  ├─ ClaudeStreamAgent (@kagero/cli-backend) — live stream-json protocol
  └─ createKageroMcpServer (@kagero/mcp) — MCP factory over any registry
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full contract.

## Security & behavior

- **Strict schemas.** Every tool input is enforced with
  `z.object(...).strict()`; unknown fields are rejected before they reach a
  backend.
- **Honest statuses.** Runs end `completed`, `aborted`, `timed-out` or with
  the CLI's own error — a killed run is never success.
- **Fail-closed permissions.** Live transports answer reverse permission
  requests with an explicit deny; nothing is auto-approved headlessly.
- **No resource leaks.** Process groups are killed through a SIGTERM → grace
  → SIGKILL ladder; ACP clients outlive single runs and are disposed on
  shutdown.

## License

[MIT](LICENSE)
