import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { Octokit } from "@octokit/rest";
import { McpServer } from "@modelcontextprotocol/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  EvaluationBudgetConfigSchema,
  runBudgetedEvaluation,
  type EvaluationBudgetReport,
  type EvaluationBudgetScenario,
} from "../../evaluation/budgets.js";
import {
  createBudgetedGithubClient,
  type BudgetedGithubClient,
} from "../../evidence/budget.js";
import type { ToolName } from "../../catalog.js";
import { MCP_TOOL_CONTRACT_CASES } from "../fixtures/mcp-contract-cases.js";
import {
  createGithubContractFixture,
  type GithubContractFixture,
} from "../fixtures/github-contract-fixtures.js";
import { connectInMemoryMcp, type ConnectedMcpFixture } from "../fixtures/mcp-client.js";

const github = vi.hoisted(() => ({
  fixture: null as GithubContractFixture | null,
  budgeted: null as BudgetedGithubClient<Octokit> | null,
}));

vi.mock("../../github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/client.js")>();
  return {
    ...actual,
    getOctokit: () => {
      if (!github.budgeted) throw new Error("Budget fixture is not initialized");
      return github.budgeted.client;
    },
  };
});

const { createAgenticSdlcServer } = await import("../../server.js");
const config = EvaluationBudgetConfigSchema.parse(
  JSON.parse(
    await readFile(new URL("../../../evaluation/budgets.json", import.meta.url), "utf8")
  ) as unknown
);
const reports: EvaluationBudgetReport[] = [];

function scenario(id: string): EvaluationBudgetScenario {
  const value = config.scenarios.find((candidate) => candidate.id === id);
  if (!value) throw new Error(`Missing budget scenario: ${id}`);
  return value;
}

function channels(result: Awaited<ReturnType<ConnectedMcpFixture["client"]["callTool"]>>): {
  markdown: string;
  structuredContent: unknown;
} {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toBeTypeOf("object");
  return {
    markdown: result.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
    structuredContent: result.structuredContent,
  };
}

describe("T10 real MCP budget measurement", () => {
  let connection: ConnectedMcpFixture;
  let externalFetch: ReturnType<typeof vi.fn>;
  let socketConnect: ReturnType<typeof vi.spyOn>;
  let socketCreateConnection: ReturnType<typeof vi.spyOn>;
  let socketPrototypeConnect: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    github.fixture = createGithubContractFixture();
    github.budgeted = createBudgetedGithubClient(github.fixture.octokit, 1_000);
    externalFetch = vi.fn(async () => {
      throw new Error("external fetch is forbidden in budget evaluation");
    });
    vi.stubGlobal("fetch", externalFetch);
    socketConnect = vi.spyOn(net, "connect").mockImplementation(() => {
      throw new Error("external socket is forbidden in budget evaluation");
    });
    socketCreateConnection = vi.spyOn(net, "createConnection").mockImplementation(() => {
      throw new Error("external socket is forbidden in budget evaluation");
    });
    socketPrototypeConnect = vi
      .spyOn(net.Socket.prototype, "connect")
      .mockImplementation(() => {
        throw new Error("external socket is forbidden in budget evaluation");
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
    github.budgeted = null;
    socketConnect?.mockRestore();
    socketCreateConnection?.mockRestore();
    socketPrototypeConnect?.mockRestore();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    const artifactPath = process.env.AGENTIC_EVALUATION_ARTIFACT;
    if (!artifactPath) return;
    const artifactDirectory = path.resolve(
      process.cwd(),
      "artifacts",
      "evaluation"
    );
    const resolved = path.resolve(artifactPath);
    if (
      path.dirname(resolved) !== artifactDirectory ||
      !/^budgets\.json\.pending-\d+$/u.test(path.basename(resolved))
    ) {
      throw new Error("Budget evaluation artifact must use the runner-owned pending path.");
    }
    const expectedCount = config.scenarios.length;
    const scenarioIds = new Set(reports.map((report) => report.scenarioId));
    if (
      reports.length !== expectedCount ||
      scenarioIds.size !== expectedCount ||
      reports.some((report) => !report.passed)
    ) {
      throw new Error(
        `Refusing to publish an incomplete budget artifact: ${reports.length}/${expectedCount} complete.`
      );
    }
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(
      resolved,
      `${JSON.stringify(
        {
          schemaVersion: "1.0",
          generatedFrom: "fixed GitHub fixture through real MCP 2.0.0 Client.callTool",
          expectedReports: expectedCount,
          completedReports: reports.length,
          complete: true,
          reports: [...reports].sort((left, right) =>
            left.scenarioId < right.scenarioId
              ? -1
              : left.scenarioId > right.scenarioId
                ? 1
                : 0
          ),
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  });

  async function measure(
    budgetScenario: EvaluationBudgetScenario,
    name: ToolName,
    args: Record<string, unknown>
  ): Promise<EvaluationBudgetReport> {
    return runBudgetedEvaluation(
      budgetScenario,
      async (signal) =>
        channels(
          await connection.client.callTool(
            { name, arguments: args },
            { signal }
          )
        ),
      { githubApiCalls: () => github.budgeted?.usedRequests() ?? 0 }
    );
  }

  it("keeps one explicit budget scenario for every public tool", () => {
    expect(config.scenarios.map((entry) => entry.tool)).toEqual(
      MCP_TOOL_CONTRACT_CASES.map((entry) => entry.name)
    );
  });

  it("propagates a budget timeout through Client.callTool to the MCP handler", async () => {
    let resolveStarted: (() => void) | undefined;
    let resolveCancelled: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    const hanging = await connectInMemoryMcp(() => {
      const server = new McpServer({ name: "budget-timeout-test", version: "1.0.0" });
      server.registerTool(
        "wait_for_budget_timeout",
        {
          inputSchema: z.object({}),
          outputSchema: z.object({ cancelled: z.boolean() }),
        },
        async (_args, context) => {
          resolveStarted?.();
          await new Promise<void>((resolve) => {
            if (context.mcpReq.signal.aborted) {
              resolveCancelled?.();
              resolve();
              return;
            }
            context.mcpReq.signal.addEventListener(
              "abort",
              () => {
                resolveCancelled?.();
                resolve();
              },
              { once: true }
            );
          });
          return {
            content: [{ type: "text", text: "cancelled" }],
            structuredContent: { cancelled: true },
          };
        }
      );
      return server;
    });

    try {
      const reportPromise = runBudgetedEvaluation(
        {
          ...scenario("repo-context-budget"),
          tool: "wait_for_budget_timeout",
          timeoutMs: 100,
        },
        async (signal) =>
          channels(
            await hanging.client.callTool(
              { name: "wait_for_budget_timeout", arguments: {} },
              { signal }
            )
          )
      );
      await started;
      const report = await reportPromise;
      await cancelled;

      expect(report).toMatchObject({
        passed: false,
        measurement: { timedOut: true, cancelled: false },
        violations: [expect.objectContaining({ metric: "timeout" })],
      });
    } finally {
      await hanging.close();
    }
  });

  it.each(MCP_TOOL_CONTRACT_CASES)(
    "reports $name limits by scenario and tool",
    async (testCase) => {
      const id = `${testCase.name.replaceAll("_", "-")}-budget`;
      const report = await measure(
        scenario(id),
        testCase.name,
        testCase.arguments
      );

      expect(report).toMatchObject({
        scenarioId: id,
        tool: testCase.name,
        passed: true,
        violations: [],
      });
      expect(report.measurement.markdownCharacters).toBeGreaterThan(0);
      expect(report.measurement.structuredItems).toBeGreaterThan(0);
      reports.push(report);
    }
  );
});
