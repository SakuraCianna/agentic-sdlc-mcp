import { describe, it, expect } from "vitest";
import { parseCliArguments, parseRepository, positiveInteger } from "../../cli/arguments.js";

describe("CLI argument boundary", () => {
  it.each([{ args: [] }, { args: ["help"] }, { args: ["--help"] }])("provides offline help for $args", ({ args }) => expect(parseCliArguments(args).command).toBe("help"));
  it("provides a version without configuration", () => expect(parseCliArguments(["--version"]).command).toBe("version"));
  it("accepts explicit advisory or enforcing PR assessment options", () => {
    const args = parseCliArguments(["assess-pr", "--repo", "team/project", "--pr", "42", "--json", "--enforce"]);
    expect(args.values.get("repo")).toBe("team/project"); expect(args.flags.has("enforce")).toBe(true);
  });
  it.each([["publish"], ["doctor", "--token", "secret"], ["doctor", "--online", "--online"], ["doctor", "--repo"], ["doctor", "team/project"], ["doctor", "--repo", "a/b", "--repo", "x/y"], ["trace", "--mappings", "mapping.json"]].map((args) => ({ args })))("rejects ambiguous or unsupported input $args", ({ args }) => expect(() => parseCliArguments(args)).toThrow());
  it.each([undefined, "https://github.com/a/b", "a/b/c", "a/..", "a/.", "a\nb/c", "../b", "a/b?token=secret"])("rejects invalid repository coordinates %s", (value) => expect(() => parseRepository(value)).toThrow());
  it("allows the supported GitHub name characters", () => expect(parseRepository("my-team/project.name_2")).toEqual({ owner: "my-team", repo: "project.name_2" }));
  it.each(["0", "-1", "1.5", "Infinity", "1e2", "9007199254740992", "121"])("rejects invalid bounded positive integer %s", (value) => expect(() => positiveInteger(value, "value", undefined, 120)).toThrow());
  it("applies explicit defaults and integer limits", () => { expect(positiveInteger(undefined, "value", 10, 120)).toBe(10); expect(positiveInteger("120", "value", undefined, 120)).toBe(120); });
});
