export const CONFORMANCE_TOOL_VERSION: "0.1.16";
export const CONFORMANCE_PROTOCOL_VERSION: "2025-11-25";
export const CONFORMANCE_SUITE: "active";

export function createConformanceExitError(exitCode: number | null): Error;
export function closeConformanceServerForSuccess(
  server: { serverUrl: string; close(): Promise<void> }
): Promise<void>;

export interface ConformanceExpectedFailure {
  scenario: string;
  reason: string;
  owner: string;
  removeWhen: string;
}

export interface ConformanceBaseline {
  schemaVersion: 1;
  toolVersion: "0.1.16";
  protocolVersion: "2025-11-25";
  suite: "active";
  expectedFailures: ConformanceExpectedFailure[];
}

export interface ConformanceCheck {
  id: string;
  status: "FAILURE" | "INFO" | "SUCCESS" | "WARNING";
  name?: string;
  description?: string;
  errorMessage?: string;
  specReferences?: Array<{ id: string; url: string }>;
  [key: string]: unknown;
}

export interface ConformanceScenarioResult {
  scenario: string;
  checks: readonly ConformanceCheck[];
}

export function validateConformanceBaseline(value: unknown): ConformanceBaseline;
export function renderExpectedFailuresYaml(
  expectedFailures: readonly ConformanceExpectedFailure[]
): string;
export function assertConformanceBaselineMatches(
  expectedFailures: readonly ConformanceExpectedFailure[],
  results: readonly ConformanceScenarioResult[]
): {
  passedScenarios: string[];
  expectedFailureScenarios: string[];
};
export function sanitizeConformanceChecks(
  scenario: string,
  checks: readonly ConformanceCheck[]
): ConformanceScenarioResult;
export function runConformancePilot(projectRoot?: string): Promise<{
  toolVersion: "0.1.16";
  protocolVersion: "2025-11-25";
  suite: "active";
  scenarioCount: number;
  passed: number;
  expectedFailures: number;
  artifact: string;
}>;
