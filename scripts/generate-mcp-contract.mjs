import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  collectPinnedMcpContract,
  isPathInside,
} from "./lib/pinned-mcp-contract.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

function parseArgs(argv) {
  const options = {
    tag: "",
    expectedCommit: "",
    output: "",
    releaseUrl: "",
    update: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--update") {
      options.update = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}.`);
    }
    if (argument === "--tag") options.tag = value;
    else if (argument === "--expected-commit") options.expectedCommit = value;
    else if (argument === "--output") options.output = value;
    else if (argument === "--release-url") options.releaseUrl = value;
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  if (!options.update) {
    throw new Error(
      "Refusing to write a contract baseline without the explicit --update flag."
    );
  }
  if (
    !options.tag ||
    !/^[0-9a-f]{40}$/i.test(options.expectedCommit) ||
    !options.output ||
    !/^https:\/\/github\.com\//i.test(options.releaseUrl)
  ) {
    throw new Error(
      "Required arguments: --tag, --expected-commit <full SHA>, --release-url, --output, --update."
    );
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputPath = path.resolve(projectRoot, options.output);
  const contractsRoot = path.resolve(projectRoot, "contracts", "mcp");
  if (!isPathInside(contractsRoot, outputPath)) {
    throw new Error("Contract output must stay inside contracts/mcp.");
  }

  const rawSnapshot = await collectPinnedMcpContract({
    projectRoot,
    tag: options.tag,
    expectedCommit: options.expectedCommit,
  });
  const module = await import(
    pathToFileURL(
      path.join(projectRoot, "dist", "contracts", "mcp-manifest.js")
    ).href
  );
  const manifest = module.createMcpContractManifest(rawSnapshot, {
    tag: options.tag,
    commit: options.expectedCommit,
    releaseUrl: options.releaseUrl,
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(
    `Wrote ${manifest.tools.length} tools and ${manifest.resources.length} resources to ${path.relative(
      projectRoot,
      outputPath
    )}.`
  );
}

await main();
