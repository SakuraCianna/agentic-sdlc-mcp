import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Run in node environment (no browser DOM needed)
    environment: "node",
    // Only pick up files in src/__tests__/
    include: ["src/__tests__/**/*.test.ts"],
    // Never touch real network — all tests must mock octokit
    // (enforced by test file structure, not by vitest itself)
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/index.ts"],
    },
  },
});
