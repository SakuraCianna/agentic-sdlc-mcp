import type { PullRequestEvidence } from "../github/pull-request-evidence.js";
import type { ReleaseReadinessResult } from "../tools/release-readiness.js";
import type { SecurityTriageResult } from "../tools/security-triage.js";
import type {
  EvidenceItem,
  EvidenceItemInput,
  EvidenceSubject,
} from "./model.js";

export function adaptCiEvidence(
  evidence: PullRequestEvidence,
  collectedAt: string,
  provenance: EvidenceItem["provenance"]
): EvidenceItemInput {
  const passingSignals =
    evidence.ci.checkRuns.passing.length + evidence.ci.commitStatuses.passing.length;
  const incomplete =
    evidence.ci.errors.length > 0 || evidence.ci.unverifiedSignals.length > 0;
  const failingNames = [
    ...evidence.ci.checkRuns.failing,
    ...evidence.ci.commitStatuses.failing,
  ].slice(0, 10).map((signal) => signal.name);
  const pendingNames = [
    ...evidence.ci.checkRuns.pending,
    ...evidence.ci.commitStatuses.pending,
  ].slice(0, 10).map((signal) => signal.name);
  const state = evidence.ci.hasFailing
    ? "failed"
    : evidence.ci.hasPending
      ? "pending"
      : passingSignals > 0 && !incomplete
        ? "verified"
        : "unverified";

  return {
    id: "ci:aggregate",
    kind: "ci_status",
    state,
    freshness: "fresh",
    completeness: incomplete ? "partial" : "complete",
    source: "github_api",
    collectedAt,
    provenance: {
      ...provenance,
      url:
        evidence.ci.checkRuns.failing[0]?.url ??
        evidence.ci.commitStatuses.failing[0]?.url ??
        evidence.ci.checkRuns.pending[0]?.url ??
        evidence.ci.commitStatuses.pending[0]?.url ??
        evidence.ci.checkRuns.passing[0]?.url ??
        evidence.ci.commitStatuses.passing[0]?.url ??
        undefined,
    },
    reason: evidence.ci.hasFailing
      ? `Collected CI signal(s) failed: ${failingNames.join(", ") || "unknown check"}.`
      : evidence.ci.hasPending
        ? `Collected CI signal(s) are pending: ${pendingNames.join(", ") || "unknown check"}.`
        : state === "verified"
          ? `${passingSignals} passing CI signal(s) were verified.`
          : evidence.ci.totalSignals > 0
            ? "Collected CI signals were skipped, neutral, or incomplete; no passing result was verified."
            : "No CI signal could be verified.",
    limitations: [...evidence.ci.errors, ...evidence.ci.unverifiedSignals],
    recommendedNextActions:
      state === "verified" ? [] : ["Run quality_gate_status for the current pull request head."],
  };
}

export function adaptReviewEvidence(
  evidence: PullRequestEvidence,
  collectedAt: string,
  provenance: EvidenceItem["provenance"]
): EvidenceItemInput {
  const limitations = evidence.unverifiedSignals.filter((signal) =>
    /review|code.?owner/i.test(signal)
  );
  const incomplete = limitations.length > 0;
  const changesRequested = evidence.reviews.changesRequestedUsers.length > 0;
  const approved = evidence.reviews.reviewDecision === "APPROVED";
  const state = changesRequested
    ? "failed"
    : incomplete
      ? "unverified"
      : approved
        ? "verified"
        : evidence.reviews.requiredApprovals
          ? "pending"
          : "not_applicable";

  return {
    id: "review:aggregate",
    kind: "review_status",
    state,
    freshness: "fresh",
    completeness: incomplete ? "partial" : "complete",
    source: "github_api",
    collectedAt,
    provenance,
    reason: changesRequested
      ? "At least one latest actionable review requests changes."
      : incomplete
        ? "Review requirements or decisions could not be fully verified."
        : approved
          ? "GitHub reports an approved aggregate review decision."
          : "No verified review approval requirement was satisfied.",
    limitations,
    recommendedNextActions:
      approved && !incomplete
        ? []
        : ["Review the pull request and resolve outstanding review requirements."],
  };
}

export function adaptReleaseReadinessEvidence(
  readiness: ReleaseReadinessResult,
  collectedAt: string,
  provenance: EvidenceItem["provenance"],
  subjectSha: string | undefined
): EvidenceItemInput {
  const incomplete =
    !subjectSha ||
    readiness.policyDegraded ||
    readiness.ciStatus === "unknown" ||
    readiness.ciEvidenceIncomplete === true ||
    readiness.bugEvidenceIncomplete === true ||
    readiness.headShaResolved === false;
  return {
    id: "release:readiness",
    kind: "release_readiness",
    state: subjectSha ? (readiness.isReady ? "verified" : "failed") : "unverified",
    freshness: subjectSha ? "fresh" : "unknown",
    completeness: incomplete ? "partial" : "complete",
    source: "github_api",
    collectedAt,
    provenance: {
      ...provenance,
      policyDigest: readiness.policyDigest,
    },
    reason: readiness.isReady
      ? "Release readiness checks passed for the immutable release target."
      : `${readiness.blockingIssues.length} release-blocking issue(s) were reported.`,
    limitations: [
      ...readiness.blockingIssues,
      ...(readiness.policyDegraded
        ? ["Repository policy evidence was degraded."]
        : []),
      ...(readiness.ciStatus === "unknown" || readiness.ciEvidenceIncomplete
        ? ["CI evidence was unavailable or incomplete."]
        : []),
      ...(readiness.bugEvidenceIncomplete
        ? ["Open bug evidence was unavailable or truncated."]
        : []),
      ...(readiness.headShaResolved === false
        ? ["Release readiness did not resolve its input to an immutable SHA."]
        : []),
    ],
    recommendedNextActions: readiness.isReady
      ? []
      : ["Resolve every release-blocking issue and recollect the evidence packet."],
  };
}

export function adaptSecurityTriageEvidence(
  security: SecurityTriageResult,
  collectedAt: string,
  repo: string,
  toolVersion: string
): EvidenceItemInput {
  const blockingCount =
    security.severityCounts.critical + security.severityCounts.high;
  const incomplete =
    security.errors.length > 0 || (security.truncatedSources?.length ?? 0) > 0;
  const limitations = [
    ...security.errors,
    ...(security.truncatedSources ?? []).map(
      (source) => `${source} alert evidence exceeded the collection budget.`
    ),
  ];
  const repositorySubject: EvidenceSubject = {
    type: "repository",
    repo,
  };

  return {
    id: "security:triage",
    kind: "security_triage",
    subject: repositorySubject,
    state:
      blockingCount > 0
        ? "failed"
        : incomplete
          ? "unverified"
          : "verified",
    freshness: "fresh",
    completeness: incomplete ? "partial" : "complete",
    source: "github_api",
    collectedAt,
    provenance: {
      url: `https://github.com/${repo}/security`,
      provider: "github",
      toolVersion,
    },
    reason:
      blockingCount > 0
        ? `${blockingCount} open critical or high security alert(s) were collected.`
        : incomplete
          ? "No critical or high alert was found in the incomplete security evidence."
          : "No open critical or high security alert was collected.",
    limitations,
    recommendedNextActions:
      blockingCount > 0
        ? ["Triage and resolve critical or high alerts before release."]
        : incomplete
          ? ["Resolve security evidence gaps and recollect the repository alert inventory."]
          : [],
  };
}
