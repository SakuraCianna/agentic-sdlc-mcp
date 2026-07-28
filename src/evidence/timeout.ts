function abortError(label: string, signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`${label} was aborted.`);
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
      const error = new Error(
        `${label} timed out after ${normalizedTimeoutMs}ms.`
      );
      cleanup();
      controller.abort(error);
      reject(error);
    }, normalizedTimeoutMs);
    timer.unref?.();

    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(resolve, reject)
      .finally(cleanup);
  });
}
