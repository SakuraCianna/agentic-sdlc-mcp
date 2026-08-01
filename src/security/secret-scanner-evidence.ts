import type {
  CiEvidence,
  GateSignal,
  GateSignalSource,
  GateSignalState,
} from "../github/pull-request-evidence.js";
import type { Severity } from "../types.js";
import type { RepoRef } from "../types.js";
import type { Octokit } from "@octokit/rest";
import { parse as parseYaml } from "yaml";
import { handleGitHubError } from "../github/client.js";

export type SecretScannerProvider =
  | "gitleaks"
  | "trufflehog"
  | "secretlint"
  | "detect-secrets"
  | "github-secret-scanning";

export type SecretScannerStatus = "passing" | "failing" | "pending" | "unverified";

export interface SecretScannerSignal {
  name: string;
  provider: SecretScannerProvider;
  source: GateSignalSource;
  appId: number | null;
  trusted: boolean;
  provenanceVerified: boolean;
  state: GateSignalState;
  url: string | null;
}

export interface SecretScannerEvidence {
  status: SecretScannerStatus;
  verified: boolean;
  degraded: boolean;
  providers: SecretScannerProvider[];
  signals: SecretScannerSignal[];
  reason: string;
}

/** Internal policy dependencies verified from an immutable base workflow. */
export interface SecretScannerPolicySignal {
  name: string;
  provider: SecretScannerProvider;
  source: GateSignalSource;
  appId: number | null;
  url: string | null;
  workflowPath: string;
  configurationPaths: string[];
}

/** Kept separate from MCP structured output to preserve the public v1 schema. */
export interface SecretScannerPolicyContext {
  signals: SecretScannerPolicySignal[];
}

export interface SecretScannerPolicyFinding {
  severity: Severity;
  category:
    | "MatureSecretScannerFailed"
    | "MatureSecretScannerPending"
    | "MissingMatureSecretScannerEvidence";
  description: string;
  reason: string;
  suggestion: string;
}

export interface SecretScannerTrustOptions {
  /** Additional GitHub App IDs explicitly trusted by repository policy. */
  trustedAppIds?: readonly number[];
  /** True when the PR changes workflows or Gitleaks configuration. */
  policyFilesChanged?: boolean;
  /** Additional bounded-source gaps that make scanner evidence incomplete. */
  incompleteReasons?: readonly string[];
}

/** Stable GitHub App ID observed for app-backed GitHub Actions check runs. */
export const GITHUB_ACTIONS_APP_ID = 15368;
const PROVENANCE_SUPPORTED_PROVIDERS = new Set<SecretScannerProvider>([
  "gitleaks",
  "trufflehog",
]);
const MAX_SCANNER_PROVENANCE_CANDIDATES = 20;

const PROVIDER_PATTERNS: ReadonlyArray<{
  provider: SecretScannerProvider;
  pattern: RegExp;
}> = [
  { provider: "gitleaks", pattern: /(?:^|[^a-z])gitleaks(?:[^a-z]|$)/i },
  { provider: "trufflehog", pattern: /(?:^|[^a-z])truffle[ _-]?hog(?:[^a-z]|$)/i },
  { provider: "secretlint", pattern: /(?:^|[^a-z])secretlint(?:[^a-z]|$)/i },
  { provider: "detect-secrets", pattern: /(?:^|[^a-z])detect[ _-]?secrets(?:[^a-z]|$)/i },
  {
    provider: "github-secret-scanning",
    pattern: /(?:^|[^a-z])(?:github[ _-]?)?secret[ _-]?scanning(?:[^a-z]|$)/i,
  },
];

function providerForSignal(name: string): SecretScannerProvider | null {
  return PROVIDER_PATTERNS.find(({ pattern }) => pattern.test(name))?.provider ?? null;
}

