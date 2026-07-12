import { describe, expect, it, vi } from "vitest";

import {
  evaluateSecretScannerEvidence,
  verifySecretScannerProvenance,
} from "../../security/secret-scanner-evidence.js";
import type { CiEvidence, GateSignal } from "../../github/pull-request-evidence.js";
import type { RepoRef } from "../../types.js";

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };
const PINNED_SHA = "e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e";

function ci(detailsUrl: string): CiEvidence {
  const signal: GateSignal = {
    name: "gitleaks",
    source: "check_run",
    appId: 15368,
    state: "passing",
    rawStatus: "completed",
    rawConclusion: "success",
    rawState: null,
    url: detailsUrl,
  };
  return {
    checkRuns: {
      passing: [signal],
      failing: [],
      pending: [],
      skipped: [],
      total: 1,
    },
    commitStatuses: {
      passing: [],
      failing: [],
      pending: [],
      skipped: [],
      total: 0,
    },
    totalSignals: 1,
    hasFailing: false,
    hasPending: false,
    unverifiedSignals: [],
    errors: [],
  };
}

function octokitForWorkflow(
  revision: string,
  headSha = "head-sha",
  workflowContent?: string
) {
  return {
    actions: {
      getWorkflowRun: vi.fn().mockResolvedValue({
        data: {
          path: ".github/workflows/secret-scan.yml",
          head_sha: headSha,
        },
      }),
    },
    repos: {
      getContent: vi.fn().mockResolvedValue({
        data: {
          type: "file",
          content: Buffer.from(
            workflowContent ??
              `permissions:\n  contents: read\njobs:\n  gitleaks:\n    steps:\n      - uses: gitleaks/gitleaks-action@${revision}`
          ).toString("base64"),
        },
      }),
    },
  } as unknown as Parameters<typeof verifySecretScannerProvenance>[1]["octokit"];
}

describe("verifySecretScannerProvenance", () => {
  it("verifies a same-head Actions run against the immutable base workflow and pinned action", async () => {
    const octokit = octokitForWorkflow(PINNED_SHA);
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/100/job/1"),
      { ref: REF, headSha: "head-sha", baseRef: "base-sha", octokit }
    );

    expect(result.errors).toEqual([]);
    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(true);
    expect(evaluateSecretScannerEvidence(result.ci)).toMatchObject({
      status: "passing",
      verified: true,
    });
    expect(octokit.actions.getWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ run_id: 100 })
    );
    expect(octokit.repos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ".github/workflows/secret-scan.yml",
        ref: "base-sha",
      })
    );
  });

  it("rejects a mutable action tag even when the check name and App ID match", async () => {
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/101/job/2"),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow("v3"),
      }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(evaluateSecretScannerEvidence(result.ci).status).toBe("unverified");
    expect(result.errors.join(" ")).toMatch(/full commit SHA/i);
  });

  it("rejects an unrelated details URL before reading workflow content", async () => {
    const octokit = octokitForWorkflow(PINNED_SHA);
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/checks/11"),
      { ref: REF, headSha: "head-sha", baseRef: "base-sha", octokit }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(octokit.actions.getWorkflowRun).not.toHaveBeenCalled();
    expect(octokit.repos.getContent).not.toHaveBeenCalled();
  });

  it("rejects a same-name no-op job when another job contains the pinned scanner", async () => {
    const workflow = `jobs:
  gitleaks:
    steps:
      - run: echo never-scans
  hidden-scanner:
    if: false
    steps:
      - uses: gitleaks/gitleaks-action@${PINNED_SHA}`;
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/102/job/3"),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(PINNED_SHA, "head-sha", workflow),
      }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(evaluateSecretScannerEvidence(result.ci).status).toBe("unverified");
  });

  it.each([
    `jobs:
  gitleaks:
    steps:
      - if: false
        uses: gitleaks/gitleaks-action@${PINNED_SHA}`,
    `jobs:
  gitleaks:
    continue-on-error: true
    steps:
      - uses: gitleaks/gitleaks-action@${PINNED_SHA}`,
  ])("rejects conditional or error-tolerant scanner execution", async (workflow) => {
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/105/job/6"),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(PINNED_SHA, "head-sha", workflow),
      }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(evaluateSecretScannerEvidence(result.ci).status).toBe("unverified");
  });

  it("caches repeated run and workflow lookups", async () => {
    const evidence = ci("https://github.com/test-org/test-repo/actions/runs/103/job/4");
    evidence.checkRuns.passing.push({ ...evidence.checkRuns.passing[0]! });
    evidence.checkRuns.total = 2;
    evidence.totalSignals = 2;
    const octokit = octokitForWorkflow(PINNED_SHA);

    const result = await verifySecretScannerProvenance(evidence, {
      ref: REF,
      headSha: "head-sha",
      baseRef: "base-sha",
      octokit,
    });

    expect(result.errors).toEqual([]);
    expect(result.ci.checkRuns.passing.every((signal) => signal.provenanceVerified)).toBe(true);
    expect(octokit.actions.getWorkflowRun).toHaveBeenCalledTimes(1);
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
  });

  it("fails closed when recognized provenance candidates exceed the verification limit", async () => {
    const evidence = ci("https://github.com/test-org/test-repo/actions/runs/104/job/5");
    const original = evidence.checkRuns.passing[0]!;
    evidence.checkRuns.passing = Array.from({ length: 21 }, () => ({ ...original }));
    evidence.checkRuns.total = 21;
    evidence.totalSignals = 21;
    const octokit = octokitForWorkflow(PINNED_SHA);

    const result = await verifySecretScannerProvenance(evidence, {
      ref: REF,
      headSha: "head-sha",
      baseRef: "base-sha",
      octokit,
    });

    expect(result.ci.unverifiedSignals).toContain("secret_scanner_provenance");
    expect(evaluateSecretScannerEvidence(result.ci).status).toBe("unverified");
    expect(octokit.actions.getWorkflowRun).toHaveBeenCalledTimes(1);
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
  });
});
