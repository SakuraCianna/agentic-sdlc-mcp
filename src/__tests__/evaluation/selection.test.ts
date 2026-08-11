import { readFile } from "node:fs/promises";
import net from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  digestEvaluationValue,
  EvaluationScenarioSchema,
  EvaluationTraceSchema,
  type EvaluationTrace,
} from "../../evaluation/model.js";
import { scoreEvaluationTrace } from "../../evaluation/scorer.js";
import { connectInMemoryMcp, type ConnectedMcpFixture } from "../fixtures/mcp-client.js";
import {
  SELECTION_EXECUTION_CASES,
  type SelectionExecutionCase,
} from "./fixtures/selection.js";
import {
  createGithubContractFixture,
  type GithubContractFixture,
} from "../fixtures/github-contract-fixtures.js";

const github = vi.hoisted(() => ({
  fixture: null as GithubContractFixture | null,
}));

vi.mock("../../github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/client.js")>();
  return {
    ...actual,
    getOctokit: () => {
      if (!github.fixture) throw new Error("Selection fixture is not initialized");
      return github.fixture.octokit;
    },
  };
});

const { createAgenticSdlcServer } = await import("../../server.js");
const scenarioDocument = JSON.parse(
  await readFile(
    new URL("../../../evaluation/scenarios/selection.json", import.meta.url),
    "utf8"
  )
) as unknown;
const traceDocument = JSON.parse(
  await readFile(
    new URL("../../../evaluation/traces/selection.json", import.meta.url),
    "utf8"
  )
) as unknown;

const ScenarioSuiteSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    group: z.literal("selection"),
    scenarios: z.array(EvaluationScenarioSchema).length(6),
  })
  .strict();

const TraceSuiteSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    group: z.literal("selection"),
    recording: z
      .object({
        provenance: z.literal("recorded-agent"),
        recordedAt: z.literal("2026-08-11"),
        recorder: z.literal("Codex agent using Agentic SDLC MCP"),
        sourceRevision: z.literal(
          "cd77cdaf6a2287c412f3f54550226d0d83b3aaf3"
        ),
        evidenceUrl: z.literal(
          "https://github.com/SakuraCianna/agentic-sdlc-mcp/issues/44#issuecomment-5248456267"
        ),
        contentDigest: z.literal(
          "9a37c0691d5740afaaa67c7748b8bcf66a62fa240d88d054d4dbadc0322d2fed"
        ),
        sanitization: z.literal(
          "Raw arguments and returned content are omitted; canonical SHA-256 digests of sanitized replay arguments are retained."
        ),
        replayMode: z.literal("fixed-fixture"),
      })
      .strict(),
    traces: z.array(EvaluationTraceSchema).length(6),
  })
  .strict();

