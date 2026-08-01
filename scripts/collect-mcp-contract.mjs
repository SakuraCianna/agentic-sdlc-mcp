import path from "node:path";

import {
  collectRawMcpContract,
  resolveContractTimeout,
} from "./lib/mcp-contract-client.mjs";

async function main(argv) {
  if (argv.length < 1 || argv.length > 2) {
    throw new Error(
      "Usage: node scripts/collect-mcp-contract.mjs <project-root> [timeout-ms]"
    );
  }

  const projectRoot = path.resolve(argv[0]);
  const timeoutMs = resolveContractTimeout(
    argv[1] === undefined ? undefined : Number(argv[1])
  );
  const contract = await collectRawMcpContract(projectRoot, { timeoutMs });
  process.stdout.write(`${JSON.stringify(contract)}\n`);
}

await main(process.argv.slice(2));
