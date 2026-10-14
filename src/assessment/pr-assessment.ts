import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import { buildEvidencePacket, EvidencePacketSchema, type EvidenceItemInput } from "../evidence/model.js";
import { withAbortableTimeout } from "../evidence/timeout.js";
import { handleQualityGateStatus, QualityGateInputSchema } from "../tools/quality-gate-status.js";
import { handleReviewPr, ReviewPrInputSchema } from "../tools/review-pr.js";
import { protectUntrustedText } from "../security/prompt-injection.js";
import { boundMarkdownDocument, safeMarkdownInline } from "../rendering/markdown.js";
import type { RepoRef } from "../types.js";
import { SERVER_INFO } from "../version.js";
import { createReadOnlyGithubSession } from "./github-session.js";
import { resolveCurrentCheck, withCurrentCheckExcluded, evaluateCurrentCheckDependency, type VerifiedCurrentCheck } from "./current-check.js";

const ImmutableShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i);
export const PrAssessmentSchema = z.object({
  schemaVersion: z.literal("1.0"),
  generatorVersion: z.string(),
  subject: z.object({ repository: z.string(), pullNumber: z.number().int().positive(), headSha: ImmutableShaSchema, baseSha: ImmutableShaSchema }),
  policyDigest: z.string(),
  decision: z.enum(["ready_for_review", "blocked", "needs_evidence"]),
  gateConclusion: z.string(),
  reviewConclusion: z.string(),
  blockers: z.array(z.object({ id: z.string(), source: z.enum(["gate", "review", "snapshot"]), message: z.string().max(600), action: z.string().max(600) })).max(100),
  warnings: z.array(z.string().max(600)).max(100),
  scope: z.array(z.string()),
  excludedCurrentCheckId: z.number().int().positive().optional(),
  selfDependency: z.object({ state: z.enum(["other_requirements_satisfied", "unresolved"]), checkRunId: z.number().int().positive(), reason: z.string() }).optional(),
  packet: EvidencePacketSchema,
  metrics: z.object({ githubRequests: z.number().int().nonnegative(), durationMs: z.number().nonnegative(), degraded: z.boolean(), timedOut: z.boolean(), cancelled: z.boolean() }),
});

export type PrAssessment = z.infer<typeof PrAssessmentSchema>;
export interface AssessPullRequestInput {
  ref: RepoRef;
  pullNumber: number;
  standard?: "basic" | "strict" | "security-focused";
  timeoutMs?: number;
  maxRequests?: number;
  signal?: AbortSignal;
  currentCheck?: { checkRunId: number; runId: number };
}

const safe = (value: string): string => protectUntrustedText(value, { maxLength: 600 }).rendered;

function observePullRequestTargets(client: Octokit, onTarget: (data: { number: number; head?: { sha?: string }; base?: { sha?: string } }) => void): Octokit {
  const pulls = new Proxy(client.pulls, { get(target, key) {
    const method: unknown = Reflect.get(target, key);
    if (key !== "get" || typeof method !== "function") return method;
    return async (...args: unknown[]) => {
      const response = await Reflect.apply(method, target, args) as { data: Parameters<typeof onTarget>[0] };
      onTarget(response.data);
      return response;
    };
  } });
  return new Proxy(client, { get(target, key) { return key === "pulls" ? pulls : Reflect.get(target, key); } });
}

