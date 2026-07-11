import type {
  CiEvidence,
  GateSignal,
  GateSignalSource,
  GateSignalState,
} from "../github/pull-request-evidence.js";
import type { Severity } from "../types.js";

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
      trustedAppIds.has(signal.appId);
    return provider
      ? [
          {
            name: signal.name,
            provider,
            source: signal.source,
            appId: signal.appId,
            trusted,
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
        ? "At least one trusted app-backed mature secret scanner reported a failure."
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
        ? "A trusted app-backed mature secret scanner has not completed yet."
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
      reason: "At least one trusted app-backed mature secret scanner completed successfully.",
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
        "Recognized passing scanner claims came from untrusted sources rather than a trusted app-backed check run."
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
