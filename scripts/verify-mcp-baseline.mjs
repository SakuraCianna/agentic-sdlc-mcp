import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collectPinnedMcpContract } from "./lib/pinned-mcp-contract.mjs";
import { V1_9_0_CONTRACT_SOURCE } from "./lib/mcp-contract-source.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const baselinePath = path.join(projectRoot, "contracts", "mcp", "v1.9.0.json");

async function main() {
  const baselineText = await fs.readFile(baselinePath, "utf8");
  const contractModule = await import(
    pathToFileURL(
      path.join(projectRoot, "dist", "contracts", "mcp-manifest.js")
    ).href
  );
  const pinnedRaw = await collectPinnedMcpContract({
    projectRoot,
    tag: V1_9_0_CONTRACT_SOURCE.tag,
    expectedCommit: V1_9_0_CONTRACT_SOURCE.commit,
  });
  const regeneratedBaseline = contractModule.createMcpContractManifest(
    pinnedRaw,
    V1_9_0_CONTRACT_SOURCE
  );
  const regeneratedText = `${JSON.stringify(regeneratedBaseline, null, 2)}\n`;
  if (baselineText !== regeneratedText) {
    throw new Error(
      "Tracked MCP baseline differs from a fresh immutable v1.9.0 discovery. Run npm run contracts:generate and review the resulting diff."
    );
  }
  console.log(
    `MCP baseline verified from immutable ${V1_9_0_CONTRACT_SOURCE.tag}@${V1_9_0_CONTRACT_SOURCE.commit}.`
  );
}

await main();
