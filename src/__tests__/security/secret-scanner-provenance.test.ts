import { describe, expect, it, vi } from "vitest";

import {
  evaluateSecretScannerEvidence,
  verifySecretScannerProvenance,
} from "../../security/secret-scanner-evidence.js";
import type { CiEvidence, GateSignal } from "../../github/pull-request-evidence.js";
import type { RepoRef } from "../../types.js";

const REF: RepoRef = { owner: "test-org", repo: "test-repo" };
const PINNED_SHA = "e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e";

function ci(detailsUrl: string, name = "gitleaks"): CiEvidence {
  const signal: GateSignal = {
    name,
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
  workflowContent?: string,
  checkName = "gitleaks",
  workflowPath = ".github/workflows/secret-scan.yml"
) {
  return {
    actions: {
      getWorkflowRun: vi.fn().mockResolvedValue({
        data: {
          path: workflowPath,
          head_sha: headSha,
        },
      }),
      getJobForWorkflowRun: vi.fn().mockImplementation(({ job_id }: { job_id: number }) =>
        Promise.resolve({
          data: {
            name: checkName,
            run_id: job_id + 99,
            head_sha: headSha,
          },
        })
      ),
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
    expect(evaluateSecretScannerEvidence(result.ci).signals[0]).not.toHaveProperty(
      "provenanceWorkflowPath"
    );
    expect(result.policyContext).toEqual({
      signals: [
        {
          name: "gitleaks",
          provider: "gitleaks",
          source: "check_run",
          appId: 15368,
          url: "https://github.com/test-org/test-repo/actions/runs/100/job/1",
          workflowPath: ".github/workflows/secret-scan.yml",
          configurationPaths: [
            ".gitleaks.toml",
            "gitleaks.toml",
            ".gitleaksignore",
          ],
        },
      ],
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

  it("accepts a static workflow path containing spaces and parentheses", async () => {
    const workflowPath = ".github/workflows/secret scan (strict).yml";
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/127/job/28"),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(
          PINNED_SHA,
          "head-sha",
          undefined,
          "gitleaks",
          workflowPath
        ),
      }
    );

    expect(result.errors).toEqual([]);
    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(true);
    expect(result.policyContext.signals[0]?.workflowPath).toBe(workflowPath);
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

  it("rejects a malformed details URL before calling the Actions API", async () => {
    const octokit = octokitForWorkflow(PINNED_SHA);
    const result = await verifySecretScannerProvenance(
      ci("https://[invalid"),
      { ref: REF, headSha: "head-sha", baseRef: "base-sha", octokit }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(result.errors.join(" ")).toMatch(/verifiable GitHub Actions/i);
    expect(octokit.actions.getWorkflowRun).not.toHaveBeenCalled();
    expect(octokit.repos.getContent).not.toHaveBeenCalled();
  });

  it.each([
    null,
    "http://github.com/test-org/test-repo/actions/runs/100/job/1",
    "https://example.test/test-org/test-repo/actions/runs/100/job/1",
    "https://github.com/other-org/test-repo/actions/runs/100/job/1",
    "https://github.com/test-org/test-repo/actions/runs/0/job/1",
    "https://github.com/test-org/test-repo/actions/runs/100/job/not-a-number",
    "https://github.com/test-org/test-repo/actions/runs/9007199254740992/job/1",
  ])("rejects an unbound Actions run URL without API calls: %s", async (detailsUrl) => {
    const evidence = ci(
      detailsUrl ??
        "https://github.com/test-org/test-repo/actions/runs/100/job/1"
    );
    evidence.checkRuns.passing[0]!.url = detailsUrl;
    const octokit = octokitForWorkflow(PINNED_SHA);

    const result = await verifySecretScannerProvenance(evidence, {
      ref: REF,
      headSha: "head-sha",
      baseRef: "base-sha",
      octokit,
    });

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(result.policyContext.signals).toEqual([]);
    expect(octokit.actions.getWorkflowRun).not.toHaveBeenCalled();
  });

  it("does not try Actions provenance for a recognized commit status", async () => {
    const evidence = ci(
      "https://github.com/test-org/test-repo/actions/runs/100/job/1"
    );
    const status = {
      ...evidence.checkRuns.passing[0]!,
      source: "commit_status" as const,
      appId: null,
    };
    evidence.checkRuns.passing = [];
    evidence.checkRuns.total = 0;
    evidence.commitStatuses.passing = [status];
    evidence.commitStatuses.total = 1;
    const octokit = octokitForWorkflow(PINNED_SHA);

    const result = await verifySecretScannerProvenance(evidence, {
      ref: REF,
      headSha: "head-sha",
      baseRef: "base-sha",
      octokit,
    });

    expect(result.ci.commitStatuses.passing[0]?.provenanceVerified).toBe(false);
    expect(result.errors).toEqual([]);
    expect(octokit.actions.getWorkflowRun).not.toHaveBeenCalled();
  });

  it("rejects a recognized provider whose workflow provenance is not supported", async () => {
    const evidence = ci(
      "https://github.com/test-org/test-repo/actions/runs/109/job/10"
    );
    evidence.checkRuns.passing[0]!.name = "secretlint";
    const octokit = octokitForWorkflow(PINNED_SHA);

    const result = await verifySecretScannerProvenance(evidence, {
      ref: REF,
      headSha: "head-sha",
      baseRef: "base-sha",
      octokit,
    });

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(result.errors.join(" ")).toMatch(/not supported/i);
    expect(octokit.actions.getWorkflowRun).not.toHaveBeenCalled();
  });

  it("rejects malformed workflow YAML without trusting a pinned-action substring", async () => {
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/110/job/11"),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(
          PINNED_SHA,
          "head-sha",
          `jobs:\n  [\n# gitleaks/gitleaks-action@${PINNED_SHA}`
        ),
      }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(result.errors.join(" ")).toMatch(/full commit SHA/i);
  });

  it.each([
    ["null document", "null"],
    ["array document", "[]"],
    ["missing jobs", "name: scan"],
    ["array jobs", "jobs: []"],
    ["non-object matching job", "jobs:\n  gitleaks: scan"],
    [
      "dynamic job name",
      `jobs:
  scan:
    name: '\${{ matrix.name }}'
    steps:
      - uses: gitleaks/gitleaks-action@${PINNED_SHA}`,
    ],
    ["non-array steps", "jobs:\n  gitleaks:\n    steps: {}"],
    [
      "invalid step entries",
      `jobs:
  gitleaks:
    steps:
      - null
      - string
      - uses: 42
      - uses: gitleaks/gitleaks-action`,
    ],
  ])("rejects an unprovable workflow shape: %s", async (_name, workflow) => {
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/123/job/24"),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(PINNED_SHA, "head-sha", workflow),
      }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(result.policyContext.signals).toEqual([]);
    expect(result.errors.join(" ")).toMatch(/full commit SHA/i);
  });

  it.each([
    [],
    { type: "file", content: "" },
  ])("fails closed when base workflow content is unavailable: %j", async (data) => {
    const octokit = octokitForWorkflow(PINNED_SHA);
    vi.mocked(octokit.repos.getContent).mockResolvedValueOnce({ data } as never);

    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/111/job/12"),
      { ref: REF, headSha: "head-sha", baseRef: "base-sha", octokit }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(result.ci.unverifiedSignals).toContain("secret_scanner_provenance");
    expect(result.errors.join(" ")).toMatch(/base workflow content is unavailable/i);
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

  it("rejects duplicate display names so a no-op job cannot borrow pinned scanner provenance", async () => {
    const workflow = `jobs:
  actual-scanner:
    name: gitleaks
    if: false
    steps:
      - uses: gitleaks/gitleaks-action@${PINNED_SHA}
  noop:
    name: gitleaks
    steps:
      - run: echo never-scans`;
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/106/job/7"),
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

  it("rejects a details URL whose concrete job does not match the scanner signal", async () => {
    const octokit = octokitForWorkflow(PINNED_SHA);
    vi.mocked(octokit.actions.getJobForWorkflowRun).mockResolvedValueOnce({
      data: { name: "noop", run_id: 107, head_sha: "head-sha" },
    } as never);

    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/107/job/8"),
      { ref: REF, headSha: "head-sha", baseRef: "base-sha", octokit }
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
    expect(octokit.actions.getJobForWorkflowRun).toHaveBeenCalledTimes(1);
    expect(octokit.repos.getContent).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the concrete Actions job cannot be fetched", async () => {
    const octokit = octokitForWorkflow(PINNED_SHA);
    vi.mocked(octokit.actions.getJobForWorkflowRun).mockRejectedValueOnce(
      Object.assign(new Error("job unavailable"), { status: 403 })
    );

    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/108/job/9"),
      { ref: REF, headSha: "head-sha", baseRef: "base-sha", octokit }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(result.ci.unverifiedSignals).toContain("secret_scanner_provenance");
    expect(result.errors).not.toHaveLength(0);
    expect(evaluateSecretScannerEvidence(result.ci).status).toBe("unverified");
  });

  it.each([
    {
      level: "workflow",
      workflow: `env:
  GITLEAKS_CONFIG: security/gitleaks-policy.toml
jobs:
  gitleaks:
    steps:
      - uses: gitleaks/gitleaks-action@${PINNED_SHA}`,
    },
    {
      level: "job",
      workflow: `jobs:
  gitleaks:
    env:
      GITLEAKS_CONFIG: ./security/gitleaks-policy.toml
    steps:
      - uses: gitleaks/gitleaks-action@${PINNED_SHA}`,
    },
    {
      level: "step",
      workflow: `jobs:
  gitleaks:
    steps:
      - uses: gitleaks/gitleaks-action@${PINNED_SHA}
        env:
          GITLEAKS_CONFIG: security/gitleaks-policy.toml`,
    },
  ])("records a static Gitleaks config from $level env", async ({ workflow }) => {
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/112/job/13"),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(PINNED_SHA, "head-sha", workflow),
      }
    );

    expect(result.errors).toEqual([]);
    expect(result.policyContext.signals[0]?.configurationPaths).toEqual(
      expect.arrayContaining([
        ".gitleaks.toml",
        "gitleaks.toml",
        ".gitleaksignore",
        "security/gitleaks-policy.toml",
      ])
    );
  });

  it.each([
    "--config security/trufflehog.yaml --only-verified",
    "--only-verified --config=security/trufflehog.yaml",
  ])("records a static TruffleHog config from extra_args: %s", async (extraArgs) => {
    const workflow = `jobs:
  trufflehog:
    name: TruffleHog
    steps:
      - uses: trufflesecurity/trufflehog@${PINNED_SHA}
        with:
          extra_args: ${extraArgs}`;
    const result = await verifySecretScannerProvenance(
      ci(
        "https://github.com/test-org/test-repo/actions/runs/113/job/14",
        "TruffleHog"
      ),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(
          PINNED_SHA,
          "head-sha",
          workflow,
          "TruffleHog",
          ".github/workflows/trufflehog.yml"
        ),
      }
    );

    expect(result.errors).toEqual([]);
    expect(result.policyContext.signals[0]).toMatchObject({
      provider: "trufflehog",
      workflowPath: ".github/workflows/trufflehog.yml",
      configurationPaths: ["security/trufflehog.yaml"],
    });
  });

  it.each([
    {
      name: "no with block",
      step: `      - uses: trufflesecurity/trufflehog@${PINNED_SHA}`,
    },
    {
      name: "unrelated inputs",
      step: `      - uses: trufflesecurity/trufflehog@${PINNED_SHA}
        with:
          path: ./`,
    },
  ])("accepts TruffleHog without an external config: $name", async ({ step }) => {
    const workflow = `jobs:
  trufflehog:
    name: TruffleHog
    steps:
${step}`;
    const result = await verifySecretScannerProvenance(
      ci(
        "https://github.com/test-org/test-repo/actions/runs/124/job/25",
        "TruffleHog"
      ),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(
          PINNED_SHA,
          "head-sha",
          workflow,
          "TruffleHog"
        ),
      }
    );

    expect(result.errors).toEqual([]);
    expect(result.policyContext.signals[0]?.configurationPaths).toEqual([]);
  });

  it("rejects duplicate case-insensitive TruffleHog extra_args inputs", async () => {
    const workflow = `jobs:
  trufflehog:
    name: TruffleHog
    steps:
      - uses: trufflesecurity/trufflehog@${PINNED_SHA}
        with:
          extra_args: '--config security/one.yaml'
          EXTRA_ARGS: '--config security/two.yaml'`;
    const result = await verifySecretScannerProvenance(
      ci(
        "https://github.com/test-org/test-repo/actions/runs/125/job/26",
        "TruffleHog"
      ),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(
          PINNED_SHA,
          "head-sha",
          workflow,
          "TruffleHog"
        ),
      }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(result.errors.join(" ")).toMatch(/ambiguous/i);
  });

  it.each([
    "${{ inputs.gitleaks_config }}",
    "../outside.toml",
    "/tmp/gitleaks.toml",
    "C:\\rules\\gitleaks.toml",
    "https://example.test/gitleaks.toml",
    "security/\u0001gitleaks.toml",
  ])("rejects a non-static repository-relative Gitleaks config: %s", async (configPath) => {
    const workflow = `jobs:
  gitleaks:
    env:
      GITLEAKS_CONFIG: '${configPath.replaceAll("'", "''")}'
    steps:
      - uses: gitleaks/gitleaks-action@${PINNED_SHA}`;
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/114/job/15"),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(PINNED_SHA, "head-sha", workflow),
      }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(result.policyContext.signals).toEqual([]);
    expect(result.errors.join(" ")).toMatch(/configuration path/i);
  });

  it("accepts a legal static Gitleaks config path containing parentheses", async () => {
    const workflow = `jobs:
  gitleaks:
    env:
      GITLEAKS_CONFIG: security/gitleaks (strict).toml
    steps:
      - uses: gitleaks/gitleaks-action@${PINNED_SHA}`;
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/128/job/29"),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(PINNED_SHA, "head-sha", workflow),
      }
    );

    expect(result.errors).toEqual([]);
    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(true);
    expect(result.policyContext.signals[0]?.configurationPaths).toContain(
      "security/gitleaks (strict).toml"
    );
  });

  it("uses the effective step-level Gitleaks config over dynamic parent env values", async () => {
    const workflow = `env:
  GITLEAKS_CONFIG: '\${{ vars.GITLEAKS_CONFIG }}'
jobs:
  gitleaks:
    env:
      GITLEAKS_CONFIG: '\${{ inputs.gitleaks_config }}'
    steps:
      - uses: gitleaks/gitleaks-action@${PINNED_SHA}
        env:
          GITLEAKS_CONFIG: security/effective-policy.toml`;
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/118/job/19"),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(PINNED_SHA, "head-sha", workflow),
      }
    );

    expect(result.errors).toEqual([]);
    expect(result.policyContext.signals[0]?.configurationPaths).toContain(
      "security/effective-policy.toml"
    );
  });

  it("accepts literal inline Gitleaks TOML because workflow changes invalidate it", async () => {
    const workflow = `jobs:
  gitleaks:
    steps:
      - uses: gitleaks/gitleaks-action@${PINNED_SHA}
        env:
          GITLEAKS_CONFIG_TOML: |
            title = "bounded inline config"
            [allowlist]
            regexTarget = "match"
            regexes = ['''^example$''']`;
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/119/job/20"),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(PINNED_SHA, "head-sha", workflow),
      }
    );

    expect(result.errors).toEqual([]);
    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(true);
  });

  it("rejects dynamically sourced inline Gitleaks TOML", async () => {
    const workflow = `jobs:
  gitleaks:
    steps:
      - uses: gitleaks/gitleaks-action@${PINNED_SHA}
        env:
          GITLEAKS_CONFIG_TOML: '\${{ secrets.GITLEAKS_CONFIG_TOML }}'`;
    const result = await verifySecretScannerProvenance(
      ci("https://github.com/test-org/test-repo/actions/runs/120/job/21"),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(PINNED_SHA, "head-sha", workflow),
      }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(result.policyContext.signals).toEqual([]);
    expect(result.errors.join(" ")).toMatch(/inline configuration/i);
  });

  it("rejects a dynamic TruffleHog config in extra_args", async () => {
    const workflow = `jobs:
  trufflehog:
    name: TruffleHog
    steps:
      - uses: trufflesecurity/trufflehog@${PINNED_SHA}
        with:
          extra_args: '--config \${{ inputs.config }}'`;
    const result = await verifySecretScannerProvenance(
      ci(
        "https://github.com/test-org/test-repo/actions/runs/115/job/16",
        "TruffleHog"
      ),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(
          PINNED_SHA,
          "head-sha",
          workflow,
          "TruffleHog"
        ),
      }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(result.policyContext.signals).toEqual([]);
    expect(result.errors.join(" ")).toMatch(/configuration arguments/i);
  });

  it("records a quoted TruffleHog config path containing spaces", async () => {
    const workflow = `jobs:
  trufflehog:
    name: TruffleHog
    steps:
      - uses: trufflesecurity/trufflehog@${PINNED_SHA}
        with:
          extra_args: '--config "security/trufflehog policy.yaml" --only-verified'`;
    const result = await verifySecretScannerProvenance(
      ci(
        "https://github.com/test-org/test-repo/actions/runs/121/job/22",
        "TruffleHog"
      ),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(
          PINNED_SHA,
          "head-sha",
          workflow,
          "TruffleHog"
        ),
      }
    );

    expect(result.errors).toEqual([]);
    expect(result.policyContext.signals[0]?.configurationPaths).toEqual([
      "security/trufflehog policy.yaml",
    ]);
  });

  it("records a TruffleHog config path with an escaped space", async () => {
    const workflow = `jobs:
  trufflehog:
    name: TruffleHog
    steps:
      - uses: trufflesecurity/trufflehog@${PINNED_SHA}
        with:
          extra_args: '--config security/trufflehog\\ policy.yaml'`;
    const result = await verifySecretScannerProvenance(
      ci(
        "https://github.com/test-org/test-repo/actions/runs/126/job/27",
        "TruffleHog"
      ),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(
          PINNED_SHA,
          "head-sha",
          workflow,
          "TruffleHog"
        ),
      }
    );

    expect(result.errors).toEqual([]);
    expect(result.policyContext.signals[0]?.configurationPaths).toEqual([
      "security/trufflehog policy.yaml",
    ]);
  });

  it.each([
    "--config",
    "--config --only-verified",
    "--config=../outside.yaml",
    "--config security/policy.yaml; echo bypass",
    "'--config security/policy.yaml",
    42,
  ])("rejects ambiguous or executable TruffleHog extra_args: %j", async (extraArgs) => {
    const workflow = `jobs:
  trufflehog:
    name: TruffleHog
    steps:
      - uses: trufflesecurity/trufflehog@${PINNED_SHA}
        with:
          extra_args: ${typeof extraArgs === "number" ? extraArgs : `'${extraArgs.replaceAll("'", "''")}'`}`;
    const result = await verifySecretScannerProvenance(
      ci(
        "https://github.com/test-org/test-repo/actions/runs/122/job/23",
        "TruffleHog"
      ),
      {
        ref: REF,
        headSha: "head-sha",
        baseRef: "base-sha",
        octokit: octokitForWorkflow(
          PINNED_SHA,
          "head-sha",
          workflow,
          "TruffleHog"
        ),
      }
    );

    expect(result.ci.checkRuns.passing[0]?.provenanceVerified).toBe(false);
    expect(result.policyContext.signals).toEqual([]);
    expect(result.errors.join(" ")).toMatch(/configuration arguments/i);
  });

  it("replaces forged provenance metadata, preserves caller input, and clears a stale gap", async () => {
    const evidence = ci(
      "https://github.com/test-org/test-repo/actions/runs/116/job/17"
    );
    const originalSignal = evidence.checkRuns.passing[0]! as GateSignal & {
      provenanceWorkflowPath?: string;
    };
    originalSignal.provenanceWorkflowPath = ".github/workflows/forged.yml";
    evidence.unverifiedSignals = ["secret_scanner_provenance", "commit_statuses"];

    const result = await verifySecretScannerProvenance(evidence, {
      ref: REF,
      headSha: "head-sha",
      baseRef: "base-sha",
      octokit: octokitForWorkflow(PINNED_SHA),
    });

    expect(originalSignal.provenanceWorkflowPath).toBe(
      ".github/workflows/forged.yml"
    );
    expect(result.ci.checkRuns.passing[0]).not.toHaveProperty(
      "provenanceWorkflowPath"
    );
    expect(result.ci.unverifiedSignals).toEqual(["commit_statuses"]);
    expect(result.policyContext.signals[0]?.workflowPath).toBe(
      ".github/workflows/secret-scan.yml"
    );
  });

  it("strips forged provenance metadata when verification fails without mutating input", async () => {
    const evidence = ci(
      "https://github.com/test-org/test-repo/actions/runs/117/job/18"
    );
    const originalSignal = evidence.checkRuns.passing[0]! as GateSignal & {
      provenanceWorkflowPath?: string;
    };
    originalSignal.provenanceWorkflowPath = ".github/workflows/forged.yml";
    const octokit = octokitForWorkflow(PINNED_SHA);
    vi.mocked(octokit.actions.getWorkflowRun).mockRejectedValueOnce(
      Object.assign(new Error("run unavailable"), { status: 403 })
    );

    const result = await verifySecretScannerProvenance(evidence, {
      ref: REF,
      headSha: "head-sha",
      baseRef: "base-sha",
      octokit,
    });

    expect(originalSignal.provenanceWorkflowPath).toBe(
      ".github/workflows/forged.yml"
    );
    expect(result.ci.checkRuns.passing[0]).not.toHaveProperty(
      "provenanceWorkflowPath"
    );
    expect(result.policyContext.signals).toEqual([]);
    expect(result.ci.unverifiedSignals).toContain("secret_scanner_provenance");
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