export async function assessPullRequest(input: AssessPullRequestInput, octokit: Octokit): Promise<PrAssessment> {
  const started = performance.now();
  return withAbortableTimeout("PR assessment", input.timeoutMs ?? 30_000, async (signal) => {
    const maxRequests = input.maxRequests ?? 120;
    if (!Number.isInteger(maxRequests) || maxRequests < 2 || maxRequests > 500) throw new Error("PR assessment request budget must be between 2 and 500.");
    const session = createReadOnlyGithubSession(octokit, { signal, maxRequests: maxRequests - 1 });
    const repository = `${input.ref.owner}/${input.ref.repo}`;
    const { data: initial } = await session.client.pulls.get({ ...input.ref, pull_number: input.pullNumber });
    if (initial.number !== input.pullNumber || !ImmutableShaSchema.safeParse(initial.head?.sha).success || !ImmutableShaSchema.safeParse(initial.base?.sha).success) {
      throw new Error("GitHub did not provide an immutable PR target.");
    }
    let client = session.client;
    let excludedCurrentCheckId: number | undefined;
    let currentCheck: VerifiedCurrentCheck | undefined;
    if (input.currentCheck) {
      const verified = await resolveCurrentCheck(input.ref, input.pullNumber, initial.head.sha, client, input.currentCheck);
      currentCheck = verified;
      client = withCurrentCheckExcluded(client, verified);
      excludedCurrentCheckId = verified.id;
    }
    const exclusionClient = client;
    let observedTargetDrift = false;
    client = observePullRequestTargets(client, (data) => {
      if (data.number !== input.pullNumber || data.head?.sha !== initial.head.sha || data.base?.sha !== initial.base.sha) observedTargetDrift = true;
    });
    const [gateResponse, reviewResponse] = await Promise.all([
      handleQualityGateStatus(QualityGateInputSchema.parse({ pullNumber: input.pullNumber }), input.ref, client),
      handleReviewPr(ReviewPrInputSchema.parse({ pullNumber: input.pullNumber, standard: input.standard ?? "basic" }), input.ref, client),
    ]);
    const gate = gateResponse.structured;
    const review = reviewResponse.structured;
    // Reserve one request for an independent target freshness check at the end.
    const finalSession = createReadOnlyGithubSession(octokit, { signal, maxRequests: 1 });
    const { data: final } = await finalSession.client.pulls.get({ ...input.ref, pull_number: input.pullNumber });
    const changed = observedTargetDrift || final.number !== initial.number || final.head?.sha !== initial.head.sha || final.base?.sha !== initial.base.sha || gate.headSha !== initial.head.sha;
    const selfDependency = currentCheck ? evaluateCurrentCheckDependency(exclusionClient, currentCheck, gate) : undefined;
    const gateReadyForReview = gate.conclusion === "passing" || selfDependency?.state === "other_requirements_satisfied";
    const policyMismatch = !gate.policyDigest || gate.policyDigest !== review.policyDigest;
    const assessmentGateBlockers = selfDependency?.state === "other_requirements_satisfied" ? [] : gate.blockers;
    const blockers: PrAssessment["blockers"] = assessmentGateBlockers.slice(0, 60).map((message, index) => ({
      id: `gate:${index + 1}`, source: "gate", message: safe(message),
      action: safe(gate.nextActions[index] ?? gate.nextActions[0] ?? "Inspect the linked PR checks and repository policy, then reassess."),
    }));
    for (const [index, finding] of review.findings.slice(0, 35).entries()) {
      if (finding.severity === "info" || finding.severity === "low") continue;
      blockers.push({ id: `review:${index + 1}`, source: "review", message: safe(finding.description), action: safe(finding.suggestion) });
    }
    if (changed) blockers.push({ id: "snapshot:changed", source: "snapshot", message: "PR head or base changed during collection.", action: "Collect fresh evidence for the new head and base SHAs." });
    if (policyMismatch) blockers.push({ id: "snapshot:policy", source: "snapshot", message: "Gate and review did not establish the same repository policy.", action: "Resolve missing policy permissions or policy changes and reassess." });
    const incomplete = changed || policyMismatch || gate.degraded || gate.policyDegraded || review.policyDegraded || gate.errors.length > 0 || review.errors.length > 0;
    const hasFailure = gate.conclusion === "failing" || gate.conclusion === "needs_review" || review.conclusion === "needs_changes";
    const decision = hasFailure ? "blocked" : incomplete || !gateReadyForReview || review.conclusion !== "pass" ? "needs_evidence" : "ready_for_review";
    const collectedAt = new Date().toISOString();
    const subject = { type: "pull_request" as const, repo: repository, number: input.pullNumber, sha: initial.head.sha };
    const provenance = { provider: "github", subjectSha: initial.head.sha, ref: initial.base.sha, policyDigest: gate.policyDigest ?? review.policyDigest, toolVersion: SERVER_INFO.version, url: `https://github.com/${repository}/pull/${input.pullNumber}` };
    const item = (id: string, kind: string, passed: boolean, failed: boolean, reason: string): EvidenceItemInput => ({
      id, kind, subject, state: failed ? "failed" : passed && !incomplete ? "verified" : "unverified",
      source: "github_api", freshness: changed ? "stale" : "fresh", completeness: incomplete ? "partial" : "complete",
      collectedAt, provenance, reason, limitations: incomplete ? ["One or more sources were incomplete or changed during assessment."] : [],
      recommendedNextActions: passed && !incomplete ? [] : ["Resolve the reported blockers or evidence gaps and reassess."],
    });
    const packet = buildEvidencePacket({ generatorVersion: SERVER_INFO.version, subject, collectedAt, evidence: [
      item("gate:decision", "quality_gate", gate.conclusion === "passing", gate.conclusion === "failing" || gate.conclusion === "needs_review", `Quality gate conclusion: ${gate.conclusion}.`),
      item("review:standard", "standards_review", review.conclusion === "pass", review.conclusion === "needs_changes", `Rule-based review conclusion: ${review.conclusion}.`),
    ], budget: { maxGithubRequests: maxRequests, collectionTimeoutMs: input.timeoutMs ?? 30_000 }, limitations: ["This is a decision snapshot, not proof of business acceptance, deployment health or complete security."] });
    return PrAssessmentSchema.parse({
      schemaVersion: "1.0", generatorVersion: SERVER_INFO.version,
      subject: { repository, pullNumber: input.pullNumber, headSha: initial.head.sha, baseSha: initial.base.sha },
      policyDigest: gate.policyDigest ?? review.policyDigest, decision, gateConclusion: gate.conclusion, reviewConclusion: review.conclusion,
      blockers, warnings: [...gate.warnings, ...gate.errors, ...review.errors, ...(selfDependency?.state === "other_requirements_satisfied" ? [selfDependency.reason] : []), ...(changed ? ["Target changed during collection; no previous verification can be reused."] : [])].slice(0, 100).map(safe),
      scope: ["GitHub merge evidence", "repository policy", "bounded rule-based PR review", "human review preparation"],
      ...(excludedCurrentCheckId ? { excludedCurrentCheckId } : {}), packet,
      ...(selfDependency ? { selfDependency } : {}),
      metrics: { githubRequests: session.usedRequests() + finalSession.usedRequests(), durationMs: Math.round(performance.now() - started), degraded: Boolean(incomplete), timedOut: false, cancelled: false },
    });
  }, input.signal);
}

