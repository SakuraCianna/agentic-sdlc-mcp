import type { Finding, SdlcWorkType, Severity } from "../types.js";
import {
  isSecretScannerPolicyPath,
  secretScannerPolicyFinding,
  unverifiedSecretScannerEvidence,
  type SecretScannerEvidence,
} from "../security/secret-scanner-evidence.js";

export type ReviewDimension =
  | "intent"
  | "scope"
  | "evidence"
  | "ownership"
  | "policy"
  | "fallback"
  | "security";

export interface StructuredReviewFinding extends Finding {
  dimension: ReviewDimension;
  paths: string[];
  reason: string;
  suggestion: string;
}

/** Minimal changed-file shape accepted from GitHub or a caller-owned fixture. */
export interface PrFile {
  filename: string;
  previousFilename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
}

/** PR text used by the pure classifier. GitHub-only metadata stays in the tool layer. */
export interface ReviewPrMeta {
  title: string;
  body: string | null;
  labels: string[];
  draft: boolean;
  commits: number;
}

export interface WorkTypeInference {
  workType: SdlcWorkType;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

export interface ClassifiedPrFiles {
  allFiles: PrFile[];
  docsFiles: PrFile[];
  testFiles: PrFile[];
  snapshotTestFiles: PrFile[];
  nonSnapshotTestFiles: PrFile[];
  workflowFiles: PrFile[];
  infrastructureFiles: PrFile[];
  authSecurityFiles: PrFile[];
  releaseFiles: PrFile[];
  lockFiles: PrFile[];
  envFiles: PrFile[];
  generatedFiles: PrFile[];
  sourceFiles: PrFile[];
  docsOnly: boolean;
}

export type ReviewStandard = "basic" | "strict" | "security-focused";
export type ReleaseRisk = "low" | "moderate" | "high" | "critical";
export type TestCoverageSignal =
  | "adequate"
  | "missing"
  | "not_required"
  | "insufficient_evidence";

export interface ReviewEvaluationInput {
  pr: ReviewPrMeta;
  files: PrFile[];
  workType?: SdlcWorkType;
  standard?: ReviewStandard;
  secretScannerEvidence?: SecretScannerEvidence;
  /** Complete policy evidence gathered by the orchestration layer, such as workflow permissions. */
  policyFindings?: StructuredReviewFinding[];
}

export interface ReviewEvaluationResult {
  workType: SdlcWorkType;
  workTypeConfidence: WorkTypeInference["confidence"];
  workTypeReasoning: string;
  findings: StructuredReviewFinding[];
  releaseRisk: ReleaseRisk;
  testCoverageSignal: TestCoverageSignal;
  conclusion: "pass" | "needs_changes" | "risky_but_acceptable";
  hasTests: boolean;
  totalChangedLines: number;
  secretScannerEvidence: SecretScannerEvidence | null;
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

const LOCK_FILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);

function normalizePath(filename: string): string {
  return filename.replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizeFile(file: PrFile): PrFile {
  return {
    ...file,
    filename: normalizePath(file.filename),
    previousFilename:
      file.previousFilename === undefined ? undefined : normalizePath(file.previousFilename),
  };
}

function isDocsPath(filename: string): boolean {
  const lower = filename.toLowerCase();
  const basename = lower.split("/").at(-1) ?? lower;
  return (
    lower.startsWith("docs/") ||
    /\.(?:adoc|md|mdx|rst|txt)$/.test(lower) ||
    /^(?:changelog|contributing|license|readme)(?:\..+)?$/.test(basename)
  );
}

function isTestPath(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)/.test(lower) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(lower) ||
    /(?:^|\/)__snapshots__(?:\/|$)/.test(lower) ||
    lower.endsWith(".snap")
  );
}

function isSnapshotPath(filename: string): boolean {
  const lower = filename.toLowerCase();
  return /(?:^|\/)__snapshots__(?:\/|$)/.test(lower) || lower.endsWith(".snap");
}

function isWorkflowPath(filename: string): boolean {
  return filename.toLowerCase().startsWith(".github/workflows/");
}

function isInfrastructurePath(filename: string): boolean {
  const lower = filename.toLowerCase();
  const basename = lower.split("/").at(-1) ?? lower;
  return (
    isWorkflowPath(lower) ||
    /(?:^|\/)(?:deploy|deployment|helm|infra|infrastructure|k8s|kubernetes|terraform)(?:\/|$)/.test(
      lower
    ) ||
    /\.(?:tf|tfvars)$/.test(lower) ||
    /^dockerfile(?:\..+)?$/.test(basename) ||
    /^(?:docker-compose|compose)\.(?:ya?ml)$/.test(basename)
  );
}

function isEnvironmentPath(filename: string): boolean {
  return /(?:^|\/)\.env(?:\.|$)/i.test(filename);
}

function isAuthSecurityPath(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    isEnvironmentPath(lower) ||
    /(?:^|[\/_.-])(?:auth|authorization|credential|credentials|oauth|password|permissions?|secrets?|security|session|tokens?)(?:[\/_.-]|$)/.test(
      lower
    )
  );
}

function isReleasePath(filename: string): boolean {
  const lower = filename.toLowerCase();
  const basename = lower.split("/").at(-1) ?? lower;
  return (
    [".npmrc", "package.json", "server.json"].includes(basename) ||
    /(?:^|\/)version\.[cm]?[jt]s$/.test(lower) ||
    /(?:^|\/)(?:publish|release|releases)(?:\/|$)/.test(lower) ||
    /(?:^|[._-])(?:publish|release)(?:[._-]|$)/.test(basename) ||
    /(?:^|\/)(?:publish|release)\.[^/]+$/.test(lower)
  );
}

