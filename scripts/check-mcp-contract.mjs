import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collectRawMcpContract } from "./lib/mcp-contract-client.mjs";
import { V1_9_0_CONTRACT_SOURCE } from "./lib/mcp-contract-source.mjs";
import { verifyPinnedContractTag } from "./lib/pinned-mcp-contract.mjs";
import {
  createManifestDiffArtifact,
  writeJsonArtifactAtomic,
} from "./lib/release-artifacts.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const baselinePath = path.join(projectRoot, "contracts", "mcp", "v1.9.0.json");

function printChanges(label, changes) {
  if (changes.length === 0) return;
  console.log(`${label}:`);
  for (const change of changes) {
    console.log(`- [${change.code}] ${change.path}: ${change.message}`);
  }
}

async function main() {
  const baselineText = await fs.readFile(baselinePath, "utf8");
  const baseline = JSON.parse(baselineText);
  if (
    baseline.schemaVersion !== 1 ||
    baseline.source?.tag !== V1_9_0_CONTRACT_SOURCE.tag ||
    baseline.source?.commit !== V1_9_0_CONTRACT_SOURCE.commit ||
    baseline.source?.releaseUrl !== V1_9_0_CONTRACT_SOURCE.releaseUrl
  ) {
    throw new Error("MCP contract baseline has invalid schema or source provenance.");
  }
  verifyPinnedContractTag({
    projectRoot,
    tag: V1_9_0_CONTRACT_SOURCE.tag,
    expectedCommit: V1_9_0_CONTRACT_SOURCE.commit,
  });

  const contractModule = await import(
    pathToFileURL(
      path.join(projectRoot, "dist", "contracts", "mcp-manifest.js")
    ).href
  );
  const rawCurrent = await collectRawMcpContract(projectRoot);
  const current = contractModule.createMcpContractManifest(
    rawCurrent,
    baseline.source
  );
  const comparison = contractModule.compareMcpContracts(baseline, current);

  await writeJsonArtifactAtomic(
    path.join(projectRoot, "artifacts", "contracts", "manifest-diff.json"),
    createManifestDiffArtifact({
      baseline: baseline.source,
      toolCount: current.tools.length,
      resourceCount: current.resources.length,
      breaking: comparison.breaking,
      nonBreaking: comparison.nonBreaking,
    })
  );

  printChanges("Breaking contract changes", comparison.breaking);
  printChanges("Compatible contract changes", comparison.nonBreaking);
  if (comparison.breaking.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `MCP contract compatible: ${current.tools.length} tools, ${current.resources.length} resources, baseline ${baseline.source.tag}@${baseline.source.commit}.`
  );
}

await main();
