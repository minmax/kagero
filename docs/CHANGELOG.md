# Changelog

Все заметные изменения в `kagero-mcp` документируются здесь. Формат вдохновлён
[Keep a Changelog](https://keepachangelog.com), версии — [SemVer](https://semver.org/).

## [0.1.1] — 2025

Это patch-релиз с hardening v0.1.0: закрывает реальные resource-leaks,
race conditions и security-разрывы, найденные в ходе multi-faceted review
**Никаких breaking changes** в публичном API
(`Agent` интерфейс и набор MCP tools обратно совместимы).

### Security

- **MCP `inputSchema` теперь enforce'ится через `z.object(...).strict()`** (был
  cosmetic). До этого схема просто декларировалась — клиент мог прислать
  любое поле и оно молча пробрасывалось в backend. Теперь неизвестные
  поля отбрасываются с ошибкой до того, как запрос дойдёт до `Agent`.
  Файл: `src/mcp/server.ts`.

### Fixed

- **`cmdMcp` устанавливает `SIGTERM`/`SIGINT`/`SIGHUP` хэндлеры** и зовёт
  `server.stop()` перед exit. Раньше Ctrl-C / systemd-stop просто убивали
  процесс — все subprocess'ы и подписки оставались в подвешенном состоянии.
  Файл: `src/cli.ts`.
- **`getAgent()` теперь race-safe.** Используется single-flight promise +
  `Map<name, Agent>` cache: параллельные вызовы с одним `backend` делят
  один экземпляр, разные `backend` живут параллельно и не вытесняют друг
  друга. Файл: `src/mcp/server.ts`.
- **`CliBackendAgent.prompt()` использует `AbortController`** и эмитит
  `session-end` события — поведение теперь консистентно с `resume()`.
  Раньше `kagero_abort` работал только для resumed-сессий, а подписчики
  на one-shot prompt не получали сигнала о завершении. Файл:
  `src/backends/base.ts`.
- **`process.kill` self-kill hazard ограждён** — добавлен явный
  `pid !== undefined && pid > 0` check перед `process.kill(-pid, sig)`.
  Без guard'а попытка послать сигнал группе без `pid` падала с `ESRCH` или
  отправляла сигнал в самого себя. Файл: `src/backends/base.ts`.
- **`proc.unref()` на каждом spawned subprocess'е** — без этого длинные
  CLI-сессии держали event loop родителя, не давая Node завершиться. Файл:
  `src/backends/base.ts`.
- **`pi-rpc` spawn-error теперь reject'ит pending promises** — раньше
  `proc.on("error", ...)` бросал синхронно из event handler'а, что
  превращалось в uncaughtException; висящие `prompt()` обещания никогда
  не резолвились. Теперь все in-flight вызовы получают
  `AgentError("spawn_failed", ...)`. Файл: `src/backends/pi-rpc.ts`.
- **`pi-rpc` `dispose()` reject'ит pending promises** — ранее `dispose()`
  просто убивал процесс, а все ожидающие вызовы висели до таймаута.
  Теперь — явный reject с `AgentError("disposed", ...)`. Файл:
  `src/backends/pi-rpc.ts`.
- **`pi-rpc` `PromptOptions` теперь полностью wired** — `cwd`, `modelId`,
  `timeoutMs` пробрасываются в RPC-запрос вместо игнорирования. Файл:
  `src/backends/pi-rpc.ts`.
- **stdout/stderr буферизуется с 50MB cap'ом** — раньше `chunks.push(c)`
  копил всё в памяти и runaway-output мог привести к OOM. Теперь при
  превышении `maxOutputBytes` (default 50MB) output обрезается и
  возвращается `{ truncated: true, maxBytes }`. Файл: `src/backends/base.ts`.

### Added

- **Новый tool `kagero_unsubscribe`.** Принимает `sub_id`, возвращённый
  `kagero_subscribe`, и снимает подписку. До этого у клиента не было
  способа освободить ресурсы подписки кроме `dispose()` всего агента.
  Файл: `src/mcp/server.ts`.
- **`kagero_backends` теперь использует logging notification.** Старая
  реализация шлёт нестандартный `notifications/event`, который
  spec-compliant клиенты молча дропают. Теперь — стандартный
  `notifications/message` (MCP 2025-06-18, level: `info`, logger: `kagero`),
  payload `{ kind: "agent_event", subId, sessionId, event }`. Файл:
  `src/mcp/server.ts`.
- **Qwen / grok / kimi / mcode `parseModels` теперь читает
  `supportsTools` / `supportsVision`** из CLI output (был hardcoded
  `true` / `false`). Раньше модель с vision-capability показывалась как
  vision-blind. Файлы: `src/backends/{qwen,grok,kimi,mcode}.ts`.

### Tests

- **Smart fake портирован из `dsh-cli-mcp`** — `test/fake-cli.ts` теперь
  реальный mock с парсингом argv, persistent state (`stateDir/_state.json`),
  session tracking, failure simulation (`setFailNext(code, stderr)`) и
  sleep simulation. Старый 30-LOC echo-fake не позволял проверить error
  paths, timeouts, abort и concurrent prompts. Тестов стало 26 (было 14).

## [0.1.0] — initial bait

- `Agent` интерфейс + 7 backend'ов: `pi-sdk`, `pi-rpc`, `dsh`, `qwen`,
  `grok`, `kimi`, `mcode`.
- MCP server с 7 tools (см. `README.md`).
- CLI: `prompt`, `resume`, `models`, `sessions`, `backends`, `mcp`.
- 14 тестов (все passing).

[0.1.1]: #011--2025
[0.1.0]: #010--initial-bait
