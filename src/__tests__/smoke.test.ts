/**
 * Tests for smoke mode (--smoke flag behavior)
 * Verifies that starting with --smoke skips token validation and exits clean.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("smoke mode — config.ts", () => {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.argv = originalArgv;
    Object.assign(process.env, originalEnv);
    vi.resetModules();
  });

  it("returns a placeholder token and isSmokeMode=true when --smoke is in argv", async () => {
    process.argv = [...process.argv, "--smoke"];
    vi.resetModules();

    const { initializeConfig, config, isSmokeMode } = await import("../config.js");
    expect(isSmokeMode).toBe(true);
    await initializeConfig();
    expect(config.isSmokeMode).toBe(true);
    expect(config.githubToken).toBe("__smoke_test_placeholder__");
  });

  it("returns a placeholder token and isSmokeMode=true when SMOKE=true is set", async () => {
    process.env["SMOKE"] = "true";
    vi.resetModules();

    const { initializeConfig, config, isSmokeMode } = await import("../config.js");
    expect(isSmokeMode).toBe(true);
    await initializeConfig();
    expect(config.isSmokeMode).toBe(true);
    expect(config.githubToken).toBe("__smoke_test_placeholder__");
  });

  it("does NOT set isSmokeMode when --smoke is absent and SMOKE is unset", async () => {
    // Ensure clean state
    process.argv = process.argv.filter((a) => a !== "--smoke");
    delete process.env["SMOKE"];
    // Set a fake token so validation passes
    process.env["GITHUB_TOKEN"] = "ghp_fake_for_test";
    vi.resetModules();

    const { initializeConfig, config, isSmokeMode } = await import("../config.js");
    expect(isSmokeMode).toBe(false);
    await initializeConfig();
    expect(config.isSmokeMode).toBe(false);
    expect(config.githubToken).toBe("ghp_fake_for_test");
  });
});
