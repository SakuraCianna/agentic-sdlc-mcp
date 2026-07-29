import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { withAbortableTimeout } from "../../evidence/timeout.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("withAbortableTimeout", () => {
  it("resolves the operation, clears its timer, and detaches the parent listener", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const removeListener = vi.spyOn(parent.signal, "removeEventListener");

    await expect(
      withAbortableTimeout(
        "evidence collection",
        50,
        async (signal) => {
          expect(signal.aborted).toBe(false);
          return "complete";
        },
        parent.signal
      )
    ).resolves.toBe("complete");

    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function)
    );
  });

  it("aborts the child signal and rejects with the timeout error", async () => {
    vi.useFakeTimers();
    let childSignal: AbortSignal | undefined;
    const result = withAbortableTimeout(
      "GitHub evidence",
      25,
      (signal) => {
        childSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }
    );
    const rejection = expect(result).rejects.toThrow(
      "GitHub evidence timed out after 25ms"
    );

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(childSignal?.aborted).toBe(true);
    expect(childSignal?.reason).toEqual(
      new Error("GitHub evidence timed out after 25ms.")
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves an Error reason from an already-aborted parent", async () => {
    const parent = new AbortController();
    const reason = new Error("caller cancelled");
    parent.abort(reason);
    const operation = vi.fn(async () => "unused");

    await expect(
      withAbortableTimeout(
        "evidence collection",
        50,
        operation,
        parent.signal
      )
    ).rejects.toBe(reason);
    expect(operation).not.toHaveBeenCalled();
  });

  it("uses a safe generic error for a non-Error parent abort reason", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let childSignal: AbortSignal | undefined;
    const result = withAbortableTimeout(
      "evidence collection",
      50,
      async (signal) => {
        childSignal = signal;
        return new Promise<never>(() => undefined);
      },
      parent.signal
    );
    const rejection = expect(result).rejects.toThrow(
      "evidence collection was aborted"
    );
    await Promise.resolve();

    parent.abort("untrusted abort reason");

    await rejection;
    expect(childSignal?.aborted).toBe(true);
    expect(childSignal?.reason).toEqual(
      new Error("evidence collection was aborted.")
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start an operation cancelled before its microtask begins", async () => {
    const parent = new AbortController();
    const operation = vi.fn(async () => "unused");
    const reason = new Error("cancel before collection");
    const result = withAbortableTimeout(
      "evidence collection",
      50,
      operation,
      parent.signal
    );
    const rejection = expect(result).rejects.toBe(reason);

    parent.abort(reason);

    await rejection;
    expect(operation).not.toHaveBeenCalled();
  });

  it("cleans up when the operation rejects synchronously", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();

    await expect(
      withAbortableTimeout(
        "evidence collection",
        50,
        () => {
          throw new Error("collector failed");
        },
        parent.signal
      )
    ).rejects.toThrow("collector failed");

    expect(vi.getTimerCount()).toBe(0);
    parent.abort(new Error("late cancellation"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("normalizes zero, negative, and fractional deadlines to bounded integers", async () => {
    vi.useFakeTimers();

    const zero = withAbortableTimeout(
      "zero deadline",
      0,
      async () => new Promise<never>(() => undefined)
    );
    const fractional = withAbortableTimeout(
      "fractional deadline",
      2.9,
      async () => new Promise<never>(() => undefined)
    );
    const zeroRejection = expect(zero).rejects.toThrow(
      "zero deadline timed out after 1ms"
    );
    const fractionalRejection = expect(fractional).rejects.toThrow(
      "fractional deadline timed out after 2ms"
    );

    await vi.advanceTimersByTimeAsync(2);

    await Promise.all([zeroRejection, fractionalRejection]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects a non-finite timeout %s",
    (timeoutMs) => {
      expect(() =>
        withAbortableTimeout(
          "evidence collection",
          timeoutMs,
          async () => "unused"
        )
      ).toThrow("timeout must be a finite number");
    }
  );

  it("keeps a real deadline alive as the only child-process handle", () => {
    const moduleUrl = new URL(
      "../../evidence/timeout.js",
      import.meta.url
    ).href;
    const script = `
      import { withAbortableTimeout } from ${JSON.stringify(moduleUrl)};
      try {
        await withAbortableTimeout(
          "evidence child probe",
          20,
          async () => new Promise(() => undefined)
        );
        process.exitCode = 2;
      } catch (error) {
        console.error(error.message);
      }
    `;

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        encoding: "utf8",
        timeout: 2_000,
        cwd: process.cwd(),
      }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "evidence child probe timed out after 20ms"
    );
  });
});
