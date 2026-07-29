export interface ContractTimeoutOptions {
  timeoutMs?: number;
}

export function resolveContractTimeout(timeoutMs?: number): number;

export function withContractTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T>;

export function collectRawMcpContract(
  projectRoot: string,
  options?: ContractTimeoutOptions
): Promise<{
  server: {
    name: string;
    version: string;
  };
  tools: Array<Record<string, unknown>>;
  resources: Array<Record<string, unknown>>;
}>;
