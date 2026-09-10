// read_feed tool — fetch an RSS 2.0 / Atom feed and return its entries as
// structured JSON.
//
// Feeds are the most reliable read channel on the web: structured XML,
// server-rendered, no anti-bot, no SPA shell. News, blogs, changelogs,
// release notes — anywhere a site offers a feed, this beats scraping the
// HTML page (web_fetch) on both coverage and stability.
//
// Zero-dependency, tolerance-first parsing: feeds in the wild routinely
// carry HTML inside descriptions, CDATA sections, bare entities, and
// namespace-prefixed tags (dc:date), so fields are extracted with tolerant
// regex scans and everything optional except a usable link/title. Same
// family discipline: HttpTransport only, http(s) only, byte cap, network
// permission, tags ["http", "feed"].

import { fetchTransport, type HttpTransport, type Tool, type ToolResultValue } from "@lingjing-agent/core";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { parseAllowedUrl, readBodyText, requestError, transportGet } from "./shared.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SUMMARY_CAP = 1000;

export interface FeedItem {
  title?: string;
  url?: string;
  date?: string;
  summary?: string;
}

export interface ReadFeedToolOptions {
  /** Custom transport (e.g. mini-program wx.request bridge). Default fetchTransport(). */
  transport?: HttpTransport;
  /** Max bytes read from the response body. Default 256 KiB. */
  maxBytes?: number;
  /** Tool-level timeout — also caps the whole body read. Default 30_000 ms. */
  timeoutMs?: number;
  /** Allowed URL schemes. Default ["http:", "https:"]. */
  allowedProtocols?: string[];
  /** Items returned when the call does not specify `limit`. Default 10 (max 50). */
  defaultLimit?: number;
}

