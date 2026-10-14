import { createHash } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import { AbortableTimeoutError, withAbortableTimeout } from "../evidence/timeout.js";
import { githubRequestOptions } from "../github/request-options.js";
import type { RepoRef } from "../types.js";

export interface IssueWritePayload {
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
  phase?: string;
  acceptanceCriteria?: string[];
  riskLevel?: string;
  goal?: string;
}

export interface ConfirmedIssue {
  number: number;
  title: string;
  url: string;
  labels: string[];
}

export interface IssueWriteItem {
  inputIndex: number;
  title: string;
  status: "created" | "reused" | "failed" | "unknown" | "pending";
  issue?: ConfirmedIssue;
  reason?: string;
}

export interface IssueWriteRecovery {
  status: "completed" | "partial" | "cancelled" | "timed_out" | "unknown" | "blocked";
  retrySafe: boolean;
  message: string;
}

export interface IssueWriteOptions {
  signal?: AbortSignal;
  /** Total live-batch deadline, including recovery reads. Defaults to 30 seconds. */
  timeoutMs?: number;
  readOnly?: boolean;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonicalRepo = (ref: RepoRef): string => `${ref.owner}/${ref.repo}`.toLowerCase();

/** Bind the complete ordered payload, repository and optional operation key to a preview. */
export function issueSetPreviewDigest(
  ref: RepoRef,
  issues: IssueWritePayload[],
  idempotencyKey?: string
): string {
  return sha256(JSON.stringify({
    version: 1,
    repository: canonicalRepo(ref),
    key: idempotencyKey === undefined ? null : sha256(idempotencyKey),
    issues: issues.map((issue) => ({
      title: issue.title,
      body: issue.body,
      labels: issue.labels ?? [],
      assignees: issue.assignees ?? [],
      phase: issue.phase ?? null,
      acceptanceCriteria: issue.acceptanceCriteria ?? [],
      riskLevel: issue.riskLevel ?? null,
      goal: issue.goal ?? null,
    })),
  }));
}

interface OperationRecord {
  digest: string;
  active: boolean;
  unsettled: number;
  unknown: Set<number>;
  confirmed: Map<number, ConfirmedIssue>;
}

// This bounded, process-local guard is not a durable lock or an exactly-once guarantee.
const operations = new Map<string, OperationRecord>();
const MAX_OPERATION_RECORDS = 256;
const RECOVERY_PAGES = 3;
const RECOVERY_PAGE_SIZE = 100;
const RECOVERY_LIMITATION = "Recovery checks at most 300 repository issue/PR entries, including closed issues. Markers are correlation data, not authorization. Cross-process races, edited markers, record eviction and server restarts prevent an exactly-once guarantee.";

type RemoteIssue = {
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  labels?: (string | { name?: string })[];
  assignees?: { login: string }[] | null;
  pull_request?: unknown;
};

function confirmed(issue: RemoteIssue): ConfirmedIssue {
  if (!Number.isSafeInteger(issue.number) || issue.number < 1 || typeof issue.title !== "string" || typeof issue.html_url !== "string") {
    throw new Error("GitHub returned incomplete issue confirmation evidence.");
  }
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    labels: (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name ?? "").filter(Boolean),
  };
}

function equalNames(a: string[], b: string[]): boolean {
  const canonical = (names: string[]): string[] => [...new Set(names.map((name) => name.toLowerCase()))].sort();
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function httpStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status : undefined;
}

