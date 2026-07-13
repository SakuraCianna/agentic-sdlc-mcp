import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".cjs", ".css", ".example", ".html", ".js", ".json", ".md", ".mjs",
  ".ps1", ".sh", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const TEXT_FILENAMES = new Set([
  ".editorconfig", ".env.example", ".gitattributes", ".gitignore", "LICENSE",
]);

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split(/\r?\n/u)
    .filter(Boolean);
}

function isTextCandidate(file) {
  const basename = path.basename(file);
  return TEXT_FILENAMES.has(basename) || TEXT_EXTENSIONS.has(path.extname(basename).toLowerCase());
}

const explicitFiles = process.argv.slice(2);
const files = (explicitFiles.length > 0 ? explicitFiles : trackedFiles()).filter(isTextCandidate);
const violations = [];

for (const file of files) {
  const content = await readFile(file);
  if (content.includes(0)) continue;
  if (content.includes(13)) violations.push(file);
}

if (violations.length > 0) {
  console.error("Line-ending check failed; tracked text must use LF:");
  for (const file of violations) console.error(`- ${file}`);
  process.exitCode = 1;
}
