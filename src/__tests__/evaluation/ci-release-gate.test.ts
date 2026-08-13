import { describe, expect, it } from "vitest";

import {
  createEvaluationCiSummary,
  createManifestDiffArtifact,
} from "../../../scripts/lib/release-artifacts.mjs";

const scenarioResults = [
  ...Array.from({ length: 6 }, (_, index) => ({
    scenarioId: `recorded-${index + 1}`,
    group: "selection" as const,
    provenance: "recorded-agent" as const,
    passed: true,
    score: 100,
    summary: { criticalViolationCount: 0 },
    rawArguments: "must-not-be-published",
  })),
  ...Array.from({ length: 6 }, (_, index) => ({
    scenarioId: `scripted-${index + 1}`,
    group: "critical" as const,
    provenance: "scripted" as const,
    passed: true,
    score: 100,
    summary: { criticalViolationCount: 0 },
    rawContent: "must-not-be-published",
  })),
];

const budgetArtifact = {
  complete: true,
  expectedReports: 13,
  completedReports: 13,
  reports: Array.from({ length: 13 }, (_, index) => ({
    scenarioId: `budget-${index + 1}`,
    passed: true,
    measurement: { durationMs: 1 },
  })),
};

const faultArtifact = {
  complete: true,
  expectedReports: 11,
  completedReports: 11,
  reports: Array.from({ length: 11 }, (_, index) => ({
    faultId: `fault-${index + 1}`,
    passed: true,
    upstreamBody: "must-not-be-published",
  })),
};

describe("T12 release artifacts", () => {
  it("summarizes the 12 scenarios by provenance without publishing raw inputs", () => {
    const summary = createEvaluationCiSummary({
      scenarioResults,
      budgetArtifact,
      faultArtifact,
    });

    expect(summary).toMatchObject({
      schemaVersion: "1.0",
      complete: true,
      releaseGate: { passed: true, minimumAccuracyPercent: 90, criticalAccuracyPercent: 100 },
      scenarios: {
        total: 12,
        passed: 12,
        accuracyPercent: 100,
        byProvenance: {
          "recorded-agent": { total: 6, passed: 6, accuracyPercent: 100 },
          scripted: { total: 6, passed: 6, accuracyPercent: 100 },
          "live-model": { total: 0, passed: 0, accuracyPercent: null },
        },
        byGroup: {
          selection: { total: 6, passed: 6, accuracyPercent: 100 },
          critical: { total: 6, passed: 6, accuracyPercent: 100 },
        },
      },
      budgets: { expected: 13, completed: 13, passed: 13 },
      faults: { expected: 11, completed: 11, passed: 11 },
    });
    const rendered = JSON.stringify(summary);
    expect(rendered).not.toContain("must-not-be-published");
    expect(rendered).not.toContain("rawArguments");
    expect(rendered).not.toContain("rawContent");
    expect(rendered).not.toContain("upstreamBody");
  });

  it("rejects an incomplete or safety-critical release gate", () => {
    expect(() =>
      createEvaluationCiSummary({
        scenarioResults: scenarioResults.slice(0, 11),
        budgetArtifact,
        faultArtifact,
      })
    ).toThrow(/12 scenario/u);
    expect(() =>
      createEvaluationCiSummary({
        scenarioResults: scenarioResults.map((result, index) =>
          index === 6
            ? { ...result, passed: false, score: 0, summary: { criticalViolationCount: 1 } }
            : result
        ),
        budgetArtifact,
        faultArtifact,
      })
    ).toThrow(/critical/u);
    expect(() =>
      createEvaluationCiSummary({
        scenarioResults: scenarioResults.map((result, index) =>
          index === 6
            ? { ...result, passed: false, score: 95, summary: { criticalViolationCount: 0 } }
            : result
        ),
        budgetArtifact,
        faultArtifact,
      })
    ).toThrow(/100% critical/u);
    expect(() =>
      createEvaluationCiSummary({
        scenarioResults,
        budgetArtifact: { ...budgetArtifact, completedReports: 12 },
        faultArtifact,
      })
    ).toThrow(/budget/iu);
  });

  it("creates a bounded manifest diff without raw contract payloads", () => {
    const artifact = createManifestDiffArtifact({
      baseline: { tag: "v1.9.0", commit: "a".repeat(40) },
      toolCount: 13,
      resourceCount: 5,
      breaking: [],
      nonBreaking: [
        { code: "ADDITIVE", path: "tools.example", message: "Compatible field added." },
      ],
      rawCurrent: { privateDescription: "must-not-be-published" },
    });

    expect(artifact).toEqual({
      schemaVersion: "1.0",
      compatible: true,
      baseline: { tag: "v1.9.0", commit: "a".repeat(40) },
      current: { tools: 13, resources: 5 },
      breaking: [],
      nonBreaking: [
        { code: "ADDITIVE", path: "tools.example", message: "Compatible field added." },
      ],
    });
    expect(JSON.stringify(artifact)).not.toContain("must-not-be-published");
  });
});