function structuredObject(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

describe("T8 deterministic selection evaluation", () => {
  let connection: ConnectedMcpFixture;
  let externalFetch: ReturnType<typeof vi.fn>;
  let socketConnect: ReturnType<typeof vi.spyOn>;
  let socketCreateConnection: ReturnType<typeof vi.spyOn>;
  let socketPrototypeConnect: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    github.fixture = createGithubContractFixture();
    externalFetch = vi.fn(async () => {
      throw new Error("external fetch is forbidden in selection evaluation");
    });
    vi.stubGlobal("fetch", externalFetch);
    socketConnect = vi.spyOn(net, "connect").mockImplementation(() => {
      throw new Error("external socket is forbidden in selection evaluation");
    });
    socketCreateConnection = vi.spyOn(net, "createConnection").mockImplementation(() => {
      throw new Error("external socket is forbidden in selection evaluation");
    });
    socketPrototypeConnect = vi
      .spyOn(net.Socket.prototype, "connect")
      .mockImplementation(() => {
        throw new Error("external socket is forbidden in selection evaluation");
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

  it("keeps six versioned scenario and trace records aligned", () => {
    const scenarios = ScenarioSuiteSchema.parse(scenarioDocument);
    const traces = TraceSuiteSchema.parse(traceDocument);
    expect(scenarios.scenarios.map((scenario) => scenario.id)).toEqual(
      traces.traces.map((trace) => trace.scenarioId)
    );
    expect(SELECTION_EXECUTION_CASES.map((testCase) => testCase.scenarioId)).toEqual(
      scenarios.scenarios.map((scenario) => scenario.id)
    );
    expect(new Set(traces.traces.map((trace) => trace.provenance))).toEqual(
      new Set(["recorded-agent"])
    );
    const { contentDigest, ...recordingWithoutDigest } = traces.recording;
    expect(contentDigest).toBe(
      digestEvaluationValue({ ...traces, recording: recordingWithoutDigest })
    );
  });

  it.each(SELECTION_EXECUTION_CASES)(
    "$scenarioId executes its fixed trace through Client.callTool",
    async (testCase: SelectionExecutionCase) => {
      const scenario = ScenarioSuiteSchema.parse(scenarioDocument).scenarios.find(
        (candidate) => candidate.id === testCase.scenarioId
      );
      const expectedTrace = TraceSuiteSchema.parse(traceDocument).traces.find(
        (candidate) => candidate.scenarioId === testCase.scenarioId
      );
      expect(scenario).toBeDefined();
      expect(expectedTrace).toBeDefined();

      const calls: EvaluationTrace["calls"] = [];
      const structuredResults: Record<string, unknown>[] = [];
      for (const call of testCase.calls) {
        const callArguments =
          typeof call.arguments === "function"
            ? call.arguments(structuredResults)
            : call.arguments;
        const plannedIssues = structuredResults[0]?.issueDrafts;
        if (call.expectedArguments) {
          expect(callArguments).toMatchObject(call.expectedArguments);
        }
        if (call.name === "create_issue_set") {
          expect(Array.isArray(plannedIssues)).toBe(true);
          expect(callArguments.issues).toEqual(plannedIssues);
        }
        const result = await connection.client.callTool({
          name: call.name,
          arguments: callArguments,
        });
        expect(result.isError).not.toBe(true);
        const structured = structuredObject(result.structuredContent);
        expect(structured).toMatchObject(call.expectedStructured);
        if (call.name === "create_issue_set") {
          expect(structured.count).toBe((plannedIssues as unknown[]).length);
        }
        structuredResults.push(structured);
        calls.push({
          tool: call.name,
          effect: call.effect,
          outcome: "success",
          argumentsDigest: digestEvaluationValue(callArguments),
        });
      }

      const actualTrace = EvaluationTraceSchema.parse({
        ...expectedTrace,
        calls,
      });
      expect(actualTrace).toEqual(expectedTrace);
      const score = scoreEvaluationTrace(scenario, actualTrace);
      expect(score.score).toBe(100);
      expect(score.passed).toBe(true);
      expect(score.summary.criticalViolationCount).toBe(0);
    }
  );

  it("distinguishes the two similar tool pairs in the checked-in scenarios", () => {
    const scenarios = ScenarioSuiteSchema.parse(scenarioDocument).scenarios;
    const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
    expect(byId.get("repository-briefing")).toMatchObject({
      requiredTools: ["repo_context"],
      forbiddenTools: ["prepare_work_item"],
    });
    expect(byId.get("issue-risk-brief")).toMatchObject({
      requiredTools: ["prepare_work_item"],
      forbiddenTools: ["repo_context"],
    });
    expect(byId.get("pull-request-gate")).toMatchObject({
      requiredTools: ["quality_gate_status"],
      forbiddenTools: ["review_pr_against_standard"],
    });
    expect(byId.get("pull-request-review")).toMatchObject({
      requiredTools: ["review_pr_against_standard"],
      forbiddenTools: ["quality_gate_status"],
    });
  });

  it("fails swapped tools, reversed order, skipped gates, and live-write controls", () => {
    const scenarios = ScenarioSuiteSchema.parse(scenarioDocument).scenarios;
    const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
    const scoreControl = (
      scenarioId: string,
      calls: EvaluationTrace["calls"]
    ) => {
      const scenario = byId.get(scenarioId);
      expect(scenario).toBeDefined();
      return scoreEvaluationTrace(scenario, {
        schemaVersion: "1.0",
        scenarioId,
        provenance: "scripted",
        calls,
      });
    };

    expect(
      scoreControl("repository-briefing", [
        { tool: "prepare_work_item", effect: "read", outcome: "success" },
      ])
    ).toMatchObject({
      passed: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "MissingRequiredTool" }),
        expect.objectContaining({ code: "ForbiddenTool" }),
      ]),
    });
    expect(
      scoreControl("pull-request-gate", [
        {
          tool: "review_pr_against_standard",
          effect: "read",
          outcome: "success",
        },
      ])
    ).toMatchObject({
      passed: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "ForbiddenTool" }),
      ]),
    });
    expect(
      scoreControl("repository-governance", [
        {
          tool: "workflow_permissions_audit",
          effect: "read",
          outcome: "success",
        },
        { tool: "branch_protection_status", effect: "read", outcome: "success" },
      ])
    ).toMatchObject({
      passed: false,
      findings: [expect.objectContaining({ code: "ToolOrderViolation" })],
    });
    expect(
      scoreControl("plan-issue-preview", [
        { tool: "create_issue_set", effect: "live-write", outcome: "success" },
      ])
    ).toMatchObject({
      passed: false,
      summary: { criticalViolationCount: 2 },
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "LiveWriteViolation" }),
        expect.objectContaining({ code: "SecurityGateSkipped" }),
      ]),
    });
  });

  it("keeps create_issue_set preview-only and selection accuracy above 90%", () => {
    const scenarios = ScenarioSuiteSchema.parse(scenarioDocument).scenarios;
    const traces = TraceSuiteSchema.parse(traceDocument).traces;
    const scores = scenarios.map((scenario, index) =>
      scoreEvaluationTrace(scenario, traces[index])
    );
    const passingScenarioCount = scores.filter((score) => score.passed).length;
    expect((passingScenarioCount / scores.length) * 100).toBeGreaterThanOrEqual(90);
    expect(
      scores.every(
        (score) =>
          score.summary.requiredToolsSatisfied === score.summary.requiredToolsTotal
      )
    ).toBe(true);
    const issueCase = SELECTION_EXECUTION_CASES.find(
      (testCase) => testCase.scenarioId === "plan-issue-preview"
    );
    expect(issueCase?.calls.at(-1)).toMatchObject({
      name: "create_issue_set",
      expectedArguments: { dryRun: true },
      effect: "dry-run",
    });
  });
});
