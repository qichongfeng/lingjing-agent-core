// web_fetch tool — the universal URL reader: fetch an http(s) URL and get its
// content back in the right shape, dispatched by what the server ACTUALLY
// returns (the model usually cannot know a URL's content type in advance —
// parameter-based dispatch would just move tool-selection errors into
// parameter-filling errors):
//
//   JSON (content-type, or a body that parses)  → pretty-printed JSON
//   RSS 2.0 / Atom (content-type or XML sniff)  → entries as JSON (limit)
//   HTML                                        → Markdown (headings/links/
//     code survive; optional Readability extractor), static pages only
//   anything else (text, non-feed XML, …)       → raw body
//
// The narrow factories (createFetchJsonTool / createReadFeedTool) remain for
// hosts that want strict single-shape tools; this one trades strictness for
// "one decision: read this URL".
//
// Family discipline: HttpTransport only (zero node:* imports — Node, browsers,
// Edge, mini-programs), http(s) only, byte-capped streaming body read,
// per-URL TTL cache (agents re-fetch the same page within a turn surprisingly
// often), network permission + tags ["http"]. Request headers come from the
// HOST (opts.headers — a browser-like UA is the host's policy call), never
// from the model.

import { fetchTransport, type HttpTransport, type Tool, type ToolResultValue } from "@lingjing-agent/core";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { parseFeed } from "./read-feed.js";
import { parseAllowedUrl, readBodyText, requestError, transportGet } from "./shared.js";

const DEFAULT_CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX_ENTRIES = 50;
const DEFAULT_FEED_LIMIT = 10;
const MAX_FEED_LIMIT = 50;

/**
 * Custom HTML→content extractor for web_fetch (e.g. the Readability-based one
 * from `@lingjing-agent/tools/node`). Receives the raw HTML and the page
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
  /** Successful results cached per URL (+feed limit) for this long. Default 15 min; 0 disables. */
  cacheTtlMs?: number;
  /** Content extractor for HTML bodies (Node hosts: Readability — see
   *  `createReadabilityExtractor` in `@lingjing-agent/tools/node`).
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
      "Fetch an http(s) URL and return its content in the right shape, chosen " +
      "by what the server returns: JSON APIs → pretty-printed JSON; RSS/Atom " +
      "feeds → entries as JSON (pass limit); HTML pages → Markdown with " +
      "followable links and code blocks; anything else → raw text. HTML works " +
      "for static, server-rendered pages — JS-heavy apps may return little. " +
      "Results are cached per URL for 15 min.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL to GET." },
          limit: { type: "number", description: `Max feed entries when the URL is an RSS/Atom feed (1-${MAX_FEED_LIMIT}). Default ${DEFAULT_FEED_LIMIT}.` },
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
      const inputLimit = (raw as { limit?: unknown }).limit;
      const feedLimit = typeof inputLimit === "number" && Number.isFinite(inputLimit)
        ? clampFeedLimit(Math.floor(inputLimit))
        : DEFAULT_FEED_LIMIT;
      const cacheKey = `${url}|limit=${feedLimit}`;

      if (cacheTtlMs > 0) {
        const hit = cache.get(cacheKey);
        if (hit !== undefined && Date.now() - hit.at < cacheTtlMs) return hit.result;
        if (hit !== undefined) cache.delete(cacheKey); // expired — re-insert below as newest
      }

      let resp;
      try {
        resp = await transportGet(transport, url, {
          accept:
            "text/html,application/xhtml+xml,application/json," +
            "application/rss+xml,application/atom+xml,text/plain;q=0.9,*/*;q=0.7",
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
      const result = resp.status >= 400
        ? rawResult(url, resp.status, resp.statusText, contentType, body)
        : await dispatch(url, resp.status, resp.statusText, contentType, body, feedLimit, maxBytes);

      if (cacheTtlMs > 0 && result.isError !== true && !ctx.signal.aborted) {
        cache.set(cacheKey, { at: Date.now(), result });
        while (cache.size > CACHE_MAX_ENTRIES) {
          const oldest = cache.keys().next();
          if (oldest.done === true) break;
          cache.delete(oldest.value);
        }
      }
      return result;
    },
  };

  /** Error statuses keep the raw body (often carries the failure reason). */
  function rawResult(
    url: string,
    status: number,
    statusText: string,
    contentType: string,
    body: { text: string; truncated: boolean },
  ): ToolResultValue {
    return {
      content:
        `url: ${url}\nstatus: ${status} ${statusText}` +
        `\ncontent-type: ${contentType || "(none)"}` +
        (body.truncated ? `\n[truncated at ${maxBytes} bytes]` : "") +
        `\n\n${body.text}`,
      isError: true,
    };
  }

  /** The universal dispatch: pick the shape by what came back. */
  async function dispatch(
    url: string,
    status: number,
    statusText: string,
    contentType: string,
    body: { text: string; truncated: boolean },
    feedLimit: number,
    cap: number,
  ): Promise<ToolResultValue> {
    const header =
      `url: ${url}\nstatus: ${status} ${statusText}` +
      `\ncontent-type: ${contentType || "(none)"}` +
      (body.truncated ? `\n[truncated at ${cap} bytes]` : "");
    const head = body.text.slice(0, 1024).trimStart();

    // Feeds: declared by content-type, or sniffed from the XML prolog+root.
    const looksFeed =
      /(rss|atom|feed)/i.test(contentType) ||
      (/^<\?xml/i.test(head) && /<(rss|feed|rdf:rdf)\b/i.test(body.text.slice(0, 2048)));
    if (looksFeed) {
      const feed = parseFeed(body.text, feedLimit);
      if (feed !== undefined) {
        const feedHeader =
          `feed: ${feed.title ?? "(untitled)"}\nurl: ${url}` +
          (body.truncated ? `\n[body truncated at ${cap} bytes — later entries may be cut]` : "") +
          `\nitems: ${feed.items.length}${feed.omitted !== undefined ? ` (${feed.omitted} more omitted)` : ""}`;
        return { content: `${feedHeader}\n${JSON.stringify(feed.items, null, 2)}` };
      }
      // not actually a feed → fall through to raw
    }

    // HTML → Markdown (with the optional extractor hook).
    if (/html/i.test(contentType) || /^<(!doctype|html)\b/i.test(head)) {
      let extracted: string | undefined;
      if (extractor !== undefined) {
        try {
          extracted = await extractor(body.text, url);
        } catch {
          /* fall back to the built-in converter below */
        }
      }
      const text = extracted !== undefined && extracted !== "" ? extracted : htmlToMarkdown(body.text, url);
      return { content: `${header}\n\n${text}` };
    }

    // JSON: declared, or a body that starts like JSON and parses.
    if (/json/i.test(contentType) || /^[[{]/.test(head)) {
      try {
        const value: unknown = JSON.parse(body.text);
        return { content: `${header}\n${JSON.stringify(value, null, 2)}` };
      } catch {
        if (body.truncated) {
          return { content: `Body truncated at ${cap} bytes before the JSON could be parsed.`, isError: true };
        }
        // declared JSON but unparseable → raw with a note (fall through)
        return { content: `${header}\n[unparseable as JSON — raw body]\n${body.text}` };
      }
    }

    return { content: `${header}\n\n${body.text}` };
  }
}

function clampFeedLimit(n: number): number {
  return Math.max(1, Math.min(MAX_FEED_LIMIT, n));
}
