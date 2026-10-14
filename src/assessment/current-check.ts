import type { Octokit } from "@octokit/rest";

import { GITHUB_ACTIONS_APP_ID } from "../security/secret-scanner-evidence.js";
import type { QualityGateResult } from "../tools/quality-gate-status.js";
import type { RepoRef } from "../types.js";

export interface CurrentCheckIdentity {
  checkRunId: number;
  runId: number;
}

export interface VerifiedCurrentCheck {
  readonly id: number;
  readonly name: string;
  readonly appId: number;
  readonly appSlug: "github-actions";
  readonly runId: number;
  readonly jobId: number;
  readonly headSha: string;
  readonly checkHeadSha: string;
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly status: "queued" | "in_progress";
}

export interface CurrentCheckDependencyResult {
  state: "other_requirements_satisfied" | "unresolved";
  checkRunId: number;
  reason: string;
}

export class CurrentCheckVerificationError extends Error {
  constructor() {
    super("The current Actions check could not be verified and was not excluded from assessment.");
    this.name = "CurrentCheckVerificationError";
  }
}

const verifiedChecks = new WeakSet<VerifiedCurrentCheck>();
interface BranchExclusionReceipt {
  removedClassicRequirement: boolean;
  removedRulesetRequirement: boolean;
  emptiedSelfStatusRule: boolean;
  unexplainedEmptyStatusRule: boolean;
  strictStatusPolicy: boolean;
}
const exclusionReceipts = new WeakMap<Octokit, {
  verified: VerifiedCurrentCheck;
  branches: Map<string, BranchExclusionReceipt>;
  currentCheckNoLongerActive: boolean;
}>();
const active = (status: unknown): status is VerifiedCurrentCheck["status"] =>
  status === "queued" || status === "in_progress";
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

function checkUrlMatches(value: unknown, ref: RepoRef, id: number): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.origin === "https://api.github.com" && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.toLowerCase() === `/repos/${ref.owner}/${ref.repo}/check-runs/${id}`.toLowerCase();
  } catch {
    return false;
  }
}

