/** A caller cancellation whose non-Error reason was safely normalized. */
export class AbortableCancellationError extends Error {
  readonly label: string;

  constructor(label: string) {
    super(`${label} was aborted.`);
    this.name = "AbortableCancellationError";
    this.label = label;
  }
}

function abortError(label: string, signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new AbortableCancellationError(label);
}

/** A locally enforced deadline, distinct from a caller-initiated cancellation. */
export class AbortableTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms.`);
    this.name = "AbortableTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Bound an asynchronous collection operation and propagate an optional parent
 * cancellation signal into the operation's own AbortSignal.
 */
export function withAbortableTimeout<T>(
  label: string,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal
): Promise<T> {
  if (!Number.isFinite(timeoutMs)) {
    throw new TypeError(`${label} timeout must be a finite number.`);
  }
  const normalizedTimeoutMs = Math.max(1, Math.floor(timeoutMs));

  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    };
    const abortFromParent = (): void => {
      const error = abortError(label, parentSignal ?? controller.signal);
      cleanup();
      controller.abort(error);
      reject(error);
    };

    if (parentSignal?.aborted) {
      abortFromParent();
      return;
    }
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });

    timer = setTimeout(() => {
      const error = new AbortableTimeoutError(label, normalizedTimeoutMs);
      cleanup();
      controller.abort(error);
      reject(error);
    }, normalizedTimeoutMs);

    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) {
          throw abortError(label, controller.signal);
        }
        return operation(controller.signal);
      })
      .then(resolve, reject)
      .finally(cleanup);
  });
}
