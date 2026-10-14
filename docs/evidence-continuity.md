# Evidence continuity and acceptance traceability

The local assessment modules compare existing evidence packets and trace explicit acceptance conditions. They perform no GitHub writes, network requests, database operations, model calls, or implicit repository discovery. They do not add an MCP tool.

## Evidence continuity

`src/assessment/continuity.ts` exports `compareEvidencePackets(previous, current, options?)`, `ContinuityContextSchema`, `EvidenceChangeSchema`, `ContinuityInvalidationCodeSchema`, and `EvidenceContinuityResultSchema`. Inputs use the existing `EvidencePacket` schema. The comparison never changes either input.

```typescript
const comparison = compareEvidencePackets(previous, current, {
  previousContext: { baseSha: previousBaseSha, policyDigest: previousPolicyDigest },
  currentContext: { baseSha: currentBaseSha, policyDigest: currentPolicyDigest },
  evaluatedAt: "2026-10-14T00:00:00.000Z",
});
```

`added`, `removed`, `changed`, and `unchanged` contain stable evidence identifiers and bounded summaries. Each entry preserves the source enum, state, freshness, completeness, and a fixed recommended action. Source reasons, Issue/PR bodies, external error messages, and source-provided actions are not copied into the comparison. Identifiers containing unsafe characters or exceeding 200 characters are represented by a deterministic hash identifier.

An item comparison reuses the existing packet builder's canonical digest, which excludes collection/update timestamps. An expiry change is additionally treated as an item change. Array order does not affect which identifiers belong to each category. A packet digest identifies content; it is not a signature authenticating the packet's producer.

The result is `invalid` for unsupported/malformed packet schemas, different repository or subject identities, different or missing Issue/PR numbers, duplicate evidence identifiers, invalid evaluation context, or more than 1,000 evidence items per packet. Invalid comparisons contain no item lists and require fresh verification. Release refs are part of release identity.

Head SHA changes, base SHA changes, policy digest changes, generator/tool version changes, source ref changes, item changes/additions/removals, stale or unknown freshness, incomplete evidence, expired evidence, and target/provenance mismatches require revalidation. Unknown schema versions are rejected, rather than treated as compatible. A PR packet does not currently carry a top-level base SHA, so callers must provide both base SHAs through the context. A complete immutable SHA must contain exactly 40 or 64 hexadecimal characters. Missing packet head SHAs, mutable refs such as `main`, abbreviated SHAs, and missing/malformed PR base context are reported as `context_unavailable` and require revalidation, even if the two snapshots use the same value. Explicit head context must agree with the packet subject and cannot replace a missing packet SHA. Same-subject item SHAs and any provided provenance subject SHA must also have the complete immutable form. These checks strengthen only this assessment layer; the existing public EvidencePacket schema is unchanged.

Each category displays at most 200 entries. `omittedChanges` and `display_truncated` report any extra entries; truncation cannot establish completeness. Omitted evidence and packet limitations also require revalidation. Expiry evaluation uses the explicit `evaluatedAt`, or otherwise the current packet's collection time, keeping the function deterministic.

`unchanged` means the selected evidence content did not change. It cannot establish that a previous successful result remains valid. `verificationInherited` is always `false`; even a result with `requiresRevalidation: false` does not verify business acceptance.

## Explicit acceptance conditions

`src/assessment/acceptance.ts` exports `extractAcceptanceCriteria(markdown, source?)` and `evaluateAcceptanceTraceability(input)`, their input/output types, and the following schemas:

- `AcceptanceSourceInputSchema`, `AcceptanceCriterionSchema`, `AcceptanceExtractionSchema`
- `AcceptanceEvidenceMappingSchema`, `AcceptanceMappingsSchema`
- `TrustedAcceptanceVerificationSourceSchema`, `AcceptanceStatusSchema`, `AcceptanceTraceabilityResultSchema`

The extractor accepts explicit Markdown text with source kind `issue`, `speckit`, `openspec`, or `markdown`. It extracts checkbox and numbered list lines, including numbered checkboxes, outside fenced code examples and HTML comments. It does not infer acceptance conditions from prose, interpret every SpecKit/OpenSpec construct, or distinguish implementation tasks from business conditions. The caller must supply the intended acceptance section or review the extracted list.

The source character budget is 100,000, the source line budget is 2,000, and the criterion budget is 100. Exceeding any budget sets `truncated`; extracted conditions cannot then establish complete acceptance. Each summary is bounded and uses the repository's existing untrusted-text renderer. Conditions remain untrusted data even after rendering.

