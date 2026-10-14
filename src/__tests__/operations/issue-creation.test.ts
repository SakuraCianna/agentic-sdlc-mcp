import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "@octokit/rest";

beforeEach(() => { vi.resetModules(); });

describe("bounded process-local operation guard", () => {
  it("fails closed when its capacity is occupied by uncertain writes", async () => {
    const { createIssuesRecoverably, issueSetPreviewDigest } = await import("../../operations/issue-creation.js");
    const ref = { owner: "owner", repo: "repo" };
    const issues = [{ title: "One issue", body: "A complete body." }];
    const create = vi.fn().mockRejectedValue(new Error("unconfirmed write"));
    const listForRepo = vi.fn().mockResolvedValue({ data: [] });
    const client = { issues: { create, listForRepo } } as unknown as Octokit;
    for (let index = 0; index < 256; index++) {
      const key = `uncertain-${index}`;
      const result = await createIssuesRecoverably(issues, ref, client, issueSetPreviewDigest(ref, issues, key), key, undefined, {});
      expect(result.recovery.status).toBe("unknown");
    }
    const key = "capacity-overflow";
    const overflow = await createIssuesRecoverably(issues, ref, client, issueSetPreviewDigest(ref, issues, key), key, undefined, {});
    expect(overflow.recovery.status).toBe("blocked");
    expect(overflow.recovery.message).toContain("guard is full");
    expect(create).toHaveBeenCalledTimes(256);
    expect(listForRepo).toHaveBeenCalledTimes(256);
  });

  it("allows later batches by evicting settled history instead of active or uncertain operations", async () => {
    const { createIssuesRecoverably, issueSetPreviewDigest } = await import("../../operations/issue-creation.js");
    const ref = { owner: "owner", repo: "repo" };
    const issues = [{ title: "One issue", body: "A complete body." }];
    const create = vi.fn().mockResolvedValue({ data: { number: 1, title: "One issue", html_url: "https://github.com/owner/repo/issues/1", labels: [] } });
    const listForRepo = vi.fn().mockResolvedValue({ data: [] });
    const client = { issues: { create, listForRepo } } as unknown as Octokit;
    for (let index = 0; index < 257; index++) {
      const key = `completed-${index}`;
      const result = await createIssuesRecoverably(issues, ref, client, issueSetPreviewDigest(ref, issues, key), key, undefined, {});
      expect(result.recovery.status).toBe("completed");
    }
    expect(create).toHaveBeenCalledTimes(257);
  });
});
