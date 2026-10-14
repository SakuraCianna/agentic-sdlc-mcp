import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContractCollectorEnvironment } from "../../scripts/lib/pinned-mcp-contract.mjs";
import { inspectReleaseTarball, prepareRelease, validateReleaseSbom } from "../../scripts/prepare-release.mjs";

const directories: string[] = [];
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sdlc-release-")); directories.push(root);
  const pkg = {
    name: "release-fixture", version: "1.11.0", mcpName: "io.example/release-fixture", type: "module",
    main: "dist/index.js", bin: { "fixture-cli": "dist/cli.js" },
    files: ["dist", "server.json", ".env.example"],
    scripts: { prepack: "node -e \"require('node:fs').writeFileSync('LIFECYCLE-RAN','unsafe')\"" },
    dependencies: { "runtime-fixture": "1.0.0" }, devDependencies: { "dev-fixture": "2.0.0" },
  };
  const lock = {
    name: pkg.name, version: pkg.version, lockfileVersion: 3,
    packages: {
      "": { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies },
      "node_modules/runtime-fixture": { version: "1.0.0", resolved: "https://registry.npmjs.org/runtime-fixture/-/runtime-fixture-1.0.0.tgz" },
      "node_modules/dev-fixture": { version: "2.0.0", resolved: "https://registry.npmjs.org/dev-fixture/-/dev-fixture-2.0.0.tgz", dev: true },
    },
  };
  const server = { name: pkg.mcpName, version: pkg.version, packages: [{ identifier: pkg.name, version: pkg.version }] };
  await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "dist"));
  for (const [file, value] of Object.entries({ "package.json": pkg, "package-lock.json": lock, "server.json": server })) await fs.writeFile(path.join(root, file), JSON.stringify(value));
  await fs.writeFile(path.join(root, "src/version.ts"), `export const SERVER_INFO = { version: "1.11.0" };\n`);
  await fs.writeFile(path.join(root, "dist/version.js"), `export const SERVER_INFO = { version: "1.11.0" };\n`);
  await fs.writeFile(path.join(root, "dist/index.js"), "export const server = true;\n");
  await fs.writeFile(path.join(root, "dist/cli.js"), "#!/usr/bin/env node\nconsole.log('fixture');\n");
  await fs.writeFile(path.join(root, ".env.example"), "GITHUB_TOKEN=\n");
  await fs.writeFile(path.join(root, ".env"), "PRIVATE_FIXTURE=do-not-package\n");
  await fs.writeFile(path.join(root, ".gitignore"), "artifacts/\n.env\n");
  const emptyGitConfig = path.join(root, ".fixture-gitconfig");
  await fs.writeFile(emptyGitConfig, "");
  for (const args of [
    ["init", "--initial-branch=feature/release-fixture"], ["add", "."],
    ["-c", "user.name=Release Fixture", "-c", "user.email=fixture@example.test", "commit", "--no-gpg-sign", "-m", "Fixture"],
  ]) execFileSync("git", args, { cwd: root, windowsHide: true, stdio: "pipe", env: { ...createContractCollectorEnvironment(), GIT_CONFIG_GLOBAL: emptyGitConfig, GIT_CONFIG_NOSYSTEM: "1" } });
  return { root, pkg, lock, server };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    const absolute = path.resolve(directory);
    if (!absolute.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Fixture cleanup escaped temp directory.");
    await fs.rm(absolute, { recursive: true, force: true });
  }
});

