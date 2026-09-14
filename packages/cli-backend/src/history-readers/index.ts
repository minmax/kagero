/**
 * history-readers — one session-log reader factory per CLI. Composition
 * layers import them from here (or through the @kagero/cli-backend barrel,
 * which re-exports this module as the `historyReaders` namespace).
 *
 * Every factory returns a LAZY reader: the concrete module (and anything
 * version-gated inside it, like dsh's node:zlib zstd) is imported on the
 * first read() call. A reader that cannot load fails that one history call
 * with its own error instead of killing the whole server at import time.
 * Import factories from this module — never from the concrete files.
 */

import type { HistoryOptions, HistoryResult } from "@kagero/core";
import type { HistoryReader } from "../spec.js";
import type { HistoryReaderOptions } from "./shared.js";

type ReaderFactoryModule = { create: (opts?: HistoryReaderOptions) => HistoryReader };

function lazyReader(
  load: () => Promise<ReaderFactoryModule>,
): (opts?: HistoryReaderOptions) => HistoryReader {
  return (opts?: HistoryReaderOptions) => ({
    read: (sessionId: string, historyOpts: HistoryOptions | undefined): Promise<HistoryResult> =>
      load().then((module) => module.create(opts).read(sessionId, historyOpts)),
  });
}

export const createClaudeHistoryReader: (opts?: HistoryReaderOptions) => HistoryReader = lazyReader(() =>
  import("./claude.js").then((m) => ({ create: m.createClaudeHistoryReader })),
);
export const createCodexHistoryReader: (opts?: HistoryReaderOptions) => HistoryReader = lazyReader(() =>
  import("./codex.js").then((m) => ({ create: m.createCodexHistoryReader })),
);
export const createDshHistoryReader: (opts?: HistoryReaderOptions) => HistoryReader = lazyReader(() =>
  import("./dsh.js").then((m) => ({ create: m.createDshHistoryReader })),
);
export const createGrokHistoryReader: (opts?: HistoryReaderOptions) => HistoryReader = lazyReader(() =>
  import("./grok.js").then((m) => ({ create: m.createGrokHistoryReader })),
);
export const createKimiHistoryReader: (opts?: HistoryReaderOptions) => HistoryReader = lazyReader(() =>
  import("./kimi.js").then((m) => ({ create: m.createKimiHistoryReader })),
);
export const createMcodeHistoryReader: (opts?: HistoryReaderOptions) => HistoryReader = lazyReader(() =>
  import("./mcode.js").then((m) => ({ create: m.createMcodeHistoryReader })),
);
export const createPiHistoryReader: (opts?: HistoryReaderOptions) => HistoryReader = lazyReader(() =>
  import("./pi.js").then((m) => ({ create: m.createPiHistoryReader })),
);
export const createQwenHistoryReader: (opts?: HistoryReaderOptions) => HistoryReader = lazyReader(() =>
  import("./qwen.js").then((m) => ({ create: m.createQwenHistoryReader })),
);

/** dsh session listing (no zstd involved), loaded on first call like the readers. */
export async function readDshSessions(opts?: {
  readonly homeDir?: string;
}): Promise<Awaited<ReturnType<typeof import("./dsh-sessions.js").readDshSessions>>> {
  return (await import("./dsh-sessions.js")).readDshSessions(opts);
}
