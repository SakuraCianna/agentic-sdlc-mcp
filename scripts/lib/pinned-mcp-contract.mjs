import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveContractTimeout } from "./mcp-contract-client.mjs";

const CHILD_PROCESS_GRACE_MS = 5_000;
const CHILD_PROCESS_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const TEMP_DIRECTORY_MAX_RETRIES = 10;
const TEMP_DIRECTORY_RETRY_DELAY_MS = 250;
const COLLECTOR_ENVIRONMENT_ALLOWLIST = new Set([
  "COMSPEC",
  "DYLD_LIBRARY_PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LD_LIBRARY_PATH",
  "PATH",
  "PATHEXT",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "TZ",
  "WINDIR",
]);

function run(command, args, cwd, stdio = "inherit", env = process.env) {
  return execFileSync(command, args, {
    cwd,
    encoding: stdio === "pipe" ? "utf8" : undefined,
    stdio,
    env,
  });
}

function runNpm(args, cwd) {
  if (process.platform === "win32") {
    return run(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "npm", ...args],
      cwd,
      "inherit",
      createPinnedNpmEnvironment()
    );
  }
  return run("npm", args, cwd, "inherit", createPinnedNpmEnvironment());
}

function normalizePathForComparison(value) {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function createContractCollectorEnvironment(environment = process.env) {
  const sanitized = {};
  for (const [name, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      COLLECTOR_ENVIRONMENT_ALLOWLIST.has(name.toUpperCase())
    ) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

export function createPinnedNpmEnvironment(environment = process.env) {
  const sanitized = {};
  for (const [name, value] of Object.entries(environment)) {
    if (name.toUpperCase() !== "NPM_CONFIG_DRY_RUN") {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

export function isWorktreeListed(porcelainOutput, candidate) {
  const normalizedCandidate = normalizePathForComparison(candidate);
  return String(porcelainOutput)
    .split("\0")
    .filter((record) => record.startsWith("worktree "))
    .some(
      (record) =>
        normalizePathForComparison(record.slice("worktree ".length)) ===
        normalizedCandidate
    );
}

function isRegisteredWorktree(projectRoot, checkoutRoot) {
  try {
    const worktreeList = run(
      "git",
      ["worktree", "list", "--porcelain", "-z"],
      projectRoot,
      "pipe"
    );
    return isWorktreeListed(worktreeList, checkoutRoot);
  } catch {
    // Fail closed: preserve the original worktree-removal error when Git
    // cannot prove that its administrative record was removed.
    return true;
  }
}

function collectRawMcpContractInChild(checkoutRoot, timeoutMs) {
  const collectorScript = fileURLToPath(
    new URL("../collect-mcp-contract.mjs", import.meta.url)
  );
  const output = execFileSync(
    process.execPath,
    [collectorScript, checkoutRoot, String(timeoutMs)],
    {
      // Keep the child outside the checkout it dynamically imports. Windows
      // can retain a just-exited process cwd handle briefly, which otherwise
      // makes the subsequent worktree removal intermittently fail with EBUSY.
      cwd: path.dirname(checkoutRoot),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      timeout: timeoutMs + CHILD_PROCESS_GRACE_MS,
      maxBuffer: CHILD_PROCESS_MAX_BUFFER_BYTES,
      env: createContractCollectorEnvironment(),
      windowsHide: true,
    }
  );
  return JSON.parse(output);
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

export function validatePinnedContractSource({ tag, expectedCommit }) {
  if (!tag.trim()) {
    throw new Error("Pinned MCP contract tag is required.");
  }
  if (!/^[0-9a-f]{40}$/i.test(expectedCommit)) {
    throw new Error(
      "Pinned MCP contract commit must be a full 40-character SHA."
    );
  }
}

export function verifyPinnedContractTag({
  projectRoot,
  tag,
  expectedCommit,
}) {
  validatePinnedContractSource({ tag, expectedCommit });
  const normalizedProjectRoot = path.resolve(projectRoot);
  const resolvedCommit = String(
    run("git", ["rev-parse", `${tag}^{commit}`], normalizedProjectRoot, "pipe")
  ).trim();
  if (resolvedCommit !== expectedCommit) {
    throw new Error(
      `Tag ${tag} resolves to ${resolvedCommit}, expected ${expectedCommit}.`
    );
  }
  return resolvedCommit;
}

export async function collectPinnedMcpContract({
  projectRoot,
  tag,
  expectedCommit,
  timeoutMs,
}) {
  const resolvedTimeoutMs = resolveContractTimeout(timeoutMs);
  const normalizedProjectRoot = path.resolve(projectRoot);
  verifyPinnedContractTag({
    projectRoot: normalizedProjectRoot,
    tag,
    expectedCommit,
  });

  const systemTemp = path.resolve(os.tmpdir());
  const temporaryRoot = await fs.mkdtemp(
    path.join(systemTemp, "agentic-sdlc-contract-")
  );
  const checkoutRoot = path.join(temporaryRoot, "checkout");
  if (!isPathInside(systemTemp, temporaryRoot)) {
    throw new Error("Temporary contract directory escaped the system temp directory.");
  }

  let worktreeAdded = false;
  try {
    run(
      "git",
      ["worktree", "add", "--detach", checkoutRoot, expectedCommit],
      normalizedProjectRoot
    );
    worktreeAdded = true;
    runNpm(
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
      checkoutRoot
    );
    runNpm(["run", "build", "--ignore-scripts"], checkoutRoot);
    return collectRawMcpContractInChild(checkoutRoot, resolvedTimeoutMs);
  } finally {
    let worktreeRemovalError;
    if (worktreeAdded) {
      try {
        run(
          "git",
          ["worktree", "remove", "--force", checkoutRoot],
          normalizedProjectRoot,
          "pipe"
        );
      } catch (error) {
        if (isRegisteredWorktree(normalizedProjectRoot, checkoutRoot)) {
          worktreeRemovalError = error;
        }
      }
    }
    let temporaryRemovalError;
    try {
      if (!isPathInside(systemTemp, temporaryRoot)) {
        throw new Error(
          "Refusing to remove a temporary directory outside system temp."
        );
      }
      await fs.rm(temporaryRoot, {
        recursive: true,
        force: true,
        maxRetries: TEMP_DIRECTORY_MAX_RETRIES,
        retryDelay: TEMP_DIRECTORY_RETRY_DELAY_MS,
      });
    } catch (error) {
      temporaryRemovalError = error;
    }
    if (worktreeRemovalError && temporaryRemovalError) {
      throw new AggregateError(
        [worktreeRemovalError, temporaryRemovalError],
        "Failed to remove the pinned MCP worktree and its temporary directory."
      );
    }
    if (worktreeRemovalError) throw worktreeRemovalError;
    if (temporaryRemovalError) throw temporaryRemovalError;
  }
}