function allSignals(ci: CiEvidence): GateSignal[] {
  return [
    ...ci.checkRuns.failing,
    ...ci.commitStatuses.failing,
    ...ci.checkRuns.pending,
    ...ci.commitStatuses.pending,
    ...ci.checkRuns.passing,
    ...ci.commitStatuses.passing,
    ...ci.checkRuns.skipped,
    ...ci.commitStatuses.skipped,
  ];
}

export function unverifiedSecretScannerEvidence(reason: string): SecretScannerEvidence {
  return {
    status: "unverified",
    verified: false,
    degraded: true,
    providers: [],
    signals: [],
    reason,
  };
}

function canonicalRepositoryPath(filename: string): string {
  return filename.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

function normalizedRepositoryPath(filename: string): string {
  return canonicalRepositoryPath(filename).toLowerCase();
}

function isWorkflowDefinitionPath(filename: string): boolean {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(normalizedRepositoryPath(filename));
}

function staticRepositoryPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(trimmed) ||
    trimmed.includes("${{") ||
    /^[a-z][a-z\d+.-]*:/i.test(trimmed) ||
    /^[\\/]/.test(trimmed) ||
    /^[a-z]:[\\/]/i.test(trimmed)
  ) {
    return null;
  }
  const canonical = canonicalRepositoryPath(trimmed);
  const segments = canonical.split("/");
  if (
    canonical.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    return null;
  }
  return canonical;
}

function staticShellRepositoryPath(value: unknown): string | null {
  const path = staticRepositoryPath(value);
  if (
    path === null ||
    path.startsWith("~") ||
    path.startsWith("-") ||
    ["$", "`", "*", "?", "[", "]", "{", "}", ";", "&", "|", "<", ">", "(", ")"].some(
      (character) => path.includes(character)
    )
  ) {
    return null;
  }
  return path;
}

function staticConfigurationPath(
  provider: SecretScannerProvider,
  value: unknown
): string | null {
  return provider === "trufflehog"
    ? staticShellRepositoryPath(value)
    : staticRepositoryPath(value);
}

function samePolicySignal(
  signal: SecretScannerSignal,
  candidate: SecretScannerPolicySignal
): boolean {
  return (
    signal.name.trim().toLowerCase() === candidate.name.trim().toLowerCase() &&
    signal.provider === candidate.provider &&
    signal.source === candidate.source &&
    signal.appId === candidate.appId &&
    signal.url === candidate.url
  );
}

function validPolicySignal(
  signal: SecretScannerSignal,
  context: SecretScannerPolicyContext | undefined
): SecretScannerPolicySignal | null {
  const matches = context?.signals.filter((candidate) =>
    samePolicySignal(signal, candidate)
  ) ?? [];
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  const workflowPath = staticRepositoryPath(match.workflowPath);
  if (
    workflowPath === null ||
    !isWorkflowDefinitionPath(workflowPath) ||
    match.configurationPaths.some(
      (path) => staticConfigurationPath(signal.provider, path) === null
    )
  ) {
    return null;
  }
  return {
    ...match,
    workflowPath,
    configurationPaths: [
      ...new Set(
        match.configurationPaths.map(
          (path) => staticConfigurationPath(signal.provider, path)!
        )
      ),
    ],
  };
}

/**
 * Invalidate only passing scanner signals whose verified workflow or configuration changed.
 * Missing or malformed internal context cannot justify carrying a passing claim across a PR.
 */
