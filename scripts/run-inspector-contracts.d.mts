export const INSPECTOR_VERSION: "2.0.0";
export const INSPECTOR_PLACEHOLDER_TOKEN: string;

export interface InspectorEnvironmentOptions {
  parentEnvironment?: NodeJS.ProcessEnv;
  storageDirectory: string;
  harnessPath: string;
  networkMode?: "deny" | "loopback";
}

export interface InspectorStdioArgumentsOptions {
  projectRoot: string;
  method: string;
  serverEnvironment: NodeJS.ProcessEnv;
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  uri?: string;
}

export interface InspectorHttpArgumentsOptions {
  serverUrl: string;
  method: string;
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  uri?: string;
}

export interface InspectorHttpServerOptions {
  projectRoot: string;
  environment: NodeJS.ProcessEnv;
}

export interface InspectorHttpServerHandle {
  serverUrl: string;
  close(): Promise<void>;
}

export interface InspectorDiscovery {
  tools: Array<Record<string, unknown>>;
  resources: Array<Record<string, unknown>>;
}

export interface InspectorFailureClassificationOptions {
  exitCode: number;
  stderr: string;
  expectedExitCode: number;
  expectedErrorCode: string;
  platform?: NodeJS.Platform;
  label: string;
}

export function createInspectorEnvironment(
  options: InspectorEnvironmentOptions
): NodeJS.ProcessEnv;
export function createInspectorStdioArguments(
  options: InspectorStdioArgumentsOptions
): string[];
export function createInspectorHttpArguments(
  options: InspectorHttpArgumentsOptions
): string[];
export function normalizeInspectorDiscovery(
  toolResult: Record<string, unknown>,
  resourceResult: Record<string, unknown>
): InspectorDiscovery;
export function assertInspectorDiscoveryMatches(
  actual: InspectorDiscovery,
  expected: InspectorDiscovery
): void;
export function parseInspectorJsonOutput(output: string): Record<string, unknown>;
export function assertInspectorOutputIsSafe(
  stdout: string,
  stderr: string,
  inheritedSensitiveValues?: readonly string[]
): void;
export function createInspectorDeadline(
  milliseconds: number,
  message: string
): { promise: Promise<never>; cancel(): void };
export function classifyInspectorFailure(
  options: InspectorFailureClassificationOptions
): {
  code: string;
  exitClass: "expected" | "known_windows_inspector_abort";
  rawExitCode: number;
};
export function startInspectorHttpServer(
  options: InspectorHttpServerOptions
): Promise<InspectorHttpServerHandle>;
export function startInspectorAuthChallengeServer(
  options: InspectorHttpServerOptions
): Promise<InspectorHttpServerHandle>;
export function parseInspectorRunnerArguments(
  argumentsList: readonly string[]
): { transport: "stdio" | "http"; repeat: number };
export function runInspectorStdioContracts(
  projectRoot?: string
): Promise<Record<string, unknown>>;
export function runInspectorHttpContracts(
  projectRoot?: string
): Promise<Record<string, unknown>>;
