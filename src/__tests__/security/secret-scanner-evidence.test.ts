import { describe, expect, it } from "vitest";

import {
  applySecretScannerPolicyChanges,
  evaluateSecretScannerEvidence,
  secretScannerPolicyFinding,
  type SecretScannerEvidence,
  type SecretScannerPolicyContext,
  type SecretScannerProvider,
} from "../../security/secret-scanner-evidence.js";
import type {
  CiEvidence,
  GateSignal,
  GateSignalState,
} from "../../github/pull-request-evidence.js";

function signal(
  name: string,
  state: GateSignalState,
  source: GateSignal["source"] = "check_run",
  appId: number | null = source === "check_run" ? 15368 : null,
  provenanceVerified = false
): GateSignal {
  return {
    name,
    source,
    appId,
    state,
    rawStatus: state === "pending" ? "in_progress" : "completed",
    rawConclusion: state === "passing" ? "success" : state === "failing" ? "failure" : null,
    rawState: source === "commit_status" ? state : null,
    url: null,
    provenanceVerified,
  };
}

function ci(signals: GateSignal[], unverifiedSignals: string[] = []): CiEvidence {
  const buckets = (source: GateSignal["source"]) => {
    const selected = signals.filter((item) => item.source === source);
    return {
      passing: selected.filter((item) => item.state === "passing"),
      failing: selected.filter((item) => item.state === "failing"),
      pending: selected.filter((item) => item.state === "pending"),
      skipped: selected.filter((item) => item.state === "skipped"),
      total: selected.length,
    };
  };
  return {
    checkRuns: buckets("check_run"),
    commitStatuses: buckets("commit_status"),
    totalSignals: signals.length,
    hasFailing: signals.some((item) => item.state === "failing"),
    hasPending: signals.some((item) => item.state === "pending"),
    unverifiedSignals,
    errors: [],
  };
}

function expectStatus(evidence: SecretScannerEvidence, status: SecretScannerEvidence["status"]): void {
  expect(evidence.status).toBe(status);
  expect(evidence.verified).toBe(status !== "unverified");
}

function policyContext(
  signals: Array<{
    name: string;
    provider: SecretScannerProvider;
    workflowPath: string;
    configurationPaths?: string[];
  }>
): SecretScannerPolicyContext {
  return {
    signals: signals.map((item) => ({
      ...item,
      source: "check_run",
      appId: 15368,
      url: null,
      configurationPaths: item.configurationPaths ?? [],
    })),
  };
}

