export interface ReleaseManifest {
  schemaVersion: "1.0";
  package: { name: string; version: string };
  git: { head: string; dirty: boolean };
  source: { digest: string; files: { path: string; sha256: string }[] };
  sbomMode: string;
  artifacts: { path: string; sha256: string; bytes: number }[];
  packageFiles: { path: string; sha256: string; bytes: number }[];
  limitations: string[];
}
export function inspectReleaseTarball(bytes: Buffer): Map<string, Buffer>;
export function validateReleaseSbom(sbom: unknown, expected: { name: string; version: string; projectRoot: string }): void;
export function prepareRelease(options?: { projectRoot?: string; outputName?: string }): Promise<{ outputDirectory: string; manifest: ReleaseManifest }>;
