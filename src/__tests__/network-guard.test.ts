import { describe, expect, it } from "vitest";

describe("test network guard", () => {
  it("rejects external fetches before network I/O", async () => {
    await expect(fetch("https://example.com/should-never-run")).rejects.toThrow(
      "External network access is disabled in tests: example.com"
    );
  });
});
