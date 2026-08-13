import type { Octokit } from "@octokit/rest";
import { vi } from "vitest";

export interface GithubContractFixture {
  octokit: Octokit;
  liveIssueCreate: ReturnType<typeof vi.fn>;
  issuesGet: ReturnType<typeof vi.fn>;
  codeScanningList: ReturnType<typeof vi.fn>;
  dependabotList: ReturnType<typeof vi.fn>;
  secretScanningList: ReturnType<typeof vi.fn>;
  issueCommentsList: ReturnType<typeof vi.fn>;
  reviewCommentsList: ReturnType<typeof vi.fn>;
  workflowLogsGet: ReturnType<typeof vi.fn>;
  repositoryContentGet: ReturnType<typeof vi.fn>;
  setIssueText(title: string, body: string): void;
  setPullRequestText(title: string, body: string): void;
  setIssueComments(comments: readonly string[]): void;
  setReadme(content: string): void;
  setRepositoryPolicy(content: string): void;
  setCheckName(name: string): void;
  denyIssueReads(): void;
  denySecurityReads(): void;
}

function notFound(path: string): Error & { status: number; response: { data: { message: string } } } {
  return Object.assign(new Error(`Fixture does not provide ${path}`), {
    status: 404,
    response: { data: { message: "Not Found" } },
  });
}

function forbidden(): Error & { status: number; response: { data: { message: string } } } {
  return Object.assign(new Error("fixture permission denial"), {
    status: 403,
    response: { data: { message: "Resource not accessible by integration" } },
  });
}

