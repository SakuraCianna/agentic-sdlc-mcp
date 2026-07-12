export interface SafeMarkdownInlineOptions {
  fallback?: string;
  /** Maximum rendered length after Markdown escaping. */
  maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 300;
const MARKDOWN_SPECIAL = /[\\`*_{}\[\]<>()#!|]/;

function normalizeInline(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Render untrusted text as one bounded Markdown inline fragment. */
export function safeMarkdownInline(
  value: string,
  options: SafeMarkdownInlineOptions = {}
): string {
  const maxLength = Math.max(1, Math.floor(options.maxLength ?? DEFAULT_MAX_LENGTH));
  const fallback = normalizeInline(options.fallback ?? "unknown") || "unknown";
  const normalized = normalizeInline(value) || fallback;
  const escapedTokens = Array.from(normalized, (character) =>
    MARKDOWN_SPECIAL.test(character) ? `\\${character}` : character
  );
  const rendered = escapedTokens.join("");
  if (rendered.length <= maxLength) return rendered;

  const suffix = "…";
  let truncated = "";
  for (const token of escapedTokens) {
    if (truncated.length + token.length + suffix.length > maxLength) break;
    truncated += token;
  }
  return `${truncated}${suffix}`.slice(0, maxLength);
}
