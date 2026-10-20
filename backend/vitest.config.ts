import { defineConfig } from "vitest/config";

// Only run the TypeScript sources. Without this, `vitest run` also picks up
// stale compiled copies under dist/**/__tests__ (emitted by `tsc`).
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
