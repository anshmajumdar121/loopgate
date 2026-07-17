import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  // ponytail: matches vite.config.ts so test files can resolve the
  // same `@/...` imports the app uses. Without this, runtime imports
  // from `@/lib/...` fail to resolve in vitest (type-only `@/types/...`
  // imports get stripped at build and never trigger the lookup).
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});