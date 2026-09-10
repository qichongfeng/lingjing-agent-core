// web_fetch tool — best-effort HTTP GET of STATIC, server-rendered pages.
//
// Modern JS-rendered SPAs return an empty shell to a plain GET, and anti-bot
// fronts (Cloudflare challenges, UA filters) refuse non-browser clients —
// this tool explicitly does NOT fight that war. What it is for: docs, blogs,
// wikis, and other server-rendered HTML, plus plain-text resources. For
// structured data prefer fetch_json; for discovery prefer web_search; for
// reliably structured site updates prefer read_feed.
//
// Same family discipline: HttpTransport only (zero node:* imports — Node,
// browsers, Edge, mini-programs), http(s) only, byte-capped streaming body
// read, HTML distilled to Markdown (headings/links/code/lists survive — the
// model can follow links with another fetch), per-URL TTL cache (agents
// re-fetch the same page within a turn surprisingly often), network
// permission + tags ["http"]. Request headers come from the HOST
// (opts.headers — e.g. a browser-like UA is the host's policy call), never
// from the model.

import { fetchTransport, type HttpTransport, type Tool, type ToolResultValue } from "@lingjing-agent/core";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { parseAllowedUrl, readBodyText, requestError, transportGet } from "./shared.js";

const DEFAULT_CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX_ENTRIES = 50;

/**
 * Custom HTML→content extractor for web_fetch (e.g. the Readability-based one
 * from `@lingjing-agent/tools-fetch/node`). Receives the raw HTML and the page
 * URL; return the content to use, or `undefined` to DECLINE — web_fetch then
 * falls back to the built-in Markdown converter. Declining is the contract
 * for "this page has no extractable article" (Readability does exactly that).
 */
export type HtmlExtractor = (html: string, url: string) => string | undefined | Promise<string | undefined>;

export interface WebFetchToolOptions {
  /** Custom transport (e.g. mini-program wx.request bridge). Default fetchTransport(). */
  transport?: HttpTransport;
  /** Max bytes read from the response body. Default 128 KiB. */
  maxBytes?: number;
  /** Tool-level timeout — also caps the whole body read. Default 30_000 ms. */
  timeoutMs?: number;
  /** Allowed URL schemes. Default ["http:", "https:"]. */
  allowedProtocols?: string[];
  /** Static extra headers on every request — host-owned (a browser-like
   *  User-Agent is the host's policy decision, not the library's default). */
  headers?: Record<string, string>;
  /** Successful results cached per URL for this long. Default 15 min; 0 disables. */
  cacheTtlMs?: number;
  /** Content extractor for HTML bodies (Node hosts: Readability — see
   *  `createReadabilityExtractor` in `@lingjing-agent/tools-fetch/node`).
   *  Falls back to the built-in converter on decline or failure. */
  extractor?: HtmlExtractor;
}

interface CacheEntry {
  at: number;
  result: ToolResultValue;
}

export function createWebFetchTool(opts: WebFetchToolOptions = {}): Tool {
  const transport = opts.transport ?? fetchTransport();
  const maxBytes = opts.maxBytes ?? 128 * 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const allowedProtocols = new Set(opts.allowedProtocols ?? ["http:", "https:"]);
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>(); // insertion-ordered → FIFO eviction
  const extractor = opts.extractor;

  return {
    name: "web_fetch",
    description:
      "Fetch an http(s) URL and return its body as Markdown (headings, links, " +
      "code blocks, and lists survive — you can follow extracted links with " +
      "another fetch). Works for static, server-rendered pages — JS-heavy apps " +
      "and anti-bot-protected sites may return little or refuse. Output is " +
      "truncated to a byte cap — ask for one page per call.",
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
      const parsed = parseAllowedUrl(raw, allowedProtocols);
      if (!parsed.ok) return { content: parsed.error, isError: true };
      const url = parsed.url.toString();

      if (cacheTtlMs > 0) {
        const hit = cache.get(url);
        if (hit !== undefined && Date.now() - hit.at < cacheTtlMs) return hit.result;
        if (hit !== undefined) cache.delete(url); // expired — re-insert below as newest
      }

      let resp;
      try {
        resp = await transportGet(transport, url, {
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.7",
          signal: ctx.signal,
          headers: opts.headers,
        });
      } catch (err) {
        return requestError(err, ctx.signal.aborted);
      }

      let body: { text: string; truncated: boolean };
      try {
        body = await readBodyText(resp, maxBytes);
      } catch (err) {
        return requestError(err, ctx.signal.aborted);
      }

      const contentType = resp.headers["content-type"] ?? "";
      const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)\b/i.test(body.text);
      let text = body.text;
      if (isHtml) {
        let extracted: string | undefined;
        if (extractor !== undefined) {
          try {
            extracted = await extractor(body.text, url);
          } catch (err) {
            ctx.log("warn", "web_fetch: custom extractor failed — falling back to the built-in converter", err);
          }
        }
        // undefined or "" = declined (no article found) → built-in full-page conversion
        text = extracted !== undefined && extracted !== "" ? extracted : htmlToMarkdown(body.text, url);
      }
      const header =
        `url: ${url}\nstatus: ${resp.status} ${resp.statusText}` +
        `\ncontent-type: ${contentType || "(none)"}` +
        (body.truncated ? `\n[truncated at ${maxBytes} bytes]` : "");
      const result: ToolResultValue = {
        content: `${header}\n\n${text}`,
        isError: resp.status >= 400,
      };

      if (cacheTtlMs > 0 && result.isError !== true && !ctx.signal.aborted) {
        cache.set(url, { at: Date.now(), result });
        while (cache.size > CACHE_MAX_ENTRIES) {
          const oldest = cache.keys().next();
          if (oldest.done === true) break;
          cache.delete(oldest.value);
        }
      }
      return result;
    },
  };
}
