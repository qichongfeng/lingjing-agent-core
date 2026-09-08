// web_fetch tool — cross-runtime HTTP GET for @lingjing-agent/core hosts.
//
// Reaches the network ONLY through core's HttpTransport (default: the global
// `fetch`). This keeps the package free of node:* imports so the SAME tool
// runs in Node, browsers, Edge, and runtimes without `fetch` (WeChat
// mini-programs inject a wx.request-backed transport — see examples/).
//
// Bounds: http(s) only, byte-capped streaming body read (stops consuming once
// the cap is hit — the transport's body AsyncIterable is simply not continued),
// HTML distilled to readable text. `permissions.network: true` so hosts can
// gate it; tags ["http"] for allowedToolTags matching.

import {
  AbortError,
  fetchTransport,
  type HttpTransport,
  type Tool,
  type ToolResultValue,
} from "@lingjing-agent/core";
import { htmlToText } from "./html-to-text.js";

/**
 * Decode UTF-8 bytes to a string. TextDecoder when the runtime has it; a
 * manual decoder otherwise (WeChat mini-program engines lack TextDecoder).
 * Called once on the capped, fully-buffered body — streaming is unnecessary.
 */
function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder === "function") return new TextDecoder("utf-8").decode(bytes);
  let out = "";
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i++]!;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if (b0 >= 0xc2 && b0 < 0xe0 && i < n) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i++]! & 0x3f));
    } else if (b0 >= 0xe0 && b0 < 0xf0 && i + 1 < n) {
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f));
    } else if (b0 >= 0xf0 && b0 < 0xf8 && i + 2 < n) {
      const cp =
        ((b0 & 0x07) << 18) | ((bytes[i++]! & 0x3f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
      out += String.fromCodePoint(cp);
    } else {
      out += "�"; // continuation byte lead, truncated sequence, or 5+ byte form
    }
  }
  return out;
}

/** Concatenate byte chunks into one buffer of at most `cap` bytes. */
function concatCapped(chunks: Uint8Array[], cap: number): { bytes: Uint8Array; truncated: boolean } {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  if (total <= cap) {
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return { bytes: out, truncated: false };
  }
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

export interface WebFetchToolOptions {
  /** Custom transport (e.g. mini-program wx.request bridge). Default fetchTransport(). */
  transport?: HttpTransport;
  /** Max bytes read from the response body. Default 128 KiB. */
  maxBytes?: number;
  /** Tool-level timeout — also caps the whole body read. Default 30_000 ms. */
  timeoutMs?: number;
  /** Allowed URL schemes. Default ["http:", "https:"]. */
  allowedProtocols?: string[];
}

export function createWebFetchTool(opts: WebFetchToolOptions = {}): Tool {
  const transport = opts.transport ?? fetchTransport();
  const maxBytes = opts.maxBytes ?? 128 * 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const allowedProtocols = new Set(opts.allowedProtocols ?? ["http:", "https:"]);

  return {
    name: "web_fetch",
    description:
      "Fetch an http(s) URL and return its body as readable text (HTML pages are " +
      "distilled to text; scripts/styles removed). Output is truncated to a byte " +
      "cap — ask for one page per call.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL to GET." },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    timeoutMs,
    permissions: { network: true, tags: ["http"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      const { url } = raw as { url?: string };
      if (typeof url !== "string" || url.length === 0) {
        return { content: "Refused: input.url must be a non-empty string", isError: true };
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { content: `Invalid URL: ${url}`, isError: true };
      }
      if (!allowedProtocols.has(parsed.protocol)) {
        return {
          content: `Refused: protocol ${parsed.protocol} not allowed (http/https only)`,
          isError: true,
        };
      }

      let resp;
      try {
        resp = await transport({
          url: parsed.toString(),
          method: "GET",
          headers: {
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.7",
            "user-agent": "lingjing-agent-tools-fetch (+https://github.com/qichongfeng/lingjing-agent-core)",
          },
          signal: ctx.signal,
        });
      } catch (err) {
        if (err instanceof AbortError || ctx.signal.aborted) {
          return { content: "(aborted)", isError: true };
        }
        return { content: `Request failed: ${(err as Error).message}`, isError: true };
      }

      // Buffer the body until we're strictly PAST the byte cap — only then is
      // truncation certain (a body of exactly maxBytes bytes is complete).
      // Breaking out of the for-await releases the transport's underlying
      // connection (its body generator's finally runs — see core's fetchTransport).
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        for await (const chunk of resp.body) {
          chunks.push(chunk);
          received += chunk.byteLength;
          if (received > maxBytes) break;
        }
      } catch (err) {
        if (err instanceof AbortError || ctx.signal.aborted) {
          return { content: "(aborted)", isError: true };
        }
        return { content: `Body read failed: ${(err as Error).message}`, isError: true };
      }

      const { bytes, truncated } = concatCapped(chunks, maxBytes);
      const text = utf8Decode(bytes);

      const contentType = resp.headers["content-type"] ?? "";
      const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)\b/i.test(text);
      const body = isHtml ? htmlToText(text) : text;
      const header =
        `url: ${parsed.toString()}\nstatus: ${resp.status} ${resp.statusText}` +
        `\ncontent-type: ${contentType || "(none)"}` +
        (truncated ? `\n[truncated at ${maxBytes} bytes]` : "");
      return { content: `${header}\n\n${body}`, isError: resp.status >= 400 };
    },
  };
}
