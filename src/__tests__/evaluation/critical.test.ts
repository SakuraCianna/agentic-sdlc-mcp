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
import {
  createGithubContractFixture,
  type GithubContractFixture,
} from "../fixtures/github-contract-fixtures.js";
import { connectInMemoryMcp, type ConnectedMcpFixture } from "../fixtures/mcp-client.js";
import {
  CRITICAL_EXECUTION_CASES,
  type CriticalExecutionCase,
} from "./fixtures/critical.js";

const github = vi.hoisted(() => ({
  fixture: null as GithubContractFixture | null,
}));

vi.mock("../../github/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../github/client.js")>();
  return {
    ...actual,
    getOctokit: () => {
      if (!github.fixture) throw new Error("Critical fixture is not initialized");
      return github.fixture.octokit;
    },
  };
});

const { createAgenticSdlcServer } = await import("../../server.js");
const scenarioDocument = JSON.parse(
  await readFile(
    new URL("../../../evaluation/scenarios/critical.json", import.meta.url),
    "utf8"
  )
) as unknown;
const traceDocument = JSON.parse(
  await readFile(
    new URL("../../../evaluation/traces/critical.json", import.meta.url),
    "utf8"
  )
) as unknown;

const ScenarioSuiteSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    group: z.literal("critical"),
    scenarios: z.array(EvaluationScenarioSchema).length(6),
  })
  .strict();

const TraceSuiteSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    group: z.literal("critical"),
    traces: z.array(EvaluationTraceSchema).length(6),
  })
  .strict();