export function applySecretScannerPolicyChanges(
  files: readonly { filename: string; previousFilename?: string }[],
  evidence: SecretScannerEvidence,
  context?: SecretScannerPolicyContext
): SecretScannerEvidence {
  if (evidence.status !== "passing" || files.length === 0) return evidence;
  const trustedPassingSignals = evidence.signals.filter(
    (signal) =>
      signal.state === "passing" &&
      signal.trusted &&
      signal.provenanceVerified
  );
  if (trustedPassingSignals.length === 0) return evidence;
  const changedPaths = new Set(
    files.flatMap((file) => [
      normalizedRepositoryPath(file.filename),
      ...(file.previousFilename === undefined
        ? []
        : [normalizedRepositoryPath(file.previousFilename)]),
    ])
  );
  const invalidatedSignals = new Set<SecretScannerSignal>();
  for (const signal of trustedPassingSignals) {
    const policySignal = validPolicySignal(signal, context);
    const affected =
      policySignal === null ||
      changedPaths.has(normalizedRepositoryPath(policySignal.workflowPath)) ||
      policySignal.configurationPaths.some((path) =>
        changedPaths.has(normalizedRepositoryPath(path))
      );
    if (affected) invalidatedSignals.add(signal);
  }
  if (invalidatedSignals.size === 0) return evidence;

  const signals = evidence.signals.map((signal) =>
    invalidatedSignals.has(signal)
      ? {
          ...signal,
          trusted: false,
          provenanceVerified: false,
        }
      : signal
  );
  const trustedPassingRemain = signals.some(
    (signal) =>
      signal.state === "passing" &&
      signal.trusted &&
      signal.provenanceVerified
  );
  if (trustedPassingRemain) {
    return {
      ...evidence,
      signals,
      reason:
        "At least one independent mature secret scanner remains trusted; scanner signals whose verified workflow or configuration changed were invalidated.",
    };
  }
  return {
    ...unverifiedSecretScannerEvidence(
      "The PR changes or cannot safely bind the workflow/configuration policy for every trusted passing secret scanner."
    ),
    providers: evidence.providers,
    signals,
  };
}

export function evaluateSecretScannerEvidence(
  ci: CiEvidence,
  options: SecretScannerTrustOptions = {}
): SecretScannerEvidence {
  const trustedAppIds = new Set([GITHUB_ACTIONS_APP_ID, ...(options.trustedAppIds ?? [])]);
  const signals = allSignals(ci).flatMap((signal): SecretScannerSignal[] => {
    const provider = providerForSignal(signal.name);
    const trusted =
      provider !== null &&
      signal.source === "check_run" &&
      signal.appId !== null &&
      trustedAppIds.has(signal.appId) &&
      PROVENANCE_SUPPORTED_PROVIDERS.has(provider) &&
      signal.provenanceVerified === true;
    return provider
      ? [
          {
            name: signal.name,
            provider,
            source: signal.source,
            appId: signal.appId,
            trusted,
            provenanceVerified: signal.provenanceVerified === true,
            state: signal.state,
            url: signal.url,
          },
        ]
      : [];
  });
  const providers = [...new Set(signals.map((signal) => signal.provider))];
  const incompleteSources = [
    ...new Set([...ci.unverifiedSignals, ...(options.incompleteReasons ?? [])]),
  ];
  const incomplete = incompleteSources.length > 0 || ci.errors.length > 0;
  const policyFilesChanged = options.policyFilesChanged === true;

  if (signals.some((signal) => signal.state === "failing")) {
    const trustedFailure = signals.some(
      (signal) => signal.state === "failing" && signal.trusted
    );
    return {
      status: "failing",
      verified: trustedFailure,
      degraded: incomplete || policyFilesChanged || !trustedFailure,
      providers,
      signals,
      reason: trustedFailure
        ? "At least one provenance-verified mature secret scanner reported a failure."
        : "An untrusted scanner claim reported a failure; treat it as blocking until independently verified.",
    };
  }
  if (signals.some((signal) => signal.state === "pending")) {
    const trustedPending = signals.some(
      (signal) => signal.state === "pending" && signal.trusted
    );
    return {
      status: "pending",
      verified: trustedPending,
      degraded: incomplete || policyFilesChanged || !trustedPending,
      providers,
      signals,
      reason: trustedPending
        ? "A provenance-verified mature secret scanner has not completed yet."
        : "An untrusted scanner claim is pending; it cannot establish clean-scan evidence.",
    };
  }
  const trustedPassing = signals.some(
    (signal) => signal.state === "passing" && signal.trusted
  );
  if (trustedPassing && !incomplete && !policyFilesChanged) {
    return {
      status: "passing",
      verified: true,
      degraded: false,
      providers,
      signals,
      reason: "At least one provenance-verified mature secret scanner completed successfully.",
    };
  }

  if (policyFilesChanged) {
    return {
      ...unverifiedSecretScannerEvidence(
        "The PR changes secret-scanner workflow or configuration policy, so its own passing check cannot establish trusted clean-scan evidence."
      ),
      providers,
      signals,
    };
  }
  if (incomplete) {
    return {
      ...unverifiedSecretScannerEvidence(
        `CI evidence is incomplete for source(s): ${incompleteSources.join(", ") || "unknown"}.`
      ),
      providers,
      signals,
    };
  }
  if (signals.some((signal) => signal.state === "passing")) {
    return {
      ...unverifiedSecretScannerEvidence(
        "Recognized passing scanner claims lack verified workflow provenance or came from an untrusted source."
      ),
      providers,
      signals,
    };
  }

  const skipped = signals.some((signal) => signal.state === "skipped");
  return {
    ...unverifiedSecretScannerEvidence(
      skipped
        ? "Recognized secret scanner checks were skipped, so they provide no clean-scan evidence."
        : "No recognized secret scanner claim was found; trusted passing currently requires provenance-supported Gitleaks or TruffleHog evidence."
    ),
    providers,
    signals,
  };
}

