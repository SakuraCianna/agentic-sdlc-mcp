import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = fileURLToPath(
  new URL("../../../scripts/check-line-endings.mjs", import.meta.url)
);

describe("line-ending quality gate", () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ));
  });

  it("accepts LF text and rejects CRLF or mixed text without echoing file contents", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agentic-sdlc-eol-"));
    tempDirectories.push(directory);
    const lf = path.join(directory, "lf.ts");
    const crlf = path.join(directory, "crlf.ts");
    const mixed = path.join(directory, "mixed.md");
    await writeFile(lf, "first\nsecond\n", "utf8");
    await writeFile(crlf, "secret-crlf\r\nsecond\r\n", "utf8");
    await writeFile(mixed, "secret-mixed\r\nsecond\n", "utf8");

    const passing = spawnSync(process.execPath, [SCRIPT_PATH, lf], { encoding: "utf8" });
    expect(passing.status).toBe(0);

    const failing = spawnSync(process.execPath, [SCRIPT_PATH, crlf, mixed], { encoding: "utf8" });
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain(crlf);
    expect(failing.stderr).toContain(mixed);
    expect(failing.stderr).not.toContain("secret-crlf");
    expect(failing.stderr).not.toContain("secret-mixed");
  });
});
