import net from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GITHUB_FAULT_CONTRACT,
  GithubFaultConfigSchema,
  type GithubFaultCase,
} from "../../evaluation/faults.js";
import {
  createGithubContractFixture,
  type GithubContractFixture,
} from "../fixtures/github-contract-fixtures.js";
import { connectInMemoryMcp, type ConnectedMcpFixture } from "../fixtures/mcp-client.js";

const github = vi.hoisted(() => ({
  fixture: null as GithubContractFixture | null,
}));

vi.mock("../../github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/client.js")>();
  return {
    ...actual,
    getOctokit: () => {
      if (!github.fixture) throw new Error("Fault fixture is not initialized");
      return github.fixture.octokit;
    },
  };
});

vi.mock("../../evidence/model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../evidence/model.js")>();
  return {
    ...actual,
    DEFAULT_EVIDENCE_BUDGET: {
      ...actual.DEFAULT_EVIDENCE_BUDGET,
      collectionTimeoutMs: 50,
    },
  };
});

const { createAgenticSdlcServer } = await import("../../server.js");
const REPOSITORY = { owner: "example", repo: "project" } as const;
const SENSITIVE_ERROR_CANARY = "PRIVATE_PATH_AND_TOKEN_CANARY";
const faultConfig = GithubFaultConfigSchema.parse(
  JSON.parse(
    await readFile(
      new URL("../../../evaluation/fixtures/github-faults.json", import.meta.url),
      "utf8"
    )
  ) as unknown
);
const GITHUB_FAULT_CASES = faultConfig.cases;
const completedFaultIds = new Set<string>();

function faultCase(id: string): GithubFaultCase {
  const fault = GITHUB_FAULT_CASES.find((candidate) => candidate.id === id);
  if (!fault) {
    throw new Error(`Unknown fault report id: ${id}`);
  }
  return fault;
}

function completeFault(fault: GithubFaultCase): void {
  if (completedFaultIds.has(fault.id)) {
    throw new Error(`Duplicate fault report id: ${fault.id}`);
  }
  completedFaultIds.add(fault.id);
}

function githubError(status: number): Error & {
  status: number;
  response: { data: { message: string } };
} {
  return Object.assign(new Error(`fixture GitHub ${status}`), {
    status,
    response: { data: { message: "Injected upstream failure" } },
  });
}

function markdown(result: Awaited<ReturnType<ConnectedMcpFixture["client"]["callTool"]>>): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function structured(
  result: Awaited<ReturnType<ConnectedMcpFixture["client"]["callTool"]>>
): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeTypeOf("object");
  return result.structuredContent as Record<string, unknown>;
}

function hundredFiles(page: number): Array<Record<string, unknown>> {
  return Array.from({ length: 100 }, (_value, index) => ({
    filename: `src/page-${page}/file-${index}.ts`,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -1 +1 @@\n-old\n+new",
  }));
}