describe("release artifact preparation with the installed npm CLI", () => {
  it("creates a real version-consistent tarball, production SBOM and content-bound manifest without lifecycle scripts or credentials", async () => {
    const f = await fixture();
    vi.stubEnv("GITHUB_TOKEN", "release-secret-canary"); vi.stubEnv("NODE_OPTIONS", "--invalid-parent-option");
    const result = await prepareRelease({ projectRoot: f.root, outputName: "reviewable-release" });
    expect(result.manifest.package).toEqual({ name: f.pkg.name, version: f.pkg.version });
    expect(result.manifest.git).toEqual({ head: expect.stringMatching(/^[a-f0-9]{40}$/), dirty: false });
    expect(result.manifest.source.files.map((file) => file.path)).toEqual(["package-lock.json", "package.json", "server.json", "src/version.ts"]);
    for (const file of result.manifest.source.files) expect(file.sha256).toBe(sha256(await fs.readFile(path.join(f.root, file.path))));
    expect(result.manifest.source.digest).toBe(sha256(JSON.stringify(result.manifest.source.files)));
    for (const artifact of result.manifest.artifacts) {
      const bytes = await fs.readFile(path.join(result.outputDirectory, artifact.path));
      expect(artifact.sha256).toBe(sha256(bytes)); expect(artifact.bytes).toBe(bytes.length);
      expect(bytes.toString("utf8")).not.toContain("release-secret-canary");
    }
    const archive = result.manifest.artifacts.find((artifact) => artifact.path.endsWith(".tgz"))!;
    const files = inspectReleaseTarball(await fs.readFile(path.join(result.outputDirectory, archive.path)));
    expect(JSON.parse(files.get("package.json")!.toString()).version).toBe("1.11.0");
    expect(files.has(".env")).toBe(false); expect(files.has(".env.example")).toBe(true);
    expect([...files].some(([name]) => /(?:__tests__|node_modules|\.npmrc)/.test(name))).toBe(false);
    expect([...files.values()].some((bytes) => bytes.toString().includes("do-not-package"))).toBe(false);
    await expect(fs.access(path.join(f.root, "LIFECYCLE-RAN"))).rejects.toThrow();
    const sbom = JSON.parse(await fs.readFile(path.join(result.outputDirectory, "sbom.cyclonedx.json"), "utf8"));
    expect(sbom.bomFormat).toBe("CycloneDX"); expect(sbom.metadata.component.version).toBe("1.11.0");
    expect(sbom.metadata.component["bom-ref"]).toBe("release-fixture@1.11.0");
    expect(sbom.metadata.component.purl).toBe("pkg:npm/release-fixture@1.11.0");
    expect(sbom.components.map((component: { name: string }) => component.name)).toContain("runtime-fixture");
    expect(sbom.components.map((component: { name: string }) => component.name)).not.toContain("dev-fixture");
    expect(await fs.readdir(result.outputDirectory)).not.toContain(".npm-user.rc");
    const manifestBytes = await fs.readFile(path.join(result.outputDirectory, "manifest.sha256.json"));
    await expect(prepareRelease({ projectRoot: f.root, outputName: "reviewable-release" })).rejects.toThrow(/already exists|overwritten/);
    expect(await fs.readFile(path.join(result.outputDirectory, "manifest.sha256.json"))).toEqual(manifestBytes);
  }, 30_000);

  it.each(["lock", "server", "source"])("rejects inconsistent %s versions before creating an output directory", async (change) => {
    const f = await fixture();
    if (change === "lock") await fs.writeFile(path.join(f.root, "package-lock.json"), JSON.stringify({ ...f.lock, version: "0.0.0" }));
    if (change === "server") await fs.writeFile(path.join(f.root, "server.json"), JSON.stringify({ ...f.server, version: "0.0.0" }));
    if (change === "source") await fs.writeFile(path.join(f.root, "src/version.ts"), 'export const version = "0.0.0";');
    await expect(prepareRelease({ projectRoot: f.root })).rejects.toThrow(/metadata must agree/);
    await expect(fs.access(path.join(f.root, "artifacts"))).rejects.toThrow();
  });

  it.each(["../outside", "E:\\outside", "/absolute", ".", "..", "a/b"])("rejects output path %s", async (outputName) => {
    const f = await fixture();
    await expect(prepareRelease({ projectRoot: f.root, outputName })).rejects.toThrow(/single safe directory/);
    await expect(fs.access(path.join(f.root, "artifacts"))).rejects.toThrow();
  });

  it("refuses an artifact-directory junction before creating anything outside the project", async () => {
    const f = await fixture(); const outside = await fs.mkdtemp(path.join(os.tmpdir(), "sdlc-release-outside-")); directories.push(outside);
    await fs.symlink(outside, path.join(f.root, "artifacts"), process.platform === "win32" ? "junction" : "dir");
    await expect(prepareRelease({ projectRoot: f.root })).rejects.toThrow(/without symbolic links/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("rejects test payloads accidentally added to the package allowlist", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.root, "dist/__tests__"));
    await fs.writeFile(path.join(f.root, "dist/__tests__/private.test.js"), "private-test-canary");
    await expect(prepareRelease({ projectRoot: f.root, outputName: "unsafe-test-package" })).rejects.toThrow(/forbidden or undeclared/);
    await expect(fs.access(path.join(f.root, "artifacts/release/unsafe-test-package/manifest.sha256.json"))).rejects.toThrow();
  }, 30_000);

  it("rejects a stale compiled version even when source metadata agrees", async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.root, "dist/version.js"), 'export const version = "0.0.0";');
    await expect(prepareRelease({ projectRoot: f.root, outputName: "stale-build" })).rejects.toThrow(/inconsistent; rebuild/);
  }, 30_000);
});