Criterion identifiers derive from source identity and the SHA-256 digest of normalized condition text. Changing `[ ]` to `[x]`, renumbering, or moving a condition within the same source does not change its identifier. Changing condition text or source identity changes its identifier. Repeated identical text from one source is consolidated with a limitation; the first source line is retained. Source locations include the kind, line, document digest, and an opaque hashed locator. Raw local paths, URL credentials, query strings, and fragments are not echoed.

```typescript
const criteria = extractAcceptanceCriteria(markdown, {
  kind: "openspec",
  locator: "specs/report-export/spec.md",
});
const result = evaluateAcceptanceTraceability({
  criteria,
  evidence: currentPacket,
  mappings,
});
```

`AcceptanceMappingsSchema` is a bounded array of at most 500 strict mapping objects. An association only requires:

```json
{
  "criterionId": "ac:0123456789abcdef01234567",
  "evidenceId": "ci:aggregate",
  "relation": "association"
}
```

A `verification` or `not_applicable` relation additionally requires `criterionDigest`, `sourceContentDigest`, and `subjectSha`. These fields must bind the extracted criterion, evidence source digest, and current immutable packet target. Positive conclusions require matching complete 40- or 64-character hexadecimal SHAs in the packet subject, item subject, mapping, and item provenance. A ref or abbreviated SHA remains `unverified` even when all four values agree. PR and Issue subjects must also have matching positive safe-integer numbers; an absent number cannot establish acceptance. They cannot assert their own trust or result. Unknown fields such as `verified: true` or producer allowlists are rejected.

| Status | Meaning |
| --- | --- |
| `missing` | No structured association exists for the condition. |
| `needs_human` | Evidence is associated, but an independently trusted criterion-specific result is unavailable. |
| `unverified` | A claimed binding is missing, mismatched, failed, stale, incomplete, expired, ambiguous, or otherwise unusable. |
| `verified` | A separately configured trusted producer verified an exact criterion-specific binding for the current target. |
| `not_applicable` | A separately configured trusted scope producer established a criterion-specific applicability decision. |

Association and verification are separate. Agent-authored checkbox marks, self-reported test results, ordinary green CI, PR approval, and an arbitrary mapping never prove business acceptance. No acceptance producer is trusted by default. Existing generic CI evidence adapters are not criterion-specific acceptance producers, so normal local CLI assessments conservatively retain `needs_human`, `unverified`, or `missing` until an appropriate producer integration exists.

## Producer integration boundary

The host may supply `trustedVerificationSources` independently of the mapping file. Each configured source specifies `github_check_run`, an expected GitHub App ID, and provider. This is integration configuration; it must never be populated from source Markdown, agent claims, or a local mappings file. The local schema checks binding consistency, not whether a producer honestly executed a test. The integrating host remains responsible for collecting authentic GitHub check-run evidence and verifying producer/workflow provenance.

A positive result requires all of the following:

1. An exact condition digest and current complete 40- or 64-character hexadecimal head SHA binding across packet, item, mapping, and provenance, with matching repository and valid Issue/PR number when applicable. SHA shape and equality alone do not authenticate the producer or prove that GitHub returned that commit.
2. `verified`, `fresh`, `complete`, unexpired evidence with the mapped source content digest.
3. A dedicated `acceptance_verification` evidence kind and identifier `acceptance:verification:<full criterion contentDigest>`; applicability uses `acceptance_scope` and `acceptance:scope:<full criterion contentDigest>`. The producer-authored identifier prevents a mapping from relabeling another criterion's verification.
4. An HTTPS GitHub Actions run/job URL for the exact repository, without credentials, query strings, or fragments, and the configured App/provider provenance.
5. A producer registered separately by the host. No default allowlist is inferred from check names, provider text, or App IDs in the evidence itself.

Truncated extraction, duplicate evidence identifiers, and omitted evidence block positive completion. Contradictory verified/not-applicable bindings require human review. A broken binding is retained as unverified even if another binding succeeds. Unknown criterion mappings make overall completeness false. An empty condition list never means acceptance passed.

The result includes per-condition associations and verification identifiers, fixed reasons and next actions, status counts, and a conservative `complete` flag. Raw evidence reasons, URLs, and errors are not copied into these summaries. All outcomes describe supplied evidence; none authorizes merging, deployment, or bypassing review.

## Validation

The targeted suites cover evidence identity and version drift, expiry, timestamp-independent digests, incomplete and oversized packets, injected text, stable criteria, extraction budgets, mapping strictness, source/target mismatches, ordinary green CI, independent producer trust, contradictory scope claims, and input immutability:

```powershell
npx vitest run src/__tests__/assessment/continuity.test.ts src/__tests__/assessment/acceptance.test.ts
npm run typecheck
```
