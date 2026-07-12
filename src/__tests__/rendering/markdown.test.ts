import { describe, expect, it } from "vitest";

import { safeMarkdownInline } from "../../rendering/markdown.js";

describe("safeMarkdownInline", () => {
  it("collapses control characters, escapes Markdown, and bounds rendered length", () => {
    const result = safeMarkdownInline(
      "title\r\n## [link](javascript:alert(1))\0" + "x".repeat(500),
      { maxLength: 80 }
    );

    expect(result).not.toMatch(/[\r\n\0]/);
    expect(result).toContain("\\#\\# \\[link\\]\\(javascript:alert\\(1\\)\\)");
    expect(result.length).toBeLessThanOrEqual(80);
  });

  it("uses a safe fallback when normalized input is empty", () => {
    expect(safeMarkdownInline("\r\n\t", { fallback: "unknown" })).toBe("unknown");
  });
});
