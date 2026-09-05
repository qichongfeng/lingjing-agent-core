// redact() — best-effort secret scrubber for events/messages before they leave
// the process (SSE / IPC / logs). This is DEFENSE-IN-DEPTH, not a guarantee:
// it masks well-known secret *shapes* (api keys, bearer tokens) in string
// fields and drops `metadata` keys whose names look like secrets. It cannot
// catch secrets split across streamed chunks — redact the final assembled
// `Message` (the `redact(Message)` overload) when whole-text coverage matters.
// The real boundary is at the provider-key / network layer, not here.

import type { AgentEvent } from "./events.js";
import type { Content, Message } from "./types.js";

export interface RedactPattern {
  name: string;
  re: RegExp;
  mask: string;
}

export interface RedactOptions {
  /** Regex masks applied to every string field. Defaults to SECRET_PATTERNS. */
  patterns?: RedactPattern[];
  /** Drop `Message.metadata` keys matching /key|token|secret|password|authorization/i.
   * Default true. */
  dropMetadataSecretKeys?: boolean;
}

/** Default mask patterns for common secret shapes. */
export const SECRET_PATTERNS: RedactPattern[] = [
  { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]+/g, mask: "sk-ant-***" },
  { name: "bearer", re: /\bBearer\s+[A-Za-z0-9._-]+/g, mask: "Bearer ***" },
  { name: "openai-key", re: /sk-[A-Za-z0-9]{20,}/g, mask: "sk-***" },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g, mask: "AKIA***" },
  {
    name: "inline-secret-eq",
    re: /(?<k>(?:api[_-]?key|secret|token|password|authorization))["']?\s*[:=]\s*["']?[A-Za-z0-9_\-+/=]{16,}/gi,
    mask: "<redacted>",
  },
];

const META_SECRET_RE = /key|token|secret|password|authorization|credential/i;

/** Scrub one event, message, content block, or string. Returns a new value;
 * the input is not mutated. */
export function redact(
  input: AgentEvent | Message | Content | string,
  opts?: RedactOptions,
): AgentEvent | Message | Content | string {
  const patterns = opts?.patterns ?? SECRET_PATTERNS;
  const dropMeta = opts?.dropMetadataSecretKeys ?? true;
  return scrub(input, patterns, dropMeta) as AgentEvent | Message | Content | string;
}

/** Scrub an array of events (e.g. before forwarding over the wire). */
export function redactEvents(events: AgentEvent[], opts?: RedactOptions): AgentEvent[] {
  return events.map((e) => redact(e, opts) as AgentEvent);
}

function scrub(
  v: unknown,
  patterns: RedactPattern[],
  dropMeta: boolean,
): unknown {
  if (typeof v === "string") return maskString(v, patterns);
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, patterns, dropMeta));

  const obj = v as Record<string, unknown>;

  // Message.metadata: drop secret-shaped keys verbatim.
  if (dropMeta && obj.metadata && typeof obj.metadata === "object") {
    const meta = obj.metadata as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(meta)) {
      if (META_SECRET_RE.test(k)) continue;
      cleaned[k] = scrub(val, patterns, dropMeta);
    }
    return { ...obj, metadata: cleaned };
  }

  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) {
    // Also scrub any object key that looks like a secret (defensive: a secret
    // value under a secret-named key on a non-Message object).
    if (META_SECRET_RE.test(k) && typeof val === "string") {
      out[k] = maskString(val, patterns);
    } else {
      out[k] = scrub(val, patterns, dropMeta);
    }
  }
  return out;
}

function maskString(s: string, patterns: RedactPattern[]): string {
  let out = s;
  for (const p of patterns) {
    // Each pattern carries its own `g` flag; reset lastIndex defensively.
    p.re.lastIndex = 0;
    out = out.replace(p.re, p.mask);
  }
  return out;
}
