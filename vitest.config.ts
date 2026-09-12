import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@kagero/core": r("./packages/core/src/index.ts"),
      "@kagero/pi-backend": r("./packages/pi-backend/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: process.env["GITHUB_ACTIONS"] ? ["dot", "github-actions"] : ["default"],
    include: ["test/**/*.test.ts"],
  },
});
