export class GitHubRequestBudgetExceededError extends Error {
  constructor(maxRequests: number) {
    super(`GitHub request budget exceeded (${maxRequests} requests).`);
    this.name = "GitHubRequestBudgetExceededError";
  }
}

export interface BudgetedGithubClient<T> {
  client: T;
  usedRequests: () => number;
}

/**
 * Wrap an Octokit-shaped object and count endpoint invocations across nested
 * namespaces. Exceeding the budget fails closed before starting the request.
 */
export function createBudgetedGithubClient<T extends object>(
  client: T,
  maxRequests: number
): BudgetedGithubClient<T> {
  const normalizedMax = Math.max(1, Math.floor(maxRequests));
  let used = 0;
  const proxies = new WeakMap<object, object>();

  const wrap = (value: object): object => {
    const cached = proxies.get(value);
    if (cached) return cached;
    const proxy = new Proxy(value, {
      get(target, property, receiver) {
        const child = Reflect.get(target, property, receiver);
        if (typeof child === "function") {
          return (...args: unknown[]) => {
            if (used >= normalizedMax) {
              throw new GitHubRequestBudgetExceededError(normalizedMax);
            }
            used += 1;
            return Reflect.apply(child, target, args);
          };
        }
        return child && typeof child === "object" ? wrap(child) : child;
      },
    });
    proxies.set(value, proxy);
    return proxy;
  };

  return {
    client: wrap(client) as T,
    usedRequests: () => used,
  };
}
