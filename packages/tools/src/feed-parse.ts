// RSS 2.0 / Atom feed parsing — shared by web_read's content dispatch (a
// feed-shaped response is parsed into entries right inside the universal
// reader) and available to hosts directly.
//
// Feeds are the most reliable read channel on the web: structured XML,
// server-rendered, no anti-bot, no SPA shell. Zero-dependency,
// tolerance-first parsing: feeds in the wild routinely carry HTML inside
// descriptions, CDATA sections, bare entities, and namespace-prefixed tags
// (dc:date), so fields are extracted with tolerant regex scans and
// everything is optional except a usable link/title.

import { htmlToMarkdown } from "./html-to-markdown.js";

const SUMMARY_CAP = 1000;

export interface FeedItem {
  title?: string;
  url?: string;
  date?: string;
  summary?: string;
}

export interface ParsedFeed {
  title?: string;
  items: FeedItem[];
  omitted?: number;
}

/** Parse RSS 2.0 or Atom; undefined when neither shape matches. `limit` is
 *  expected pre-clamped by the caller (web_read clamps to 1..50). */
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
