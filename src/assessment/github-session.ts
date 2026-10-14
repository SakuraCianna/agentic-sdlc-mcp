import type { Octokit } from "@octokit/rest";

import { AbortableCancellationError } from "../evidence/timeout.js";

export interface ReadOnlyGithubSessionOptions {
  signal?: AbortSignal;
  maxRequests?: number;
}

export class ReadOnlyGithubSessionError extends Error {
  constructor(readonly code: "request_budget_exhausted" | "read_only_operation_required") {
    super(code === "request_budget_exhausted"
      ? "GitHub evidence request budget was exhausted before collection completed."
      : "This GitHub evidence session permits supported read-only requests only.");
    this.name = "ReadOnlyGithubSessionError";
  }
}

type Callable = (...args: unknown[]) => unknown;
type EndpointFunction = Callable & {
  endpoint?: { DEFAULTS?: { method?: string } };
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function queryIsReadOnly(query: unknown): query is string {
  if (typeof query !== "string" || query.length > 100_000) return false;
  const tokens: string[] = [];
  let cursor = 0;
  // GraphQL block strings allow escaped triple quotes. A simple string-stripping
  // regex can misread their boundary and conceal a later mutation operation.
  while (cursor < query.length) {
    if (query[cursor] === "#") {
      while (cursor < query.length && !/[\r\n]/.test(query[cursor])) cursor += 1;
    } else if (query[cursor] === '"') {
      const block = query.startsWith('"""', cursor);
      cursor += block ? 3 : 1;
      let closed = false;
      while (cursor < query.length) {
        if (block && query.startsWith('\\"""', cursor)) cursor += 4;
        else if (query.startsWith(block ? '"""' : '"', cursor)) {
          cursor += block ? 3 : 1;
          closed = true;
          break;
        } else if (!block && query[cursor] === "\\") cursor += 2;
        else if (!block && /[\r\n]/.test(query[cursor])) return false;
        else cursor += 1;
      }
      if (!closed) return false;
      tokens.push(" ");
    } else {
      tokens.push(query[cursor]);
      cursor += 1;
    }
  }
  const document = tokens.join("").trim();
  return /^(?:query\b|\{)/.test(document) && !/\b(?:mutation|subscription)\b/.test(document);
}

/** A bounded client view; the supplied Octokit instance and its options stay unchanged. */
export function createReadOnlyGithubSession(
  octokit: Octokit,
  options: ReadOnlyGithubSessionOptions = {}
): { client: Octokit; usedRequests: () => number } {
  const maxRequests = options.maxRequests ?? 100;
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 0) {
    throw new TypeError("GitHub evidence request budget must be a non-negative safe integer.");
  }
  const sessionSignal = options.signal ?? new AbortController().signal;
  let requests = 0;
  const proxies = new WeakMap<object, object>();
  const rejectOperation = (): never => {
    throw new ReadOnlyGithubSessionError("read_only_operation_required");
  };
  const requestOptions = (input: unknown): Record<string, unknown> => {
    const parameters = record(input);
    const request = record(parameters.request);
    const callerSignal = request.signal instanceof AbortSignal ? request.signal : undefined;
    const signal = callerSignal && callerSignal !== sessionSignal
      ? AbortSignal.any([sessionSignal, callerSignal])
      : sessionSignal;
    if (signal.aborted) throw new AbortableCancellationError("GitHub evidence collection");
    return { ...parameters, request: { ...request, signal } };
  };
  const invoke = (method: Callable, receiver: object, args: unknown[]): unknown => {
    if (requests >= maxRequests) throw new ReadOnlyGithubSessionError("request_budget_exhausted");
    requests += 1;
    return Reflect.apply(method, receiver, args);
  };
  const wrap = (target: object, path: string[]): object => {
    const existing = proxies.get(target);
    if (existing) return existing;
    const proxy = new Proxy(target, {
      get(object, key) {
        if (typeof key !== "string" || key === "constructor" || key === "__proto__") return undefined;
        const value: unknown = Reflect.get(object, key, object);
        if (typeof value === "function") {
          const method = value as EndpointFunction;
          if (path.length === 0 && key === "graphql") {
            return (...args: unknown[]) => {
              const query = typeof args[0] === "string" ? args[0] : record(args[0]).query;
              if (!queryIsReadOnly(query)) return rejectOperation();
              const input = requestOptions(typeof args[0] === "string" ? args[1] : args[0]);
              if (["method", "url", "baseUrl"].some((key) => input[key] !== undefined)) return rejectOperation();
              if (typeof args[0] === "string" && input.query !== undefined) return rejectOperation();
              return invoke(method, object, typeof args[0] === "string" ? [query, input] : [input]);
            };
          }
          if (path.length === 0 && key === "request") {
            return (...args: unknown[]) => {
              const first = args[0];
              const parameters = typeof first === "string" ? record(args[1]) : record(first);
              const routeMethod = typeof first === "string" ? first.match(/^([A-Za-z]+)\s/)?.[1] : undefined;
              const httpMethod = String(parameters.method ?? routeMethod ?? "GET").toUpperCase();
              if (!["GET", "HEAD"].includes(httpMethod)) return rejectOperation();
              const route = String(parameters.url ?? (typeof first === "string" ? first : ""));
              if (/(?:^|\/)graphql(?:[?#]|$)/.test(route)) return rejectOperation();
              const input = requestOptions(parameters);
              return invoke(method, object, typeof first === "string" ? [first, input] : [input]);
            };
          }
          const endpointPath = path.length === 1 || (path.length === 2 && path[0] === "rest");
          const httpMethod = method.endpoint?.DEFAULTS?.method?.toUpperCase();
          const knownMockRead = httpMethod === undefined && /^(?:get|list|compare|download|check)(?:[A-Z]|$)/.test(key);
          if (!endpointPath || (!knownMockRead && !["GET", "HEAD"].includes(httpMethod ?? ""))) {
            return rejectOperation;
          }
          return (...args: unknown[]) => {
            const input = requestOptions(args[0]);
            if (typeof input.method === "string" && !["GET", "HEAD"].includes(input.method.toUpperCase())) {
              return rejectOperation();
            }
            if (typeof input.url === "string" && /(?:^|\/)graphql(?:[?#]|$)/.test(input.url)) return rejectOperation();
            return invoke(method, object, [input]);
          };
        }
        if (typeof value === "object" && value !== null) return wrap(value, [...path, key]);
        return undefined;
      },
      set: () => false,
      defineProperty: () => false,
      deleteProperty: () => false,
    });
    proxies.set(target, proxy);
    return proxy;
  };
  return { client: wrap(octokit, []) as Octokit, usedRequests: () => requests };
}