function isLockPath(filename: string): boolean {
  return LOCK_FILE_NAMES.has((filename.split("/").at(-1) ?? filename).toLowerCase());
}

function isGeneratedPath(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    /(?:^|\/)(?:build|coverage|dist|generated)(?:\/|$)/.test(lower) ||
    /\.min\.(?:css|js)$/.test(lower)
  );
}

export function classifyPrFiles(files: PrFile[]): ClassifiedPrFiles {
  const allFiles = files.map(normalizeFile);
  const docsFiles = allFiles.filter((file) => isDocsPath(file.filename));
  const testFiles = allFiles.filter((file) => isTestPath(file.filename));
  const snapshotTestFiles = testFiles.filter((file) => isSnapshotPath(file.filename));
  const nonSnapshotTestFiles = testFiles.filter((file) => !isSnapshotPath(file.filename));
  const workflowFiles = allFiles.filter((file) => isWorkflowPath(file.filename));
  const infrastructureFiles = allFiles.filter((file) => isInfrastructurePath(file.filename));
  const authSecurityFiles = allFiles.filter((file) => isAuthSecurityPath(file.filename));
  const releaseFiles = allFiles.filter((file) => isReleasePath(file.filename));
  const lockFiles = allFiles.filter((file) => isLockPath(file.filename));
  const envFiles = allFiles.filter((file) => isEnvironmentPath(file.filename));
  const generatedFiles = allFiles.filter((file) => isGeneratedPath(file.filename));
  const sourceFiles = allFiles.filter(
    (file) =>
      !docsFiles.includes(file) &&
      !testFiles.includes(file) &&
      !lockFiles.includes(file) &&
      !generatedFiles.includes(file)
  );

  return {
    allFiles,
    docsFiles,
    testFiles,
    snapshotTestFiles,
    nonSnapshotTestFiles,
    workflowFiles,
    infrastructureFiles,
    authSecurityFiles,
    releaseFiles,
    lockFiles,
    envFiles,
    generatedFiles,
    sourceFiles,
    docsOnly: allFiles.length > 0 && docsFiles.length === allFiles.length,
  };
}

function normalizedLabels(labels: string[]): string[] {
  return labels.map((label) => label.trim().toLowerCase());
}

function hasLabel(labels: string[], pattern: RegExp): boolean {
  return labels.some((label) => pattern.test(label));
}

export function inferWorkType(pr: ReviewPrMeta, files: PrFile[]): WorkTypeInference {
  const classified = classifyPrFiles(files);
  const labels = normalizedLabels(pr.labels);
  const title = pr.title.trim();
  const body = pr.body ?? "";

  if (
    hasLabel(labels, /^(?:security|security-fix|vulnerability)$/) ||
    /\b(?:security|vulnerability|cve-\d+|credential exposure)\b/i.test(title) ||
    /\b(?:security(?: hardening| vulnerability)?|credential exposure|threat model|cve-\d+)\b/i.test(
      body
    )
  ) {
    return {
      workType: "security",
      confidence: "high",
      reasoning: "Security-specific label or PR text takes priority over other work signals.",
    };
  }

  if (
    classified.releaseFiles.length > 0 ||
    hasLabel(labels, /^(?:publish|release|release-.+)$/) ||
    /\b(?:publish|release)\b/i.test(title)
  ) {
    return {
      workType: "release",
      confidence: "high",
      reasoning: "A release/publish path, label, or title explicitly identifies release work.",
    };
  }

  if (classified.infrastructureFiles.length > 0) {
    return {
      workType: "infra",
      confidence: "high",
      reasoning: "Workflow or infrastructure paths are present in the changed files.",
    };
  }

  if (classified.docsOnly) {
    return {
      workType: "docs",
      confidence: "high",
      reasoning: "Every changed file is documentation.",
    };
  }

  if (
    hasLabel(labels, /^(?:bug|bugfix|defect|fix|regression)$/) ||
    /\b(?:bug|bugfix|crash|defect|fix(?:e[sd])?|regression)\b/i.test(title) ||
    /\b(?:bugfix|bug|crash|defect|regression|reproducible crash|fix(?:e[sd])? (?:a |the )?(?:bug|crash|defect))\b/i.test(
      body
    )
  ) {
    return {
      workType: "bugfix",
      confidence: "medium",
      reasoning: "A bug-specific label or conservative bug/regression phrase is present.",
    };
  }

  if (
    hasLabel(labels, /^(?:refactor|refactoring)$/) ||
    /\b(?:refactor|refactoring)\b/i.test(title)
  ) {
    return {
      workType: "refactor",
      confidence: "medium",
      reasoning: "A refactor label or title identifies behavior-preserving restructuring.",
    };
  }

  return {
    workType: "feature",
    confidence: "low",
    reasoning: "No higher-confidence task signal was found; feature is the conservative default.",
  };
}

function finding(
  severity: Severity,
  category: string,
  dimension: ReviewDimension,
  description: string,
  paths: string[],
  reason: string,
  suggestion: string
): StructuredReviewFinding {
  return { severity, category, dimension, description, paths, reason, suggestion };
}

function hasDetailedPrefixedLine(body: string, prefixes: RegExp): boolean {
  return body.split(/\r?\n/).some((line) => {
    const match = line.match(prefixes);
    return Boolean(match?.[1] && match[1].replace(/\s/g, "").length >= 10);
  });
}

function hasNoTestReason(body: string): boolean {
  return hasDetailedPrefixedLine(
    body,
    /^\s*(?:[-*]\s*)?(?:no tests|testing not required)\s*:\s*(.+)$/i
  );
}

