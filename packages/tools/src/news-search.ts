// news_search tool — search Hacker News via the Algolia API, no API key.
//
// HN's public search API (hn.algolia.com) is free, keyless, and sends
// `Access-Control-Allow-Origin: *`, so it runs browser-direct like the rest
// of the family. Scope is TECH NEWS (HN is a tech-news aggregator) — for
// general current events there is no free + CORS-open search backend; that
// still requires a keyed API (see web_search) or a host-side proxy.
//
// Two orderings: relevance (default) or most-recent-first (`recent: true`),
// which is what "最新/最近有什么新闻" wants.
//
// Family discipline: HttpTransport only, byte-capped read, network
// permission, tags ["http", "news"].

import { fetchTransport, type HttpTransport, type Tool, type ToolResultValue } from "@lingjing-agent/core";
import { readBodyText, requestError, transportGet } from "./shared.js";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const RESULT_BODY_CAP = 256 * 1024;

export interface NewsSearchResult {
  title: string;
  url: string;
  source: "hackernews";
  points: number;
  comments: number;
  author: string;
  createdAt: string;
}

export interface NewsSearchToolOptions {
  /** Results returned when the call does not specify `limit`. Default 8 (max 20). */
  limit?: number;
  /** Custom transport (e.g. mini-program wx.request bridge). Default fetchTransport(). */
  transport?: HttpTransport;
  /** Tool-level timeout. Default 15_000 ms. */
  timeoutMs?: number;
}

export function createNewsSearchTool(opts: NewsSearchToolOptions = {}): Tool {
  const defaultLimit = clampLimit(opts.limit ?? DEFAULT_LIMIT);
  const transport = opts.transport ?? fetchTransport();
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return {
    name: "news_search",
    description:
      "Search news via Hacker News (tech-community source: tech, science, and " +
      "major current events through that lens) and return stories as JSON " +
      "([{title, url, points, comments, author, createdAt}]). Pass recent: true " +
      "for newest-first. The output starts with an as_of UTC timestamp — judge " +
      "each story's recency (createdAt) against it, not against your training " +
      "data's sense of time. Content is ENGLISH — translate the query to English " +
      "before searching; say so when the user asks about non-tech or local news.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: { type: "number", description: `Max stories (1-${MAX_LIMIT}). Default ${DEFAULT_LIMIT}.` },
          recent: { type: "boolean", description: "Order by newest first instead of relevance." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    timeoutMs,
    permissions: { network: true, tags: ["http", "news"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      const query = (raw as { query?: unknown }).query;
      if (typeof query !== "string" || query.trim() === "") {
        return { content: "Refused: input.query must be a non-empty string", isError: true };
      }
      const input = raw as { limit?: unknown; recent?: unknown };
      const limit = typeof input.limit === "number" && Number.isFinite(input.limit)
        ? clampLimit(Math.floor(input.limit))
        : defaultLimit;
      const endpoint = input.recent === true ? "search_by_date" : "search";

      let resp;
      try {
        resp = await transportGet(
          transport,
          `https://hn.algolia.com/api/v1/${endpoint}?query=${encodeURIComponent(query.trim())}` +
            `&tags=story&hitsPerPage=${limit}`,
          { accept: "application/json", signal: ctx.signal },
        );
      } catch (err) {
        return requestError(err, ctx.signal.aborted);
      }

      let body: { text: string; truncated: boolean };
      try {
        body = await readBodyText(resp, RESULT_BODY_CAP);
      } catch (err) {
        return requestError(err, ctx.signal.aborted);
      }

      if (resp.status >= 400) {
        const snippet = body.text.slice(0, 512).replace(/\s+/g, " ").trim();
        return { content: `Search failed: ${resp.status} ${resp.statusText}${snippet}`, isError: true };
      }

      let data: unknown;
      try {
        data = JSON.parse(body.text);
      } catch {
        return { content: "Search API returned a non-JSON response", isError: true };
      }
      const hits = ((data as { hits?: unknown[] }).hits ?? []).slice(0, limit);
      const results = hits.map((h): NewsSearchResult => {
        const e = h as Record<string, unknown>;
        const title = typeof e["title"] === "string" ? e["title"] : "";
        const objectID = typeof e["objectID"] === "string" ? e["objectID"] : "";
        const url = typeof e["url"] === "string" && e["url"] !== "" ? e["url"] : `https://news.ycombinator.com/item?id=${objectID}`;
        return {
          title,
          url,
          source: "hackernews",
          points: typeof e["points"] === "number" ? e["points"] : 0,
          comments: typeof e["num_comments"] === "number" ? e["num_comments"] : 0,
          author: typeof e["author"] === "string" ? e["author"] : "",
          createdAt: typeof e["created_at"] === "string" ? e["created_at"] : "",
        };
      });
      if (results.length === 0) return { content: `No news results for: ${query}` };
      // The model has no clock: anchor recency judgments to this timestamp.
      return { content: `as_of: ${new Date().toISOString()}\n${JSON.stringify(results, null, 2)}` };
    },
  };
}

function clampLimit(n: number): number {
  return Math.max(1, Math.min(MAX_LIMIT, n));
}
