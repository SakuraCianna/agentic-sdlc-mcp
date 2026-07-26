export function githubRequestOptions(
  signal?: AbortSignal
): { request: { signal: AbortSignal } } | Record<string, never> {
  return signal ? { request: { signal } } : {};
}