describe("cross-version npm SBOM package identity", () => {
  const expected = { name: "release-fixture", version: "1.11.0", projectRoot: path.join(os.tmpdir(), "different-checkout-name") };
  const valid = () => ({ bomFormat: "CycloneDX", metadata: { component: { name: expected.name, version: expected.version, "bom-ref": "release-fixture@1.11.0", purl: "pkg:npm/release-fixture@1.11.0" } } });

  it("accepts canonical npm 12 package names and actual npm 10/11 root directory display names", () => {
    const canonical = valid();
    expect(() => validateReleaseSbom(canonical, expected)).not.toThrow();
    const legacy = valid(); legacy.metadata.component.name = path.basename(expected.projectRoot);
    expect(() => validateReleaseSbom(legacy, expected)).not.toThrow();
  });

  it("accepts the documented legacy name-from-folder behavior under a scoped parent", () => {
    const scopedRoot = path.join(os.tmpdir(), "@checkout-scope", "different-checkout-name");
    const sbom = valid(); sbom.metadata.component.name = "@checkout-scope/different-checkout-name";
    expect(() => validateReleaseSbom(sbom, { ...expected, projectRoot: scopedRoot })).not.toThrow();
  });

  it("binds scoped npm package names to their exact bom-ref and encoded npm purl", () => {
    const sbom = valid();
    sbom.metadata.component = { name: "@team/release-fixture", version: expected.version, "bom-ref": "@team/release-fixture@1.11.0", purl: "pkg:npm/%40team/release-fixture@1.11.0" };
    expect(() => validateReleaseSbom(sbom, { ...expected, name: "@team/release-fixture" })).not.toThrow();
    sbom.metadata.component.purl = "pkg:npm/%40other/release-fixture@1.11.0";
    expect(() => validateReleaseSbom(sbom, { ...expected, name: "@team/release-fixture" })).toThrow(/SBOM metadata/);
  });

  it.each([
    { name: "unrelated-package" },
    { version: "0.0.0" },
    { "bom-ref": "unrelated-package@1.11.0" },
    { "bom-ref": "release-fixture@0.0.0" },
    { "bom-ref": undefined },
    { purl: "pkg:npm/unrelated-package@1.11.0" },
    { purl: "pkg:npm/release-fixture@0.0.0" },
    { purl: undefined },
  ])("rejects mismatched or missing identity data %j even when other fields are correct", (change) => {
    const sbom = valid(); Object.assign(sbom.metadata.component, change);
    expect(() => validateReleaseSbom(sbom, expected)).toThrow(/SBOM metadata/);
  });

  it("does not let a valid legacy display name override a different package identity", () => {
    const sbom = valid(); sbom.metadata.component.name = path.basename(expected.projectRoot);
    sbom.metadata.component["bom-ref"] = "unrelated-package@1.11.0";
    expect(() => validateReleaseSbom(sbom, expected)).toThrow(/SBOM metadata/);
  });

  it.each([null, {}, { bomFormat: "SPDX" }, { bomFormat: "CycloneDX", metadata: { component: null } }])("rejects malformed SBOM metadata %j", (sbom) => {
    expect(() => validateReleaseSbom(sbom, expected)).toThrow(/SBOM metadata/);
  });
});

describe("tarball inspection never extracts untrusted paths", () => {
  function tarball(name: string, type = "0") {
    const header = Buffer.alloc(512);
    header.write(name); header.write("00000000002\0", 124); header.write(type, 156); header.fill(32, 148, 156);
    const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    return gzipSync(Buffer.concat([header, Buffer.from("{}"), Buffer.alloc(510 + 1024)]));
  }
  it.each(["package/../escape", "outside/file", "package/dir\\escape"])("rejects unsafe path %s", (name) => {
    expect(() => inspectReleaseTarball(tarball(name))).toThrow(/unsafe path/);
  });
  it.each(["1", "2", "3"])("rejects link or device entry type %s", (type) => {
    expect(() => inspectReleaseTarball(tarball("package/file", type))).toThrow(/links and special/);
  });
  it("rejects a checksum-corrupted header", () => {
    const content = gunzipSync(tarball("package/package.json")); content[0] = 0;
    expect(() => inspectReleaseTarball(gzipSync(content))).toThrow(/checksum/);
  });
  it("rejects truncated archives and hidden payload after the end marker", () => {
    const content = gunzipSync(tarball("package/package.json"));
    expect(() => inspectReleaseTarball(gzipSync(content.subarray(0, content.length - 1)))).toThrow(/truncated/);
    content[content.length - 1] = 1;
    expect(() => inspectReleaseTarball(gzipSync(content))).toThrow(/end marker|trailing payload/);
  });
});
