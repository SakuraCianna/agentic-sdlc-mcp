export function parseDeterministicEvaluationArgs(args: readonly string[]): string;

export function createDeterministicEvaluationEnvironment(
  source?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv & { AGENTIC_EVALUATION_OFFLINE: "1" };

export function assertCompleteBudgetArtifact(value: unknown): void;

export function assertCompleteFaultArtifact(value: unknown): void;
