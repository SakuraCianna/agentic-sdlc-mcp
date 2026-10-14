export class CliUsageError extends Error {}

export interface CliArguments { command: string; values: ReadonlyMap<string, string>; flags: ReadonlySet<string> }
const VALUE_OPTIONS = new Set(["repo", "pr", "standard", "output", "summary", "previous", "current", "packet", "acceptance", "mappings", "source", "subject", "number", "ref", "timeout-ms", "max-requests"]);
const FLAG_OPTIONS = new Set(["json", "online", "enforce", "help", "version"]);
const COMMAND_OPTIONS: Record<string, ReadonlySet<string>> = {
  doctor: new Set(["repo", "online", "json", "timeout-ms", "help"]),
  "assess-pr": new Set(["repo", "pr", "standard", "output", "summary", "previous", "acceptance", "mappings", "source", "timeout-ms", "max-requests", "enforce", "json", "help"]),
  evidence: new Set(["repo", "subject", "number", "ref", "output", "summary", "previous", "acceptance", "mappings", "source", "timeout-ms", "max-requests", "json", "help"]),
  diff: new Set(["previous", "current", "output", "json", "help"]),
  trace: new Set(["packet", "acceptance", "mappings", "source", "output", "json", "help"]),
};

export function parseCliArguments(argv: readonly string[]): CliArguments {
  const args = [...argv];
  const command = args.shift() ?? "help";
  if (command === "--help" || command === "help") return { command: "help", values: new Map(), flags: new Set() };
  if (command === "--version") return { command: "version", values: new Map(), flags: new Set() };
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) throw new CliUsageError("Unknown command. Run agentic-sdlc --help.");
  const values = new Map<string, string>();
  const flags = new Set<string>();
  while (args.length) {
    const argument = args.shift()!;
    if (!argument.startsWith("--")) throw new CliUsageError("Only named options are supported.");
    const name = argument.slice(2);
    if (!allowed.has(name) || values.has(name) || flags.has(name)) throw new CliUsageError("Unknown or duplicate option.");
    if (FLAG_OPTIONS.has(name)) flags.add(name);
    else if (VALUE_OPTIONS.has(name)) {
      const value = args.shift();
      if (!value || value.startsWith("--")) throw new CliUsageError("An option value is missing.");
      values.set(name, value);
    }
  }
  if (values.has("mappings") && !values.has("acceptance")) throw new CliUsageError("--mappings requires --acceptance.");
  return { command, values, flags };
}

export function positiveInteger(value: string | undefined, label: string, fallback?: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!value || !/^[1-9]\d*$/.test(value)) throw new CliUsageError(`${label} must be a positive integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) throw new CliUsageError(`${label} is outside the supported range.`);
  return number;
}

export function parseRepository(value: string | undefined): { owner: string; repo: string } {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/.test(value)) throw new CliUsageError("Provide --repo owner/repo using a GitHub repository name.");
  const [owner, repo] = value.split("/");
  if (repo === "." || repo === "..") throw new CliUsageError("Invalid repository name.");
  return { owner: owner!, repo: repo! };
}
