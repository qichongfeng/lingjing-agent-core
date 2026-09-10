// Shared plumbing for the fetch-family tools: URL gating, byte-capped body
// reads, and the common response shape. Every tool here reaches the network
// ONLY through core's HttpTransport (default: the global `fetch`) so the
// package stays free of node:* imports — Node, browsers, Edge, and
// mini-programs (wx.request bridge) all run the SAME code.

import { AbortError, concatBytes, decodeUtf8, type HttpTransport, type HttpTransportResponse } from "@lingjing-agent/core";

export const DEFAULT_USER_AGENT = "lingjing-agent-tools-fetch (+https://github.com/qichongfeng/lingjing-agent-core)";

/** Concatenate byte chunks into one buffer of at most `cap` bytes. */
export function concatCapped(chunks: Uint8Array[], cap: number): { bytes: Uint8Array; truncated: boolean } {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  if (total <= cap) return { bytes: concatBytes(chunks), truncated: false };
  const out = new Uint8Array(cap);
  let off = 0;
  for (const c of chunks) {
    if (off >= cap) break;
    const take = Math.min(c.byteLength, cap - off);
    out.set(take === c.byteLength ? c : c.subarray(0, take), off);
    off += take;
  }
  return { bytes: out, truncated: true };
}

export type ParsedUrl = { ok: true; url: URL } | { ok: false; error: string };

/** Validate + scheme-gate the `url` field of a tool call's input. */
export function parseAllowedUrl(input: unknown, allowedProtocols: Set<string>): ParsedUrl {
  const raw = (input as { url?: unknown }).url;
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, error: "Refused: input.url must be a non-empty string" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `Invalid URL: ${raw}` };
  }
  if (!allowedProtocols.has(url.protocol)) {
    return { ok: false, error: `Refused: protocol ${url.protocol} not allowed (http/https only)` };
  }
  return { ok: true, url };
}

export interface CappedBody {
  text: string;
  truncated: boolean;
}

/**
 * Read a response body as text, capped at `maxBytes` bytes. Buffering runs
 * until strictly PAST the cap — only then is truncation certain (a body of
 * exactly maxBytes bytes is complete). Breaking out of the for-await
 * releases the transport's underlying connection (its body generator's
 * finally runs — see core's fetchTransport).
 */
export async function readBodyText(resp: HttpTransportResponse, maxBytes: number): Promise<CappedBody> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of resp.body) {
    chunks.push(chunk);
    received += chunk.byteLength;
    if (received > maxBytes) break;
  }
  const { bytes, truncated } = concatCapped(chunks, maxBytes);
  return { text: decodeUtf8(bytes), truncated };
}

/** Map a request/body failure the way every tool here reports it. */
export function requestError(err: unknown, aborted: boolean): { content: string; isError: true } {
  if (err instanceof AbortError || aborted) return { content: "(aborted)", isError: true };
  return { content: `Request failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
}

/** One transport call, sharing the header/UA conventions of the family. */
export async function transportGet(
  transport: HttpTransport,
  url: string,
  opts: { accept: string; signal: AbortSignal; headers?: Record<string, string> | undefined },
): Promise<HttpTransportResponse> {
  return transport({
    url,
    method: "GET",
    headers: { accept: opts.accept, "user-agent": DEFAULT_USER_AGENT, ...opts.headers },
    signal: opts.signal,
  });
}
