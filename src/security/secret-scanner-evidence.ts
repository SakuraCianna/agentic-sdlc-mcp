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

export function isSecretScannerPolicyPath(filename: string): boolean {
  const normalized = filename.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  return (
    normalized.startsWith(".github/workflows/") ||
    basename === ".gitleaks.toml" ||
    basename === "gitleaks.toml" ||
    basename === ".gitleaksignore"
  );
}

export function evaluateSecretScannerEvidence(
  ci: CiEvidence,
  options: SecretScannerTrustOptions = {}
): SecretScannerEvidence {
  const trustedAppIds = new Set([GITHUB_ACTIONS_APP_ID, ...(options.trustedAppIds ?? [])]);
  const signals = allSignals(ci).flatMap((signal): SecretScannerSignal[] => {
    const provider = providerForSignal(signal.name);
    const trusted =
      signal.source === "check_run" &&
      signal.appId !== null &&
      trustedAppIds.has(signal.appId) &&
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
        : "No mature secret scanner check (Gitleaks, TruffleHog, Secretlint, detect-secrets, or GitHub Secret Scanning) was found."
    ),
    providers,
    signals,
  };
}

const TRUSTED_SCANNER_ACTIONS: Readonly<Record<SecretScannerProvider, readonly string[]>> = {
  gitleaks: ["gitleaks/gitleaks-action"],
  trufflehog: ["trufflesecurity/trufflehog"],
  secretlint: [],
  "detect-secrets": [],
  "github-secret-scanning": [],
};

export interface SecretScannerProvenanceParams {
  ref: RepoRef;
  headSha: string;
  baseRef: string;
  octokit: Octokit;
}

export interface SecretScannerProvenanceResult {
  ci: CiEvidence;
  errors: string[];
}

function actionsRunId(url: string | null, ref: RepoRef): number | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (
      parts.length < 5 ||
      parts[0]?.toLowerCase() !== ref.owner.toLowerCase() ||
      parts[1]?.toLowerCase() !== ref.repo.toLowerCase() ||
      parts[2] !== "actions" ||
      parts[3] !== "runs" ||
      !/^\d+$/.test(parts[4] ?? "")
    ) {
      return null;
    }
    const runId = Number(parts[4]);
    return Number.isSafeInteger(runId) && runId > 0 ? runId : null;
  } catch {
    return null;
  }
}

function pinnedScannerActionFound(
  workflowContent: string,
  provider: SecretScannerProvider
): boolean {
  let document: unknown;
  try {
    document = parseYaml(workflowContent);
  } catch {
    return false;
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) return false;
  const jobs = (document as Record<string, unknown>)["jobs"];
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) return false;
  const trustedActions = new Set(TRUSTED_SCANNER_ACTIONS[provider]);

  for (const job of Object.values(jobs as Record<string, unknown>)) {
    if (!job || typeof job !== "object" || Array.isArray(job)) continue;
    const steps = (job as Record<string, unknown>)["steps"];
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (!step || typeof step !== "object" || Array.isArray(step)) continue;
      const uses = (step as Record<string, unknown>)["uses"];
      if (typeof uses !== "string") continue;
      const separator = uses.lastIndexOf("@");
      if (separator <= 0) continue;
      const action = uses.slice(0, separator).toLowerCase();
      const revision = uses.slice(separator + 1);
      if (trustedActions.has(action) && /^[0-9a-f]{40}$/i.test(revision)) return true;
    }
  }
  return false;
}

async function verifySignalProvenance(
  signal: GateSignal,
  provider: SecretScannerProvider,
  params: SecretScannerProvenanceParams
): Promise<{ verified: boolean; error: string | null }> {
  if (signal.source !== "check_run" || signal.appId !== GITHUB_ACTIONS_APP_ID) {
    return { verified: false, error: null };
  }
  const runId = actionsRunId(signal.url, params.ref);
  if (runId === null) {
    return {
      verified: false,
      error: `check \`${signal.name}\` does not link to a verifiable GitHub Actions workflow run.`,
    };
  }

  try {
    const { data: run } = await params.octokit.actions.getWorkflowRun({
      owner: params.ref.owner,
      repo: params.ref.repo,
      run_id: runId,
    });
    const workflowPath = typeof run.path === "string" ? run.path.replace(/^\.\//, "") : "";
    if (
      run.head_sha !== params.headSha ||
      !/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(workflowPath)
    ) {
      return {
        verified: false,
        error: `check \`${signal.name}\` is not tied to the reviewed head and a repository workflow path.`,
      };
    }
    const { data } = await params.octokit.repos.getContent({
      owner: params.ref.owner,
      repo: params.ref.repo,
      path: workflowPath,
      ref: params.baseRef,
    });
    if (Array.isArray(data) || data.type !== "file" || !data.content) {
      return {
        verified: false,
        error: `base workflow provenance for check \`${signal.name}\` is unavailable.`,
      };
    }
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    if (!pinnedScannerActionFound(content, provider)) {
      return {
        verified: false,
        error: `base workflow for check \`${signal.name}\` does not use the recognized scanner action pinned to a full commit SHA.`,
      };
    }
    return { verified: true, error: null };
  } catch (error) {
    return {
      verified: false,
      error: `check \`${signal.name}\` provenance: ${handleGitHubError(error)}`,
    };
  }
}

/** Verify check-run provenance without mutating the caller-owned CI evidence. */
export async function verifySecretScannerProvenance(
  ci: CiEvidence,
  params: SecretScannerProvenanceParams
): Promise<SecretScannerProvenanceResult> {
  const verifiedSignals = new Set<GateSignal>();
  const errors: string[] = [];
  for (const signal of allSignals(ci)) {
    const provider = providerForSignal(signal.name);
    if (!provider) continue;
    const result = await verifySignalProvenance(signal, provider, params);
    if (result.verified) verifiedSignals.add(signal);
    if (result.error) errors.push(result.error);
  }
  const mark = (signal: GateSignal): GateSignal => ({
    ...signal,
    provenanceVerified: verifiedSignals.has(signal),
  });
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
    },
    errors,
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
