export interface PinnedContractSource {
  tag: string;
  expectedCommit: string;
}

export function isPathInside(parent: string, candidate: string): boolean;

export function createContractCollectorEnvironment(
  environment?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv;

export function isWorktreeListed(
  porcelainOutput: string,
  candidate: string
): boolean;

export function validatePinnedContractSource(source: PinnedContractSource): void;

export function verifyPinnedContractTag(options: {
  projectRoot: string;
  tag: string;
  expectedCommit: string;
}): string;

export function collectPinnedMcpContract(options: {
  projectRoot: string;
  tag: string;
  expectedCommit: string;
  timeoutMs?: number;
}): Promise<{
  server: {
    name: string;
    version: string;
  };
  tools: Array<Record<string, unknown>>;
  resources: Array<Record<string, unknown>>;
}>;
