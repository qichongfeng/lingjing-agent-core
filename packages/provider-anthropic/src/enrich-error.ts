// Turn an Anthropic HTTP error into a core ProviderError carrying `status`,
// `retryable`, and `retryAfterMs` (parsed from the response's `retry-after`
// header). Mirrors the provider-openai helper so adapters stay symmetrical.
// Pure + unit-testable: takes the raw error and reads a Headers-like `.headers`.

import type { ProviderError } from "@lingjing-agent/core";
import { parseRetryAfter } from "./parse-retry-after.js";

/** Adapter-known retryable HTTP statuses (matches core's isRetryable set). */
export function isRetryableStatus(status: number | undefined): boolean {
  if (typeof status !== "number") return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

interface HttpLikeError {
  status?: number;
  headers?: Headers | Record<string, string> | null;
  message?: string;
  /** Adapter-set machine code (e.g. "overloaded", "model_not_found") parsed
   *  from the protocol body — must survive re-enrichment of status-less
   *  errors (in-stream SSE failures). */
  code?: string;
  /** Explicit classification from the throw site wins over status-derived. */
  retryable?: boolean;
}

export function enrichError(err: unknown): ProviderError {
  if (isProviderError(err)) return err;
  // Abort must never be retried and must surface unchanged — it's a cancellation,
  // not a provider fault. Re-throw so callers that do `throw enrichError(err)`
  // propagate the original AbortError.
  if (err instanceof Error && err.name === "AbortError") throw err;
  const e = err as HttpLikeError & Error;
  const status = typeof e?.status === "number" ? e.status : undefined;
  const retryable =
    typeof e?.retryable === "boolean" ? e.retryable
    : typeof status === "number" ? isRetryableStatus(status)
    : true;
  const retryAfterMs = parseRetryAfter(readHeader(e?.headers, "retry-after"));
  const message = e instanceof Error ? e.message : String(err);
  const out = Object.assign(new Error(message), {
    name: "ProviderError",
    retryable,
    ...(typeof status === "number" ? { status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(typeof e?.code === "string" ? { code: e.code } : {}),
  }) as ProviderError & Error;
  (out as { cause?: unknown }).cause = err;
  return out;
}

function isProviderError(err: unknown): err is ProviderError {
  return err instanceof Error && "retryable" in err && "status" in err && err.name === "ProviderError";
}

function readHeader(
  headers: HttpLikeError["headers"],
  name: string,
): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const lower = name.toLowerCase();
  const rec = headers as Record<string, string>;
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}
