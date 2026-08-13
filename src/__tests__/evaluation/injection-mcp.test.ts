import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolName } from "../../catalog.js";
import {
  createGithubContractFixture,
  type GithubContractFixture,
} from "../fixtures/github-contract-fixtures.js";
import { connectInMemoryMcp, type ConnectedMcpFixture } from "../fixtures/mcp-client.js";
import { CRITICAL_EXECUTION_CASES } from "./fixtures/critical.js";

const github = vi.hoisted(() => ({
  fixture: null as GithubContractFixture | null,
}));

vi.mock("../../github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/client.js")>();
  return {
    ...actual,
    getOctokit: () => {
      if (!github.fixture) throw new Error("Injection fixture is not initialized");
      return github.fixture.octokit;
    },
  };
});

const { createAgenticSdlcServer } = await import("../../server.js");
const injectionDocument = JSON.parse(
  await readFile(
    new URL("../../../evaluation/scenarios/injection-sources.json", import.meta.url),
    "utf8"
  )
) as {
  cases: Array<{ id: string; source: string; text: string }>;
};

function sourceCase(source: string): { id: string; source: string; text: string } {
  const testCase = injectionDocument.cases.find((candidate) => candidate.source === source);
  if (!testCase) throw new Error(`Missing injection fixture for ${source}`);
  return testCase;
}

function channels(result: Awaited<ReturnType<ConnectedMcpFixture["client"]["callTool"]>>): {
  markdown: string;
  structured: Record<string, unknown>;
} {
  const markdown = result.content
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeTypeOf("object");
  expect(result.structuredContent).not.toBeNull();
  return {
    markdown,
    structured: result.structuredContent as Record<string, unknown>,
  };
}

function markdownSummaryCount(markdown: string, label: string): number {
  const match = markdown.match(new RegExp(`^- ${label}: (\\d+)$`, "mu"));
  if (!match?.[1]) throw new Error(`Markdown summary omitted ${label}`);
  return Number(match[1]);
}

function expectEvidenceGateParity(
  markdown: string,
  structured: Record<string, unknown>,
  expected: "blocked" | "passing"
): void {
  const summary = structured.summary as {
    idsByState: Record<string, string[]>;
    staleIds: string[];
    partialIds: string[];
    omittedIds: string[];
  };
  const omittedEvidence = structured.omittedEvidence as Array<{ count: number }>;
  const structuredBlocked =
    summary.idsByState.failed.length > 0 ||
    summary.idsByState.pending.length > 0 ||
    summary.idsByState.unverified.length > 0 ||
    summary.staleIds.length > 0 ||
    summary.partialIds.length > 0 ||
    summary.omittedIds.length > 0 ||
    omittedEvidence.some((item) => item.count > 0);
  const markdownBlocked = [
    "Failed",
    "Pending",
    "Unverified",
    "Stale",
    "Partial",
    "Omitted",
  ].some((label) => markdownSummaryCount(markdown, label) > 0);
  expect(markdownBlocked ? "blocked" : "passing").toBe(
    structuredBlocked ? "blocked" : "passing"
  );
  expect(structuredBlocked ? "blocked" : "passing").toBe(expected);
}