export function createReadFeedTool(opts: ReadFeedToolOptions = {}): Tool {
  const transport = opts.transport ?? fetchTransport();
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const allowedProtocols = new Set(opts.allowedProtocols ?? ["http:", "https:"]);
  const defaultLimit = clampLimit(opts.defaultLimit ?? DEFAULT_LIMIT);

  return {
    name: "read_feed",
    description:
      "Fetch an RSS or Atom feed URL and return its entries as JSON " +
      "([{title, url, date, summary}], most recent first as the feed orders " +
      "them). Feeds are structured and reliable — the best way to read news, " +
      "blogs, changelogs, and release notes.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute http(s) URL of an RSS/Atom feed." },
          limit: { type: "number", description: `Max entries to return (1-${MAX_LIMIT}). Default ${DEFAULT_LIMIT}.` },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    timeoutMs,
    permissions: { network: true, tags: ["http", "feed"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      const parsed = parseAllowedUrl(raw, allowedProtocols);
      if (!parsed.ok) return { content: parsed.error, isError: true };
      const url = parsed.url.toString();
      const input = raw as { limit?: unknown };
      const limit = typeof input.limit === "number" && Number.isFinite(input.limit)
        ? clampLimit(Math.floor(input.limit))
        : defaultLimit;

      let resp;
      try {
        resp = await transportGet(transport, url, {
          accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
          signal: ctx.signal,
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

      if (resp.status >= 400) {
        return { content: `url: ${url}\nstatus: ${resp.status} ${resp.statusText}`, isError: true };
      }

      const feed = parseFeed(body.text, limit);
      if (feed === undefined) {
        const cut = body.truncated ? ` (body truncated at ${maxBytes} bytes — entries may be cut off)` : "";
        return { content: `No RSS/Atom entries found at ${url}${cut} — not a feed?`, isError: true };
      }
      const header =
        `feed: ${feed.title ?? "(untitled)"}\nurl: ${url}` +
        (body.truncated ? `\n[body truncated at ${maxBytes} bytes — later entries may be cut]` : "") +
        `\nitems: ${feed.items.length}${feed.omitted !== undefined ? ` (${feed.omitted} more omitted)` : ""}`;
      return { content: `${header}\n${JSON.stringify(feed.items, null, 2)}` };
    },
  };
}

function clampLimit(n: number): number {
  return Math.max(1, Math.min(MAX_LIMIT, n));
}

export interface ParsedFeed {
  title?: string;
  items: FeedItem[];
  omitted?: number;
}

/** Parse RSS 2.0 or Atom; undefined when neither shape matches. Shared with
 *  web_fetch's universal reader (feed responses dispatched by content sniff). */
export function parseFeed(xml: string, limit: number): ParsedFeed | undefined {
  const atomEntries = collectBlocks(xml, "entry");
  const isAtom = atomEntries.length > 0;
  const blocks = isAtom ? atomEntries : collectBlocks(xml, "item");
  if (blocks.length === 0) return undefined;

  const rawTitle = firstTag(isAtom ? atomChannelScope(xml) : xml, "title");
  const feedTitle = rawTitle === undefined ? undefined : decodeXml(rawTitle);
  const items = blocks.slice(0, limit).map((b) => (isAtom ? parseAtomEntry(b) : parseRssItem(b)));
  return {
    ...(feedTitle !== undefined && { title: feedTitle }),
    items,
    ...(blocks.length > limit ? { omitted: blocks.length - limit } : {}),
  };
}

/** Atom feed title lives before the first <entry>; RSS channel title is the
 *  first <title> overall. Scope the scan so an entry title can't shadow it. */
function atomChannelScope(xml: string): string {
  const i = xml.search(/<entry[\s>]/i);
  return i === -1 ? xml : xml.slice(0, i);
}

function collectBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "gi");
  for (;;) {
    const m = re.exec(xml);
    if (m === null) break;
    const inner = m[1];
    if (inner !== undefined) out.push(inner);
  }
  return out;
}

/** First matching tag's inner text (CDATA-stripped, entities decoded);
 *  undefined when absent. */
function firstTag(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (m === null || m[1] === undefined) return undefined;
  return decodeXml(m[1]).trim();
}

/** First matching tag trying several names in order. */
function firstTagAny(block: string, tags: string[]): string | undefined {
  for (const t of tags) {
    const v = firstTag(block, t);
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

function parseRssItem(block: string): FeedItem {
  const item: FeedItem = {};
  const title = firstTag(block, "title");
  if (title !== undefined && title !== "") item.title = title;
  const link = firstTag(block, "link");
  if (link !== undefined && link !== "") item.url = link;
  const date = firstTagAny(block, ["pubDate", "dc:date", "date"]);
  if (date !== undefined && date !== "") item.date = date;
  const summary = firstTagAny(block, ["description", "summary"]);
  if (summary !== undefined && summary !== "") item.summary = capSummary(summary);
  return item;
}

function parseAtomEntry(block: string): FeedItem {
  const item: FeedItem = {};
  const title = firstTag(block, "title");
  if (title !== undefined && title !== "") item.title = title;
  const href = atomLink(block);
  if (href !== undefined) item.url = href;
  const date = firstTagAny(block, ["updated", "published", "dc:date"]);
  if (date !== undefined && date !== "") item.date = date;
  const summary = firstTagAny(block, ["summary", "content"]);
  if (summary !== undefined && summary !== "") item.summary = capSummary(summary);
  return item;
}

/** Atom link: <link rel="alternate" href="…"/> preferred, first link otherwise. */
function atomLink(block: string): string | undefined {
  let first: string | undefined;
  const re = /<link\b([^>]*?)\/?>/gi;
  for (;;) {
    const m = re.exec(block);
    if (m === null) break;
    const attrs = m[1] ?? "";
    const href = /href\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
    const val = href ? (href[2] ?? href[3]) : undefined;
    if (val === undefined || val === "") continue;
    if (/\brel\s*=\s*("alternate"|'alternate')/i.test(attrs)) return val;
    first ??= val;
  }
  return first;
}

/** Feed summaries are HTML more often than not — sometimes literally (<p>…),
 *  sometimes entity-escaped inside the XML (&lt;p&gt;…). Decode first, then
 *  distill to Markdown if tags remain (links survive), then cap. */
function capSummary(raw: string): string {
  const decoded = decodeXml(raw);
  const text = /<[a-z!/][\s\S]*>/i.test(decoded) ? htmlToMarkdown(decoded) : decoded;
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > SUMMARY_CAP ? `${oneLine.slice(0, SUMMARY_CAP)}…` : oneLine;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/** Decode the XML builtin + numeric entities feeds actually use. */
function decodeXml(s: string): string {
  return stripCdata(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&"); // amp LAST so we never double-decode
}

function safeFromCodePoint(cp: number): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return "�";
  }
}
