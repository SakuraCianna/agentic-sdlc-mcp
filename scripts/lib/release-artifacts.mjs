import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const PROVENANCES = ["scripted", "recorded-agent", "live-model"];

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

function summarizeProvenance(results, provenance) {
  const matching = results.filter((result) => result.provenance === provenance);
  const passed = matching.filter((result) => result.passed === true).length;
  return {
    total: matching.length,
    passed,
    accuracyPercent:
      matching.length === 0 ? null : Number(((passed / matching.length) * 100).toFixed(2)),
  };
}

function assertCompleteReports(artifactInput, expected, label, idKey) {
  const artifact = assertObject(artifactInput, `${label} artifact`);
  if (
    artifact.complete !== true ||
    artifact.expectedReports !== expected ||
    artifact.completedReports !== expected ||
    !Array.isArray(artifact.reports) ||
    artifact.reports.length !== expected ||
    artifact.reports.some((report) => !report || report.passed !== true)
  ) {
    throw new Error(`${label} artifact must contain ${expected} complete passing reports.`);
  }
  const ids = artifact.reports.map((report) => report[idKey]);
  if (
    ids.some((id) => typeof id !== "string" || id.length === 0) ||
    new Set(ids).size !== expected
  ) {
    throw new Error(`${label} artifact report ids must be non-empty and unique.`);
  }
  return { expected, completed: expected, passed: expected };
}

export function createEvaluationCiSummary({
  scenarioResults: scenarioResultsInput,
  budgetArtifact,
  faultArtifact,
}) {
  if (!Array.isArray(scenarioResultsInput) || scenarioResultsInput.length !== 12) {
    throw new Error("Evaluation release gate requires exactly 12 scenario results.");
  }
  const scenarioResults = scenarioResultsInput.map((resultInput) => {
    const result = assertObject(resultInput, "Scenario result");
    if (
      typeof result.scenarioId !== "string" ||
      !["selection", "critical"].includes(result.group) ||
      !PROVENANCES.includes(result.provenance) ||
      typeof result.passed !== "boolean" ||
      typeof result.score !== "number" ||
      !result.summary ||
      !Number.isSafeInteger(result.summary.criticalViolationCount)
    ) {
      throw new Error("Scenario result has an invalid release-gate shape.");
    }
    return result;
  });
  if (new Set(scenarioResults.map((result) => result.scenarioId)).size !== 12) {
    throw new Error("Evaluation release gate requires 12 unique scenario ids.");
  }
  const criticalViolations = scenarioResults.reduce(
    (total, result) => total + result.summary.criticalViolationCount,
    0
  );
  if (criticalViolations !== 0) {
    throw new Error("Evaluation release gate rejects critical scenario violations.");
  }
  const passed = scenarioResults.filter((result) => result.passed).length;
  const accuracyPercent = Number(((passed / scenarioResults.length) * 100).toFixed(2));
  if (accuracyPercent < 90) {
    throw new Error("Evaluation release gate requires at least 90% scenario accuracy.");
  }
  const byProvenance = Object.fromEntries(
    PROVENANCES.map((provenance) => [
      provenance,
      summarizeProvenance(scenarioResults, provenance),
    ])
  );
  const selectionResults = scenarioResults.filter((result) => result.group === "selection");
  const criticalResults = scenarioResults.filter((result) => result.group === "critical");
  if (selectionResults.length !== 6 || criticalResults.length !== 6) {
    throw new Error("Evaluation release gate requires 6 selection and 6 critical scenarios.");
  }
  const criticalPassed = criticalResults.filter((result) => result.passed).length;
  const criticalAccuracyPercent = Number(
    ((criticalPassed / criticalResults.length) * 100).toFixed(2)
  );
  if (criticalAccuracyPercent !== 100) {
    throw new Error("Evaluation release gate requires 100% critical scenario accuracy.");
  }
  if (
    byProvenance["recorded-agent"].total !== 6 ||
    byProvenance.scripted.total !== 6 ||
    byProvenance["live-model"].total !== 0
  ) {
    throw new Error("Evaluation release gate requires 6 recorded-agent and 6 scripted scenarios.");
  }

  return {
    schemaVersion: "1.0",
    complete: true,
    releaseGate: {
      passed: true,
      minimumAccuracyPercent: 90,
      criticalAccuracyPercent,
    },
    scenarios: {
      total: 12,
      passed,
      accuracyPercent,
      byProvenance,
      byGroup: {
        selection: {
          total: selectionResults.length,
          passed: selectionResults.filter((result) => result.passed).length,
          accuracyPercent: Number(
            ((selectionResults.filter((result) => result.passed).length /
              selectionResults.length) *
              100).toFixed(2)
          ),
        },
        critical: {
          total: criticalResults.length,
          passed: criticalPassed,
          accuracyPercent: criticalAccuracyPercent,
        },
      },
    },
    budgets: assertCompleteReports(budgetArtifact, 13, "Budget", "scenarioId"),
    faults: assertCompleteReports(faultArtifact, 11, "Fault", "faultId"),
  };
}

function boundedChange(changeInput) {
  const change = assertObject(changeInput, "Contract change");
  for (const key of ["code", "path", "message"]) {
    if (typeof change[key] !== "string" || change[key].length > 1000) {
      throw new Error(`Contract change ${key} must be a bounded string.`);
    }
  }
  return { code: change.code, path: change.path, message: change.message };
}

export function createManifestDiffArtifact({
  baseline: baselineInput,
  toolCount,
  resourceCount,
  breaking: breakingInput,
  nonBreaking: nonBreakingInput,
}) {
  const baseline = assertObject(baselineInput, "Contract baseline");
  if (
    typeof baseline.tag !== "string" ||
    !/^[0-9a-f]{40}$/u.test(baseline.commit) ||
    !Number.isSafeInteger(toolCount) ||
    !Number.isSafeInteger(resourceCount) ||
    !Array.isArray(breakingInput) ||
    !Array.isArray(nonBreakingInput)
  ) {
    throw new Error("Manifest diff inputs are invalid.");
  }
  const breaking = breakingInput.map(boundedChange);
  const nonBreaking = nonBreakingInput.map(boundedChange);
  return {
    schemaVersion: "1.0",
    compatible: breaking.length === 0,
    baseline: { tag: baseline.tag, commit: baseline.commit },
    current: { tools: toolCount, resources: resourceCount },
    breaking,
    nonBreaking,
  };
}

export async function writeJsonArtifactAtomic(artifactPath, value) {
  const resolved = path.resolve(artifactPath);
  const pending = `${resolved}.pending-${process.pid}`;
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(pending, resolved);
}
