import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run in node environment (no browser DOM needed)
    environment: "node",
    // Only pick up files in src/__tests__/
    include: ["src/__tests__/**/*.test.ts"],
    // Block external fetch/socket access while preserving loopback integration tests.
    setupFiles: ["src/__tests__/setup/network-guard.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/index.ts"],
      thresholds: {
        statements: 92,
        branches: 87,
        functions: 93,
        lines: 93,
      },
    },
  },
});