describe("T9 real MCP prompt-injection seams", () => {
  let connection: ConnectedMcpFixture;
  let externalFetch: ReturnType<typeof vi.fn>;
  let socketConnect: ReturnType<typeof vi.spyOn>;
  let socketCreateConnection: ReturnType<typeof vi.spyOn>;
  let socketPrototypeConnect: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    github.fixture = createGithubContractFixture();
    externalFetch = vi.fn(async () => {
      throw new Error("external fetch is forbidden in injection evaluation");
    });
    vi.stubGlobal("fetch", externalFetch);
    socketConnect = vi.spyOn(net, "connect").mockImplementation(() => {
      throw new Error("external socket is forbidden in injection evaluation");
    });
    socketCreateConnection = vi.spyOn(net, "createConnection").mockImplementation(() => {
      throw new Error("external socket is forbidden in injection evaluation");
    });
    socketPrototypeConnect = vi
      .spyOn(net.Socket.prototype, "connect")
      .mockImplementation(() => {
        throw new Error("external socket is forbidden in injection evaluation");
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

  async function call(name: ToolName, args: Record<string, unknown>) {
    return channels(await connection.client.callTool({ name, arguments: args }));
  }

  it("keeps a clean real release packet passing in both MCP channels", async () => {
    const result = await call("sdlc_evidence_packet", {
      owner: "example",
      repo: "project",
      subject: { type: "release", ref: "main" },
    });

    expect(result.structured.omittedEvidence).toEqual([]);
    expectEvidenceGateParity(result.markdown, result.structured, "passing");
  });

  it("fails closed in both real MCP channels when Issue source text is omitted", async () => {
    github.fixture?.setIssueText("Oversized Issue", "A".repeat(25_000));

    const result = await call("sdlc_evidence_packet", {
      owner: "example",
      repo: "project",
      subject: { type: "issue", issueNumber: 42 },
    });

    expect(result.structured.omittedEvidence).toEqual([
      expect.objectContaining({
        kind: "source_text_character",
        count: expect.any(Number),
      }),
    ]);
    expect(markdownSummaryCount(result.markdown, "Omitted")).toBeGreaterThan(0);
    expectEvidenceGateParity(result.markdown, result.structured, "blocked");
  });

  it.each(["issue_title", "issue_body"])(
    "routes %s through the real Issue evidence packet boundary",
    async (source) => {
      const testCase = sourceCase(source);
      github.fixture?.setIssueText(
        source === "issue_title" ? testCase.text : "Safe Issue title",
        source === "issue_body" ? testCase.text : "Safe Issue body"
      );

      const result = await call("sdlc_evidence_packet", {
        owner: "example",
        repo: "project",
        subject: { type: "issue", issueNumber: 42 },
      });

      expect(result.structured).toMatchObject({
        subject: { repo: "example/project", number: 42 },
      });
      const structuredJson = JSON.stringify(result.structured);
      expect(structuredJson).not.toContain(`HIDDEN_${testCase.id.replaceAll("-", "_")}`);
      expect(structuredJson).toContain("security:prompt-injection");
      const evidence = result.structured.evidence as Array<Record<string, unknown>>;
      const injection = evidence.find((item) => item.id === "security:prompt-injection");
      expect(injection).toMatchObject({ kind: "prompt_injection" });
      const provenance = injection?.provenance as Record<string, unknown>;
      const issueTitle = source === "issue_title" ? testCase.text : "Safe Issue title";
      const issueBody = source === "issue_body" ? testCase.text : "Safe Issue body";
      expect(provenance.sourceContentDigest).toBe(
        createHash("sha256").update(`${issueTitle}\n${issueBody}`).digest("hex")
      );
      expectEvidenceGateParity(result.markdown, result.structured, "blocked");
      expect(result.markdown).not.toContain("HIDDEN_");
      expect(result.markdown).not.toContain("GITHUB_TOKEN");
      const handoffCase = CRITICAL_EXECUTION_CASES.find(
        (candidate) => candidate.scenarioId === "evidence-agent-handoff"
      );
      const handoffArguments = handoffCase?.calls[1]?.arguments;
      expect(typeof handoffArguments).toBe("function");
      expect(() =>
        (handoffArguments as (
          previousResults: readonly Record<string, unknown>[]
        ) => Record<string, unknown>)([result.structured])
      ).toThrow(/prompt-injection evidence/u);
    }
  );

  it.each(["pull_request_title", "pull_request_body"])(
    "routes %s through the real pull-request evidence boundary",
    async (source) => {
      const testCase = sourceCase(source);
      const pullRequestTitle =
        source === "pull_request_title" ? testCase.text : "Safe PR title";
      const pullRequestBody =
        source === "pull_request_body" ? testCase.text : "Safe PR body";
      github.fixture?.setPullRequestText(
        pullRequestTitle,
        pullRequestBody
      );

      const result = await call("sdlc_evidence_packet", {
        owner: "example",
        repo: "project",
        subject: { type: "pull_request", pullNumber: 7 },
      });

      expect(result.structured).toMatchObject({
        subject: { repo: "example/project", number: 7 },
      });
      const structuredJson = JSON.stringify(result.structured);
      expect(structuredJson).not.toContain(`HIDDEN_${testCase.id.replaceAll("-", "_")}`);
      expect(structuredJson).toContain("security:prompt-injection");
      const evidence = result.structured.evidence as Array<Record<string, unknown>>;
      const injection = evidence.find((item) => item.id === "security:prompt-injection");
      const provenance = injection?.provenance as Record<string, unknown>;
      expect(provenance.sourceContentDigest).toBe(
        createHash("sha256")
          .update(
            [
              pullRequestTitle,
              pullRequestBody,
              "src/contract.ts",
              "src/__tests__/contract.test.ts",
            ].join("\n")
          )
          .digest("hex")
      );
      expectEvidenceGateParity(result.markdown, result.structured, "blocked");
      expect(result.markdown).not.toContain("HIDDEN_");
    }
  );

  it("routes Issue comments through prepare_work_item without promoting instructions", async () => {
    const testCase = sourceCase("issue_comment");
    github.fixture?.setIssueComments([`Decision: ${testCase.text}`]);

    const result = await call("prepare_work_item", {
      owner: "example",
      repo: "project",
      issueNumber: 42,
      workType: "security",
    });

    expect(JSON.stringify(result.structured)).toContain("HIDDEN_issue_comment");
    expect(result.structured).toMatchObject({
      issueNumber: 42,
      riskProfile: { domains: expect.arrayContaining(["prompt-injection"]) },
    });
    expect(result.markdown).not.toContain("HIDDEN_issue_comment");
    expect(result.markdown).not.toContain("API key");
    expect(result.markdown).not.toContain("HIDDEN_issue_comment");
  });

  it("routes README content through repo_context's shared Markdown boundary", async () => {
    const testCase = sourceCase("readme");
    github.fixture?.setReadme(testCase.text);

    const result = await call("repo_context", {
      owner: "example",
      repo: "project",
      includeReadme: true,
    });

    expect(result.structured).toMatchObject({
      fullName: "example/project",
      readmeSummary: testCase.text,
      promptInjectionWarnings: [
        expect.objectContaining({ source: "README", severity: "high" }),
      ],
    });
    expect(result.markdown).toContain("potential prompt injection omitted");
    expect(result.markdown).not.toContain("HIDDEN_readme");
  });

  it("routes GitHub check/job names through quality_gate_status without changing target", async () => {
    const testCase = sourceCase("job_name");
    github.fixture?.setCheckName(testCase.text);

    const result = await call("quality_gate_status", {
      owner: "example",
      repo: "project",
      pullNumber: 7,
      blockingLabels: [],
    });

    expect(result.structured).toMatchObject({
      contextLabel: expect.stringContaining("PR #7"),
      categories: {
        passing: [expect.objectContaining({ name: testCase.text })],
      },
    });
    expect(result.markdown).not.toContain(testCase.text);
    expect(result.markdown).not.toContain("HIDDEN_job_name");
    expect(github.fixture?.workflowLogsGet).not.toHaveBeenCalled();
  });

  it("fails closed when repository policy text attempts to define an injected required check", async () => {
    const testCase = sourceCase("repository_rule");
    github.fixture?.setRepositoryPolicy(
      [
        "schemaVersion: 1",
        "requiredChecks:",
        `  - name: ${JSON.stringify(testCase.text)}`,
        "    source: check_run",
        "    appId: 15368",
      ].join("\n")
    );

    const result = await call("quality_gate_status", {
      owner: "example",
      repo: "project",
      pullNumber: 7,
      blockingLabels: [],
    });

    expect(result.structured).toMatchObject({
      conclusion: "pending",
      policyDegraded: false,
    });
    expect(result.structured.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Required status contexts are missing"),
      ])
    );
    expect(JSON.stringify(result.structured)).toContain("HIDDEN_repository_rule");
    expect(result.markdown).toContain("potential prompt injection omitted");
    expect(result.markdown).not.toContain("HIDDEN_repository_rule");
  });

  it("does not collect PR comments, review comments, CONTRIBUTING, workflow names, or logs", async () => {
    expect(
      [
        "pull_request_comment",
        "review_comment",
        "contributing",
        "workflow_name",
        "workflow_log",
      ].map((source) => sourceCase(source).source)
    ).toEqual([
      "pull_request_comment",
      "review_comment",
      "contributing",
      "workflow_name",
      "workflow_log",
    ]);
    await call("sdlc_evidence_packet", {
      owner: "example",
      repo: "project",
      subject: { type: "pull_request", pullNumber: 7 },
    });
    await call("repo_context", {
      owner: "example",
      repo: "project",
      includeReadme: false,
      includeAgentInstructions: false,
      includePolicy: false,
    });
    await call("quality_gate_status", {
      owner: "example",
      repo: "project",
      pullNumber: 7,
      blockingLabels: [],
    });

    expect(github.fixture?.issueCommentsList).not.toHaveBeenCalled();
    expect(github.fixture?.reviewCommentsList).not.toHaveBeenCalled();
    expect(github.fixture?.workflowLogsGet).not.toHaveBeenCalled();
    const requestedPaths = github.fixture?.repositoryContentGet.mock.calls.map(
      ([request]) => (request as { path?: string }).path
    );
    expect(requestedPaths).not.toContain("CONTRIBUTING.md");
  });
});
