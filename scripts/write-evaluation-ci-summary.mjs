import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createEvaluationCiSummary,
  writeJsonArtifactAtomic,
} from "./lib/release-artifacts.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), "utf8"));
}

export async function buildEvaluationCiSummary() {
  const { scoreEvaluationTrace } = await import(
    pathToFileURL(path.join(projectRoot, "dist", "evaluation", "scorer.js")).href
  );
  const scenarioResults = [];
  for (const group of ["selection", "critical"]) {
    const scenarios = await readJson(`evaluation/scenarios/${group}.json`);
    const traces = await readJson(`evaluation/traces/${group}.json`);
    const traceById = new Map(traces.traces.map((trace) => [trace.scenarioId, trace]));
    for (const scenario of scenarios.scenarios) {
      const trace = traceById.get(scenario.id);
      if (!trace) throw new Error(`Missing ${group} trace for ${scenario.id}.`);
      scenarioResults.push({
        ...scoreEvaluationTrace(scenario, trace),
        group,
      });
    }
  }
  return createEvaluationCiSummary({
    scenarioResults,
    budgetArtifact: await readJson("artifacts/evaluation/budgets.json"),
    faultArtifact: await readJson("artifacts/evaluation/faults.json"),
  });
}

async function main() {
  const summary = await buildEvaluationCiSummary();
  await writeJsonArtifactAtomic(
    path.join(projectRoot, "artifacts", "evaluation", "scenario-score.json"),
    summary
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
