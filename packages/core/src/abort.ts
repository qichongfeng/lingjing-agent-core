// Abort helpers. AbortSignal.any is used when available (Node 20+, modern
// browsers); otherwise we link signals manually so core stays runtime-portable.

export class AbortError extends Error {
  override readonly name = "AbortError";
  constructor(message = "Aborted") {
    super(message);
  }
}

export class TimeoutError extends Error {
  override readonly name = "TimeoutError";
  constructor(message: string) {
    super(message);
  }
}

/** Combine multiple signals into one: aborts when any input signal aborts. */
export function anySignal(signals: (AbortSignal | undefined | null)[]): AbortSignal {
  const valid = signals.filter((s): s is AbortSignal => !!s && !s.aborted);
  const aborted = signals.find((s): s is AbortSignal => !!s && s.aborted);
  const controller = new AbortController();
  if (aborted) {
    controller.abort((aborted as AbortSignal & { reason?: unknown }).reason);
    return controller.signal;
  }
  if (valid.length === 0) return controller.signal; // never-aborting
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(valid);
  }
  const listeners = valid.map((s) => {
    const fn = (): void => controller.abort((s as AbortSignal & { reason?: unknown }).reason);
    s.addEventListener("abort", fn, { once: true });
    return { s, fn };
  });
  // Detach from all sources once our derived signal fires, so a long-lived source
  // signal doesn't accumulate listeners across many anySignal() calls (e.g. one
  // per tool execution in a long conversation).
  controller.signal.addEventListener(
    "abort",
    () => {
      for (const { s, fn } of listeners) s.removeEventListener("abort", fn);
    },
    { once: true },
  );
  return controller.signal;
}

/** Detect runtime without importing any platform package. */
export function detectRuntime(): "node" | "browser" | "edge" {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.process === "object" && g.process !== null) {
    const versions = (g.process as { versions?: Record<string, unknown> }).versions;
    if (versions && typeof versions.node === "string") return "node";
  }
  if (typeof g.window !== "undefined") return "browser";
  return "edge";
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