export function renderPrAssessment(assessment: PrAssessment): string {
  const inline = (value: string) => safeMarkdownInline(value, { maxLength: 600 });
  return boundMarkdownDocument([
    `# PR evidence: ${inline(assessment.subject.repository)} #${assessment.subject.pullNumber}`,
    `Decision: **${assessment.decision}**`,
    `Head: \`${inline(assessment.subject.headSha)}\` · Base: \`${inline(assessment.subject.baseSha)}\``,
    `Policy: \`${inline(assessment.policyDigest)}\` · Server: ${inline(assessment.generatorVersion)}`,
    "", "## Blockers and next actions",
    ...(assessment.blockers.length ? assessment.blockers.map((entry) => `- **${inline(entry.id)}:** ${inline(entry.message)} — ${inline(entry.action)}`) : ["No blocking finding was collected within this assessment's scope."]),
    "", "## Evidence warnings", ...(assessment.warnings.length ? assessment.warnings.map((entry) => `- ${inline(entry)}`) : ["No collection warning."]),
    ...(assessment.selfDependency ? ["", `Current-check dependency: ${inline(assessment.selfDependency.state)} — ${inline(assessment.selfDependency.reason)}`] : []),
    "", "Human review remains required. This assessment does not prove business acceptance or authorize merge, release or deployment.",
    `GitHub requests: ${assessment.metrics.githubRequests}; duration: ${assessment.metrics.durationMs}ms.`,
  ].join("\n\n"), 24_000);
}