describe("T11 GitHub fault injection matrix", () => {
  let connection: ConnectedMcpFixture;
  let externalFetch: ReturnType<typeof vi.fn>;
  let socketConnect: ReturnType<typeof vi.spyOn>;
  let socketCreateConnection: ReturnType<typeof vi.spyOn>;
  let socketPrototypeConnect: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    github.fixture = createGithubContractFixture();
    externalFetch = vi.fn(async () => {
      throw new Error("external fetch is forbidden in fault evaluation");
    });
    vi.stubGlobal("fetch", externalFetch);
    socketConnect = vi.spyOn(net, "connect").mockImplementation(() => {
      throw new Error("external socket is forbidden in fault evaluation");
    });
    socketCreateConnection = vi.spyOn(net, "createConnection").mockImplementation(() => {
      throw new Error("external socket is forbidden in fault evaluation");
    });
    socketPrototypeConnect = vi
      .spyOn(net.Socket.prototype, "connect")
      .mockImplementation(() => {
        throw new Error("external socket is forbidden in fault evaluation");
      });
    connection = await connectInMemoryMcp(createAgenticSdlcServer);
  });

  afterEach(async () => {
    expect(github.fixture?.liveIssueCreate).not.toHaveBeenCalled();
    expect(externalFetch).not.toHaveBeenCalled();
    expect(socketConnect).not.toHaveBeenCalled();
    expect(socketCreateConnection).not.toHaveBeenCalled();
    expect(socketPrototypeConnect).not.toHaveBeenCalled();
    await connection?.close();
    github.fixture = null;
    socketConnect?.mockRestore();
    socketCreateConnection?.mockRestore();
    socketPrototypeConnect?.mockRestore();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    const artifactPath = process.env.AGENTIC_EVALUATION_ARTIFACT;
    if (!artifactPath) return;
    const artifactDirectory = path.resolve(process.cwd(), "artifacts", "evaluation");
    const resolved = path.resolve(artifactPath);
    if (
      path.dirname(resolved) !== artifactDirectory ||
      !/^faults\.json\.pending-\d+$/u.test(path.basename(resolved))
    ) {
      throw new Error("Fault evaluation artifact must use the runner-owned pending path.");
    }
    const expectedIds = GITHUB_FAULT_CASES.map((fault) => fault.id).sort();
    const completedIds = [...completedFaultIds].sort();
    if (JSON.stringify(completedIds) !== JSON.stringify(expectedIds)) {
      throw new Error(
        `Refusing to publish an incomplete fault artifact: ${completedIds.length}/${expectedIds.length} complete.`
      );
    }
    const reports = GITHUB_FAULT_CASES.map((fault) => ({
      faultId: fault.id,
      kind: fault.kind,
      endpoint: fault.endpoint,
      status: fault.status ?? null,
      affectedTool: fault.affectedTool,
      aggregateTool: fault.aggregateTool,
      expectedSignal: fault.expectedSignal,
      preservesSignal: fault.preservesSignal,
      passed: true,
    }));
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(
      resolved,
      `${JSON.stringify({
        schemaVersion: "1.0",
        generatedFrom: "fixed GitHub faults through real MCP 2.0.0 Client.callTool",
        expectedReports: expectedIds.length,
        completedReports: reports.length,
        complete: true,
        reports,
      }, null, 2)}\n`,
      "utf8"
    );
  });

  it("locks every fault to an affected tool and an aggregate tool", () => {
    expect(GITHUB_FAULT_CASES).toEqual(GITHUB_FAULT_CONTRACT);
    expect(GITHUB_FAULT_CASES.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining([
        "http",
        "graphql-partial",
        "timeout",
        "truncation",
        "missing-field",
        "duplicate-response",
      ])
    );
    expect(new Set(GITHUB_FAULT_CASES.map((entry) => entry.id)).size).toBe(
      GITHUB_FAULT_CASES.length
    );
    for (const entry of GITHUB_FAULT_CASES) {
      expect(entry.affectedTool).not.toBe(entry.aggregateTool);
      expect(entry.expectedSignal).not.toHaveLength(0);
      expect(entry.preservesSignal).not.toHaveLength(0);
    }
  });

  it("rejects duplicate ids, ambiguous statuses, and self-aggregating fault cases", () => {
    const base = GITHUB_FAULT_CASES[0]!;
    expect(
      GithubFaultConfigSchema.safeParse({
        schemaVersion: "1.0",
        cases: [base, { ...base }],
      }).success
    ).toBe(false);
    expect(
      GithubFaultConfigSchema.safeParse({
        schemaVersion: "1.0",
        cases: [{ ...base, status: undefined }],
      }).success
    ).toBe(false);
    expect(
      GithubFaultConfigSchema.safeParse({
        schemaVersion: "1.0",
        cases: [{ ...base, kind: "timeout", status: 403 }],
      }).success
    ).toBe(false);
    expect(
      GithubFaultConfigSchema.safeParse({
        schemaVersion: "1.0",
        cases: [{ ...base, aggregateTool: base.affectedTool }],
      }).success
    ).toBe(false);
  });

  it.each([
    ["checks-429", "checksListForRef", 429, "check_runs", "commit_statuses"],
    ["status-500", "combinedStatusGet", 500, "commit_statuses", "check_runs"],
  ] as const)(
    "%s keeps the other CI source while both affected and aggregate tools fail closed",
    async (id, endpoint, expectedStatus, unavailable, preserved) => {
      const fault = faultCase(id);
      expect(fault.endpoint).toBe(
        endpoint === "checksListForRef"
          ? "checks.listForRef"
          : "repos.getCombinedStatusForRef"
      );
      expect(fault.status).toBe(expectedStatus);
      github.fixture?.[endpoint].mockRejectedValue(githubError(fault.status!));

      const gate = structured(
        await connection.client.callTool({
          name: fault.affectedTool,
          arguments: { ...REPOSITORY, ref: "main" },
        })
      );
      const release = structured(
        await connection.client.callTool({
          name: fault.aggregateTool,
          arguments: { ...REPOSITORY, headRef: "main" },
        })
      );

      expect(gate.conclusion).not.toBe("passing");
      expect(gate.unverifiedSignals).toContain(unavailable);
      const checks = (gate.evidence as {
        checks: {
          checkRuns: { passing: unknown[] };
          commitStatuses: { passing: unknown[] };
        };
      }).checks;
      expect(
        preserved === "check_runs"
          ? checks.checkRuns.passing
          : checks.commitStatuses.passing
      ).not.toHaveLength(0);
      expect(release.ciStatus).not.toBe("passing");
      expect(release.ciEvidenceIncomplete).toBe(true);
      expect(release.ciSummary).toContain(
        unavailable === "check_runs" ? "check runs" : "commit statuses"
      );
      completeFault(fault);
    }
  );

  it("turns GraphQL partial failure into unverified evidence without discarding CI", async () => {
    const fault = faultCase("graphql-partial");
    expect(fault.endpoint).toBe("graphql");
    github.fixture?.graphql.mockRejectedValue(
      Object.assign(new Error("GraphQL partial response"), {
        status: 500,
        response: { data: { message: "GraphQL partial response" } },
        data: { repository: { pullRequest: null } },
        errors: [{ type: "PARTIAL" }],
      })
    );

    const gate = structured(
      await connection.client.callTool({
        name: fault.affectedTool,
        arguments: { ...REPOSITORY, pullNumber: 7 },
      })
    );
    const packet = structured(
      await connection.client.callTool({
          name: fault.aggregateTool,
        arguments: {
          ...REPOSITORY,
          subject: { type: "pull_request", pullNumber: 7 },
        },
      })
    );

    expect(gate.conclusion).not.toBe("passing");
    expect(gate.unverifiedSignals).toEqual(
      expect.arrayContaining(["review_decision", "linked_issues"])
    );
    expect((gate.categories as { passing: unknown[] }).passing).not.toHaveLength(0);
    expect(JSON.stringify(packet)).toContain("graphql");
    expect(JSON.stringify(packet)).toContain("verified");
    completeFault(fault);
  });

  it("marks 301 changed files as truncated in both PR summary and evidence packet", async () => {
    const fault = faultCase("files-truncated");
    expect(fault.endpoint).toBe("pulls.listFiles");
    github.fixture?.pullsListFiles.mockImplementation(async ({ page }: { page?: number }) => ({
      data: page === 4 ? hundredFiles(4).slice(0, 1) : hundredFiles(page ?? 1),
    }));

    const summaryResult = await connection.client.callTool({
      name: fault.affectedTool,
      arguments: { ...REPOSITORY, pullNumber: 7 },
    });
    const summary = structured(summaryResult);
    const packet = structured(
      await connection.client.callTool({
          name: fault.aggregateTool,
        arguments: {
          ...REPOSITORY,
          subject: { type: "pull_request", pullNumber: 7 },
        },
      })
    );

    expect(summary.filesTruncated).toBe(true);
    expect(markdown(summaryResult)).toContain("incomplete");
    expect(JSON.stringify(packet)).toContain("changed_files");
    expect(JSON.stringify(packet)).toContain("partial");
    completeFault(fault);
  });

  it("does not promote missing primary PR fields and preserves repository handoff evidence", async () => {
    const fault = faultCase("pull-missing-field");
    expect(fault.endpoint).toBe("pulls.get");
    github.fixture?.pullsGet.mockResolvedValue({
      data: { number: 7, title: "Incomplete PR", labels: [] },
    });

    const direct = await connection.client.callTool({
      name: fault.affectedTool,
      arguments: { ...REPOSITORY, pullNumber: 7 },
    });
    const aggregate = structured(
      await connection.client.callTool({
        name: fault.aggregateTool,
        arguments: { ...REPOSITORY, pullNumber: 7 },
      })
    );

    expect(direct.isError).toBe(true);
    expect(aggregate.prRef).toBeNull();
    expect(aggregate.evidenceWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Pull request #7 evidence is unavailable"),
      expect.stringContaining("Pull request collection was degraded"),
    ]));
    expect(JSON.stringify(aggregate)).toContain("repository:metadata");
    completeFault(fault);
  });

  it("keeps repository handoff evidence when Issue reads fail with 403", async () => {
    const fault = faultCase("issue-403");
    expect(fault.endpoint).toBe("issues.get");
    const error = githubError(fault.status!);
    error.response.data.message = SENSITIVE_ERROR_CANARY;
    github.fixture?.issuesGet.mockRejectedValue(error);

    const direct = await connection.client.callTool({
      name: fault.affectedTool,
      arguments: { ...REPOSITORY, issueNumber: 42 },
    });
    const aggregate = structured(
      await connection.client.callTool({
        name: fault.aggregateTool,
        arguments: { ...REPOSITORY, issueNumber: 42 },
      })
    );

    expect(direct.isError).toBe(true);
    expect(aggregate.issueRef).toBeNull();
    expect(aggregate.evidenceWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Issue #42 evidence is unavailable"),
      expect.stringContaining("Issue collection was degraded"),
    ]));
    expect(JSON.stringify(aggregate)).toContain("repository:metadata");
    expect(markdown(direct)).not.toContain(SENSITIVE_ERROR_CANARY);
    expect(JSON.stringify(aggregate)).not.toContain(SENSITIVE_ERROR_CANARY);
    completeFault(fault);
  });

  it("keeps repository handoff evidence when PR reads fail with 404", async () => {
    const fault = faultCase("pull-404");
    expect(fault.endpoint).toBe("pulls.get");
    github.fixture?.pullsGet.mockRejectedValue(githubError(fault.status!));

    const direct = await connection.client.callTool({
      name: fault.affectedTool,
      arguments: { ...REPOSITORY, pullNumber: 7 },
    });
    const aggregate = structured(
      await connection.client.callTool({
        name: fault.aggregateTool,
        arguments: { ...REPOSITORY, pullNumber: 7 },
      })
    );

    expect(direct.isError).toBe(true);
    expect(aggregate.prRef).toBeNull();
    expect(aggregate.evidenceWarnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Pull request #7 evidence is unavailable"),
      expect.stringContaining("Pull request collection was degraded"),
    ]));
    expect(JSON.stringify(aggregate)).toContain("repository:metadata");
    completeFault(fault);
  });

  it("keeps successful security sources when Code Scanning fails with 401", async () => {
    const fault = faultCase("security-401");
    expect(fault.endpoint).toBe("codeScanning.listAlertsForRepo");
    github.fixture?.codeScanningList.mockRejectedValue(githubError(fault.status!));
    github.fixture?.dependabotList.mockResolvedValue({
      data: [{
        number: 9,
        state: "open",
        security_advisory: { severity: "low", summary: "Fixture advisory" },
        dependency: { package: { name: "fixture-package" } },
        html_url: "https://github.com/example/project/security/dependabot/9",
        fixed_at: null,
        dismissed_at: null,
      }],
    });

    const triageResult = await connection.client.callTool({
      name: fault.affectedTool,
      arguments: REPOSITORY,
    });
    const triage = structured(triageResult);
    const packet = structured(
      await connection.client.callTool({
          name: fault.aggregateTool,
        arguments: {
          ...REPOSITORY,
          subject: { type: "release", ref: "main" },
        },
      })
    );

    expect(triage.errors).toEqual([
      expect.stringContaining("Code Scanning: GitHub authentication failed (401)"),
    ]);
    expect(github.fixture?.dependabotList).toHaveBeenCalled();
    expect(JSON.stringify(triage.alerts)).toContain("[Dependabot]");
    expect(github.fixture?.secretScanningList).toHaveBeenCalled();
    expect(markdown(triageResult)).not.toContain("Injected upstream failure");
    expect(JSON.stringify(packet)).toMatch(/partial|unverified/u);
    expect(JSON.stringify(packet)).toContain("release");
    completeFault(fault);
  });

  it("keeps PR metadata when changed-file collection fails with 422", async () => {
    const fault = faultCase("files-422");
    expect(fault.endpoint).toBe("pulls.listFiles");
    github.fixture?.pullsListFiles.mockRejectedValue(githubError(fault.status!));

    const direct = await connection.client.callTool({
      name: fault.affectedTool,
      arguments: { ...REPOSITORY, pullNumber: 7 },
    });
    const packet = structured(
      await connection.client.callTool({
          name: fault.aggregateTool,
        arguments: {
          ...REPOSITORY,
          subject: { type: "pull_request", pullNumber: 7 },
        },
      })
    );

    expect(direct.isError).toBe(true);
    expect(markdown(direct)).toContain("validation error (422)");
    expect(JSON.stringify(packet)).toContain("pr:metadata");
    expect(JSON.stringify(packet)).toContain("changed_files");
    expect(JSON.stringify(packet)).toMatch(/partial|unverified/u);
    completeFault(fault);
  });

  it("does not multiply a duplicate check response into distinct evidence", async () => {
    const fault = faultCase("duplicate-check-response");
    expect(fault.endpoint).toBe("checks.listForRef");
    const duplicate = {
      name: "ci/fixture",
      status: "completed",
      conclusion: "success",
      app: { id: 15368 },
      details_url: "https://github.com/example/project/actions/runs/1",
      html_url: "https://github.com/example/project/runs/1",
    };
    github.fixture?.checksListForRef.mockResolvedValue({
      data: { total_count: 2, check_runs: [duplicate, { ...duplicate }] },
    });

    const gate = structured(
      await connection.client.callTool({
          name: fault.affectedTool,
        arguments: { ...REPOSITORY, ref: "main" },
      })
    );
    const release = structured(
      await connection.client.callTool({
          name: fault.aggregateTool,
        arguments: { ...REPOSITORY, headRef: "main" },
      })
    );

    const gateChecks = gate.evidence as {
      checks: { checkRuns: { passing: Array<{ name: string }> } };
    };
    expect(gateChecks.checks.checkRuns.passing.filter((item) => item.name === "ci/fixture"))
      .toHaveLength(1);
    expect(release.ciStatus).toBe("passing");
    expect(release.ciSummary).toContain("All 2 CI signal(s)");
    completeFault(fault);
  });

  it("aborts direct and aggregate PR requests without leaving a pending upstream operation", async () => {
    const fault = faultCase("pull-timeout");
    expect(fault.endpoint).toBe("pulls.get");
    let directStartedResolve: (() => void) | undefined;
    let directAbortedResolve: (() => void) | undefined;
    const directStarted = new Promise<void>((resolve) => {
      directStartedResolve = resolve;
    });
    const directAborted = new Promise<void>((resolve) => {
      directAbortedResolve = resolve;
    });
    github.fixture?.pullsGet.mockImplementationOnce(
      async ({ request }: { request?: { signal?: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          const signal = request?.signal;
          expect(signal).toBeInstanceOf(AbortSignal);
          directStartedResolve?.();
          signal?.addEventListener(
            "abort",
            () => {
              directAbortedResolve?.();
              reject(signal.reason);
            },
            { once: true }
          );
        })
    );
    const controller = new AbortController();
    const direct = connection.client.callTool(
      {
        name: fault.affectedTool,
        arguments: { ...REPOSITORY, pullNumber: 7 },
      },
      { signal: controller.signal }
    );
    await directStarted;
    controller.abort(new Error("caller cancelled fault probe"));
    await expect(direct).rejects.toThrow(/cancelled fault probe/u);
    await directAborted;

    let aggregateAborted = false;
    github.fixture?.pullsGet.mockImplementationOnce(
      async ({ request }: { request?: { signal?: AbortSignal } }) =>
        new Promise((_resolve, reject) => {
          const signal = request?.signal;
          expect(signal).toBeInstanceOf(AbortSignal);
          signal?.addEventListener(
            "abort",
            () => {
              aggregateAborted = true;
              reject(signal.reason);
            },
            { once: true }
          );
        })
    );
    const packet = structured(
      await connection.client.callTool({
          name: fault.aggregateTool,
        arguments: {
          ...REPOSITORY,
          subject: { type: "pull_request", pullNumber: 7 },
        },
      })
    );

    expect(aggregateAborted).toBe(true);
    expect(JSON.stringify(packet)).toContain("timed out");
    expect(JSON.stringify(packet)).toMatch(/partial|unverified/u);
    completeFault(fault);
  });
});
