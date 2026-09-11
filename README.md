# kagero-mcp

[![status](https://img.shields.io/badge/status-v0.1.0-blue.svg)](#)
[![MCP protocol](https://img.shields.io/badge/MCP-2025--06--18-blue.svg)](https://modelcontextprotocol.io)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Kagero (陽炎)** — MCP-bait для agentic мира. TypeScript фреймворк с общим
`Agent`-интерфейсом поверх:

- **`pi-sdk`** — in-process через `@earendil-works/pi-coding-agent` (peer-dep)
- **`pi-rpc`** — через `pi --mode rpc` (subprocess)
- **`dsh`** / **`qwen`** / **`grok`** / **`kimi`** / **`mcode`** — CLI-агенты

Один интерфейс — разные backend'ы. Выбор через `KAGERO_BACKEND` env var.

> Это **тень** от `niwa` (настоящей agentic OS). Показывает форму, но
> мастерство — за углом.

## Архитектура

```
kagero (Agent interface)
  ├─ pi-sdk  (in-process, @earendil-works/pi-coding-agent)
  ├─ pi-rpc  (subprocess, pi --mode rpc)
  ├─ dsh     (subprocess, dsh --print)
  ├─ qwen    (subprocess, qwen --print)
  ├─ grok    (subprocess, grok --print)
  ├─ kimi    (subprocess, kimi --print)
  └─ mcode   (subprocess, mcode --print)

        ↓
MCP server (stdio)         CLI (kagero prompt/resume/...)
```

## Установка

```bash
npm install kagero-mcp
# или без install
npx kagero-mcp
```

Для использования `pi-sdk` backend'а поставьте peer-dep:

```bash
npm install @earendil-works/pi-coding-agent
```

## Использование

### CLI

```bash
# One-shot prompt (по умолчанию pi-sdk)
kagero prompt "List the files in the current directory"

# Другой backend
KAGERO_BACKEND=dsh kagero prompt "List the files"

# Список доступных backend'ов
kagero backends

# Список моделей активного backend'а
kagero models

# Список сессий
kagero sessions
```

### MCP server

```bash
kagero mcp              # uses default backend
kagero mcp --backend=dsh
```

Tools exposed:
- `kagero_prompt` — one-shot prompt
- `kagero_resume` — continue a session
- `kagero_models` — list models
- `kagero_sessions` — list sessions
- `kagero_subscribe` — subscribe to live events
- `kagero_abort` — abort an in-flight run
- `kagero_backends` — list available backends

### As a library

```ts
import { select } from "kagero-mcp";

const agent = await select("dsh");
const res = await agent.prompt("Hello, world!");
console.log(res.text);
```

## Конфигурация (env)

| Variable | Default | Назначение |
|----------|---------|------------|
| `KAGERO_BACKEND` | `pi-sdk` | Какой backend активен |
| `DSH_MCP_BIN` / `DSH_BINARY` | (PATH) | Путь к `dsh` |
| `QWEN_MCP_BIN` | (PATH) | Путь к `qwen` |
| `GROK_MCP_BIN` | (PATH) | Путь к `grok` |
| `KIMI_MCP_BIN` | (PATH) | Путь к `kimi` |
| `MCODE_MCP_BIN` | (PATH) | Путь к `mcode` |
| `PI_RPC_BIN` / `PI_BINARY` | (PATH) | Путь к `pi` для RPC-режима |

## Архитектура

`src/agent.ts` — общий интерфейс (`Agent`, `AgentEvent`, `AgentResponse`).
`src/registry.ts` — `select(name) → Agent`, ленивая загрузка backend'ов.
`src/backends/base.ts` — общая логика для CLI-backend'ов (spawn, signal,
   timeout). Каждый CLI backend (dsh, qwen, ...) наследует и реализует
   `buildArgs()` + `parseModels()`.
`src/backends/pi-sdk.ts` — in-process через dynamic import peer-dep.
`src/backends/pi-rpc.ts` — JSON-RPC через stdio к `pi --mode rpc`.
`src/mcp/server.ts` — MCP-сервер с 7 tools.
`src/cli.ts` — CLI entry point.

## Разработка

```bash
git clone https://github.com/minmax/kagero
cd kagero
npm install
npm run build        # → dist/
npm test             # 14 tests (unit + integration)
npm run check        # biome + tsc
```

## Эстетика

`kagero` (陽炎 / かげろう) — японское слово с тремя слоями значений:
- **heat haze** — марево, дрожание воздуха над раскалённой землёй
- **mayfly** — подёнка, символ мимолётности (蜻蛉日記 — классический дневник X века)
- **gossamer** — прозрачный, как шёлк на просвет

Это bait: видишь форму, тянешь руку — нет. Иди в сад (niwa) за настоящим.

## Лицензия

[MIT](LICENSE) © Niwa Labs.
