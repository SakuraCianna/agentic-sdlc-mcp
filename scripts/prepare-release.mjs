import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_TAR_BYTES = 64 * 1024 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sorted = (values) => [...values].sort();
const portable = (value) => value.split(path.sep).join("/");

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function regularFile(root, relative) {
  const absolute = path.resolve(root, relative);
  if (!inside(root, absolute)) throw new Error("Release input path escapes the project.");
  const info = await fs.lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Release inputs must be regular files without symbolic links.");
  return fs.readFile(absolute);
}

async function treeFiles(root, relative) {
  const directory = path.resolve(root, relative);
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Release source directories must not be symbolic links.");
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Release source directories must not contain symbolic links.");
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await treeFiles(root, child));
    else if (entry.isFile()) files.push(portable(child));
    else throw new Error("Release source contains an unsupported file type.");
  }
  return sorted(files);
}

function childEnvironment() {
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ"]);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase()))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : devNull };
}

async function npmCliPath() {
  const executableDirectory = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(executableDirectory, "../lib/node_modules/npm/bin/npm-cli.js"),
    ...(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).flatMap((entry) => [path.join(entry, "npm"), path.join(entry, "node_modules/npm/bin/npm-cli.js")]),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const resolved = await fs.realpath(candidate);
      if (path.basename(resolved) === "npm-cli.js") return resolved;
    } catch { /* Try the next standard npm installation location. */ }
  }
  throw new Error("Cannot locate npm-cli.js. Run this script through npm run release:prepare.");
}

function run(command, args, cwd, env) {
  try {
    return execFileSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: MAX_TAR_BYTES, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch {
    throw new Error("A release preparation command failed; no publish command was run. Check the local build, Git metadata and npm installation.");
  }
}

function numberField(header, offset, length) {
  const text = header.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(text)) throw new Error("Tarball has an invalid numeric header.");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error("Tarball numeric header exceeds supported bounds.");
  return value;
}

function paxPath(bytes) {
  let offset = 0;
  let result;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    const sizeText = bytes.subarray(offset, space).toString("ascii");
    const size = Number(sizeText);
    if (space < offset || !/^[1-9]\d*$/.test(sizeText) || !Number.isSafeInteger(size) || size <= space - offset || offset + size > bytes.length) throw new Error("Tarball PAX metadata is invalid.");
    const record = bytes.subarray(space + 1, offset + size).toString("utf8");
    if (!record.endsWith("\n")) throw new Error("Tarball PAX metadata is incomplete.");
    if (/^(?:size|linkpath|GNU\.sparse[^=]*)=/.test(record)) throw new Error("Tarball has unsupported PAX file-size or link metadata.");
    if (record.startsWith("path=")) result = record.slice(5, -1);
    offset += size;
  }
  return result;
}

/** Inspect tar bytes without extracting any path to the filesystem. */
export function inspectReleaseTarball(bytes) {
  const archive = gunzipSync(bytes, { maxOutputLength: MAX_TAR_BYTES });
  if (archive.length % 512 !== 0) throw new Error("Tarball is truncated.");
  const files = new Map();
  let pendingPath;
  let terminated = false;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > archive.length || !archive.subarray(offset).every((byte) => byte === 0)) throw new Error("Tarball has an invalid end marker or trailing payload.");
      terminated = true;
      break;
    }
    const checksum = [...header].reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== numberField(header, 148, 8)) throw new Error("Tarball header checksum is invalid.");
    const size = numberField(header, 124, 12);
    const start = offset + 512;
    if (start + size > archive.length) throw new Error("Tarball is truncated.");
    const content = archive.subarray(start, start + size);
    const type = header.subarray(156, 157).toString("ascii");
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    if (type === "x") pendingPath = paxPath(content);
    else {
      const fullPath = pendingPath ?? (prefix ? `${prefix}/${name}` : name);
      pendingPath = undefined;
      if (!fullPath.startsWith("package/") || fullPath.includes("\\") || fullPath.includes("\0") || fullPath.split("/").some((part) => part === ".." || part === ".")) throw new Error("Tarball contains an unsafe path.");
      if (type !== "0" && type !== "\0" && type !== "5") throw new Error("Tarball links and special entries are forbidden.");
      if (type !== "5") {
        const relative = fullPath.slice("package/".length);
        if (!relative || files.has(relative)) throw new Error("Tarball has a duplicate or empty file path.");
        files.set(relative, content);
      }
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (files.size === 0 || pendingPath !== undefined || !terminated) throw new Error("Tarball contains no complete package files.");
  return files;
}

