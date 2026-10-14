#!/usr/bin/env node
import { runCli } from "./cli/run.js";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
