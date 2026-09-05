// Parse an HTTP `retry-after` header (RFC 7231) into a millisecond delay.
// Accepts delta-seconds ("5") or an HTTP-date. Returns undefined when absent,
// malformed, or points to a non-finite/absurdly-large delay. Mirrors the
// provider-openai helper (kept per-package so adapters stay self-contained).

export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const v = value.trim();
  if (v === "") return undefined;
  if (/^\d+$/.test(v)) {
    const secs = Number(v);
    if (!Number.isFinite(secs) || secs < 0 || secs > 24 * 3600) return undefined;
    return secs * 1000;
  }
  const ts = Date.parse(v);
  if (!Number.isFinite(ts)) return undefined;
  const diff = ts - Date.now();
  if (!Number.isFinite(diff)) return undefined;
  return diff < 0 ? 0 : diff;
}