function allowedPackagePath(relative, packageFiles) {
  if (relative === ".env.example") return true;
  const segments = relative.split("/");
  if (segments.some((segment) => /^(?:\.env(?:\..*)?|\.git|\.npmrc|\.agentic-sdlc-mcp\.json|node_modules|__tests__|tests?|fixtures?|coverage|artifacts)$/i.test(segment)) || /\.(?:pem|key|p12|pfx)$/i.test(relative)) return false;
  if (["package.json", "README.md", "LICENSE"].includes(relative)) return true;
  return packageFiles.some((entry) => typeof entry === "string" && !entry.includes("*") && (entry === relative || relative.startsWith(`${entry.replace(/\/$/, "")}/`)));
}

async function sourceSnapshot(root) {
  const paths = sorted(["package.json", "package-lock.json", "server.json", ...await treeFiles(root, "src")]);
  const files = [];
  for (const relative of paths) files.push({ path: relative, sha256: hash(await regularFile(root, relative)) });
  return { digest: hash(JSON.stringify(files)), files };
}

/** Prepare only. Existing paths are never replaced and no package is published. */
export async function prepareRelease({ projectRoot = PROJECT_ROOT, outputName } = {}) {
  const root = await fs.realpath(projectRoot);
  const packageJson = JSON.parse(await regularFile(root, "package.json"));
  const lock = JSON.parse(await regularFile(root, "package-lock.json"));
  const server = JSON.parse(await regularFile(root, "server.json"));
  const versionSource = (await regularFile(root, "src/version.ts")).toString("utf8");
  const version = packageJson.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || lock.version !== version || lock.packages?.[""]?.version !== version ||
      lock.name !== packageJson.name || server.version !== version || server.name !== packageJson.mcpName || !versionSource.includes(`version: "${version}"`) ||
      server.packages?.[0]?.version !== version || server.packages?.[0]?.identifier !== packageJson.name || !Array.isArray(packageJson.files)) throw new Error("Package, lockfile, server and runtime version metadata must agree before packing.");
  const env = childEnvironment();
  const head = run("git", ["rev-parse", "--verify", "HEAD"], root, env).trim();
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error("Git HEAD is not a valid immutable commit identifier.");
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=normal"], root, env).trim().length > 0;
  const snapshot = await sourceSnapshot(root);
  const name = outputName ?? `${version}-${head.slice(0, 12)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || name === "." || name === "..") throw new Error("Output name must be a single safe directory name under artifacts/release.");
  for (const relative of ["artifacts", "artifacts/release"]) {
    const directory = path.join(root, relative);
    try { await fs.mkdir(directory); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !inside(root, await fs.realpath(directory))) throw new Error("Release artifact directories must stay inside the project without symbolic links.");
  }
  const outputDirectory = path.join(root, "artifacts", "release", name);
  try { await fs.mkdir(outputDirectory); } catch { throw new Error("Release output directory already exists or cannot be created; choose a new output name. Nothing was overwritten."); }
  const userConfig = path.join(outputDirectory, ".npm-user.rc");
  const globalConfig = path.join(outputDirectory, ".npm-global.rc");
  await fs.writeFile(userConfig, "", { flag: "wx" });
  await fs.writeFile(globalConfig, "", { flag: "wx" });
  const npmEnvironment = { ...env, npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_cache: path.join(outputDirectory, ".npm-cache"), npm_config_logs_max: "0" };
  try {
    const cli = await npmCliPath();
    const rawPackOutput = JSON.parse(run(process.execPath, [cli, "pack", ".", "--json", "--ignore-scripts", "--offline", "--pack-destination", outputDirectory], root, npmEnvironment));
    // npm 11 returns an array; npm 12's logTar buffers an object keyed by package name.
    const packOutput = Array.isArray(rawPackOutput) ? rawPackOutput : rawPackOutput && typeof rawPackOutput === "object" && Object.keys(rawPackOutput).length === 1 && Object.hasOwn(rawPackOutput, packageJson.name) ? [rawPackOutput[packageJson.name]] : [];
    if (!Array.isArray(packOutput) || packOutput.length !== 1) throw new Error("npm pack must produce exactly one package.");
    const packed = packOutput[0];
    if (packed.name !== packageJson.name || packed.version !== version || typeof packed.filename !== "string" || path.basename(packed.filename) !== packed.filename || !packed.filename.endsWith(".tgz")) throw new Error("Packed npm metadata does not match the intended release.");
    const tarballPath = path.join(outputDirectory, packed.filename);
    const tarball = await regularFile(outputDirectory, packed.filename);
    const files = inspectReleaseTarball(tarball);
    if (JSON.stringify(sorted(files.keys())) !== JSON.stringify(sorted((packed.files ?? []).map((file) => file.path)))) throw new Error("Actual tarball files do not match npm pack metadata.");
    if ([...files.keys()].some((relative) => !allowedPackagePath(relative, packageJson.files))) throw new Error("Tarball contains a forbidden or undeclared file; no release manifest was written.");
    const packaged = JSON.parse(files.get("package.json")?.toString("utf8") ?? "null");
    const packagedServer = JSON.parse(files.get("server.json")?.toString("utf8") ?? "null");
    const packagedVersion = files.get("dist/version.js")?.toString("utf8") ?? "";
    const bins = typeof packageJson.bin === "string" ? [packageJson.bin] : Object.values(packageJson.bin ?? {});
    if (packaged?.version !== version || packaged?.name !== packageJson.name || packagedServer?.version !== version || !packagedVersion.includes(`version: "${version}"`) ||
        !files.has(packageJson.main) || bins.some((bin) => !files.has(bin))) throw new Error("Tarball package, server, runtime or binary entry points are inconsistent; rebuild before preparing a release.");
    const sbom = JSON.parse(run(process.execPath, [cli, "sbom", "--sbom-format", "cyclonedx", "--omit=dev", "--package-lock-only", "--offline"], root, npmEnvironment));
    if (sbom.bomFormat !== "CycloneDX" || sbom.metadata?.component?.name !== packageJson.name || sbom.metadata?.component?.version !== version) throw new Error("SBOM metadata does not match the packed package.");
    if ((await sourceSnapshot(root)).digest !== snapshot.digest || run("git", ["rev-parse", "--verify", "HEAD"], root, env).trim() !== head) throw new Error("Release inputs changed while artifacts were being prepared; no manifest was written.");
    const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);
    await fs.writeFile(path.join(outputDirectory, "sbom.cyclonedx.json"), sbomBytes, { flag: "wx" });
    const manifest = {
      schemaVersion: "1.0", package: { name: packageJson.name, version }, git: { head, dirty },
      source: snapshot, sbomMode: "package-lock-only; omit=dev",
      artifacts: [{ path: path.basename(tarballPath), sha256: hash(tarball), bytes: tarball.length }, { path: "sbom.cyclonedx.json", sha256: hash(sbomBytes), bytes: sbomBytes.length }],
      packageFiles: [...files].map(([relative, content]) => ({ path: relative, sha256: hash(content), bytes: content.length })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      limitations: ["Preparation does not publish, sign or establish a reproducible build. Dirty working-tree inputs are bound by their actual content digests; Git HEAD alone does not identify them."],
    };
    await fs.writeFile(path.join(outputDirectory, "manifest.sha256.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    return { outputDirectory, manifest };
  } finally {
    // Remove only the two empty files created above; never recursively clean output.
    await fs.unlink(userConfig);
    await fs.unlink(globalConfig);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  try {
    if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output-name")) throw new Error("Usage: npm run release:prepare -- --output-name unique-name");
    const result = await prepareRelease({ outputName: args[1] });
    console.log(`Prepared release artifacts: ${result.outputDirectory}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release preparation failed.");
    process.exitCode = 1;
  }
}