function sectionContents(body: string, names: string): string[] {
  const lines = body.split(/\r?\n/);
  const namePattern = new RegExp(`^(?:${names})\\s*:?$`, "i");
  const inlinePattern = new RegExp(`^\\s*(?:${names})\\s*:\\s*(.*)$`, "i");
  const sections: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
    const inline = line.match(inlinePattern);
    if (!heading && !inline) continue;
    if (heading && !namePattern.test(heading[1] ?? "")) continue;

    const content: string[] = [];
    if (inline?.[1]) content.push(inline[1]);
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor] ?? "";
      if (/^\s*#{1,6}\s+/.test(next)) break;
      content.push(next);
    }
    sections.push(content.join("\n").trim());
  }

  return sections;
}

function hasDetailedSection(body: string, names: string): boolean {
  return sectionContents(body, names).some(
    (content) => content.replace(/\s/g, "").length >= 10
  );
}

function hasConcreteVerificationMethod(content: string): boolean {
  return (
    /\bmarkdownlint\b|\blink[ -]?check(?:er|ing)?\b/i.test(content) ||
    /\b(?:ran|run|executed|verified with|validated with)\s+`?(?:bun|cargo|dotnet|git|go|gradle|make|markdownlint|mvn|node|npm|npx|pnpm|python|pytest|yarn)\b/i.test(
      content
    ) ||
    /\brender(?:ed|ing)?\b[^.\n]*\b(?:doc(?:umentation)?|markdown|page|site)\b/i.test(
      content
    ) ||
    /\b(?:build|built)\b[^.\n]*\b(?:doc(?:umentation)?|example|page|site)\b/i.test(
      content
    ) ||
    /\b(?:checked|validated|verified)\b[^.\n]*\b(?:example|link|markdown|render(?:ed)?|output)\b/i.test(
      content
    )
  );
}

function hasDocsVerification(body: string): boolean {
  const sections = sectionContents(body, "verification|validated");
  return sections.length > 0
    ? sections.some(hasConcreteVerificationMethod)
    : hasConcreteVerificationMethod(body);
}

function hasBugReproduction(body: string): boolean {
  return hasDetailedSection(body, "reproduction|steps? to reproduce|before");
}

function hasFallback(body: string): boolean {
  return hasDetailedSection(body, "rollback|fallback|revert");
}

function hasSecurityValidation(body: string): boolean {
  return (
    hasDetailedSection(body, "security verification|security validation") ||
    /\b(?:codeql|dast|npm audit|penetration test(?:ing)?|sast|security test(?:ing)?|threat model (?:validated|verified))\b/i.test(
      body
    )
  );
}

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const SECRET_ASSIGNMENTS: SecretPattern[] = [
  {
    name: "credential assignment",
    pattern:
      /(?:^|[,{;]\s*|\b(?:const|let|var)\s+)\s*["']?[\w.-]*(?:api[_-]?key|client[_-]?secret|credential|password|private[_-]?key|secret|token)[\w.-]*["']?\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([^\s,;]+))/i,
  },
  {
    name: "AWS access key assignment",
    pattern: /\b[\w.-]+\s*[:=]\s*(?:"(AKIA[0-9A-Z]{16})"|'(AKIA[0-9A-Z]{16})'|`(AKIA[0-9A-Z]{16})`|(AKIA[0-9A-Z]{16}))\b/,
  },
];

function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length < 8 ||
    /(?:process|import\.meta)\.env|\bsecrets\.|(?:os\.)?getenv\s*\(|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Z_][A-Z0-9_]*\b/.test(
      normalized
    ) ||
    /^(?:<[^>]+>|\*+|redacted|fake|your[_ -]|change[_ -]?me|dummy|example|placeholder|sample|test)/i.test(
      normalized
    ) ||
    /^x+$/i.test(normalized) ||
    /^(?:AKIA[0-9A-Z]*EXAMPLE|(?:ghp_|github_pat_|sk-|xox[a-z]-)(?:x+|your(?:[-_ ]|$)|example|dummy|redacted|change[-_ ]?me|placeholder))/i.test(
      normalized
    ) ||
    /(?:_example|example_|your[_ -]?token|not[_ -]?a[_ -]?secret)/i.test(normalized)
  );
}

function isHighConfidenceUnquotedSecret(value: string): boolean {
  const normalized = value.trim();
  if (/^(?:ghp_|github_pat_|sk-|AKIA[0-9A-Z]|xox[a-z]-|eyJ[a-zA-Z0-9_-]*\.)/.test(normalized)) {
    return true;
  }
  if (
    /^(?:undefined|null|true|false)$/i.test(normalized) ||
    /^[A-Za-z_$][\w$]*$/.test(normalized) ||
    /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(normalized) ||
    /[(){}[\]]/.test(normalized)
  ) {
    return false;
  }
  if (normalized.length < 20) return false;

  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(normalized)
  ).length;
  return classes >= 3;
}

type SecretLexicalMode = "code" | "block_comment" | "single" | "double" | "template";

interface SecretLexicalState {
  mode: SecretLexicalMode;
  escaped: boolean;
}

function maskSecretCodeLine(line: string, state: SecretLexicalState): string {
  if (state.mode === "code" && /^(?:\s*#|\s*\*)/.test(line)) return "";
  let code = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    const next = line[index + 1] ?? "";
    if (state.mode === "block_comment") {
      if (character === "*" && next === "/") {
        code += "  ";
        index += 1;
        state.mode = "code";
      } else {
        code += " ";
      }
      continue;
    }
    if (state.mode !== "code") {
      code += " ";
      if (state.escaped) {
        state.escaped = false;
      } else if (character === "\\") {
        state.escaped = true;
      } else if (
        (state.mode === "single" && character === "'") ||
        (state.mode === "double" && character === '"') ||
        (state.mode === "template" && character === "`")
      ) {
        state.mode = "code";
      }
      continue;
    }
    if (character === "/" && next === "/") break;
    if (character === "/" && next === "*") {
      code += "  ";
      index += 1;
      state.mode = "block_comment";
    } else if (character === "'" || character === '"' || character === "`") {
      state.mode =
        character === "'" ? "single" : character === '"' ? "double" : "template";
      state.escaped = false;
      code += " ";
    } else {
      code += character;
    }
  }
  return code;
}