describe("evaluateSecretScannerEvidence", () => {
  it.each([
    ["gitleaks", "gitleaks"],
    ["TruffleHog Secrets Scan", "trufflehog"],
  ] as const)("trusts a provenance-supported mature scanner check: %s", (name, provider) => {
    const evidence = evaluateSecretScannerEvidence(ci([signal(name, "passing", "check_run", 15368, true)]));

    expectStatus(evidence, "passing");
    expect(evidence.providers).toContain(provider);
  });

  it.each([
    ["secretlint", "secretlint"],
    ["detect-secrets", "detect-secrets"],
    ["GitHub Secret Scanning", "github-secret-scanning"],
  ] as const)("keeps unsupported provenance provider claims unverified: %s", (name, provider) => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal(name, "passing", "check_run", 15368, true)])
    );

    expectStatus(evidence, "unverified");
    expect(evidence.providers).toContain(provider);
  });

  it("makes a failing mature scanner outrank a passing scanner", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([
        signal("gitleaks", "passing", "check_run", 15368, true),
        signal("TruffleHog", "failing", "check_run", 15368, true),
      ])
    );

    expectStatus(evidence, "failing");
    expect(evidence.signals).toHaveLength(2);
  });

  it("reports pending while a recognized scanner is incomplete", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "pending", "check_run", 15368, true)])
    );

    expectStatus(evidence, "pending");
  });

  it("does not treat skipped or unrelated green checks as verified secret scanning", () => {
    const skipped = evaluateSecretScannerEvidence(ci([signal("gitleaks", "skipped")]));
    const unrelated = evaluateSecretScannerEvidence(ci([signal("unit tests", "passing")]));

    expectStatus(skipped, "unverified");
    expectStatus(unrelated, "unverified");
    expect(unrelated.reason).toMatch(/no recognized secret scanner/i);
  });

  it("retains a recognized commit-status claim but does not treat it as verified clean", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("detect-secrets", "passing", "commit_status")])
    );

    expectStatus(evidence, "unverified");
    expect(evidence.signals[0]?.source).toBe("commit_status");
    expect(evidence.signals[0]?.trusted).toBe(false);
  });

  it("rejects a same-name passing check from an untrusted GitHub App", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 999999)])
    );

    expectStatus(evidence, "unverified");
    expect(evidence.signals[0]).toMatchObject({ appId: 999999, trusted: false });
    expect(evidence.reason).toMatch(/untrusted/i);
  });

  it("does not trust a same-name Actions check without explicit workflow provenance", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 15368)])
    );

    expectStatus(evidence, "unverified");
    expect(evidence.signals[0]).toMatchObject({
      appId: 15368,
      trusted: false,
      provenanceVerified: false,
    });
    expect(evidence.reason).toMatch(/provenance|untrusted/i);
  });

  it("fails closed when any CI source is unavailable or truncated", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 15368, true)], ["commit_statuses"])
    );

    expectStatus(evidence, "unverified");
    expect(evidence.degraded).toBe(true);
    expect(evidence.reason).toMatch(/incomplete/i);
  });

  it("does not trust a passing check while scanner policy files are modified", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 15368, true)]), {
      policyFilesChanged: true,
      }
    );

    expectStatus(evidence, "unverified");
    expect(evidence.reason).toMatch(/policy/i);
  });

  it("keeps a recognized failure highest priority even from an untrusted source", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([
        signal("gitleaks", "passing", "check_run", 15368, true),
        signal("TruffleHog", "failing", "commit_status"),
      ])
    );

    expect(evidence.status).toBe("failing");
    expect(evidence.verified).toBe(false);
    expect(evidence.degraded).toBe(true);
  });

  it("does not allow an inconsistent degraded passing object through the policy boundary", () => {
    const issue = secretScannerPolicyFinding({
      status: "passing",
      verified: false,
      degraded: true,
      providers: ["gitleaks"],
      signals: [],
      reason: "Caller supplied contradictory evidence.",
    });

    expect(issue).toMatchObject({
      category: "MissingMatureSecretScannerEvidence",
      severity: "high",
    });
  });
});

