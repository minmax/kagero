# Architecture

## Agent interface — the core contract

`src/agent.ts` defines the `Agent` interface. Every concrete backend
implements it. The MCP server and CLI both depend only on this contract.

```ts
interface Agent {
  readonly name: string;
  prompt(prompt: string, opts?: PromptOptions): Promise<AgentResponse>;
  resume(sessionId: string, prompt: string, opts?: PromptOptions): Promise<AgentResponse>;
  listModels(): Promise<ModelInfo[]>;
  listSessions(): Promise<SessionInfo[]>;
  subscribe(sessionId: string, onEvent: (e: AgentEvent) => void): () => void;
  abort(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}
```

The shape is inspired by the pi SDK's `AgentSession` (in-process) so that
SDK is the "canonical" implementation. CLI backends adapt to fit.

## Two backend families

### 1. In-process: `pi-sdk`
- Imports `@earendil-works/pi-coding-agent` (peer-dep, optional).
- Real streaming via `subscribe()`.
- Real session state.
- Latency = network call to the model.
- Use case: when you want the "real" agent with no subprocess overhead.

### 2. Subprocess: `pi-rpc`, `dsh`, `qwen`, `grok`, `kimi`, `mcode`
- All share `CliBackendAgent` base class.
- Each one just provides: binary name, arg layout, output parser.
- ~50 lines of code per backend.
- Use case: when the user has a CLI installed and wants to delegate
  without changing their stack.

## Why two ways for pi?

`pi-sdk` is in-process, lower latency, has real events. But it requires
installing a heavy npm package as a peer-dep.

`pi-rpc` spawns `pi --mode rpc` as a subprocess. No peer-dep needed if the
user has the official `pi` CLI installed. Slightly higher latency, but
otherwise functionally equivalent.

The user picks via `KAGERO_BACKEND=pi-sdk` vs `KAGERO_BACKEND=pi-rpc`.

## Why the same Agent interface for CLI backends?

Every CLI we wrap is a coding agent that takes a prompt and returns text.
`dsh`, `qwen`, `grok`, `kimi`, `mcode` all do `--print "<prompt>"` and
emit text. The differences are:
- Model list (via `--list-models`)
- Session id semantics
- Approval mode

But these are stable enough that a single CLI-backend base class can
encapsulate all of them. Adding a new CLI agent = 50 lines of glue, not
500 lines of new infrastructure.

## Why MCP on top?

The MCP protocol is the de-facto way for agents to talk to tools. By
exposing the kagero Agent as MCP tools, any MCP host (Claude Code, Cursor,
Windsurf) can use kagero as a meta-agent that delegates to whichever
backend the user has installed.

The 7 MCP tools are intentionally thin — each is a one-liner that calls
the Agent interface. No business logic in the MCP layer.

## File layout

```
src/
├── agent.ts            # Agent interface + types
├── registry.ts         # select() factory
├── backends/
│   ├── base.ts         # CliBackendAgent base class (spawn, signal, timeout)
│   ├── pi-sdk.ts       # in-process @earendil-works/pi-coding-agent
│   ├── pi-rpc.ts       # subprocess pi --mode rpc
│   ├── dsh.ts          # subprocess dsh --print
│   ├── qwen.ts         # subprocess qwen --print
│   ├── grok.ts         # subprocess grok --print
│   ├── kimi.ts         # subprocess kimi --print
│   └── mcode.ts        # subprocess mcode --print
├── mcp/
│   └── server.ts       # MCP server over the Agent contract
├── cli.ts              # CLI entry point
└── index.ts            # public exports

test/
├── agent.test.ts       # 6 unit tests
├── backends.test.ts    # 4 integration tests (fake binary)
└── mcp.test.ts         # 4 MCP round-trip tests
```

## Adding a new backend

1. Create `src/backends/<name>.ts` extending `CliBackendAgent`.
2. Provide `name`, `buildArgs()`, `parseModels()`.
3. Register in `src/registry.ts`.

Total: ~50 lines of code.

## Roadmap (out of v0.1.0)

- Real-time streaming to MCP via `notifications/message`
- OTel export for tracing across backends
- Approval-mode helper (yolo / default / auto / plan)
- Better session-id routing for `pi-sdk` (currently uses a single tree)
