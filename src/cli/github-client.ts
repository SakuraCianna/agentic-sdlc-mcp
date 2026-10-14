import { Octokit } from "@octokit/rest";

/** CLI output is an explicit contract; plugin request logs must not bypass its safe error channel. */
export function createCliGithubClient(token?: string, fetch?: typeof globalThis.fetch): Octokit {
  const quiet = () => {};
  return new Octokit({
    auth: token,
    log: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    ...(fetch ? { request: { fetch } } : {}),
  });
}
