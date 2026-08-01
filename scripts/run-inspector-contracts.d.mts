export const INSPECTOR_VERSION: "2.0.0";
export const INSPECTOR_PLACEHOLDER_TOKEN: string;

export interface InspectorEnvironmentOptions {
  parentEnvironment?: NodeJS.ProcessEnv;
  storageDirectory: string;
  harnessPath: string;
}

export interface InspectorStdioArgumentsOptions {
  projectRoot: string;
  method: string;
  serverEnvironment: NodeJS.ProcessEnv;
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  uri?: string;
}

export function createInspectorEnvironment(
  options: InspectorEnvironmentOptions
): NodeJS.ProcessEnv;
export function createInspectorStdioArguments(
  options: InspectorStdioArgumentsOptions
): string[];
export function parseInspectorJsonOutput(output: string): Record<string, unknown>;
export function assertInspectorOutputIsSafe(
  stdout: string,
  stderr: string,
  inheritedSensitiveValues?: readonly string[]
): void;