/** Resolve the official run/job association before permitting a self-check exception. */
export async function resolveCurrentCheck(
  ref: RepoRef,
  pullNumber: number,
  headSha: string,
  client: Octokit,
  identity: CurrentCheckIdentity
): Promise<VerifiedCurrentCheck> {
  const fail = (): never => { throw new CurrentCheckVerificationError(); };
  if (!positiveId(identity.checkRunId) || !positiveId(identity.runId) || !positiveId(pullNumber) || !headSha) fail();
  try {
    const [{ data: check }, { data: run }] = await Promise.all([
      Promise.resolve().then(() => client.checks.get({ owner: ref.owner, repo: ref.repo, check_run_id: identity.checkRunId })),
      Promise.resolve().then(() => client.actions.getWorkflowRun({ owner: ref.owner, repo: ref.repo, run_id: identity.runId })),
    ]);
    const repository = `${ref.owner}/${ref.repo}`.toLowerCase();
    if (
      check.id !== identity.checkRunId || !active(check.status) || check.conclusion !== null ||
      check.app?.id !== GITHUB_ACTIONS_APP_ID || check.app.slug !== "github-actions" ||
      !check.name || !checkUrlMatches(check.url, ref, check.id) || run.id !== identity.runId ||
      run.repository?.full_name?.toLowerCase() !== repository || !positiveId(run.repository.id) ||
      check.head_sha !== run.head_sha ||
      !run.pull_requests?.some((pull) => pull.number === pullNumber && pull.head.sha === headSha &&
        pull.base.repo.id === run.repository.id) ||
      (check.check_suite && run.check_suite_id !== undefined && check.check_suite.id !== run.check_suite_id)
    ) fail();

    for (let page = 1; page <= 10; page += 1) {
      const { data } = await client.actions.listJobsForWorkflowRun({
        owner: ref.owner, repo: ref.repo, run_id: identity.runId, filter: "latest", page, per_page: 100,
      });
      if (!Array.isArray(data.jobs) || data.jobs.length > 100) fail();
      const jobs = data.jobs.filter((job) => checkUrlMatches(job.check_run_url, ref, check.id));
      if (jobs.length > 1) fail();
      if (jobs.length === 1) {
        const job = jobs[0];
        if (
          !positiveId(job.id) || job.run_id !== run.id || job.head_sha !== check.head_sha ||
          job.name !== check.name || !active(job.status) || job.conclusion !== null ||
          (job.run_attempt !== undefined && run.run_attempt !== undefined && job.run_attempt !== run.run_attempt)
        ) fail();
        const status = active(check.status) ? check.status : fail();
        const verified = Object.freeze({
          id: check.id, name: check.name, appId: GITHUB_ACTIONS_APP_ID, appSlug: "github-actions" as const,
          runId: run.id, jobId: job.id, headSha, checkHeadSha: check.head_sha,
          owner: ref.owner, repo: ref.repo, pullNumber, status,
        });
        verifiedChecks.add(verified);
        return verified;
      }
      if (data.jobs.length < 100) break;
    }
  } catch {
    fail();
  }
  return fail();
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null ? value as RecordValue : {};

/** Filter only the verified check and App-bound branch requirements in returned evidence. */
export function withCurrentCheckExcluded(client: Octokit, verified: VerifiedCurrentCheck): Octokit {
  if (!verifiedChecks.has(verified)) throw new CurrentCheckVerificationError();
  const receipt = { verified, branches: new Map<string, BranchExclusionReceipt>(), currentCheckNoLongerActive: false };
  const branchReceipt = (params: RecordValue): BranchExclusionReceipt | undefined => {
    if (typeof params.branch !== "string") return undefined;
    let branch = receipt.branches.get(params.branch);
    if (!branch) {
      branch = { removedClassicRequirement: false, removedRulesetRequirement: false,
        emptiedSelfStatusRule: false, unexplainedEmptyStatusRule: false, strictStatusPolicy: false };
      receipt.branches.set(params.branch, branch);
    }
    return branch;
  };
  const inRepository = (args: unknown[]): boolean => {
    const params = record(args[0]);
    return String(params.owner).toLowerCase() === verified.owner.toLowerCase() &&
      String(params.repo).toLowerCase() === verified.repo.toLowerCase();
  };
  const matchesRequirement = (value: unknown, appKey: string): boolean => {
    const check = record(value);
    return check.context === verified.name && check[appKey] === verified.appId;
  };
  const isCurrentCheck = (value: unknown): boolean => {
    const check = record(value);
    return check.id === verified.id && check.name === verified.name &&
      check.head_sha === verified.checkHeadSha && record(check.app).id === verified.appId &&
      active(check.status) && check.conclusion === null;
  };
  type PageResponse = RecordValue & { data: RecordValue };
  const checkPages = new Map<string, Map<number, Promise<PageResponse>>>();
  const filteredPage = async (method: (...args: unknown[]) => unknown, receiver: object, params: RecordValue): Promise<PageResponse> => {
    const perPage = params.per_page ?? 30;
    const page = params.page ?? 1;
    if (!Number.isSafeInteger(perPage) || Number(perPage) < 1 || Number(perPage) > 100 ||
      !Number.isSafeInteger(page) || Number(page) < 1 || Number(page) > 10) {
      throw new CurrentCheckVerificationError();
    }
    const size = Number(perPage);
    const requestedPage = Number(page);
    const cacheKey = JSON.stringify({ ...params, request: undefined, page: undefined, per_page: size });
    let pages = checkPages.get(cacheKey);
    if (!pages) {
      pages = new Map();
      checkPages.set(cacheKey, pages);
    }
    const collected: unknown[] = [];
    let firstResponse: PageResponse | undefined;
    let excluded = 0;
    // Refill filtered pages so a removed check cannot turn a full page into a
    // false end-of-inventory signal for the shared bounded evidence collector.
    for (let rawPage = 1; rawPage <= 11; rawPage += 1) {
      let responsePromise = pages.get(rawPage);
      if (!responsePromise) {
        responsePromise = Promise.resolve(Reflect.apply(method, receiver, [{ ...params, page: rawPage, per_page: size }])) as Promise<PageResponse>;
        pages.set(rawPage, responsePromise);
      }
      const response = await responsePromise;
      firstResponse ??= response;
      const checks = response.data.check_runs;
      if (!Array.isArray(checks) || checks.length > size) throw new CurrentCheckVerificationError();
      for (const check of checks) {
        const item = record(check);
        if (item.id === verified.id && item.name === verified.name && record(item.app).id === verified.appId &&
          item.head_sha === verified.checkHeadSha && (!active(item.status) || item.conclusion !== null)) {
          receipt.currentCheckNoLongerActive = true;
        }
        if (isCurrentCheck(check)) excluded += 1;
        else collected.push(check);
      }
      if (collected.length >= requestedPage * size || checks.length < size) {
        return {
          ...firstResponse,
          data: {
            ...firstResponse.data,
            ...(typeof firstResponse.data.total_count === "number"
              ? { total_count: Math.max(0, firstResponse.data.total_count - excluded) }
              : {}),
            check_runs: collected.slice((requestedPage - 1) * size, requestedPage * size),
          },
        };
      }
    }
    throw new CurrentCheckVerificationError();
  };
  const wrapGroup = (group: object, groupName: string): object => new Proxy(group, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const params = record(args[0]);
        if (groupName === "checks" && key === "listForRef" && inRepository(args) &&
          (params.ref === verified.headSha || params.ref === verified.checkHeadSha)) {
          return filteredPage(value as (...args: unknown[]) => unknown, target, params);
        }
        const result = await Reflect.apply(value, target, args) as { data: unknown };
        if (!inRepository(args)) return result;
        const data = record(result.data);
        if (groupName === "repos" && key === "getBranchProtection") {
          const required = record(data.required_status_checks);
          if (!Array.isArray(required.checks)) return result;
          const checks = required.checks.filter((check) => !matchesRequirement(check, "app_id"));
          const removed = checks.length !== required.checks.length;
          const branch = branchReceipt(params);
          if (branch && removed) branch.removedClassicRequirement = true;
          if (branch && required.strict === true) branch.strictStatusPolicy = true;
          const hasSameName = checks.some((check) => record(check).context === verified.name);
          const contexts = Array.isArray(required.contexts)
            ? required.contexts.filter((context) => !(removed && !hasSameName && context === verified.name))
            : required.contexts;
          return { ...result, data: { ...data, required_status_checks: { ...required, checks, contexts } } };
        }
        if (groupName === "repos" && key === "getBranchRules" && Array.isArray(result.data)) {
          const branch = branchReceipt(params);
          return { ...result, data: result.data.map((rule) => {
            const item = record(rule);
            const parameters = record(item.parameters);
            if (item.type !== "required_status_checks") return rule;
            if (branch && parameters.strict_required_status_checks_policy === true) branch.strictStatusPolicy = true;
            if (!Array.isArray(parameters.required_status_checks) || parameters.required_status_checks.length === 0) {
              if (branch) branch.unexplainedEmptyStatusRule = true;
              return rule;
            }
            const checks = parameters.required_status_checks.filter((check) => !matchesRequirement(check, "integration_id"));
            if (branch && checks.length !== parameters.required_status_checks.length) {
              branch.removedRulesetRequirement = true;
              if (checks.length === 0) branch.emptiedSelfStatusRule = true;
            }
            return { ...item, parameters: { ...parameters, required_status_checks:
              checks } };
          }) };
        }
        return result;
      };
    },
  });
  const groups = new Map<string, object>();
  const root = (target: object): object => new Proxy(target, {
    get(object, key) {
      const value: unknown = Reflect.get(object, key, object);
      if (key === "rest" && typeof value === "object" && value !== null) return root(value);
      if ((key === "checks" || key === "repos") && typeof value === "object" && value !== null) {
        if (!groups.has(key)) groups.set(key, wrapGroup(value, key));
        return groups.get(key);
      }
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  const wrapped = root(client) as Octokit;
  exclusionReceipts.set(wrapped, receipt);
  return wrapped;
}

/** A conditional human-review assessment; the original GitHub gate remains blocked. */
export function evaluateCurrentCheckDependency(
  client: Octokit,
  verified: VerifiedCurrentCheck,
  gate: QualityGateResult
): CurrentCheckDependencyResult {
  const unresolved = (reason = "The current check cannot be isolated as the only remaining merge dependency; retain the original quality-gate result."): CurrentCheckDependencyResult =>
    ({ state: "unresolved", checkRunId: verified.id, reason });
  const receipt = exclusionReceipts.get(client);
  const pull = gate.evidence.pullRequest;
  const reviews = gate.evidence.reviews;
  const protection = gate.evidence.branchProtection;
  const branch = pull && receipt?.branches.get(pull.baseBranch);
  if (!verifiedChecks.has(verified) || receipt?.verified !== verified || receipt.currentCheckNoLongerActive || !branch ||
    (!branch.removedClassicRequirement && !branch.removedRulesetRequirement) ||
    gate.headSha !== verified.headSha || gate.evidence.scope !== "pull_request" ||
    !pull || !reviews || !protection || pull.draft || pull.mergeable !== true ||
    pull.mergeableState !== "blocked" || gate.conclusion !== "policy_gap" ||
    gate.degraded || gate.policyDegraded || !gate.policyDigest || gate.errors.length > 0 ||
    gate.unverifiedSignals.length > 0 || branch.unexplainedEmptyStatusRule || branch.strictStatusPolicy) return unresolved();
  const requirements = protection.pullRequestRuleRequirements;
  if (requirements.strictRequiredStatusChecksPolicy || requirements.lockBranch ||
    requirements.requiredConversationResolution || requirements.requiredSignatures ||
    requirements.requiredLinearHistory || requirements.requiredReviewThreadResolution ||
    requirements.requiredReviewersConfigured || requirements.allowedMergeMethods !== null ||
    reviews.changesRequestedUsers.length > 0 || reviews.reviewDecision === "CHANGES_REQUESTED" ||
    reviews.reviewDecision === "REVIEW_REQUIRED" ||
    (((reviews.required ?? 0) > 0 || reviews.requireCodeOwnerReviews ||
      requirements.dismissStaleReviews || requirements.requireLastPushApproval) && reviews.reviewDecision !== "APPROVED") ||
    (reviews.requireCodeOwnerReviews && reviews.codeOwnerReviewSatisfied !== true)) return unresolved();

  const checks = gate.evidence.checks;
  if (checks.checkRuns.failing.length > 0 || checks.commitStatuses.failing.length > 0 ||
    checks.checkRuns.pending.length > 0 || checks.commitStatuses.pending.length > 0 ||
    checks.missingRequiredContexts.length > 0) return unresolved();
  if (checks.checkRuns.passing.length + checks.commitStatuses.passing.length === 0) {
    return unresolved("No independent passing CI evidence remains after excluding the current check.");
  }
  const required = checks.requiredChecks.length > 0 ? checks.requiredChecks :
    checks.requiredContexts.map((context) => ({ context, appId: null }));
  const satisfied = [
    ...checks.checkRuns.passing, ...checks.checkRuns.skipped,
    ...checks.commitStatuses.passing, ...checks.commitStatuses.skipped,
  ];
  if (!required.every((check) => satisfied.some((signal) =>
    check.context.toLowerCase() === signal.name.toLowerCase() &&
    (check.appId === null || signal.source === "check_run" && signal.appId === check.appId)))) return unresolved();

  const blockedReason = "GitHub reports that merging is blocked, but the underlying check or review requirement must be resolved from its specific evidence.";
  const allowedReasons = new Set([blockedReason]);
  if (required.length === 0 && branch.removedClassicRequirement && protection.classicEnabled) {
    allowedReasons.add("No verified merge-relevant protection policy was found.");
  }
  if (required.length === 0 && branch.emptiedSelfStatusRule) {
    allowedReasons.add("Unmodeled merge rules cannot be verified: required_status_checks.");
  }
  if (!gate.blockers.includes(blockedReason) || gate.blockers.some((reason) => !allowedReasons.has(reason))) return unresolved();
  return {
    state: "other_requirements_satisfied", checkRunId: verified.id,
    reason: "Only the verified current Actions check remains as a known self-dependency. Independent CI and other modeled requirements are satisfied; GitHub's original merge block remains in force until this check completes.",
  };
}
