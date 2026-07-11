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

function octokitForWorkflow(revision: string, headSha = "head-sha") {
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
            `permissions:\n  contents: read\njobs:\n  scan:\n    steps:\n      - uses: gitleaks/gitleaks-action@${revision}`
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
});
