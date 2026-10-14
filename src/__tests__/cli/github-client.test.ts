import { describe, expect, it, vi } from "vitest";
import { createCliGithubClient } from "../../cli/github-client.js";
import { runCli } from "../../cli/run.js";

describe("CLI GitHub output isolation", () => {
  it("keeps private endpoint URLs and upstream error bodies out of every console channel", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ message: "UPSTREAM-PRIVATE-CANARY" }), { status: 403, headers: { "content-type": "application/json" } }));
    const client = createCliGithubClient("credential-presence-canary", fetch);
    let out = ""; let err = "";
    try {
      const code = await runCli(["doctor", "--repo", "private-team/private-repo", "--online", "--json"], { env: { GITHUB_TOKEN: "credential-presence-canary" }, client, stdout: (value) => { out += value; }, stderr: (value) => { err += value; } });
      expect(code).toBe(2); expect(fetch).toHaveBeenCalled(); expect(consoleError).not.toHaveBeenCalled(); expect(consoleWarn).not.toHaveBeenCalled();
      expect(out + err).not.toContain("UPSTREAM-PRIVATE-CANARY"); expect(out + err).not.toContain("https://api.github.com"); expect(out + err).not.toContain("credential-presence-canary");
    } finally { consoleError.mockRestore(); consoleWarn.mockRestore(); }
  });
});