function structuredObject(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

describe("T9 deterministic critical evaluation", () => {
  let connection: ConnectedMcpFixture;
  let externalFetch: ReturnType<typeof vi.fn>;
  let socketConnect: ReturnType<typeof vi.spyOn>;
  let socketCreateConnection: ReturnType<typeof vi.spyOn>;
  let socketPrototypeConnect: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    github.fixture = createGithubContractFixture();
    externalFetch = vi.fn(async () => {
      throw new Error("external fetch is forbidden in critical evaluation");
    });
    vi.stubGlobal("fetch", externalFetch);
    socketConnect = vi.spyOn(net, "connect").mockImplementation(() => {
      throw new Error("external socket is forbidden in critical evaluation");
    });
    socketCreateConnection = vi.spyOn(net, "createConnection").mockImplementation(() => {
      throw new Error("external socket is forbidden in critical evaluation");
    });
    socketPrototypeConnect = vi
      .spyOn(net.Socket.prototype, "connect")
      .mockImplementation(() => {
        throw new Error("external socket is forbidden in critical evaluation");
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

  it("keeps six scripted multi-tool scenarios and traces aligned", () => {
    const scenarios = ScenarioSuiteSchema.parse(scenarioDocument);
    const traces = TraceSuiteSchema.parse(traceDocument);
    expect(scenarios.scenarios.map((scenario) => scenario.id)).toEqual(
      traces.traces.map((trace) => trace.scenarioId)
    );
    expect(CRITICAL_EXECUTION_CASES.map((testCase) => testCase.scenarioId)).toEqual(
      scenarios.scenarios.map((scenario) => scenario.id)
    );
    expect(traces.traces.every((trace) => trace.provenance === "scripted")).toBe(true);
    expect(scenarios.scenarios.every((scenario) => scenario.requiredTools.length >= 2)).toBe(
      true
    );
    expect(CRITICAL_EXECUTION_CASES.every((testCase) => testCase.calls.length >= 2)).toBe(
      true
    );
    expect(
      CRITICAL_EXECUTION_CASES.every(
        (testCase) => typeof testCase.calls[1]?.arguments === "function"
      )
    ).toBe(true);
  });

  it.each(CRITICAL_EXECUTION_CASES)(
    "$scenarioId composes structured results through Client.callTool",
    async (testCase: CriticalExecutionCase) => {
      testCase.setup?.(github.fixture as GithubContractFixture);
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
        const result = await connection.client.callTool({
          name: call.name,
          arguments: callArguments,
        });
        expect(result.isError).not.toBe(true);
        const structured = structuredObject(result.structuredContent);
        expect(structured).toMatchObject(call.expectedStructured);
        if (call.name === "security_triage") {
          expect(github.fixture?.codeScanningList).toHaveBeenCalled();
          expect(github.fixture?.dependabotList).toHaveBeenCalled();
          expect(github.fixture?.secretScanningList).toHaveBeenCalled();
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
      expect(scoreEvaluationTrace(scenario, actualTrace)).toMatchObject({
        passed: true,
        score: 100,
        summary: {
          requiredToolsSatisfied: 2,
          requiredToolsTotal: 2,
          criticalViolationCount: 0,
        },
      });
    }
  );

  it("does not execute a protected call when security evidence is degraded", async () => {
    github.fixture?.denySecurityReads();
    const testCase = CRITICAL_EXECUTION_CASES.find(
      (candidate) => candidate.scenarioId === "security-release-gate"
    );
    expect(testCase).toBeDefined();
    const gateCall = testCase?.calls[0];
    const protectedCall = testCase?.calls[1];
    expect(gateCall).toBeDefined();
    expect(typeof protectedCall?.arguments).toBe("function");

    const gateArguments =
      typeof gateCall?.arguments === "function" ? gateCall.arguments([]) : gateCall?.arguments;
    const gateResult = await connection.client.callTool({
      name: gateCall?.name ?? "security_triage",
      arguments: gateArguments,
    });
    const gateStructured = structuredObject(gateResult.structuredContent);
    expect(gateStructured).toMatchObject({
      severityCounts: { critical: 0, high: 0 },
      truncatedSources: [],
    });
    expect(gateStructured.errors).toEqual([
      expect.stringContaining("Code Scanning"),
      expect.stringContaining("Dependabot"),
      expect.stringContaining("Secret Scanning"),
    ]);

    expect(() =>
      (protectedCall?.arguments as (
        previousResults: readonly Record<string, unknown>[]
      ) => Record<string, unknown>)([gateStructured])
    ).toThrow(/unavailable alert evidence/u);
    expect(() =>
      (protectedCall?.arguments as (
        previousResults: readonly Record<string, unknown>[]
      ) => Record<string, unknown>)([
        {
          severityCounts: { critical: 0, high: 0 },
          errors: [],
          truncatedSources: ["dependabot"],
        },
      ])
    ).toThrow(/truncated alert evidence/u);
    expect(github.fixture?.codeScanningList).toHaveBeenCalled();
    expect(github.fixture?.dependabotList).toHaveBeenCalled();
    expect(github.fixture?.secretScanningList).toHaveBeenCalled();
  });

  it("does not compose release evidence from a blocked readiness result", () => {
    const testCase = CRITICAL_EXECUTION_CASES.find(
      (candidate) => candidate.scenarioId === "release-evidence-packet"
    );
    const protectedArguments = testCase?.calls[1]?.arguments;
    expect(typeof protectedArguments).toBe("function");
    expect(() =>
      (protectedArguments as (
        previousResults: readonly Record<string, unknown>[]
      ) => Record<string, unknown>)([
        {
          headRef: "main",
          isReady: false,
          ciStatus: "passing",
          blockingIssues: ["Open release-blocking bugs"],
        },
      ])
    ).toThrow(/passing readiness result/u);
  });

  it("does not compose a safe handoff from unverified Issue metadata", () => {
    const testCase = CRITICAL_EXECUTION_CASES.find(
      (candidate) => candidate.scenarioId === "evidence-agent-handoff"
    );
    const protectedArguments = testCase?.calls[1]?.arguments;
    expect(typeof protectedArguments).toBe("function");
    expect(() =>
      (protectedArguments as (
        previousResults: readonly Record<string, unknown>[]
      ) => Record<string, unknown>)([
        {
          subject: { type: "issue", number: 42 },
          summary: {
            idsByState: {
              verified: [],
              unverified: ["issue:metadata"],
              failed: [],
            },
          },
        },
      ])
    ).toThrow(/verified Issue metadata evidence/u);

    const degradedCase = CRITICAL_EXECUTION_CASES.find(
      (candidate) => candidate.scenarioId === "degraded-evidence-handoff"
    );
    const degradedArguments = degradedCase?.calls[1]?.arguments;
    expect(typeof degradedArguments).toBe("function");
    expect(
      (degradedArguments as (
        previousResults: readonly Record<string, unknown>[]
      ) => Record<string, unknown>)([
        {
          subject: { type: "issue", number: 99 },
          summary: {
            idsByState: {
              verified: [],
              unverified: ["issue:metadata"],
              failed: [],
            },
          },
        },
      ])
    ).toMatchObject({ issueNumber: 99 });
  });

  it("fails reversed order, skipped gates, forbidden tools, and live writes", () => {
    const scenarios = ScenarioSuiteSchema.parse(scenarioDocument).scenarios;
    const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
    const scoreControl = (
      scenarioId: string,
      calls: EvaluationTrace["calls"]
    ) =>
      scoreEvaluationTrace(byId.get(scenarioId), {
        schemaVersion: "1.0",
        scenarioId,
        provenance: "scripted",
        calls,
      });

    expect(
      scoreControl("security-review-gate", [
        { tool: "review_pr_against_standard", effect: "read", outcome: "success" },
        { tool: "security_triage", effect: "read", outcome: "success" },
      ])
    ).toMatchObject({
      passed: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "ToolOrderViolation" }),
        expect.objectContaining({ code: "SecurityGateSkipped" }),
      ]),
    });
    expect(
      scoreControl("security-release-gate", [
        { tool: "release_readiness_check", effect: "read", outcome: "success" },
      ])
    ).toMatchObject({
      passed: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "MissingRequiredTool" }),
        expect.objectContaining({ code: "SecurityGateSkipped" }),
      ]),
    });
    expect(
      scoreControl("quality-release-gate", [
        { tool: "quality_gate_status", effect: "read", outcome: "success" },
        { tool: "review_pr_against_standard", effect: "read", outcome: "success" },
      ])
    ).toMatchObject({
      passed: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "ForbiddenTool" }),
      ]),
    });
    expect(
      scoreControl("evidence-agent-handoff", [
        { tool: "sdlc_evidence_packet", effect: "read", outcome: "success" },
        { tool: "agent_handoff_packet", effect: "live-write", outcome: "success" },
      ])
    ).toMatchObject({
      passed: false,
      findings: expect.arrayContaining([
        expect.objectContaining({ code: "LiveWriteViolation" }),
      ]),
    });
  });
});
