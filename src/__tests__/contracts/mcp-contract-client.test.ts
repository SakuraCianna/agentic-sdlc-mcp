import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveContractTimeout,
  withContractTimeout,
} from "../../../scripts/lib/mcp-contract-client.mjs";

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP contract collector deadline", () => {
  it("uses the documented default discovery timeout", () => {
    expect(resolveContractTimeout()).toBe(15_000);
  });

  it("returns a completed operation and clears its deadline", async () => {
    vi.useFakeTimers();

    await expect(
      withContractTimeout(Promise.resolve("complete"), 50, "contract discovery")
    ).resolves.toBe("complete");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a stalled operation with a bounded, actionable error", async () => {
    vi.useFakeTimers();
    const stalled = withContractTimeout(
      new Promise<never>(() => undefined),
      50,
      "contract discovery"
    );
    const expectation = expect(stalled).rejects.toThrow(
      "contract discovery timed out after 50ms"
    );

    await vi.advanceTimersByTimeAsync(50);

    await expectation;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a real deadline alive while the operation is pending", async () => {
    await expect(
      withContractTimeout(
        new Promise<never>(() => undefined),
        20,
        "real contract discovery"
      )
    ).rejects.toThrow("real contract discovery timed out after 20ms");
  });

  it("keeps the deadline alive as the only child-process handle", () => {
    const moduleUrl = new URL(
      "../../../scripts/lib/mcp-contract-client.mjs",
      import.meta.url
    ).href;
    const script = `
      import { withContractTimeout } from ${JSON.stringify(moduleUrl)};
      try {
        await withContractTimeout(new Promise(() => undefined), 20, "child probe");
        process.exitCode = 2;
      } catch (error) {
        console.error(error.message);
      }
    `;

    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        encoding: "utf8",
        timeout: 2_000,
      }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("child probe timed out after 20ms");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects invalid timeout %s",
    async (timeoutMs) => {
      await expect(
        withContractTimeout(Promise.resolve("unused"), timeoutMs, "contract discovery")
      ).rejects.toThrow("positive integer");
    }
  );
});