const TRUSTED_SCANNER_ACTIONS: Readonly<
  Partial<Record<SecretScannerProvider, readonly string[]>>
> = {
  gitleaks: ["gitleaks/gitleaks-action"],
  trufflehog: ["trufflesecurity/trufflehog"],
};
const GITLEAKS_DEFAULT_CONFIGURATION_PATHS = [
  ".gitleaks.toml",
  "gitleaks.toml",
  ".gitleaksignore",
] as const;

export interface SecretScannerProvenanceParams {
  ref: RepoRef;
  headSha: string;
  baseRef: string;
  octokit: Octokit;
}

export interface SecretScannerProvenanceResult {
  ci: CiEvidence;
  errors: string[];
  policyContext: SecretScannerPolicyContext;
}

type WorkflowRunData = Awaited<ReturnType<Octokit["actions"]["getWorkflowRun"]>>["data"];
type WorkflowJobData = Awaited<
  ReturnType<Octokit["actions"]["getJobForWorkflowRun"]>
>["data"];

interface SecretScannerProvenanceCache {
  runs: Map<number, Promise<WorkflowRunData>>;
  jobs: Map<number, Promise<WorkflowJobData>>;
  workflows: Map<string, Promise<string>>;
}

function actionsRunCoordinates(
  url: string | null,
  ref: RepoRef
): { runId: number; jobId: number } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (
      parts.length < 7 ||
      parts[0]?.toLowerCase() !== ref.owner.toLowerCase() ||
      parts[1]?.toLowerCase() !== ref.repo.toLowerCase() ||
      parts[2] !== "actions" ||
      parts[3] !== "runs" ||
      !/^\d+$/.test(parts[4] ?? "") ||
      parts[5] !== "job" ||
      !/^\d+$/.test(parts[6] ?? "")
    ) {
      return null;
    }
    const runId = Number(parts[4]);
    const jobId = Number(parts[6]);
    return Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(jobId) && jobId > 0
      ? { runId, jobId }
      : null;
  } catch {
    return null;
  }
}

type ScannerActionInspection =
  | { kind: "verified"; configurationPaths: string[] }
  | { kind: "invalid_configuration"; reason: string }
  | { kind: "not_verified" };

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inheritedEnvironmentValue(
  scopes: readonly Record<string, unknown>[],
  name: string
): { present: boolean; value: unknown } {
  for (const scope of [...scopes].reverse()) {
    const environment = objectRecord(scope["env"]);
    if (environment && Object.prototype.hasOwnProperty.call(environment, name)) {
      return { present: true, value: environment[name] };
    }
  }
  return { present: false, value: undefined };
}