function assignmentIsInCode(match: RegExpMatchArray, codeLine: string): boolean {
  const value = match.slice(1).find((capture) => capture !== undefined);
  if (!value || match.index === undefined) return false;
  const valueOffset = match[0].lastIndexOf(value);
  const prefix = valueOffset >= 0 ? match[0].slice(0, valueOffset) : match[0];
  const operatorOffset = Math.max(prefix.lastIndexOf("="), prefix.lastIndexOf(":"));
  if (operatorOffset < 0) return false;
  const operatorIndex = match.index + operatorOffset;
  return (codeLine[operatorIndex] ?? " ").trim().length > 0;
}

export function scanPatchForSecrets(
  filename: string,
  patch?: string
): StructuredReviewFinding[] {
  if (!patch) return [];
  const normalizedFilename = normalizePath(filename);
  const findings: StructuredReviewFinding[] = [];
  const lexicalState: SecretLexicalState = { mode: "code", escaped: false };

  for (const line of newSidePatchLines(patch)) {
    const codeLine = maskSecretCodeLine(line.text, lexicalState);
    if (!line.added) continue;

    for (const { name, pattern } of SECRET_ASSIGNMENTS) {
      const match = line.text.match(pattern);
      if (!match || !assignmentIsInCode(match, codeLine)) continue;
      const quotedValue = match?.slice(1, 4).find((capture) => capture !== undefined);
      const unquotedValue = match?.[4];
      const value = quotedValue ?? unquotedValue;
      if (!value || isPlaceholderSecret(value)) continue;
      if (!quotedValue && !isHighConfidenceUnquotedSecret(value)) continue;

      findings.push(
        finding(
          "high",
          "SecretLikeAssignment",
          "security",
          `Possible ${name} added in \`${normalizedFilename}\`.`,
          [normalizedFilename],
          "The added patch line assigns a non-placeholder literal to a credential-like name.",
          "Confirm this is not a real credential; if it is, remove and rotate it, then load it from a secret store or environment variable."
        )
      );
      break;
    }
  }

  return findings;
}

interface NewSideLine {
  text: string;
  added: boolean;
}

function newSidePatchLines(patch: string): NewSideLine[] {
  const lines: NewSideLine[] = [];
  for (const rawLine of patch.split(/\r?\n/)) {
    if (
      rawLine.startsWith("@@") ||
      rawLine.startsWith("+++") ||
      rawLine.startsWith("---") ||
      rawLine.startsWith("\\ No newline") ||
      rawLine.startsWith("-")
    ) {
      continue;
    }
    if (rawLine.startsWith("+")) {
      lines.push({ text: rawLine.slice(1), added: true });
    } else if (rawLine.startsWith(" ")) {
      lines.push({ text: rawLine.slice(1), added: false });
    }
  }
  return lines;
}

function addedPatchLines(file: PrFile): string[] | null {
  if (!file.patch) return null;
  return newSidePatchLines(file.patch)
    .filter((line) => line.added)
    .map((line) => line.text);
}

function lexAssertionContent(
  content: string,
  added: boolean[]
): { content: string; meaningfulAdded: boolean[] } {
  type LexicalState = "code" | "single" | "double" | "template" | "line_comment" | "block_comment";
  let state: LexicalState = "code";
  let escaped = false;
  let result = "";
  const meaningfulAdded = Array.from({ length: content.length }, () => false);

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index] ?? "";
    const next = content[index + 1] ?? "";

    if (state === "line_comment") {
      if (character === "\n") {
        state = "code";
        result += "\n";
      } else {
        result += " ";
      }
      continue;
    }
    if (state === "block_comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state !== "code") {
      result += character === "\n" ? "\n" : " ";
      if (
        character !== "\n" &&
        added[index]
      ) {
        meaningfulAdded[index] = true;
      }
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (
        (state === "single" && character === "'") ||
        (state === "double" && character === '"') ||
        (state === "template" && character === "`")
      ) {
        state = "code";
      }
      continue;
    }

    if (character === "/" && next === "/") {
      result += "  ";
      index += 1;
      state = "line_comment";
    } else if (character === "/" && next === "*") {
      result += "  ";
      index += 1;
      state = "block_comment";
    } else if (character === "'") {
      result += " ";
      state = "single";
      meaningfulAdded[index] = Boolean(added[index]);
    } else if (character === '"') {
      result += " ";
      state = "double";
      meaningfulAdded[index] = Boolean(added[index]);
    } else if (character === "`") {
      result += " ";
      state = "template";
      meaningfulAdded[index] = Boolean(added[index]);
    } else {
      result += character;
      meaningfulAdded[index] = Boolean(added[index] && !/\s/.test(character));
    }
  }

  return { content: result, meaningfulAdded };
}

interface NewSideCharacterStream {
  content: string;
  meaningfulAdded: boolean[];
}

function buildNewSideCharacterStream(patch: string): NewSideCharacterStream {
  let content = "";
  const added: boolean[] = [];
  for (const line of newSidePatchLines(patch)) {
    const segment = `${line.text}\n`;
    content += segment;
    added.push(...Array.from({ length: segment.length }, () => line.added));
  }
  return lexAssertionContent(content, added);
}

