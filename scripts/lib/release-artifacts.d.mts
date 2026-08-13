export interface ScenarioReleaseResult {
  scenarioId: string;
  group: "selection" | "critical";
  provenance: "scripted" | "recorded-agent" | "live-model";
  passed: boolean;
  score: number;
  summary: { criticalViolationCount: number };
  [key: string]: unknown;
}

export function createEvaluationCiSummary(input: {
  scenarioResults: ScenarioReleaseResult[];
  budgetArtifact: unknown;
  faultArtifact: unknown;
}): Record<string, unknown>;

export function createManifestDiffArtifact(input: {
  baseline: { tag: string; commit: string };
  toolCount: number;
  resourceCount: number;
  breaking: unknown[];
  nonBreaking: unknown[];
  [key: string]: unknown;
}): Record<string, unknown>;

export function writeJsonArtifactAtomic(
  artifactPath: string,
  value: unknown
): Promise<void>;
