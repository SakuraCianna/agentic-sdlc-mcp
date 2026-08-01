import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertInspectorDiscoveryMatches,
  classifyInspectorFailure,
  createInspectorDeadline,
  createInspectorEnvironment,
  createInspectorHttpArguments,
  normalizeInspectorDiscovery,
  parseInspectorRunnerArguments,
  startInspectorAuthChallengeServer,
  startInspectorHttpServer,
} from "../../../scripts/run-inspector-contracts.mjs";

describe("Inspector loopback HTTP contract runner", () => {
  it("compares complete normalized tool and resource discovery JSON", () => {
    const stdio = normalizeInspectorDiscovery(
      {
        tools: [
          {
            name: "z_tool",
            inputSchema: { type: "object", properties: { value: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
          { name: "a_tool", inputSchema: { type: "object" } },
        ],
      },
      {
        resources: [
          { uri: "sdlc://z", name: "Z", mimeType: "text/markdown" },
          { uri: "sdlc://a", name: "A", mimeType: "text/markdown" },
        ],
      }
    );
    const http = normalizeInspectorDiscovery(
      {
        tools: [
          { inputSchema: { type: "object" }, name: "a_tool" },
          {
            annotations: { readOnlyHint: true },
            inputSchema: { properties: { value: { type: "string" } }, type: "object" },
            name: "z_tool",
          },
        ],
      },
      {
        resources: [
          { mimeType: "text/markdown", name: "A", uri: "sdlc://a" },
          { mimeType: "text/markdown", name: "Z", uri: "sdlc://z" },
        ],
      }
    );

    expect(() => assertInspectorDiscoveryMatches(http, stdio)).not.toThrow();
    const drifted = structuredClone(http);
    drifted.tools[1].inputSchema = { type: "object" };
    expect(() => assertInspectorDiscoveryMatches(drifted, stdio)).toThrow(
      "complete tools/resources JSON"
    );
  });

  it("keeps a hard deadline referenced until it fires", () => {
    const runnerUrl = pathToFileURL(
      path.resolve("scripts", "run-inspector-contracts.mjs")
    ).href;
    const child = spawnSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `import { createInspectorDeadline } from ${JSON.stringify(runnerUrl)};
       createInspectorDeadline(25, "deadline-fired").promise.catch((error) => {
         process.stdout.write(error.message);
       });`,
    ], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("deadline-fired");
    expect(child.stderr).toBe("");

    const cancelled = createInspectorDeadline(2_000, "must-not-fire");
    cancelled.cancel();
  });

  it("classifies only the exact Windows Inspector HTTP shutdown abort", () => {
    const errorEnvelope = '{"error":{"code":"tool_not_found","message":"missing"}}';
    const closingAssertion =
      "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\\win\\async.c, line 94";

    expect(classifyInspectorFailure({
      exitCode: 5,
      stderr: `${errorEnvelope}\n`,
      expectedExitCode: 5,
      expectedErrorCode: "tool_not_found",
      platform: "linux",
      label: "unknown tool",
    })).toEqual({
      code: "tool_not_found",
      exitClass: "expected",
      rawExitCode: 5,
    });
    expect(classifyInspectorFailure({
      exitCode: 0xc0000409,
      stderr: `${errorEnvelope}\n${closingAssertion}\n`,
      expectedExitCode: 5,
      expectedErrorCode: "tool_not_found",
      platform: "win32",
      label: "unknown tool",
    })).toEqual({
      code: "tool_not_found",
      exitClass: "known_windows_inspector_abort",
      rawExitCode: 0xc0000409,
    });

    for (const invalid of [
      { platform: "linux", stderr: `${errorEnvelope}\n${closingAssertion}\n` },
      { platform: "win32", stderr: `${errorEnvelope}\n${closingAssertion}\nextra` },
      {
        platform: "win32",
        stderr: `${errorEnvelope.replace("tool_not_found", "error")}\n${closingAssertion}\n`,
      },
    ] as const) {
      expect(() => classifyInspectorFailure({
        exitCode: 0xc0000409,
        stderr: invalid.stderr,
        expectedExitCode: 5,
        expectedErrorCode: "tool_not_found",
        platform: invalid.platform,
        label: "unknown tool",
      })).toThrow("unknown tool");
    }
  });

  it("parses only bounded stdio or HTTP contract repetitions", () => {
    expect(parseInspectorRunnerArguments([])).toEqual({ transport: "stdio", repeat: 1 });
    expect(parseInspectorRunnerArguments(["--transport", "http", "--repeat", "10"]))
      .toEqual({ transport: "http", repeat: 10 });
    for (const invalid of [
      ["--transport", "sse"],
      ["--transport", "http", "--repeat", "0"],
      ["--transport", "http", "--repeat", "11"],
      ["--transport", "http", "--repeat", "1.5"],
      ["--unknown"],
    ]) {
      expect(() => parseInspectorRunnerArguments(invalid)).toThrow("Inspector runner arguments");
    }
  });

  it("builds a non-interactive HTTP target for one exact loopback endpoint", () => {
    const argumentsList = createInspectorHttpArguments({
      serverUrl: "http://127.0.0.1:43123/mcp",
      method: "tools/list",
    });

    expect(argumentsList).toEqual([
      "--cli",
      "http://127.0.0.1:43123/mcp",
      "--transport",
      "http",
      "--stored-auth-only",
      "--method",
      "tools/list",
      "--format",
      "json",
    ]);
    expect(argumentsList).not.toContain("--config");
    expect(argumentsList).not.toContain("--catalog");
    expect(argumentsList).not.toContain("--use-stored-auth");
    expect(argumentsList).not.toContain("-e");
  });

  it.each([
    "https://127.0.0.1:43123/mcp",
    "http://localhost:43123/mcp",
    "http://127.attacker.example:43123/mcp",
    "http://127.0.0.1:43123/other",
    "http://user:pass@127.0.0.1:43123/mcp",
    "http://127.0.0.1:43123/mcp?target=external",
    "http://127.0.0.1:43123/mcp#fragment",
  ])("rejects a non-canonical loopback target: %s", (serverUrl) => {
    expect(() => createInspectorHttpArguments({ serverUrl, method: "initialize" })).toThrow(
      "canonical loopback"
    );
  });

  it("marks only the HTTP fixture environment as loopback-capable", () => {
    const harnessPath = path.resolve("scripts", "fixtures", "deny-external-fetch.mjs");
    const storageDirectory = path.resolve("inspector-state");
    const stdioEnvironment = createInspectorEnvironment({
      parentEnvironment: { PATH: process.env.PATH },
      storageDirectory,
      harnessPath,
    });
    const httpEnvironment = createInspectorEnvironment({
      parentEnvironment: { PATH: process.env.PATH },
      storageDirectory,
      harnessPath,
      networkMode: "loopback",
    });

    expect(stdioEnvironment.MCP_INSPECTOR_NETWORK_MODE).toBe("deny");
    expect(httpEnvironment.MCP_INSPECTOR_NETWORK_MODE).toBe("loopback");
  });

  it("allows an exact IPv4 loopback target while rejecting DNS and external targets", () => {
    const harnessPath = path.resolve("scripts", "fixtures", "deny-external-fetch.mjs");
    const environment = createInspectorEnvironment({
      parentEnvironment: process.env,
      storageDirectory: path.resolve("inspector-state"),
      harnessPath,
      networkMode: "loopback",
    });
    delete environment.NODE_OPTIONS;
    const script = `
      const net = (await import("node:net")).default;
      const { Socket } = await import("node:net");
      globalThis.fetch = async (input) => new Response(String(input));
      const allowedSocket = { allowed: true };
      const allowedNormalizedSocket = { normalized: true };
      net.createConnection = () => allowedSocket;
      net.connect = net.createConnection;
      Socket.prototype.connect = () => allowedNormalizedSocket;
      await import(${JSON.stringify(pathToFileURL(harnessPath).href)});
      const exactFetch = await fetch("http://127.0.0.1:43123/mcp");
      const exactFetchAllowed = (await exactFetch.text()).includes("127.0.0.1:43123/mcp");
      const exactSocketAllowed = net.connect({ host: "127.0.0.1", port: 43123 }) === allowedSocket;
      const normalizedSocketAllowed = Socket.prototype.connect.call(
        {},
        [{ host: "127.0.0.1", port: "43123" }, null]
      ) === allowedNormalizedSocket;
      const blocked = [];
      for (const target of [
        "http://localhost:43123/mcp",
        "https://127.attacker.example/mcp",
        "https://api.github.com/repos/example/project",
      ]) {
        try {
          await fetch(target);
          blocked.push(false);
        } catch (error) {
          blocked.push(/loopback|network access is disabled/i.test(String(error)));
        }
      }
      let deceptiveSocketBlocked = false;
      try {
        net.connect({ host: "127.attacker.example", port: 443 });
      } catch (error) {
        deceptiveSocketBlocked = /loopback|network access is disabled/i.test(String(error));
      }
      process.exit(
        exactFetchAllowed && exactSocketAllowed && normalizedSocketAllowed &&
          blocked.every(Boolean) && deceptiveSocketBlocked
          ? 0
          : 1
      );
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      encoding: "utf8",
      env: environment,
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
      windowsHide: true,
    });

    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("");
  });

  it("serves an isolated auth challenge and observes any attempted browser spawn", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-sdlc-auth-test-"));
    const storageDirectory = path.join(fixtureRoot, "storage");
    const requestMarkerPath = path.join(storageDirectory, "auth-request.marker");
    const browserMarkerPath = path.join(storageDirectory, "browser-attempt.marker");
    const harnessPath = path.resolve("scripts", "fixtures", "deny-external-fetch.mjs");
    await fs.mkdir(storageDirectory, { recursive: true });
    await fs.writeFile(path.join(storageDirectory, "empty.env"), "", "utf8");
    const environment: NodeJS.ProcessEnv = {
      ...createInspectorEnvironment({
        parentEnvironment: process.env,
        storageDirectory,
        harnessPath,
        networkMode: "loopback",
      }),
      MCP_INSPECTOR_AUTH_CHALLENGE_MARKER_PATH: requestMarkerPath,
      MCP_INSPECTOR_BROWSER_ATTEMPT_MARKER_PATH: browserMarkerPath,
    };

    let server;
    try {
      server = await startInspectorAuthChallengeServer({
        projectRoot: path.resolve("."),
        environment,
      });
      const response = await fetch(server.serverUrl, {
        method: "POST",
        signal: AbortSignal.timeout(2_000),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain("Bearer");
      expect(await fs.readFile(requestMarkerPath, "utf8")).toContain("auth-required");

      const childEnvironment: NodeJS.ProcessEnv = { ...environment };
      delete childEnvironment.NODE_OPTIONS;
      const child = spawnSync(process.execPath, [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(pathToFileURL(harnessPath).href)});
         const childProcess = (await import("node:child_process")).default;
         try { childProcess.spawn("must-not-run"); } catch { process.exit(0); }
         process.exit(1);`,
      ], {
        encoding: "utf8",
        env: childEnvironment,
        timeout: 2_000,
        windowsHide: true,
      });
      expect(child.status).toBe(0);
      expect(await fs.readFile(browserMarkerPath, "utf8")).toContain("spawn-blocked");
    } finally {
      await server?.close();
      await fs.rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
    }
  });


  it("starts and closes the production HTTP adapter on a random loopback port", async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-sdlc-http-test-"));
    const storageDirectory = path.join(fixtureRoot, "storage");
    const harnessPath = path.resolve("scripts", "fixtures", "deny-external-fetch.mjs");
    await fs.mkdir(storageDirectory, { recursive: true });
    await fs.writeFile(path.join(storageDirectory, "empty.env"), "", "utf8");
    const environment = createInspectorEnvironment({
      parentEnvironment: process.env,
      storageDirectory,
      harnessPath,
      networkMode: "loopback",
    });
    const originalExecArgv = [...process.execArgv];
    process.execArgv.push("--input-type=module");

    try {
      const server = await startInspectorHttpServer({
        projectRoot: path.resolve("."),
        environment,
      });
      expect(server.serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
      const response = await fetch(server.serverUrl, {
        method: "GET",
        signal: AbortSignal.timeout(2_000),
      });
      expect(response.status).toBe(405);
      expect(await fs.readFile(
        path.join(storageDirectory, "server-harness.marker"),
        "utf8"
      )).toBe("server-harness-loaded\n");

      await server.close();
      await server.close();
      await expect(fetch(server.serverUrl, {
        signal: AbortSignal.timeout(1_000),
      })).rejects.toThrow();
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
      await fs.rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 15_000);
});
