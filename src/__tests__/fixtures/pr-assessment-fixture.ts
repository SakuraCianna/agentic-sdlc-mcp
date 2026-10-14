import { vi } from "vitest";
import type { Octokit } from "@octokit/rest";
import { createGithubContractFixture } from "./github-contract-fixtures.js";

export const TEST_PR_HEAD = "a".repeat(40);
export const TEST_PR_BASE = "b".repeat(40);

export function createReadyPrFixture() {
  const fixture = createGithubContractFixture();
  fixture.setPullRequestText("Docs: clarify repository setup", "Clarifies installation without changing behavior.\n\n## Verification\nRan `git diff --check` and manually checked the documented setup commands.");
  fixture.pullsListFiles.mockResolvedValue({ data: [{ filename: "README.md", status: "modified", additions: 2, deletions: 1, changes: 3, patch: "@@ -1 +1 @@\n-old docs\n+clear docs" }] });
  const originalGet = fixture.pullsGet.getMockImplementation()!;
  fixture.pullsGet.mockImplementation(async (...args: unknown[]) => {
    const response = await Reflect.apply(originalGet, undefined, args) as Awaited<ReturnType<Octokit["pulls"]["get"]>>;
    return { data: { ...response.data, head: { ...response.data.head, sha: TEST_PR_HEAD }, base: { ...response.data.base, sha: TEST_PR_BASE } } };
  });
  Object.assign(fixture.octokit.repos, {
    getBranchProtection: vi.fn(async () => ({ data: { required_status_checks: { strict: false, contexts: ["ci/fixture"], checks: [{ context: "ci/fixture", app_id: 15368 }] }, required_pull_request_reviews: null } })),
  });
  return fixture;
}