function skipWhitespace(content: string, start: number): number {
  let cursor = start;
  while (/\s/.test(content[cursor] ?? "")) cursor += 1;
  return cursor;
}

function findClosingParenthesis(content: string, openingIndex: number): number | null {
  let depth = 0;
  for (let cursor = openingIndex; cursor < content.length; cursor += 1) {
    const character = content[cursor];
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return null;
}

function spanContainsMeaningfulAdded(
  meaningfulAdded: boolean[],
  start: number,
  end: number
): boolean {
  for (let cursor = start; cursor <= end; cursor += 1) {
    if (meaningfulAdded[cursor]) return true;
  }
  return false;
}

function hasAddedExpectAssertion(stream: NewSideCharacterStream): boolean {
  const expectCall = /\bexpect\s*\(/g;
  for (const match of stream.content.matchAll(expectCall)) {
    const start = match.index;
    const openingIndex = stream.content.indexOf("(", start);
    const expectClose = findClosingParenthesis(stream.content, openingIndex);
    if (expectClose === null) continue;

    let cursor = expectClose + 1;
    while (cursor < stream.content.length) {
      cursor = skipWhitespace(stream.content, cursor);
      if (stream.content[cursor] !== ".") break;
      cursor = skipWhitespace(stream.content, cursor + 1);
      const nameMatch = stream.content.slice(cursor).match(/^([A-Za-z_$][\w$]*)/);
      const name = nameMatch?.[1];
      if (!name) break;
      cursor += name.length;
      if (["not", "rejects", "resolves"].includes(name)) continue;

      cursor = skipWhitespace(stream.content, cursor);
      if (stream.content[cursor] !== "(") break;
      const matcherClose = findClosingParenthesis(stream.content, cursor);
      if (matcherClose === null) break;
      if (
        !name.toLowerCase().includes("snapshot") &&
        spanContainsMeaningfulAdded(stream.meaningfulAdded, start, matcherClose)
      ) {
        return true;
      }
      break;
    }
  }
  return false;
}

const NODE_ASSERT_METHODS = new Set([
  "deepEqual",
  "deepStrictEqual",
  "doesNotMatch",
  "doesNotReject",
  "doesNotThrow",
  "equal",
  "fail",
  "ifError",
  "match",
  "notDeepEqual",
  "notDeepStrictEqual",
  "notEqual",
  "notStrictEqual",
  "ok",
  "rejects",
  "strictEqual",
  "throws",
]);

function hasAddedNodeAssertion(stream: NewSideCharacterStream): boolean {
  const assertCall = /\bassert(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*\(/g;
  for (const match of stream.content.matchAll(assertCall)) {
    const method = match[1];
    if (method && !NODE_ASSERT_METHODS.has(method)) continue;
    const start = match.index;
    const openingIndex = stream.content.indexOf("(", start);
    const closingIndex = findClosingParenthesis(stream.content, openingIndex);
    if (
      closingIndex !== null &&
      spanContainsMeaningfulAdded(stream.meaningfulAdded, start, closingIndex)
    ) {
      return true;
    }
  }
  return false;
}

function hasNonSnapshotAssertion(file: PrFile): boolean {
  if (!file.patch) return false;
  const stream = buildNewSideCharacterStream(file.patch);
  return hasAddedExpectAssertion(stream) || hasAddedNodeAssertion(stream);
}

function evaluateTestEvidence(
  workType: SdlcWorkType,
  body: string,
  classified: ClassifiedPrFiles,
  findings: StructuredReviewFinding[]
): TestCoverageSignal {
  const changedPaths = classified.allFiles.map((file) => file.filename);
  const hasNonSnapshotTests = classified.nonSnapshotTestFiles.length > 0;
  const hasSnapshotTests = classified.snapshotTestFiles.length > 0;
  const noTestReason = hasNoTestReason(body);

  if (workType === "docs") {
    if (hasDocsVerification(body)) return "not_required";
    findings.push(
      finding(
        "medium",
        "MissingDocsVerification",
        "evidence",
        "Documentation changes do not include a reviewable verification method.",
        classified.docsFiles.map((file) => file.filename),
        "Docs-only work does not need code tests, but still needs Markdown, link, example, or command verification.",
        "Add a Verification or Validated section naming the command or manual documentation check performed."
      )
    );
    return "insufficient_evidence";
  }

  if (workType === "bugfix") {
    const regressionTestPaths = classified.nonSnapshotTestFiles
      .filter(hasNonSnapshotAssertion)
      .map((file) => file.filename);
    const hasRegressionAssertion = regressionTestPaths.length > 0;
    if (!hasBugReproduction(body)) {
      findings.push(
        finding(
          "high",
          "MissingReproduction",
          "intent",
          "The bugfix does not include a concrete reproduction or before-state.",
          changedPaths,
          "A reviewer cannot confirm that the change addresses the reported failure without reproduction evidence.",
          "Add a Reproduction, Steps to reproduce, or Before section with the failing behavior."
        )
      );
    }
    if (!hasRegressionAssertion) {
      const hasUnavailableTestPatch = classified.nonSnapshotTestFiles.some(
        (file) => addedPatchLines(file) === null
      );
      findings.push(
        finding(
          "high",
          "MissingRegressionTest",
          "evidence",
          "The bugfix does not include a non-snapshot regression test.",
          classified.testFiles.map((file) => file.filename),
          hasUnavailableTestPatch
            ? "The changed test patch is unavailable, so a non-snapshot regression assertion cannot be verified."
            : hasSnapshotTests || hasNonSnapshotTests
              ? "Snapshot-only updates do not demonstrate the repaired behavior with a focused assertion."
              : "No changed non-snapshot test protects the repaired behavior from regression.",
          "Add or update a focused unit or integration test that fails before the fix and passes after it."
        )
      );
      return hasSnapshotTests || hasNonSnapshotTests
        ? "insufficient_evidence"
        : "missing";
    }
    return "adequate";
  }

  if (hasNonSnapshotTests) return "adequate";
  if (noTestReason) return "not_required";

  findings.push(
    finding(
      "high",
      "MissingTests",
      "evidence",
      "The change has no non-snapshot test evidence or qualified no-test explanation.",
      changedPaths,
      hasSnapshotTests
        ? "Only snapshot evidence changed, which is insufficient for behavior coverage."
        : "No changed test file demonstrates the new or preserved behavior.",
      "Add a focused unit/integration test, or include `No tests:` / `Testing not required:` followed by a specific reviewable reason."
    )
  );
  return hasSnapshotTests ? "insufficient_evidence" : "missing";
}

const SEMVER_SOURCE = "([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)";

interface ReleaseVersionSource {
  path: string;
  version: string | null;
}

function isReleaseVersionSource(filename: string): boolean {
  const lower = normalizePath(filename).toLowerCase();
  const basename = lower.split("/").at(-1) ?? lower;
  return (
    basename === "package.json" ||
    basename === "server.json" ||
    /(?:^|\/)version\.[cm]?[jt]s$/.test(lower)
  );
}

function extractReleaseTargetVersions(title: string, body: string): string[] {
  const versions: string[] = [];
  const hasReleaseTitleSemantics = /^\s*(?:(?:chore|build)\((?:release|publish)\)|(?:release|publish))(?:\s*:|\b)/i.test(
    title
  );
  if (hasReleaseTitleSemantics) {
    const titleVersions = new RegExp(`\\bv?${SEMVER_SOURCE}\\b`, "gi");
    for (const match of title.matchAll(titleVersions)) {
      if (match[1]) versions.push(match[1]);
    }
  }

  const declaration = new RegExp(
    `^\\s*(?:[-*]\\s*)?(?:release target|target version|publish version|release version)\\s*:\\s*v?${SEMVER_SOURCE}\\s*$`,
    "gim"
  );
  for (const match of body.matchAll(declaration)) {
    if (match[1]) versions.push(match[1]);
  }
  return versions;
}

function extractAddedReleaseVersion(file: PrFile): string | null {
  const lines = addedPatchLines(file);
  if (!lines) return null;
  const lower = file.filename.toLowerCase();
  const basename = lower.split("/").at(-1) ?? lower;
  const matcher =
    basename === "package.json" || basename === "server.json"
      ? new RegExp(`^[\\s]*["']version["']\\s*:\\s*["']v?${SEMVER_SOURCE}["']`, "i")
      : new RegExp(
          `\\b(?:server_info\\s*\\.\\s*)?(?:server_)?version\\b[^\\n]*?["'\`]v?${SEMVER_SOURCE}["'\`]`,
          "i"
        );

  for (const line of lines) {
    const match = line.match(matcher);
    if (match?.[1]) return match[1];
  }
  return null;
}

function addReleaseVersionFindings(
  title: string,
  body: string,
  classified: ClassifiedPrFiles,
  findings: StructuredReviewFinding[]
): void {
  const versionFiles = classified.allFiles.filter((file) =>
    isReleaseVersionSource(file.filename)
  );
  const sources: ReleaseVersionSource[] = versionFiles.map((file) => ({
    path: file.filename,
    version: extractAddedReleaseVersion(file),
  }));
  const unverifiable = sources.filter((source) => source.version === null);

  if (unverifiable.length > 0) {
    findings.push(
      finding(
        "high",
        "UnverifiedReleaseVersion",
        "policy",
        "One or more changed release version sources have no verifiable added version.",
        unverifiable.map((source) => source.path),
        "A missing or truncated patch prevents the reviewer from confirming the version that will be published.",
        "Provide the complete patch and update the explicit package/server/runtime version field to the intended release target."
      )
    );
  }

  const verified = sources.filter(
    (source): source is ReleaseVersionSource & { version: string } => source.version !== null
  );
  const distinctVersions = new Set(verified.map((source) => source.version));
  if (distinctVersions.size > 1) {
    findings.push(
      finding(
        "high",
        "InconsistentReleaseVersions",
        "policy",
        "Changed release version sources do not agree on one artifact version.",
        verified.map((source) => source.path),
        `The patch contains multiple release versions: ${[...distinctVersions].join(", ")}.`,
        "Align every package, server metadata, and runtime version source to the same semantic version."
      )
    );
  }

  const targets = [...new Set(extractReleaseTargetVersions(title, body))];
  if (targets.length !== 1) return;
  const target = targets[0];
  if (!target) return;
  const mismatched = verified.filter((source) => source.version !== target);
  if (mismatched.length > 0) {
    findings.push(
      finding(
        "high",
        "ReleaseVersionMismatch",
        "policy",
        `The changed release metadata does not match the declared target version ${target}.`,
        mismatched.map((source) => source.path),
        `The mismatched sources contain ${[...new Set(mismatched.map((source) => source.version))].join(", ")}.`,
        `Update these version sources to ${target}, or correct the declared release target before publishing.`
      )
    );
  }
}

function addWorkTypeEvidenceFindings(
  workType: SdlcWorkType,
  title: string,
  body: string,
  classified: ClassifiedPrFiles,
  findings: StructuredReviewFinding[]
): void {
  const paths = classified.allFiles.map((file) => file.filename);

  if ((workType === "release" || workType === "infra") && !hasDocsVerification(body)) {
    findings.push(
      finding(
        "high",
        "MissingOperationalVerification",
        "evidence",
        `${workType === "release" ? "Release" : "Infrastructure"} work lacks explicit verification evidence.`,
        paths,
        "Operational changes need a named command or validation procedure before merge.",
        "Add a Verification section with the command or environment validation performed."
      )
    );
  }

  if ((workType === "release" || workType === "infra") && !hasFallback(body)) {
    findings.push(
      finding(
        "high",
        "MissingFallback",
        "fallback",
        `${workType === "release" ? "Release" : "Infrastructure"} work lacks a detailed rollback or fallback.`,
        paths,
        "High-impact operational changes need an executable recovery path, not an empty heading.",
        "Add a Rollback, Fallback, or Revert section with concrete recovery steps."
      )
    );
  }

  if (workType === "release") {
    const targets = [...new Set(extractReleaseTargetVersions(title, body))];
    if (targets.length === 0) {
      findings.push(
        finding(
          "high",
          "MissingReleaseVersion",
          "policy",
          "Release work does not identify the version being published.",
          paths,
          "The version is required to compare source metadata, release configuration, and the intended artifact.",
          "Declare `Release target: x.y.z` in the PR body or name the release version explicitly in the title."
        )
      );
    } else if (targets.length > 1) {
      findings.push(
        finding(
          "high",
          "ConflictingReleaseTargets",
          "policy",
          "The PR declares more than one release target version.",
          paths,
          `Explicit release targets conflict: ${targets.join(", ")}.`,
          "Choose one release target and align the PR title, body declaration, and changed version sources."
        )
      );
    }
    addReleaseVersionFindings(title, body, classified, findings);
  }

  if (workType === "infra" && classified.workflowFiles.length > 0) {
    if (!/\b(?:pull_request|push|schedule|trigger(?:ed|s)?|workflow_dispatch)\b|\bon\s*:/i.test(body)) {
      findings.push(
        finding(
          "high",
          "MissingWorkflowTrigger",
          "policy",
          "Workflow work does not document the intended trigger conditions.",
          classified.workflowFiles.map((file) => file.filename),
          "A reviewer cannot determine when the changed automation will run.",
          "Describe the exact events, branches, paths, or schedules that should trigger the workflow."
        )
      );
    }
    if (!/\b(?:error path|fail(?:ed|s|ure)?|timeout|cancelled|canceled)\b/i.test(body)) {
      findings.push(
        finding(
          "high",
          "MissingWorkflowFailurePath",
          "fallback",
          "Workflow work does not describe failure behavior.",
          classified.workflowFiles.map((file) => file.filename),
          "Operational automation needs an explicit failure path so partial or stalled execution is reviewable.",
          "Describe failure, timeout, and cancellation behavior and how an operator should recover."
        )
      );
    }
  }

  if (workType === "security") {
    const requirements: Array<[RegExp, string, string]> = [
      [/\b(?:threat|attack|vulnerability|risk)\b/i, "MissingThreatAnalysis", "threat or risk"],
      [/\b(?:access|authorization|permission|privilege)\b/i, "MissingPermissionAnalysis", "permission impact"],
      [/\b(?:credential|key|secret|token)\b/i, "MissingSecretAnalysis", "credential and secret handling"],
    ];
    for (const [pattern, category, subject] of requirements) {
      if (pattern.test(body)) continue;
      findings.push(
        finding(
          "high",
          category,
          "security",
          `Security work does not document ${subject}.`,
          paths,
          `The approved security review standard requires an explicit ${subject} assessment.`,
          `Document the ${subject} and the evidence used to validate it.`
        )
      );
    }
    if (!hasSecurityValidation(body)) {
      findings.push(
        finding(
          "high",
          "MissingSecurityValidation",
          "security",
          "Security work does not describe security-specific validation.",
          paths,
          "General test files do not prove that the identified threat or permission boundary was validated.",
          "Document a security verification method such as a focused abuse-case test, CodeQL/SAST result, audit, or threat-model validation."
        )
      );
    }
  }
}

function addSecurityFocusedFindings(
  classified: ClassifiedPrFiles,
  findings: StructuredReviewFinding[]
): void {
  if (classified.envFiles.length > 0) {
    findings.push(
      finding(
        "critical",
        "EnvironmentFileChanged",
        "security",
        "An environment configuration file is included in the change.",
        classified.envFiles.map((file) => file.filename),
        "Environment files can contain deploy-time credentials or private configuration.",
        "Confirm no real secret is present, keep runtime environment files ignored, and rotate any exposed credential."
      )
    );
  }

  for (const file of classified.allFiles) {
    findings.push(...scanPatchForSecrets(file.filename, file.patch));
  }

  if (classified.lockFiles.length > 0) {
    findings.push(
      finding(
        "medium",
        "LockfileChanged",
        "security",
        "A dependency lockfile changed.",
        classified.lockFiles.map((file) => file.filename),
        "Dependency resolution changed and may alter the shipped software supply chain.",
        "Review the dependency diff and run the ecosystem's vulnerability audit before release."
      )
    );
  }

  if (classified.generatedFiles.length > 0) {
    findings.push(
      finding(
        "medium",
        "GeneratedArtifactChanged",
        "scope",
        "Generated or built artifacts are included in the change.",
        classified.generatedFiles.map((file) => file.filename),
        "Generated output is harder to review and can conceal behavior not evident in source changes.",
        "Verify the artifacts are intentionally versioned and reproducible from reviewed source."
      )
    );
  }
}

function addSecretScannerEvidenceFinding(
  evidence: SecretScannerEvidence,
  findings: StructuredReviewFinding[]
): void {
  const issue = secretScannerPolicyFinding(evidence);
  if (!issue) return;
  findings.push(
    finding(
      issue.severity,
      issue.category,
      "security",
      issue.description,
      [],
      issue.reason,
      issue.suggestion
    )
  );
}

function addStrictFindings(
  classified: ClassifiedPrFiles,
  totalChangedLines: number,
  findings: StructuredReviewFinding[]
): void {
  if (totalChangedLines <= 800) return;
  findings.push(
    finding(
      "medium",
      "LargeChangeScope",
      "scope",
      `The PR changes ${totalChangedLines} lines, which is difficult to review as one unit.`,
      classified.allFiles.map((file) => file.filename),
      "Large diffs increase the chance that intent, tests, or security-sensitive details are missed during review.",
      "Split independent concerns into smaller PRs, or document why this change must remain atomic."
    )
  );
}

function calculateReleaseRisk(
  findings: StructuredReviewFinding[],
  classified: ClassifiedPrFiles
): ReleaseRisk {
  if (findings.some((item) => item.severity === "critical")) return "critical";
  if (
    findings.some((item) => item.severity === "high") ||
    classified.workflowFiles.length > 0 ||
    classified.authSecurityFiles.length > 0 ||
    classified.releaseFiles.length > 0 ||
    classified.lockFiles.length > 0
  ) {
    return "high";
  }
  if (findings.some((item) => item.severity === "medium")) return "moderate";
  return "low";
}

function calculateConclusion(
  findings: StructuredReviewFinding[]
): ReviewEvaluationResult["conclusion"] {
  if (findings.some((item) => item.severity === "critical" || item.severity === "high")) {
    return "needs_changes";
  }
  if (findings.some((item) => item.severity === "medium")) return "risky_but_acceptable";
  return "pass";
}

function sortFindings(findings: StructuredReviewFinding[]): StructuredReviewFinding[] {
  return [...findings].sort(
    (left, right) =>
      SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity)
  );
}

export function evaluatePullRequestReview(
  input: ReviewEvaluationInput
): ReviewEvaluationResult {
  const classified = classifyPrFiles(input.files);
  const inferred = inferWorkType(input.pr, classified.allFiles);
  const workType = input.workType ?? inferred.workType;
  const workTypeConfidence = input.workType ? "high" : inferred.confidence;
  const workTypeReasoning = input.workType
    ? `The caller explicitly selected the ${input.workType} work type.`
    : inferred.reasoning;
  const body = input.pr.body ?? "";
  const findings: StructuredReviewFinding[] = [...(input.policyFindings ?? [])];
  const standard = input.standard ?? "basic";
  const suppliedSecretScannerEvidence =
    input.secretScannerEvidence ??
    unverifiedSecretScannerEvidence(
      "The security-focused review did not receive CI evidence from a mature secret scanner."
    );
  const scannerPolicyChanged = classified.allFiles.some(
    (file) =>
      isSecretScannerPolicyPath(file.filename) ||
      (file.previousFilename !== undefined &&
        isSecretScannerPolicyPath(file.previousFilename))
  );
  const effectiveSecretScannerEvidence: SecretScannerEvidence =
    suppliedSecretScannerEvidence.status === "passing" && scannerPolicyChanged
      ? {
          ...unverifiedSecretScannerEvidence(
            "The PR changes secret-scanner workflow or configuration policy, so its supplied passing evidence is not trusted."
          ),
          providers: suppliedSecretScannerEvidence.providers,
          signals: suppliedSecretScannerEvidence.signals,
        }
      : suppliedSecretScannerEvidence;
  const totalChangedLines = classified.allFiles.reduce(
    (total, file) => total + (file.changes ?? (file.additions ?? 0) + (file.deletions ?? 0)),
    0
  );

  if (input.pr.draft) {
    findings.push(
      finding(
        "info",
        "Status",
        "scope",
        "PR is still marked as a draft.",
        [],
        "Draft status indicates that the author has not yet declared the change ready for final review.",
        "Mark the PR as ready for review when the implementation and evidence are complete."
      )
    );
  }

  if (input.pr.commits > 20) {
    findings.push(
      finding(
        "low",
        "Hygiene",
        "scope",
        `PR has ${input.pr.commits} commits -- consider squashing for cleaner history.`,
        [],
        "A very large commit count makes review history and later investigation harder to follow.",
        "Squash closely related fixup commits while preserving meaningful reviewable milestones."
      )
    );
  }

  if (body.trim().length < 20) {
    findings.push(
      finding(
        "high",
        "MissingIntent",
        "intent",
        "The PR description does not provide enough intent for review.",
        [],
        "A short or empty body does not explain why the change is needed or how it should be evaluated.",
        "Explain the problem, intended outcome, and relevant constraints in the PR description."
      )
    );
  }

  const testCoverageSignal = evaluateTestEvidence(workType, body, classified, findings);
  addWorkTypeEvidenceFindings(workType, input.pr.title, body, classified, findings);
  if (standard === "strict" || standard === "security-focused") {
    addStrictFindings(classified, totalChangedLines, findings);
  }
  if (standard === "security-focused") {
    addSecretScannerEvidenceFinding(effectiveSecretScannerEvidence, findings);
    addSecurityFocusedFindings(classified, findings);
  }

  const sortedFindings = sortFindings(findings);
  return {
    workType,
    workTypeConfidence,
    workTypeReasoning,
    findings: sortedFindings,
    releaseRisk: calculateReleaseRisk(sortedFindings, classified),
    testCoverageSignal,
    conclusion: calculateConclusion(sortedFindings),
    hasTests: classified.testFiles.length > 0,
    totalChangedLines,
    secretScannerEvidence:
      standard === "security-focused" ? effectiveSecretScannerEvidence : null,
  };
}
