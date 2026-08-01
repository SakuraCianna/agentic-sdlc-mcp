import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  INSPECTOR_PLACEHOLDER_TOKEN,
  INSPECTOR_VERSION,
  assertInspectorOutputIsSafe,
  createInspectorEnvironment,
  createInspectorStdioArguments,
  parseInspectorJsonOutput,
} from "../../../scripts/run-inspector-contracts.mjs";

describe("Inspector contract runner", () => {
  it("pins Inspector 2 and builds an explicit ad-hoc stdio target", () => {
    const harnessPath = path.resolve("scripts", "fixtures", "deny-external-fetch.mjs");
    const environment = createInspectorEnvironment({
      parentEnvironment: { HOME: "C:\\Users\\Example", PATH: "C:\\Windows\\System32" },
      storageDirectory: path.resolve("inspector-state"),
      harnessPath,
    });
    const argumentsList = createInspectorStdioArguments({
      method: "tools/list",
      projectRoot: path.resolve("project-root"),
      serverEnvironment: environment,
    });

    expect(INSPECTOR_VERSION).toBe("2.0.0");
    expect(argumentsList).toContain("--cli");
    expect(argumentsList).toContain("tools/list");
    expect(argumentsList).toContain(path.join(path.resolve("project-root"), "dist", "index.js"));
    expect(argumentsList).not.toContain("--config");
    expect(argumentsList).not.toContain("--catalog");
    expect(argumentsList).toContain(`GITHUB_TOKEN=${INSPECTOR_PLACEHOLDER_TOKEN}`);
    expect(argumentsList).toContain(`NODE_OPTIONS=--import=${pathToFileURL(harnessPath).href}`);
    expect(argumentsList).toContain(
      `MCP_INSPECTOR_HARNESS_MARKER_PATH=${path.join(path.resolve("inspector-state"), "server-harness.marker")}`
    );
  });

  it("removes inherited credentials, isolates Inspector state, and preserves HOME", () => {
    const harnessPath = path.resolve("scripts", "fixtures", "deny-external-fetch.mjs");
    const environment = createInspectorEnvironment({
      parentEnvironment: {
        HOME: "C:\\Users\\Example",
        PATH: "C:\\Windows\\System32",
        GITHUB_TOKEN: "real-token",
        GH_TOKEN: "real-gh-token",
        GITHUB_PAT: "real-pat",
        MCP_CATALOG_PATH: "C:\\Users\\Example\\default-catalog.json",
        NODE_OPTIONS: "--inspect",
      },
      storageDirectory: path.resolve("inspector-state"),
      harnessPath,
    });

    expect(environment.HOME).toBe("C:\\Users\\Example");
    expect(environment.GITHUB_TOKEN).toBe(INSPECTOR_PLACEHOLDER_TOKEN);
    expect(environment.GITHUB_OWNER).toBe("inspector-fixture-owner");
    expect(environment.GITHUB_REPO).toBe("inspector-fixture-repo");
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GITHUB_PAT).toBeUndefined();
    expect(environment.MCP_CATALOG_PATH).toBeUndefined();
    expect(environment.MCP_STORAGE_DIR).toBe(path.resolve("inspector-state"));
    expect(environment.MCP_CLIENT_CONFIG_PATH).toBe(
      path.join(path.resolve("inspector-state"), "client.json")
    );
    expect(environment.MCP_INSPECTOR_OAUTH_STATE_PATH).toBe(
      path.join(path.resolve("inspector-state"), "oauth.json")
    );
    expect(environment.MCP_INSPECTOR_HARNESS_MARKER_PATH).toBe(
      path.join(path.resolve("inspector-state"), "server-harness.marker")
    );
    expect(environment.NODE_OPTIONS).toBe(`--import=${pathToFileURL(harnessPath).href}`);
  });

  it("accepts exactly one JSON object and rejects banners or empty output", () => {
    expect(parseInspectorJsonOutput('{"result":{"tools":[]}}\n')).toEqual({
      result: { tools: [] },
    });
    expect(() => parseInspectorJsonOutput('banner\n{"result":{}}')).toThrow(
      "exactly one JSON object"
    );
    expect(() => parseInspectorJsonOutput("  ")).toThrow("empty stdout");
  });

  it("fails closed when a placeholder or inherited secret canary reaches output", () => {
    expect(() => assertInspectorOutputIsSafe("clean json", "clean stderr")).not.toThrow();
    expect(() =>
      assertInspectorOutputIsSafe(`token=${INSPECTOR_PLACEHOLDER_TOKEN}`, "")
    ).toThrow("credential canary");
    expect(() => assertInspectorOutputIsSafe("", "real-token", ["real-token"])).toThrow(
      "credential canary"
    );
  });

  it("blocks the global config path and deceptive DNS fetch/socket targets", () => {
    const harnessPath = path.resolve("scripts", "fixtures", "deny-external-fetch.mjs");
    const environment = createInspectorEnvironment({
      parentEnvironment: process.env,
      storageDirectory: path.resolve("inspector-state"),
      harnessPath,
    });
    delete environment.NODE_OPTIONS;
    const script = `
      const fsSync = (await import("node:fs")).default;
      const net = (await import("node:net")).default;
      const os = await import("node:os");
      const path = await import("node:path");
      fsSync.existsSync = () => true;
      globalThis.fetch = () => Promise.reject(new Error("original-fetch-reached"));
      net.createConnection = () => { throw new Error("original-socket-reached"); };
      net.connect = net.createConnection;
      await import(${JSON.stringify(pathToFileURL(harnessPath).href)});
      const globalConfig = path.join(os.homedir(), ".agentic-sdlc-mcp.json");
      const otherPath = path.join(os.homedir(), "other-file.json");
      const configBlocked = fsSync.existsSync(globalConfig) === false;
      const otherPathPreserved = fsSync.existsSync(otherPath) === true;
      let fetchBlocked = false;
      let socketBlocked = false;
      try {
        await fetch("https://127.attacker.example/should-not-resolve");
      } catch (error) {
        fetchBlocked = /network access is disabled/i.test(String(error));
      }
      try {
        net.connect({ host: "127.attacker.example", port: 443 });
      } catch (error) {
        socketBlocked = /network access is disabled/i.test(String(error));
      }
      process.exit(configBlocked && otherPathPreserved && fetchBlocked && socketBlocked ? 0 : 1);
    `;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        encoding: "utf8",
        env: environment,
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
        windowsHide: true,
      }
    );

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("");
  });
});
