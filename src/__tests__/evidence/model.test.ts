import { describe, expect, it } from "vitest";

import { buildEvidencePacket } from "../../evidence/model.js";

describe("buildEvidencePacket", () => {
  it("never treats a caller assertion as verified evidence", () => {
    const packet = buildEvidencePacket({
      generatorVersion: "1.9.0",
      collectedAt: "2026-07-26T00:00:00.000Z",
      subject: {
        type: "issue",
        repo: "test-org/test-repo",
        number: 42,
      },
      evidence: [
        {
          id: "caller:tests",
          kind: "test_result",
          state: "verified",
          freshness: "unknown",
          completeness: "partial",
          source: "caller_assertion",
          collectedAt: "2026-07-26T00:00:00.000Z",
          provenance: {},
          reason: "The caller says all tests passed.",
          limitations: [],
          recommendedNextActions: [],
        },
      ],
    });

    expect(packet.evidence[0]?.state).toBe("unverified");
    expect(packet.evidence[0]?.subject).toEqual(packet.subject);
    expect(packet.evidence[0]?.limitations).toContain(
      "Caller assertions cannot be promoted to verified system evidence."
    );
    expect(packet.summary.idsByState.verified).toEqual([]);
    expect(packet.summary.idsByState.unverified).toEqual(["caller:tests"]);
  });

  it("changes the packet digest when source content changes", () => {
    const makePacket = (sourceContentDigest: string) =>
      buildEvidencePacket({
        generatorVersion: "1.9.0",
        subject: {
          type: "issue",
          repo: "test-org/test-repo",
          number: 42,
        },
        evidence: [{
          id: "issue:body",
          kind: "issue_body",
          state: "unverified",
          freshness: "fresh",
          completeness: "complete",
          source: "github_api",
          collectedAt: "2026-07-26T00:00:00.000Z",
          provenance: { sourceContentDigest },
          reason: "Issue body is untrusted repository content.",
          limitations: [],
          recommendedNextActions: [],
        }],
      });

    expect(makePacket("a".repeat(64)).contentDigest).not.toBe(
      makePacket("b".repeat(64)).contentDigest
    );
  });

  it("keeps the digest stable across collection times but changes it for stale evidence", () => {
    const baseInput = {
      generatorVersion: "1.9.0",
      subject: {
        type: "pull_request" as const,
        repo: "test-org/test-repo",
        number: 7,
        sha: "abc123",
      },
      evidence: [
        {
          id: "ci:test",
          kind: "ci_check",
          state: "verified" as const,
          freshness: "fresh" as const,
          completeness: "complete" as const,
          source: "github_check_run" as const,
          collectedAt: "2026-07-26T00:00:00.000Z",
          sourceUpdatedAt: "2026-07-25T23:59:00.000Z",
          provenance: {
            url: "https://github.com/test-org/test-repo/actions/runs/1",
            subjectSha: "abc123",
          },
          reason: "The required test check passed.",
          limitations: [],
          recommendedNextActions: [],
        },
      ],
    };

    const first = buildEvidencePacket({
      ...baseInput,
      collectedAt: "2026-07-26T00:00:00.000Z",
    });
    const recollected = buildEvidencePacket({
      ...baseInput,
      collectedAt: "2026-07-27T00:00:00.000Z",
      evidence: [
        {
          ...baseInput.evidence[0],
          collectedAt: "2026-07-27T00:00:00.000Z",
          sourceUpdatedAt: "2026-07-27T00:00:00.000Z",
        },
      ],
    });
    const stale = buildEvidencePacket({
      ...baseInput,
      evidence: [{ ...baseInput.evidence[0], freshness: "stale" as const }],
    });

    expect(recollected.contentDigest).toBe(first.contentDigest);
    expect(stale.contentDigest).not.toBe(first.contentDigest);
    expect(stale.summary.staleIds).toEqual(["ci:test"]);
  });

  it("downgrades a verified claim that has no traceable provenance", () => {
    const packet = buildEvidencePacket({
      generatorVersion: "1.9.0",
      subject: {
        type: "repository",
        repo: "test-org/test-repo",
      },
      evidence: [
        {
          id: "policy:unknown",
          kind: "repository_policy",
          state: "verified",
          freshness: "fresh",
          completeness: "complete",
          source: "repository_policy",
          collectedAt: "2026-07-26T00:00:00.000Z",
          provenance: {},
          reason: "Policy loaded.",
          limitations: [],
          recommendedNextActions: [],
        },
      ],
    });

    expect(packet.evidence[0]?.state).toBe("unverified");
    expect(packet.evidence[0]?.limitations).toContain(
      "Verified evidence requires traceable provenance."
    );
  });

  it("enforces the item budget and records omitted evidence", () => {
    const packet = buildEvidencePacket({
      generatorVersion: "1.9.0",
      subject: {
        type: "repository",
        repo: "test-org/test-repo",
      },
      maxEvidenceItems: 2,
      evidence: Array.from({ length: 3 }, (_, index) => ({
        id: `system:${index}`,
        kind: "system_status",
        state: "unverified" as const,
        freshness: "unknown" as const,
        completeness: "partial" as const,
        source: "system" as const,
        collectedAt: "2026-07-26T00:00:00.000Z",
        provenance: {},
        reason: "Bounded evidence.",
        limitations: [],
        recommendedNextActions: [],
      })),
    });

    expect(packet.evidence).toHaveLength(2);
    expect(packet.budget).toEqual(
      expect.objectContaining({
        maxEvidenceItems: 2,
        maxGithubRequests: 40,
        maxSourceTextCharacters: 20_000,
        maxFilesPerSource: 300,
        maxItemsPerSource: 300,
        maxRenderedMarkdownCharacters: 50_000,
        collectionTimeoutMs: 30_000,
      })
    );
    expect(packet.omittedEvidence).toEqual([{
      kind: "evidence_item",
      count: 1,
      reason: "Evidence packet exceeded the 2-item budget.",
    }]);
  });
});