function staticArguments(value: unknown): string[] | null {
  if (
    typeof value !== "string" ||
    value.includes("${{") ||
    value.includes("$") ||
    value.includes("`") ||
    ["\r", "\n", ";", "&", "|", "<", ">"].some((character) =>
      value.includes(character)
    )
  ) {
    return null;
  }
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (quote !== null || escaped) return null;
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function caseInsensitiveProperty(
  record: Record<string, unknown>,
  name: string
): { present: boolean; value: unknown } | null {
  const matches = Object.entries(record).filter(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  if (matches.length > 1) return null;
  return matches.length === 0
    ? { present: false, value: undefined }
    : { present: true, value: matches[0]![1] };
}

function scannerConfigurationPaths(
  document: Record<string, unknown>,
  job: Record<string, unknown>,
  step: Record<string, unknown>,
  provider: SecretScannerProvider
): { paths: string[]; error: string | null } {
  if (provider === "gitleaks") {
    const inlineConfiguration = inheritedEnvironmentValue(
      [document, job, step],
      "GITLEAKS_CONFIG_TOML"
    );
    if (
      inlineConfiguration.present &&
      (typeof inlineConfiguration.value !== "string" ||
        inlineConfiguration.value.includes("${{") ||
        inlineConfiguration.value.length > 1_000_000)
    ) {
      return {
        paths: [],
        error:
          "Gitleaks inline configuration is not statically bounded by the base workflow.",
      };
    }
    const configured = inheritedEnvironmentValue(
      [document, job, step],
      "GITLEAKS_CONFIG"
    );
    if (!configured.present) {
      return { paths: [...GITLEAKS_DEFAULT_CONFIGURATION_PATHS], error: null };
    }
    const path = staticRepositoryPath(configured.value);
    if (path === null) {
      return {
        paths: [],
        error:
          "Gitleaks configuration path is not a static repository-relative path.",
      };
    }
    return {
      paths: [...new Set([...GITLEAKS_DEFAULT_CONFIGURATION_PATHS, path])],
      error: null,
    };
  }

  if (provider === "trufflehog") {
    const withInputs = objectRecord(step["with"]);
    if (!withInputs) return { paths: [], error: null };
    const extraArgs = caseInsensitiveProperty(withInputs, "extra_args");
    if (extraArgs === null) {
      return {
        paths: [],
        error: "TruffleHog configuration arguments contain ambiguous input keys.",
      };
    }
    if (!extraArgs.present) return { paths: [], error: null };
    const tokens = staticArguments(extraArgs.value);
    if (tokens === null) {
      return {
        paths: [],
        error: "TruffleHog configuration arguments are not statically bounded.",
      };
    }
    const paths: string[] = [];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      let candidate: string | undefined;
      if (token === "--config") {
        candidate = tokens[index + 1];
        index++;
        if (candidate === undefined || candidate.startsWith("-")) {
          return {
            paths: [],
            error:
              "TruffleHog configuration arguments do not provide a static config path.",
          };
        }
      } else if (token.startsWith("--config=")) {
        candidate = token.slice("--config=".length);
      }
      if (candidate === undefined) continue;
      const path = staticShellRepositoryPath(candidate);
      if (path === null) {
        return {
          paths: [],
          error:
            "TruffleHog configuration arguments do not contain a static repository-relative config path.",
        };
      }
      paths.push(path);
    }
    return { paths: [...new Set(paths)], error: null };
  }

  return { paths: [], error: null };
}

function inspectPinnedScannerAction(
  workflowContent: string,
  provider: SecretScannerProvider,
  checkName: string
): ScannerActionInspection {
  let document: unknown;
  try {
    document = parseYaml(workflowContent);
  } catch {
    return { kind: "not_verified" };
  }
  const documentRecord = objectRecord(document);
  if (!documentRecord) return { kind: "not_verified" };
  const jobs = objectRecord(documentRecord["jobs"]);
  if (!jobs) return { kind: "not_verified" };
  const trustedActions = new Set(TRUSTED_SCANNER_ACTIONS[provider] ?? []);
  if (trustedActions.size === 0) return { kind: "not_verified" };
  const normalizedCheckName = checkName.trim().toLowerCase();

  const matchingJobs: Array<Record<string, unknown>> = [];
  for (const [jobId, job] of Object.entries(jobs)) {
    const jobRecord = objectRecord(job);
    if (!jobRecord) continue;
    const configuredName = typeof jobRecord["name"] === "string" ? jobRecord["name"] : jobId;
    if (configuredName.includes("${{")) continue;
    const normalizedJobName = configuredName.trim().toLowerCase();
    const checkMatchesJob =
      normalizedCheckName === normalizedJobName ||
      normalizedCheckName.startsWith(`${normalizedJobName} (`);
    if (checkMatchesJob) matchingJobs.push(jobRecord);
  }
  if (matchingJobs.length !== 1) return { kind: "not_verified" };
  const matchedJob = matchingJobs[0]!;
  if (
    (matchedJob["if"] !== undefined && matchedJob["if"] !== true) ||
    (matchedJob["continue-on-error"] !== undefined &&
      matchedJob["continue-on-error"] !== false)
  ) {
    return { kind: "not_verified" };
  }
  const steps = matchedJob["steps"];
  if (!Array.isArray(steps)) return { kind: "not_verified" };
  const configurationPaths = new Set<string>();
  let pinnedActionFound = false;
  for (const step of steps) {
    const stepRecord = objectRecord(step);
    if (!stepRecord) continue;
    const uses = stepRecord["uses"];
    if (typeof uses !== "string") continue;
    const separator = uses.lastIndexOf("@");
    if (separator <= 0) continue;
    const action = uses.slice(0, separator).toLowerCase();
    const revision = uses.slice(separator + 1);
    const condition = stepRecord["if"];
    const continueOnError = stepRecord["continue-on-error"];
    if (
      trustedActions.has(action) &&
      /^[0-9a-f]{40}$/i.test(revision) &&
      (condition === undefined || condition === true) &&
      (continueOnError === undefined || continueOnError === false)
    ) {
      pinnedActionFound = true;
      const configuration = scannerConfigurationPaths(
        documentRecord,
        matchedJob,
        stepRecord,
        provider
      );
      if (configuration.error !== null) {
        return {
          kind: "invalid_configuration",
          reason: configuration.error,
        };
      }
      for (const path of configuration.paths) configurationPaths.add(path);
    }
  }
  return pinnedActionFound
    ? { kind: "verified", configurationPaths: [...configurationPaths] }
    : { kind: "not_verified" };
}

async function verifySignalProvenance(
  signal: GateSignal,
  provider: SecretScannerProvider,
  params: SecretScannerProvenanceParams,
  cache: SecretScannerProvenanceCache
): Promise<{
  verified: boolean;
  error: string | null;
  workflowPath: string | null;
  configurationPaths: string[];
}> {
  if (signal.source !== "check_run" || signal.appId !== GITHUB_ACTIONS_APP_ID) {
    return {
      verified: false,
      error: null,
      workflowPath: null,
      configurationPaths: [],
    };
  }
  if (!PROVENANCE_SUPPORTED_PROVIDERS.has(provider)) {
    return {
      verified: false,
      error: `check \`${signal.name}\` uses a recognized provider whose workflow provenance is not supported in this version.`,
      workflowPath: null,
      configurationPaths: [],
    };
  }
  const coordinates = actionsRunCoordinates(signal.url, params.ref);
  if (coordinates === null) {
    return {
      verified: false,
      error: `check \`${signal.name}\` does not link to a verifiable GitHub Actions workflow run.`,
      workflowPath: null,
      configurationPaths: [],
    };
  }
  const { runId, jobId } = coordinates;

  try {
    let runPromise = cache.runs.get(runId);
    if (!runPromise) {
      runPromise = params.octokit.actions
        .getWorkflowRun({
          owner: params.ref.owner,
          repo: params.ref.repo,
          run_id: runId,
        })
        .then((response) => response.data);
      cache.runs.set(runId, runPromise);
    }
    const run = await runPromise;
    let jobPromise = cache.jobs.get(jobId);
    if (!jobPromise) {
      jobPromise = params.octokit.actions
        .getJobForWorkflowRun({
          owner: params.ref.owner,
          repo: params.ref.repo,
          job_id: jobId,
        })
        .then((response) => response.data);
      cache.jobs.set(jobId, jobPromise);
    }
    const job = await jobPromise;
    const workflowPath =
      typeof run.path === "string" ? staticRepositoryPath(run.path) ?? "" : "";
    if (
      run.head_sha !== params.headSha ||
      job.run_id !== runId ||
      job.head_sha !== params.headSha ||
      job.name.trim().toLowerCase() !== signal.name.trim().toLowerCase() ||
      !/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(workflowPath)
    ) {
      return {
        verified: false,
        error: `check \`${signal.name}\` is not tied to the reviewed head and a repository workflow path.`,
        workflowPath: null,
        configurationPaths: [],
      };
    }
    const workflowKey = `${params.baseRef}\u0000${workflowPath}`;
    let workflowPromise = cache.workflows.get(workflowKey);
    if (!workflowPromise) {
      workflowPromise = params.octokit.repos
        .getContent({
          owner: params.ref.owner,
          repo: params.ref.repo,
          path: workflowPath,
          ref: params.baseRef,
        })
        .then(({ data }) => {
          if (Array.isArray(data) || data.type !== "file" || !data.content) {
            throw new Error("base workflow content is unavailable");
          }
          return Buffer.from(data.content, "base64").toString("utf-8");
        });
      cache.workflows.set(workflowKey, workflowPromise);
    }
    const content = await workflowPromise;
    const inspection = inspectPinnedScannerAction(content, provider, signal.name);
    if (inspection.kind === "invalid_configuration") {
      return {
        verified: false,
        error: `base workflow job for check \`${signal.name}\`: ${inspection.reason}`,
        workflowPath: null,
        configurationPaths: [],
      };
    }
    if (inspection.kind === "not_verified") {
      return {
        verified: false,
        error: `base workflow job for check \`${signal.name}\` does not unconditionally use the recognized scanner action pinned to a full commit SHA.`,
        workflowPath: null,
        configurationPaths: [],
      };
    }
    return {
      verified: true,
      error: null,
      workflowPath,
      configurationPaths: inspection.configurationPaths,
    };
  } catch (error) {
    return {
      verified: false,
      error: `check \`${signal.name}\` provenance: ${handleGitHubError(error)}`,
      workflowPath: null,
      configurationPaths: [],
    };
  }
}

/** Verify check-run provenance without mutating the caller-owned CI evidence. */
export async function verifySecretScannerProvenance(
  ci: CiEvidence,
  params: SecretScannerProvenanceParams
): Promise<SecretScannerProvenanceResult> {
  const verifiedPolicies = new Map<
    GateSignal,
    {
      provider: SecretScannerProvider;
      workflowPath: string;
      configurationPaths: string[];
    }
  >();
  const errors: string[] = [];
  const candidates = allSignals(ci).flatMap((signal) => {
    const provider = providerForSignal(signal.name);
    return provider ? [{ signal, provider }] : [];
  });
  const cache: SecretScannerProvenanceCache = {
    runs: new Map(),
    jobs: new Map(),
    workflows: new Map(),
  };
  const candidatesToVerify = candidates.slice(0, MAX_SCANNER_PROVENANCE_CANDIDATES);
  if (candidates.length > MAX_SCANNER_PROVENANCE_CANDIDATES) {
    errors.push(
      `secret scanner provenance candidates exceeded the ${MAX_SCANNER_PROVENANCE_CANDIDATES}-signal verification limit.`
    );
  }
  for (const { signal, provider } of candidatesToVerify) {
    const result = await verifySignalProvenance(signal, provider, params, cache);
    if (result.verified && result.workflowPath !== null) {
      verifiedPolicies.set(signal, {
        provider,
        workflowPath: result.workflowPath,
        configurationPaths: result.configurationPaths,
      });
    }
    if (result.error) errors.push(result.error);
  }
  const mark = (signal: GateSignal): GateSignal => {
    const marked = { ...signal } as GateSignal & {
      provenanceWorkflowPath?: unknown;
      provenanceConfigurationPaths?: unknown;
    };
    delete marked.provenanceWorkflowPath;
    delete marked.provenanceConfigurationPaths;
    marked.provenanceVerified = verifiedPolicies.has(signal);
    return marked;
  };
  const mapBuckets = (buckets: CiEvidence["checkRuns"]): CiEvidence["checkRuns"] => ({
    passing: buckets.passing.map(mark),
    failing: buckets.failing.map(mark),
    pending: buckets.pending.map(mark),
    skipped: buckets.skipped.map(mark),
    total: buckets.total,
  });
  return {
    ci: {
      ...ci,
      checkRuns: mapBuckets(ci.checkRuns),
      commitStatuses: mapBuckets(ci.commitStatuses),
      unverifiedSignals:
        errors.length > 0
          ? [...new Set([...ci.unverifiedSignals, "secret_scanner_provenance"])]
          : ci.unverifiedSignals.filter(
              (signal) => signal !== "secret_scanner_provenance"
            ),
    },
    errors,
    policyContext: {
      signals: candidatesToVerify.flatMap(({ signal }) => {
        const policy = verifiedPolicies.get(signal);
        return policy
          ? [
              {
                name: signal.name,
                provider: policy.provider,
                source: signal.source,
                appId: signal.appId,
                url: signal.url,
                workflowPath: policy.workflowPath,
                configurationPaths: [...policy.configurationPaths],
              },
            ]
          : [];
      }),
    },
  };
}

export function secretScannerPolicyFinding(
  evidence: SecretScannerEvidence
): SecretScannerPolicyFinding | null {
  const providerLabel = evidence.providers.length > 0 ? evidence.providers.join(", ") : "none";
  if (evidence.status === "failing") {
    return {
      severity: "critical",
      category: "MatureSecretScannerFailed",
      description: `Mature secret scanner evidence failed (${providerLabel}).`,
      reason: evidence.reason,
      suggestion:
        "Inspect the scanner report, remove the secret, rotate or revoke the credential, and rerun the scanner before merge.",
    };
  }
  if (evidence.status === "pending") {
    return {
      severity: "high",
      category: "MatureSecretScannerPending",
      description: `Mature secret scanner evidence is still pending (${providerLabel}).`,
      reason: evidence.reason,
      suggestion: "Wait for the scanner to complete and review its report before merge.",
    };
  }
  if (
    evidence.status === "unverified" ||
    (evidence.status === "passing" && (!evidence.verified || evidence.degraded))
  ) {
    return {
      severity: "high",
      category: "MissingMatureSecretScannerEvidence",
      description: "No verified mature secret scanner result is available for this PR.",
      reason: evidence.reason,
      suggestion:
        "Run a mature scanner such as Gitleaks or TruffleHog in CI, or enable GitHub Secret Scanning, then rerun the review.",
    };
  }
  return null;
}
