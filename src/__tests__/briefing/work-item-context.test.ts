import { describe, expect, it } from "vitest";

import {
  buildDependencyGraph,
  deriveAdjacentFileCandidates,
  deriveRepositoryEntryCandidates,
} from "../../briefing/work-item-context.js";

describe("deriveAdjacentFileCandidates", () => {
  it("keeps test candidates inside the same monorepo package", () => {
    const candidates = deriveAdjacentFileCandidates(["packages/api/src/auth/session.ts"]);

    expect(candidates).toEqual(expect.arrayContaining([
      {
        path: "packages/api/src/auth/session.test.ts",
        reason: "Same-directory test naming convention for packages/api/src/auth/session.ts.",
      },
      {
        path: "packages/api/src/auth/__tests__/session.test.ts",
        reason: "Adjacent __tests__ convention for packages/api/src/auth/session.ts.",
      },
    ]));
    expect(candidates.every((candidate) => candidate.path.startsWith("packages/api/"))).toBe(true);
  });

  it("maps an existing test hint back to its likely source without recursive test names", () => {
    const candidates = deriveAdjacentFileCandidates(["src/auth/session.spec.ts"]);

    expect(candidates).toContainEqual({
      path: "src/auth/session.ts",
      reason: "Source counterpart inferred from test path src/auth/session.spec.ts.",
    });
    expect(candidates.some((candidate) => candidate.path.includes(".spec.test."))).toBe(false);
  });

  it("maps root test directories and Windows separators back to source paths", () => {
    expect(deriveAdjacentFileCandidates(["tests/auth.test.ts"])).toContainEqual({
      path: "auth.ts",
      reason: "Source counterpart inferred from test path tests/auth.test.ts.",
    });
    expect(deriveAdjacentFileCandidates(["__tests__\\session.spec.ts"])).toContainEqual({
      path: "session.ts",
      reason: "Source counterpart inferred from test path __tests__/session.spec.ts.",
    });
  });

  it("deduplicates and caps adversarial candidate expansion", () => {
    const hints = Array.from({ length: 20 }, (_, index) => `src/module-${index}.ts`);
    const candidates = deriveAdjacentFileCandidates([...hints, ...hints]);

    expect(candidates).toHaveLength(12);
    expect(new Set(candidates.map((candidate) => candidate.path)).size).toBe(12);
  });

  it("handles root source paths and ignores non-source path-like hints", () => {
    expect(deriveAdjacentFileCandidates(["auth.ts"])).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "auth.test.ts" }),
      expect.objectContaining({ path: "__tests__/auth.test.ts" }),
    ]));
    expect(deriveAdjacentFileCandidates(["README", ".env", "assets/logo.svg"])).toEqual([]);
  });

  it("does not emit a candidate already present as an explicit hint", () => {
    const candidates = deriveAdjacentFileCandidates(["src/auth.ts", "src/auth.test.ts"]);

    expect(candidates.filter((candidate) => candidate.path === "src/auth.test.ts")).toEqual([]);
    expect(candidates).toContainEqual(expect.objectContaining({ path: "src/auth.spec.ts" }));
  });
});

describe("deriveRepositoryEntryCandidates", () => {
  it("offers bounded root entries for root source changes", () => {
    expect(deriveRepositoryEntryCandidates(["src/auth/session.ts"])).toEqual([
      "src/index.ts",
      "src/main.ts",
      "src/app.ts",
      "index.ts",
      "index.js",
    ]);
  });

  it("does not apply root entries to monorepo packages or docs-only work", () => {
    expect(deriveRepositoryEntryCandidates(["packages/api/src/session.ts"])).toEqual([]);
    expect(deriveRepositoryEntryCandidates(["apps/web/src/session.ts"])).toEqual([]);
    expect(deriveRepositoryEntryCandidates(["docs/auth.md"])).toEqual([]);
    expect(deriveRepositoryEntryCandidates([])).toEqual([]);
  });
});

describe("buildDependencyGraph", () => {
  const issue = (number: number, overrides: Record<string, unknown> = {}) => ({
    number,
    title: `Issue ${number}`,
    state: "open",
    html_url: `https://github.com/acme/app/issues/${number}`,
    repository_url: "https://api.github.com/repos/acme/app",
    ...overrides,
  });

  it("preserves relationship semantics and derives blockers/parallel work", () => {
    const graph = buildDependencyGraph({
      current: { owner: "acme", repo: "app", issueNumber: 10 },
      blockedBy: [issue(2), issue(3, { state: "closed" })],
      blocking: [issue(20)],
      subIssues: [issue(11), issue(12), issue(2)],
      crossReferences: [issue(30, {
        repository_url: "https://api.github.com/repos/acme/other",
        html_url: "https://github.com/acme/other/issues/30",
      })],
    });

    expect(graph.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: "blocked_by", number: 2, repository: "acme/app", verified: true }),
      expect.objectContaining({ relation: "blocking", number: 20 }),
      expect.objectContaining({ relation: "sub_issue", number: 11 }),
      expect.objectContaining({ relation: "cross_reference", number: 30, repository: "acme/other" }),
    ]));
    expect(graph.blockers).toEqual([expect.objectContaining({ number: 2 })]);
    expect(graph.parallelizableWork.map((item) => item.number)).toEqual([11, 12]);
  });

  it("drops self references and deduplicates the same relation", () => {
    const graph = buildDependencyGraph({
      current: { owner: "acme", repo: "app", issueNumber: 10 },
      blockedBy: [issue(10), issue(2), issue(2)],
      blocking: [],
      subIssues: [],
      crossReferences: [],
    });

    expect(graph.dependencies).toHaveLength(1);
    expect(graph.dependencies[0]?.number).toBe(2);
  });

  it("falls back to the current repository when repository metadata is absent or malformed", () => {
    const graph = buildDependencyGraph({
      current: { owner: "acme", repo: "app", issueNumber: 10 },
      blockedBy: [
        issue(2, { repository_url: undefined }),
        issue(3, { repository_url: "https://api.github.com/not-a-repository" }),
      ],
      blocking: [],
      subIssues: [],
      crossReferences: [],
    });

    expect(graph.dependencies.map((item) => item.repository)).toEqual(["acme/app", "acme/app"]);
  });
});
