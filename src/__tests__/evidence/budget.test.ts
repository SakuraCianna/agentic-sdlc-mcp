import { describe, expect, it, vi } from "vitest";

import {
  createBudgetedGithubClient,
  GitHubRequestBudgetExceededError,
} from "../../evidence/budget.js";

describe("createBudgetedGithubClient", () => {
  it("fails closed before starting a request beyond the configured budget", async () => {
    const get = vi.fn().mockResolvedValue({ data: {} });
    const budgeted = createBudgetedGithubClient(
      { repos: { get } },
      2
    );

    await budgeted.client.repos.get();
    await budgeted.client.repos.get();

    expect(() => budgeted.client.repos.get()).toThrow(
      GitHubRequestBudgetExceededError
    );
    expect(get).toHaveBeenCalledTimes(2);
    expect(budgeted.usedRequests()).toBe(2);
  });
});
