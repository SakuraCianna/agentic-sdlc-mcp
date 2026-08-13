import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  assertCompleteBudgetArtifact,
  assertCompleteFaultArtifact,
  createDeterministicEvaluationEnvironment,
  parseDeterministicEvaluationArgs,
} from "../../../scripts/run-deterministic-evaluation.mjs";

describe("deterministic evaluation runner", () => {
  it("accepts only an explicit registered group", () => {
    expect(parseDeterministicEvaluationArgs(["--group", "selection"])).toBe(
      "selection"
    );
    expect(parseDeterministicEvaluationArgs(["--group", "critical"])).toBe(
      "critical"
    );
    expect(parseDeterministicEvaluationArgs(["--group", "budgets"])).toBe(
      "budgets"
    );
    expect(parseDeterministicEvaluationArgs(["--group", "faults"])).toBe(
      "faults"
    );
    expect(() => parseDeterministicEvaluationArgs([])).toThrow(/Usage/u);
    expect(() =>
      parseDeterministicEvaluationArgs(["--group", "selection", "extra"])
    ).toThrow(/Usage/u);
    expect(() =>
      parseDeterministicEvaluationArgs(["--group", "unknown"])
    ).toThrow(/Unsupported/u);
  });

  it("passes only the minimal environment allowlist to the child", () => {
    const environment = createDeterministicEvaluationEnvironment({
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "<redacted>",
      ACTIONS_RUNTIME_TOKEN: "<redacted>",
      BUSINESS_FLAG: "<redacted>",
      FUTURE_PROVIDER_API_KEY: "<redacted>",
      GH_TOKEN: "<redacted>",
      GITHUB_ID_TOKEN: "<redacted>",
      GITHUB_TOKEN: "<redacted>",
      github_token: "<redacted>",
      MODEL_ACCESS_TOKEN: "<redacted>",
      PATH: "fixture-path",
      PRIVATE_SIGNING_KEY: "<redacted>",
      CI: "true",
      LANG: "en_US.UTF-8",
    });

    expect(environment).toEqual({
      AGENTIC_EVALUATION_OFFLINE: "1",
      CI: "true",
      LANG: "en_US.UTF-8",
      PATH: "fixture-path",
    });
  });

  it("publishes only a complete all-passing 13-scenario budget artifact", () => {
    const complete = {
      complete: true,
      expectedReports: 13,
      completedReports: 13,
      reports: Array.from({ length: 13 }, (_value, index) => ({
        scenarioId: `scenario-${index}`,
        passed: true,
      })),
    };

    expect(() => assertCompleteBudgetArtifact(complete)).not.toThrow();
    expect(() =>
      assertCompleteBudgetArtifact({ ...complete, completedReports: 12 })
    ).toThrow(/incomplete/u);
    expect(() =>
      assertCompleteBudgetArtifact({
        ...complete,
        reports: complete.reports.map((report, index) =>
          index === 0 ? { ...report, passed: false } : report
        ),
      })
    ).toThrow(/failed/u);
    expect(() =>
      assertCompleteBudgetArtifact({
        ...complete,
        reports: complete.reports.map((report) => ({
          ...report,
          scenarioId: "duplicate",
        })),
      })
    ).toThrow(/unique/u);
  });

  it("publishes only a complete all-passing 11-case fault artifact", async () => {
    const faultCases: Array<{
      id: string;
      kind: string;
      endpoint: string;
      status?: number;
      affectedTool: string;
      aggregateTool: string;
      expectedSignal: string;
      preservesSignal: string;
    }> = JSON.parse(
      await readFile(
        new URL("../../../evaluation/fixtures/github-faults.json", import.meta.url),
        "utf8"
      )
    ).cases;
    const complete = {
      complete: true,
      expectedReports: 11,
      completedReports: 11,
      reports: faultCases.map((fault) => ({
        faultId: fault.id,
        kind: fault.kind,
        endpoint: fault.endpoint,
        status: fault.status ?? null,
        affectedTool: fault.affectedTool,
        aggregateTool: fault.aggregateTool,
        expectedSignal: fault.expectedSignal,
        preservesSignal: fault.preservesSignal,
        passed: true,
      })),
    };

    expect(() => assertCompleteFaultArtifact(complete)).not.toThrow();
    expect(() =>
      assertCompleteFaultArtifact({ ...complete, completedReports: 10 })
    ).toThrow(/incomplete/u);
    expect(() =>
      assertCompleteFaultArtifact({
        ...complete,
        reports: complete.reports.map((report) => ({
          ...report,
          faultId: "duplicate",
        })),
      })
    ).toThrow(/versioned fixture/u);
    expect(() =>
      assertCompleteFaultArtifact({
        ...complete,
        reports: complete.reports.map((report: { faultId: string; passed: boolean }, index: number) =>
          index === 0 ? { ...report, faultId: "unknown-fault" } : report
        ),
      })
    ).toThrow(/versioned fixture/u);
    expect(() =>
      assertCompleteFaultArtifact({
        ...complete,
        reports: complete.reports.map((report, index) =>
          index === 0 ? { ...report, status: 500 } : report
        ),
      })
    ).toThrow(/metadata/u);
  });
});