/** Only an explicit HTTP rejection can establish that a create did not commit. */
function definitiveRejection(error: unknown): boolean {
  const status = httpStatus(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

export function describeIssueCreationFailure(error: unknown): string {
  const status = httpStatus(error);
  switch (status) {
    case 401: return "GitHub authentication failed (401); check that GITHUB_TOKEN is valid.";
    case 403: return "GitHub permission denied (403); check token and repository issue permissions.";
    case 404: return "GitHub repository or issue endpoint was not found (404); verify the target repository.";
    case 422: return "GitHub validation failed (422); check the title, body, labels, and assignees.";
    case 429: return "GitHub rate limit exceeded (429); retry after the limit resets.";
    default: return status ? `GitHub API error (${status}) while creating this issue.` : "GitHub issue creation did not return a confirmed result.";
  }
}

export async function createIssuesRecoverably(
  issues: IssueWritePayload[],
  ref: RepoRef,
  octokit: Octokit,
  digest: string,
  idempotencyKey: string | undefined,
  suppliedDigest: string | undefined,
  options: IssueWriteOptions
): Promise<{ items: IssueWriteItem[]; recovery: IssueWriteRecovery }> {
  const items: IssueWriteItem[] = issues.map((issue, inputIndex) => ({ inputIndex, title: issue.title, status: "pending" }));
  const key = idempotencyKey === undefined ? undefined : sha256(`${canonicalRepo(ref)}\n${idempotencyKey}`);
  let record = key === undefined ? undefined : operations.get(key);
  let ownsRecord = false;
  const mergeHistory = (): void => {
    // A cancelled lookup cannot turn a previous write into an input that was never sent.
    if (!record || record.digest !== digest) return;
    for (const [index, issue] of record.confirmed) {
      if (items[index].status === "pending" || items[index].status === "unknown") {
        items[index] = { ...items[index], issue, status: "unknown", reason: "A previously confirmed issue reference was not verified by this attempt. Inspect GitHub before recreating it." };
      }
    }
    for (const index of record.unknown) {
      if (items[index].status === "pending" || items[index].status === "unknown") {
        items[index] = { ...items[index], status: "unknown", reason: "A prior write has unknown commit status and was not confirmed by recovery lookup. Inspect GitHub before any retry." };
      }
    }
  };
  const result = (status: IssueWriteRecovery["status"], message: string) => {
    mergeHistory();
    return {
      items,
      recovery: {
        status,
        retrySafe: idempotencyKey !== undefined && !items.some((item) => item.status === "unknown") && status !== "blocked" &&
          (!record || (record.digest === digest && record.unknown.size === 0 && record.unsettled === 0 && (!record.active || ownsRecord))),
        message: `${message}${idempotencyKey ? ` ${RECOVERY_LIMITATION}` : " Retry only the failed or pending inputs; do not replay a partially completed batch. Use an idempotencyKey for resumable batches."}`,
      },
    };
  };
  if (options.readOnly === true || process.env.SDLC_READ_ONLY === "true") {
    return result("blocked", "Live issue creation is disabled by SDLC_READ_ONLY=true; preview remains available.");
  }
  if (suppliedDigest !== undefined && suppliedDigest !== digest) {
    return result("blocked", "previewDigest does not match this repository and complete issue payload. Generate and review a fresh preview before writing.");
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError("Issue creation timeoutMs must be a positive finite number.");
  const deadline = Date.now() + Math.floor(timeoutMs);
  const stopStatus = (): "cancelled" | "timed_out" | undefined => options.signal?.aborted ? "cancelled" : Date.now() >= deadline ? "timed_out" : undefined;
  const initialStop = stopStatus();
  if (initialStop) return result(initialStop, "The batch stopped before any write request was started.");

  if (key !== undefined) {
    if (record && record.digest !== digest) return result("blocked", "This idempotencyKey is already bound to a different payload. Use the original payload or a new key and reviewed preview.");
    if (record?.active || record?.unsettled) return result("blocked", "This idempotencyKey has an active or unsettled request. Wait for it to settle and reconcile confirmed issue numbers before retrying.");
    if (!record) {
      if (operations.size >= MAX_OPERATION_RECORDS) {
        const removable = [...operations].find(([, value]) => !value.active && value.unsettled === 0 && value.unknown.size === 0);
        if (!removable) return result("blocked", "The bounded operation guard is full of active or uncertain batches; reconcile them before starting another batch.");
        operations.delete(removable[0]);
      }
      record = { digest, active: false, unsettled: 0, unknown: new Set(), confirmed: new Map() };
      operations.set(key, record);
    }
    record.active = true;
    ownsRecord = true;
  }

  const request = <T>(label: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    withAbortableTimeout(label, Math.max(1, deadline - Date.now()), operation, options.signal);
  const markerFor = (index: number): string => `<!-- agentic-sdlc:create-issue-set:v1 key=${key} digest=${digest} index=${index} -->`;
  const bodyFor = (index: number): string => key ? `${issues[index].body}\n\n${markerFor(index)}` : issues[index].body;

  try {
    if (key !== undefined) {
      let complete = false;
      let invalid = false;
      let readFailed = false;
      const markerPrefix = `<!-- agentic-sdlc:create-issue-set:v1 key=${key} `;
      try {
        for (let page = 1; page <= RECOVERY_PAGES; page++) {
          const { data } = await request("Issue recovery lookup", (signal) => octokit.issues.listForRepo({
            owner: ref.owner, repo: ref.repo, state: "all", sort: "created", direction: "desc",
            page, per_page: RECOVERY_PAGE_SIZE, ...githubRequestOptions(signal),
          }));
          for (const issue of data as RemoteIssue[]) {
            if (issue.pull_request || !issue.body?.includes(markerPrefix)) continue;
            const inputIndex = issues.findIndex((_, index) => issue.body?.endsWith(markerFor(index)));
            if (inputIndex < 0) { invalid = true; continue; }
            const expected = issues[inputIndex];
            const labels = confirmed(issue).labels;
            if (items[inputIndex].status !== "pending" || issue.title !== expected.title || issue.body !== bodyFor(inputIndex) ||
                !equalNames(labels, expected.labels ?? []) ||
                !equalNames((issue.assignees ?? []).map((assignee) => assignee.login), expected.assignees ?? [])) {
              invalid = true;
              continue;
            }
            items[inputIndex] = { inputIndex, title: expected.title, status: "reused", issue: confirmed(issue) };
            record?.unknown.delete(inputIndex);
            record?.confirmed.set(inputIndex, confirmed(issue));
          }
          if (data.length < RECOVERY_PAGE_SIZE) { complete = true; break; }
          if (stopStatus()) break;
        }
      } catch { readFailed = true; }
      mergeHistory();
      const stopped = stopStatus();
      if (stopped) return result(stopped, "Recovery lookup stopped; confirmed matches were preserved and no new issue was created.");
      if (invalid) return result("blocked", "Existing markers conflict with this key, payload, or input index. Confirmed matches were preserved; inspect the marked issues before retrying.");
      if (items.some((item) => item.status === "unknown")) {
        for (const item of items) if (item.status === "unknown") record?.unknown.add(item.inputIndex);
        return result("unknown", "Prior uncertain writes remain unconfirmed. No missing issue was recreated.");
      }
      if (!complete || readFailed) return result(items.every((item) => item.status === "reused") ? "completed" : "blocked", "Recovery evidence is incomplete (lookup failed or reached the 300-issue cap). Confirmed matches were preserved; no missing input was created. Reconcile individual issue numbers in GitHub before retrying.");
    }

    for (const item of items) {
      if (item.status === "reused") continue;
      const stopped = stopStatus();
      if (stopped) return result(stopped, "The batch stopped before starting the next issue; confirmed successes were preserved.");
      const issue = issues[item.inputIndex];
      let started = false;
      try {
        const { data } = await request("Issue creation", (signal) => {
          started = true;
          const upstream = octokit.issues.create({
            owner: ref.owner, repo: ref.repo, title: issue.title, body: bodyFor(item.inputIndex),
            labels: issue.labels, assignees: issue.assignees, ...githubRequestOptions(signal),
          });
          if (record) {
            record.unsettled++;
            void Promise.resolve(upstream).then(() => { record!.unsettled--; }, () => { record!.unsettled--; });
          }
          return upstream;
        });
        item.status = "created";
        item.issue = confirmed(data);
        record?.confirmed.set(item.inputIndex, item.issue);
      } catch (error) {
        const stopped = stopStatus() ?? (error instanceof AbortableTimeoutError ? "timed_out" : undefined);
        if (!started) return result(stopped ?? "cancelled", "The batch stopped before the next write request started.");
        if (definitiveRejection(error)) {
          item.status = "failed";
          item.reason = describeIssueCreationFailure(error);
          continue;
        }
        item.status = "unknown";
        item.reason = "GitHub may have created this issue, but the response was not confirmed. Do not blindly recreate it; reconcile the marked issue or inspect GitHub first.";
        record?.unknown.add(item.inputIndex);
        return result(stopped ?? "unknown", "The in-flight write has unknown commit status. Later inputs remain pending; no write was automatically retried.");
      }
    }
    return result(items.some((item) => item.status === "failed") ? "partial" : "completed", "The batch finished; inspect per-input results before retrying any failed item.");
  } finally {
    if (record) record.active = false;
  }
}
