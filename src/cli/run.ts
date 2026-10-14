import { readFile, stat, mkdir, writeFile, appendFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import { parseCliArguments, parseRepository, positiveInteger, CliUsageError } from "./arguments.js";
import { diagnose } from "./doctor.js";
import { createCliGithubClient } from "./github-client.js";
import { assessPullRequest, PrAssessmentSchema, renderPrAssessment } from "../assessment/pr-assessment.js";
import { compareEvidencePackets, type ContinuityContext } from "../assessment/continuity.js";
import { extractAcceptanceCriteria, evaluateAcceptanceTraceability, AcceptanceMappingsSchema } from "../assessment/acceptance.js";
import { EvidencePacketSchema, type EvidencePacket } from "../evidence/model.js";
import { collectSdlcEvidencePacket, SdlcEvidencePacketInputSchema } from "../tools/sdlc-evidence-packet.js";
import { AbortableTimeoutError, withAbortableTimeout } from "../evidence/timeout.js";
import { createReadOnlyGithubSession } from "../assessment/github-session.js";
import { SERVER_INFO } from "../version.js";
import { handleGitHubError } from "../github/client.js";
import { safeMarkdownInline } from "../rendering/markdown.js";

export const CLI_HELP = `agentic-sdlc — read-only workflow evidence

  doctor [--repo owner/repo] [--online] [--json]
  assess-pr --repo owner/repo --pr N [--standard basic|strict|security-focused]
            [--json] [--output new.json] [--summary new.md] [--enforce]
  evidence --repo owner/repo --subject pr|issue|release [--number N|--ref REF]
           [--json] [--output new.json]
  diff --previous old.json --current new.json [--json] [--output diff.json]
  trace --packet evidence.json --acceptance criteria.md [--mappings links.json]
        [--source markdown|issue|speckit|openspec] [--json] [--output trace.json]

assess-pr/evidence also accept --previous, --acceptance, --mappings and --source.
Online commands accept --timeout-ms (1–120000). Assess/evidence accept
--max-requests (2–500).
GITHUB_TOKEN is read from the environment only. Files are never overwritten.
Exit: 0 completed/advisory; 1 enforced PR blocked; 2 invalid/config/unverified;
      130 cancelled. No command approves, merges, deploys or creates Issues.
`;

interface CliDependencies { env?: NodeJS.ProcessEnv; client?: Octokit; stdout?: (value: string) => void; stderr?: (value: string) => void; signal?: AbortSignal }
const MAX_INPUT_BYTES = 1_048_576;

async function boundedRead(path: string): Promise<string> {
  if ((await stat(path)).size > MAX_INPUT_BYTES) throw new CliUsageError("Input file exceeds the 1 MiB limit.");
  const content = await readFile(path, "utf8");
  if (Buffer.byteLength(content, "utf8") > MAX_INPUT_BYTES) throw new CliUsageError("Input file exceeds the 1 MiB limit.");
  return content;
}

async function jsonRead(path: string): Promise<unknown> {
  try { return JSON.parse(await boundedRead(path)) as unknown; }
  catch (error) { if (error instanceof CliUsageError) throw error; throw new CliUsageError("Cannot read a valid JSON input file."); }
}

function packetFrom(value: unknown): { packet: EvidencePacket; context?: ContinuityContext } {
  const assessment = PrAssessmentSchema.safeParse(value);
  if (assessment.success) return { packet: assessment.data.packet, context: { headSha: assessment.data.subject.headSha, baseSha: assessment.data.subject.baseSha, policyDigest: assessment.data.policyDigest, toolVersion: assessment.data.generatorVersion } };
  const envelope = value && typeof value === "object" && "packet" in value ? (value as { packet: unknown }).packet : value;
  return { packet: EvidencePacketSchema.parse(envelope) };
}

async function saveNew(path: string, contents: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  try { await writeFile(path, contents, { encoding: "utf8", flag: "wx" }); }
  catch { throw new CliUsageError("Cannot create output file. Choose a writable path that does not already exist."); }
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const started = performance.now();
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? ((value) => process.stdout.write(value));
  const stderr = dependencies.stderr ?? ((value) => process.stderr.write(value));
  let json = argv.includes("--json");
  try {
    const args = parseCliArguments(argv);
    json = args.flags.has("json");
    if (args.command === "help" || args.flags.has("help")) { stdout(CLI_HELP); return 0; }
    if (args.command === "version") { stdout(`${SERVER_INFO.version}\n`); return 0; }
    const value = (name: string) => args.values.get(name);
    const required = (name: string): string => { const result = value(name); if (!result) throw new CliUsageError(`--${name} is required.`); return result; };
    const timeoutMs = positiveInteger(value("timeout-ms"), "timeout-ms", 30_000, 120_000);
    const maxRequests = positiveInteger(value("max-requests"), "max-requests", 120, 500);
    if (maxRequests < 2) throw new CliUsageError("max-requests must be at least 2.");
    const inputPaths = ["previous", "current", "packet", "acceptance", "mappings"].flatMap((name) => value(name) ? [resolve(value(name)!)] : []);
    const output = value("output");
    const summaryPath = value("summary");
    if ([output, summaryPath].some((path) => path && inputPaths.includes(resolve(path))) || (output && summaryPath && resolve(output) === resolve(summaryPath))) throw new CliUsageError("Output and input paths must be different.");
    let result: unknown;
    let markdown: string;
    let exitCode = 0;
    const repository = value("repo") ?? (env["GITHUB_OWNER"] && env["GITHUB_REPO"] ? `${env["GITHUB_OWNER"]}/${env["GITHUB_REPO"]}` : undefined);
    if (args.command === "doctor") {
      const ref = repository ? parseRepository(repository) : undefined;
      const report = await diagnose({ env, ref, online: args.flags.has("online"), timeoutMs, signal: dependencies.signal }, dependencies.client ?? (args.flags.has("online") ? createCliGithubClient(env["GITHUB_TOKEN"]) : undefined));
      result = report;
      markdown = [`# Diagnostics: ${SERVER_INFO.version}`, `Status: ${report.status}`, ...report.checks.map((check) => `- ${check.id}: ${check.state} — ${check.action}`), ...report.limitations].join("\n");
      exitCode = report.status === "ready" ? 0 : 2;
    } else if (args.command === "diff") {
      const previous = packetFrom(await jsonRead(required("previous")));
      const current = packetFrom(await jsonRead(required("current")));
      result = compareEvidencePackets(previous.packet, current.packet, { previousContext: previous.context, currentContext: current.context });
      markdown = `# Evidence comparison\n\n${JSON.stringify(result, null, 2)}\n`;
      exitCode = (result as { comparison: string }).comparison === "valid" ? 0 : 2;
    } else if (args.command === "trace") {
      const { packet } = packetFrom(await jsonRead(required("packet")));
      const source = z.enum(["markdown", "issue", "speckit", "openspec"]).parse(value("source") ?? "markdown");
      const criteria = extractAcceptanceCriteria(await boundedRead(required("acceptance")), { kind: source });
      const mappings = value("mappings") ? AcceptanceMappingsSchema.parse(await jsonRead(value("mappings")!)) : [];
      result = evaluateAcceptanceTraceability({ criteria, evidence: packet, mappings });
      markdown = `# Acceptance traceability\n\n${JSON.stringify(result, null, 2)}\n`;
    } else {
      const ref = parseRepository(repository);
      if (!env["GITHUB_TOKEN"]?.trim() && !dependencies.client) throw new CliUsageError("Inject GITHUB_TOKEN before collecting repository evidence.");
      const client = dependencies.client ?? createCliGithubClient(env["GITHUB_TOKEN"]);
      let packet: EvidencePacket;
      let context: ContinuityContext | undefined;
      if (args.command === "assess-pr") {
        const pullNumber = positiveInteger(required("pr"), "pr");
        const standard = z.enum(["basic", "strict", "security-focused"]).parse(value("standard") ?? "basic");
        const currentCheck = env["SDLC_CURRENT_CHECK_RUN_ID"] ? {
          checkRunId: positiveInteger(env["SDLC_CURRENT_CHECK_RUN_ID"], "current check identity"),
          runId: positiveInteger(env["GITHUB_RUN_ID"], "current workflow identity"),
        } : undefined;
        if (currentCheck && (env["GITHUB_ACTIONS"] !== "true" || env["GITHUB_REPOSITORY"]?.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase())) throw new CliUsageError("Current-check exclusion requires matching GitHub Actions repository identity.");
        const assessment = await assessPullRequest({ ref, pullNumber, standard, timeoutMs, maxRequests, signal: dependencies.signal, currentCheck }, client);
        result = assessment; packet = assessment.packet;
        context = { headSha: assessment.subject.headSha, baseSha: assessment.subject.baseSha, policyDigest: assessment.policyDigest, toolVersion: assessment.generatorVersion };
        markdown = renderPrAssessment(assessment);
        if (args.flags.has("enforce")) exitCode = assessment.decision === "ready_for_review" ? 0 : assessment.decision === "blocked" ? 1 : 2;
      } else {
        const subject = required("subject");
        if (!["pr", "issue", "release"].includes(subject)) throw new CliUsageError("subject must be pr, issue or release.");
        const parsedSubject = subject === "release" ? { type: "release", ref: required("ref") } : subject === "pr" ? { type: "pull_request", pullNumber: positiveInteger(required("number"), "number") } : { type: "issue", issueNumber: positiveInteger(required("number"), "number") };
        if ((subject === "release" && value("number")) || (subject !== "release" && value("ref"))) throw new CliUsageError("number and ref must match the selected subject.");
        packet = await withAbortableTimeout("Evidence collection", timeoutMs, async (signal) => {
          const session = createReadOnlyGithubSession(client, { signal, maxRequests });
          return collectSdlcEvidencePacket(SdlcEvidencePacketInputSchema.parse({ subject: parsedSubject }), ref, session.client, undefined, signal);
        }, dependencies.signal);
        result = packet;
        markdown = `# Evidence snapshot\n\nSubject: ${safeMarkdownInline(packet.subject.repo)}\n\nDigest: ${packet.contentDigest}\n\n${packet.evidence.map((item) => `- ${safeMarkdownInline(item.id)}: ${item.state} / ${item.freshness} / ${item.completeness}`).join("\n")}\n`;
      }
      if (value("previous") || value("acceptance")) {
        const additions: Record<string, unknown> = {};
        if (value("previous")) {
          const previous = packetFrom(await jsonRead(value("previous")!));
          additions["continuity"] = compareEvidencePackets(previous.packet, packet, { previousContext: previous.context, currentContext: context });
        }
        if (value("acceptance")) {
          const source = z.enum(["markdown", "issue", "speckit", "openspec"]).parse(value("source") ?? "markdown");
          const criteria = extractAcceptanceCriteria(await boundedRead(value("acceptance")!), { kind: source });
          const mappings = value("mappings") ? AcceptanceMappingsSchema.parse(await jsonRead(value("mappings")!)) : [];
          additions["acceptance"] = evaluateAcceptanceTraceability({ criteria, evidence: packet, mappings });
        }
        result = args.command === "assess-pr" ? { ...(result as object), ...additions } : { packet, ...additions };
        markdown += `\n\n## Evidence continuity and acceptance\n\n${JSON.stringify(additions, null, 2)}\n`;
      }
    }
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_INPUT_BYTES) throw new CliUsageError("Result exceeds the 1 MiB output limit.");
    if (output) await saveNew(output, serialized);
    if (summaryPath) {
      if (env["GITHUB_ACTIONS"] === "true" && env["GITHUB_STEP_SUMMARY"] && resolve(summaryPath) === resolve(env["GITHUB_STEP_SUMMARY"])) await appendFile(summaryPath, `${markdown}\n`, "utf8");
      else await saveNew(summaryPath, `${markdown}\n`);
    }
    stdout(json ? serialized : `${markdown}\n`);
    return exitCode;
  } catch (error) {
    const cancelled = dependencies.signal?.aborted;
    const timedOut = error instanceof AbortableTimeoutError;
    const message = error instanceof CliUsageError ? error.message : error instanceof z.ZodError ? "Input did not match the supported schema." : handleGitHubError(error);
    if (json) stdout(`${JSON.stringify({ error: { code: cancelled ? "cancelled" : timedOut ? "timeout" : "invalid_or_unavailable", message }, metrics: { timedOut, cancelled: Boolean(cancelled), degraded: true, durationMs: Math.round(performance.now() - started) } })}\n`);
    else stderr(`${message}\n`);
    return cancelled ? 130 : 2;
  }
}