describe("applySecretScannerPolicyChanges", () => {
  it("invalidates only one scanner when independent passing evidence remains", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([
        signal("gitleaks", "passing", "check_run", 15368, true),
        signal("TruffleHog", "passing", "check_run", 15368, true),
      ])
    );

    const result = applySecretScannerPolicyChanges(
      [{ filename: ".github/workflows/gitleaks.yml" }],
      evidence,
      policyContext([
        {
          name: "gitleaks",
          provider: "gitleaks",
          workflowPath: ".github/workflows/gitleaks.yml",
        },
        {
          name: "TruffleHog",
          provider: "trufflehog",
          workflowPath: ".github/workflows/trufflehog.yml",
        },
      ])
    );

    expect(result).toMatchObject({
      status: "passing",
      verified: true,
      degraded: false,
    });
    expect(result.signals.find((item) => item.provider === "gitleaks")).toMatchObject({
      trusted: false,
      provenanceVerified: false,
    });
    expect(result.signals.find((item) => item.provider === "trufflehog")).toMatchObject({
      trusted: true,
      provenanceVerified: true,
    });
  });

  it("invalidates evidence when every trusted passing scanner workflow changes", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([
        signal("gitleaks", "passing", "check_run", 15368, true),
        signal("TruffleHog", "passing", "check_run", 15368, true),
      ])
    );

    const result = applySecretScannerPolicyChanges(
      [
        { filename: ".github/workflows/gitleaks.yml" },
        { filename: ".github/workflows/trufflehog.yml" },
      ],
      evidence,
      policyContext([
        {
          name: "gitleaks",
          provider: "gitleaks",
          workflowPath: ".github/workflows/gitleaks.yml",
        },
        {
          name: "TruffleHog",
          provider: "trufflehog",
          workflowPath: ".github/workflows/trufflehog.yml",
        },
      ])
    );

    expect(result).toMatchObject({
      status: "unverified",
      verified: false,
      degraded: true,
    });
    expect(result.signals.every((item) => !item.trusted && !item.provenanceVerified)).toBe(true);
  });

  it("does not invalidate TruffleHog-only evidence for a Gitleaks configuration change", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("TruffleHog", "passing", "check_run", 15368, true)])
    );

    const result = applySecretScannerPolicyChanges(
      [{ filename: ".gitleaks.toml" }],
      evidence,
      policyContext([
        {
          name: "TruffleHog",
          provider: "trufflehog",
          workflowPath: ".github/workflows/trufflehog.yml",
        },
      ])
    );

    expect(result).toBe(evidence);
  });

  it("ignores non-workflow files inside the Actions directory", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 15368, true)])
    );

    const result = applySecretScannerPolicyChanges(
      [{ filename: ".github/workflows/README.md" }],
      evidence,
      policyContext([
        {
          name: "gitleaks",
          provider: "gitleaks",
          workflowPath: ".github/workflows/gitleaks.yml",
          configurationPaths: [".gitleaks.toml", "gitleaks.toml", ".gitleaksignore"],
        },
      ])
    );

    expect(result).toBe(evidence);
  });

  it("does not treat a nested Gitleaks-like filename as the root default config", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 15368, true)])
    );

    const result = applySecretScannerPolicyChanges(
      [{ filename: "security/gitleaks.toml" }],
      evidence,
      policyContext([
        {
          name: "gitleaks",
          provider: "gitleaks",
          workflowPath: ".github/workflows/gitleaks.yml",
          configurationPaths: [".gitleaks.toml", "gitleaks.toml", ".gitleaksignore"],
        },
      ])
    );

    expect(result).toBe(evidence);
  });

  it.each([
    { filename: "security/gitleaks-policy.toml" },
    {
      filename: "security/retired-policy.toml",
      previousFilename: "security/gitleaks-policy.toml",
    },
  ])("invalidates an exact custom Gitleaks configuration dependency: $filename", (changedFile) => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 15368, true)])
    );

    const result = applySecretScannerPolicyChanges(
      [changedFile],
      evidence,
      policyContext([
        {
          name: "gitleaks",
          provider: "gitleaks",
          workflowPath: ".github/workflows/gitleaks.yml",
          configurationPaths: ["security/gitleaks-policy.toml"],
        },
      ])
    );

    expect(result).toMatchObject({
      status: "unverified",
      verified: false,
      signals: [
        expect.objectContaining({
          trusted: false,
          provenanceVerified: false,
        }),
      ],
    });
  });

  it("invalidates an exact custom TruffleHog configuration dependency", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("TruffleHog", "passing", "check_run", 15368, true)])
    );

    const result = applySecretScannerPolicyChanges(
      [{ filename: "security/trufflehog.yaml" }],
      evidence,
      policyContext([
        {
          name: "TruffleHog",
          provider: "trufflehog",
          workflowPath: ".github/workflows/trufflehog.yml",
          configurationPaths: ["security/trufflehog.yaml"],
        },
      ])
    );

    expect(result.status).toBe("unverified");
    expect(result.signals[0]).toMatchObject({
      trusted: false,
      provenanceVerified: false,
    });
  });

  it.each([
    undefined,
    policyContext([
      {
        name: "gitleaks",
        provider: "gitleaks",
        workflowPath: "docs/not-a-workflow.yml",
      },
    ]),
  ])("fails closed for workflow changes when policy context is absent or invalid", (context) => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 15368, true)])
    );

    const result = applySecretScannerPolicyChanges(
      [{ filename: ".github/workflows/ci.yml" }],
      evidence,
      context
    );

    expect(result.status).toBe("unverified");
    expect(result.signals[0]).toMatchObject({
      trusted: false,
      provenanceVerified: false,
    });
  });

  it("fails closed when duplicate policy entries make signal binding ambiguous", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 15368, true)])
    );
    const entry = {
      name: "gitleaks",
      provider: "gitleaks" as const,
      workflowPath: ".github/workflows/gitleaks.yml",
    };

    const result = applySecretScannerPolicyChanges(
      [{ filename: "src/index.ts" }],
      evidence,
      policyContext([entry, entry])
    );

    expect(result.status).toBe("unverified");
  });

  it("fails closed when runtime policy context contains a non-string dependency", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 15368, true)])
    );
    const malformedContext = policyContext([
      {
        name: "gitleaks",
        provider: "gitleaks",
        workflowPath: ".github/workflows/gitleaks.yml",
      },
    ]) as unknown as {
      signals: Array<{
        name: string;
        provider: "gitleaks";
        source: "check_run";
        appId: number;
        url: null;
        workflowPath: string;
        configurationPaths: unknown[];
      }>;
    };
    malformedContext.signals[0]!.configurationPaths = [42];

    const result = applySecretScannerPolicyChanges(
      [{ filename: "src/index.ts" }],
      evidence,
      malformedContext as unknown as SecretScannerPolicyContext
    );

    expect(result.status).toBe("unverified");
  });

  it("leaves a contradictory passing object unchanged when it has no trusted signal", () => {
    const evidence: SecretScannerEvidence = {
      status: "passing",
      verified: true,
      degraded: false,
      providers: ["gitleaks"],
      signals: [
        {
          name: "gitleaks",
          provider: "gitleaks",
          source: "check_run",
          appId: 15368,
          trusted: false,
          provenanceVerified: false,
          state: "passing",
          url: null,
        },
      ],
      reason: "Caller-owned contradictory fixture.",
    };

    expect(
      applySecretScannerPolicyChanges(
        [{ filename: ".github/workflows/gitleaks.yml" }],
        evidence
      )
    ).toBe(evidence);
  });

  it("does not mutate caller evidence or policy context while invalidating a signal", () => {
    const evidence = evaluateSecretScannerEvidence(
      ci([signal("gitleaks", "passing", "check_run", 15368, true)])
    );
    const context = policyContext([
      {
        name: "gitleaks",
        provider: "gitleaks",
        workflowPath: ".github/workflows/gitleaks.yml",
      },
    ]);
    const evidenceBefore = structuredClone(evidence);
    const contextBefore = structuredClone(context);

    const result = applySecretScannerPolicyChanges(
      [{ filename: ".github/workflows/gitleaks.yml" }],
      evidence,
      context
    );

    expect(result).not.toBe(evidence);
    expect(evidence).toEqual(evidenceBefore);
    expect(context).toEqual(contextBefore);
  });

  it.each([
    {
      name: "empty file list",
      files: [],
      evidence: evaluateSecretScannerEvidence(
        ci([signal("gitleaks", "passing", "check_run", 15368, true)])
      ),
    },
    {
      name: "non-passing evidence",
      files: [{ filename: ".github/workflows/gitleaks.yml" }],
      evidence: evaluateSecretScannerEvidence(
        ci([signal("gitleaks", "failing", "check_run", 15368, true)])
      ),
    },
  ])("returns the original evidence for $name", ({ files, evidence }) => {
    expect(applySecretScannerPolicyChanges(files, evidence)).toBe(evidence);
  });
});