export function createGithubContractFixture(): GithubContractFixture {
  let issueTitle = "Harden local MCP contracts";
  let issueBody = "Keep protocol behavior deterministic and local-only.";
  let pullRequestTitle = "Add MCP contract coverage";
  let pullRequestBody = "Adds deterministic protocol-level tests.";
  let issueComments: readonly string[] = [];
  let readmeContent: string | null = null;
  let repositoryPolicyContent: string | null = null;
  let checkName = "ci/fixture";
  const liveIssueCreate = vi.fn(async () => {
    throw new Error("live issue creation is forbidden in the MCP contract matrix");
  });
  const issuesGet = vi.fn(async () => ({
    data: {
      number: 42,
      title: issueTitle,
      state: "open",
      html_url: "https://github.com/example/project/issues/42",
      body: issueBody,
      labels: [{ name: "testing" }],
      assignees: [{ login: "alice" }],
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
      milestone: null,
    },
  }));
  const codeScanningList = vi.fn(async () => ({ data: [] }));
  const dependabotList = vi.fn(async () => ({ data: [] }));
  const secretScanningList = vi.fn(async () => ({ data: [] }));
  const issueCommentsList = vi.fn(async () => ({
    data: issueComments.map((body, index) => ({
      id: index + 1,
      body,
      user: { login: "maintainer" },
      author_association: "OWNER",
      created_at: "2026-08-01T00:00:00Z",
      html_url: `https://github.com/example/project/issues/42#issuecomment-${index + 1}`,
    })),
  }));
  const reviewCommentsList = vi.fn(async () => ({ data: [] }));
  const workflowLogsGet = vi.fn(async () => ({ data: new ArrayBuffer(0) }));
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    if (path === ".agentic-sdlc.yml" && repositoryPolicyContent !== null) {
      return {
        data: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(repositoryPolicyContent).toString("base64"),
          sha: "policy-blob-sha",
        },
      };
    }
    if (path === "CHANGELOG.md") {
      return {
        data: {
          type: "file",
          encoding: "base64",
          content: Buffer.from("# Changelog\n").toString("base64"),
          sha: "changelog-blob-sha",
        },
      };
    }
    if (path === ".github/workflows") {
      return {
        data: [
          {
            type: "file",
            name: "ci.yml",
            path: ".github/workflows/ci.yml",
          },
        ],
      };
    }
    if (path === ".github/workflows/ci.yml") {
      return {
        data: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(
            "name: CI\non: [push]\npermissions:\n  contents: read\njobs: {}\n"
          ).toString("base64"),
          sha: "workflow-blob-sha",
        },
      };
    }
    throw notFound(path);
  });

  const octokit = {
    repos: {
      get: vi.fn(async () => ({
        data: {
          name: "project",
          full_name: "example/project",
          description: "Local MCP contract fixture",
          default_branch: "main",
          visibility: "private",
          language: "TypeScript",
          stargazers_count: 3,
          open_issues_count: 1,
          topics: ["mcp"],
          pushed_at: "2026-08-01T00:00:00Z",
        },
      })),
      getReadme: vi.fn(async () => {
        if (readmeContent === null) throw notFound("README.md");
        return { data: readmeContent };
      }),
      getContent,
      getCommit: vi.fn(async () => ({ data: { sha: "fixture-head-sha" } })),
      getCombinedStatusForRef: vi.fn(async () => ({
        data: {
          statuses: [
            {
              context: checkName,
              state: "success",
              target_url: "https://github.com/example/project/actions/runs/1",
            },
          ],
        },
      })),
      getBranchProtection: vi.fn(async () => {
        throw notFound("branch protection");
      }),
      getBranchRules: vi.fn(async () => ({ data: [] })),
    },
    issues: {
      get: issuesGet,
      create: liveIssueCreate,
      listComments: issueCommentsList,
      listForRepo: vi.fn(async () => ({ data: [] })),
      listLabelsForRepo: vi.fn(async () => ({ data: [{ name: "testing" }] })),
      listSubIssues: vi.fn(async () => ({ data: [] })),
      listDependenciesBlockedBy: vi.fn(async () => ({ data: [] })),
      listDependenciesBlocking: vi.fn(async () => ({ data: [] })),
      listEventsForTimeline: vi.fn(async () => ({ data: [] })),
    },
    pulls: {
      get: vi.fn(async () => ({
        data: {
          number: 7,
          title: pullRequestTitle,
          body: pullRequestBody,
          user: { login: "alice" },
          state: "open",
          html_url: "https://github.com/example/project/pull/7",
          created_at: "2026-08-01T00:00:00Z",
          draft: false,
          head: { ref: "contract-tests", sha: "fixture-head-sha" },
          base: { ref: "main", sha: "fixture-base-sha" },
          commits: 1,
          mergeable: true,
          mergeable_state: "clean",
          labels: [{ name: "testing" }],
        },
      })),
      list: vi.fn(async () => ({ data: [] })),
      listFiles: vi.fn(async () => ({
        data: [
          {
            filename: "src/contract.ts",
            status: "modified",
            additions: 4,
            deletions: 1,
            changes: 5,
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
          {
            filename: "src/__tests__/contract.test.ts",
            status: "added",
            additions: 8,
            deletions: 0,
            changes: 8,
            patch: "@@ -0,0 +1 @@\n+test",
          },
        ],
      })),
      listRequestedReviewers: vi.fn(async () => ({ data: { users: [], teams: [] } })),
      listReviews: vi.fn(async () => ({ data: [] })),
      listReviewComments: reviewCommentsList,
    },
    checks: {
      listForRef: vi.fn(async () => ({
        data: {
          total_count: 1,
          check_runs: [
            {
              name: checkName,
              status: "completed",
              conclusion: "success",
              app: { id: 15368 },
              details_url: "https://github.com/example/project/actions/runs/1",
              html_url: "https://github.com/example/project/runs/1",
            },
          ],
        },
      })),
    },
    actions: {
      getWorkflowRun: vi.fn(async () => {
        throw notFound("workflow run");
      }),
      getJobForWorkflowRun: vi.fn(async () => {
        throw notFound("workflow job");
      }),
      downloadJobLogsForWorkflowRun: workflowLogsGet,
    },
    codeScanning: { listAlertsForRepo: codeScanningList },
    dependabot: { listAlertsForRepo: dependabotList },
    secretScanning: { listAlertsForRepo: secretScanningList },
    graphql: vi.fn(async () => ({
      repository: {
        pullRequest: {
          reviewDecision: null,
          closingIssuesReferences: {
            nodes: [],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    })),
  } as unknown as Octokit;

  return {
    octokit,
    liveIssueCreate,
    issuesGet,
    codeScanningList,
    dependabotList,
    secretScanningList,
    issueCommentsList,
    reviewCommentsList,
    workflowLogsGet,
    repositoryContentGet: getContent,
    setIssueText(title, body) {
      issueTitle = title;
      issueBody = body;
    },
    setPullRequestText(title, body) {
      pullRequestTitle = title;
      pullRequestBody = body;
    },
    setIssueComments(comments) {
      issueComments = [...comments];
    },
    setReadme(content) {
      readmeContent = content;
    },
    setRepositoryPolicy(content) {
      repositoryPolicyContent = content;
    },
    setCheckName(name) {
      checkName = name;
    },
    denyIssueReads() {
      issuesGet.mockRejectedValue(forbidden());
    },
    denySecurityReads() {
      codeScanningList.mockRejectedValue(forbidden());
      dependabotList.mockRejectedValue(forbidden());
      secretScanningList.mockRejectedValue(forbidden());
    },
  };
}
