// web_search tool — web search via a host-configured search API (Brave /
// Tavily / Serper), returning {title, url, snippet} entries.
//
// Search is the reliable answer to "the model needs to know something
// current": snippets are server-rendered by the provider, immune to the SPA
// and anti-bot failures that make direct page reads (web_read) unreliable
// — and often answer the question without fetching anything at all.
//
// The API key is HOST-owned configuration (opts.apiKey), exactly like OAuth
// credentials in the MCP package — never something the model supplies. Same
// family discipline: HttpTransport only (zero node:* imports), byte-capped
// reads, network permission, tags ["http", "search"].

import { fetchTransport, type HttpTransport, type Tool, type ToolResultValue } from "@lingjing-agent/core";
import { DEFAULT_USER_AGENT, readBodyText, requestError } from "./shared.js";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const RESULT_BODY_CAP = 256 * 1024;

export type WebSearchEngine = "brave" | "tavily" | "serper";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchToolOptions {
  /** Search API to call. Default "brave". */
  engine?: WebSearchEngine;
  /** Host-owned API key for the engine (Brave API / Tavily / Serper). Required. */
  apiKey: string;
  /** Custom transport (e.g. mini-program wx.request bridge). Default fetchTransport(). */
  transport?: HttpTransport;
  /** Results returned when the call does not specify `maxResults`. Default 5 (max 10). */
  maxResults?: number;
  /** Tool-level timeout. Default 15_000 ms. */
  timeoutMs?: number;
}

interface EngineRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  /** Map the engine's JSON response to common results. */
  parse: (data: unknown) => WebSearchResult[];
}

export function createWebSearchTool(opts: WebSearchToolOptions): Tool {
  if (typeof opts.apiKey !== "string" || opts.apiKey === "") {
    throw new Error("createWebSearchTool: opts.apiKey is required (host-owned search API key)");
  }
  const engine = opts.engine ?? "brave";
  const transport = opts.transport ?? fetchTransport();
  const defaultMaxResults = clampResults(opts.maxResults ?? DEFAULT_MAX_RESULTS);
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return {
    name: "web_search",
    description:
      "Search the web and return entries as JSON ([{title, url, snippet}]). " +
      "Use for current information and discovery; snippets often answer the " +
      "question directly — read a result URL only when detail is needed.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          maxResults: { type: "number", description: `Max entries (1-${MAX_RESULTS}). Default ${DEFAULT_MAX_RESULTS}.` },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    timeoutMs,
    permissions: { network: true, tags: ["http", "search"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      const query = (raw as { query?: unknown }).query;
      if (typeof query !== "string" || query.trim() === "") {
        return { content: "Refused: input.query must be a non-empty string", isError: true };
      }
      const inputMax = (raw as { maxResults?: unknown }).maxResults;
      const maxResults = typeof inputMax === "number" && Number.isFinite(inputMax)
        ? clampResults(Math.floor(inputMax))
        : defaultMaxResults;

      const req = engineRequest(engine, opts.apiKey, query.trim(), maxResults);
      let resp;
      try {
        resp = await transport({
          url: req.url,
          method: req.method,
          headers: { "user-agent": DEFAULT_USER_AGENT, ...req.headers },
          ...(req.body !== undefined && { body: req.body }),
          signal: ctx.signal,
        });
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
        // 401/403 from a search API is a host-key problem the model cannot fix.
        const hint = resp.status === 401 || resp.status === 403 ? " — check the configured API key" : "";
        return {
          content: `Search failed: ${resp.status} ${resp.statusText}${hint}${snippet === "" ? "" : `\n${snippet}`}`,
          isError: true,
        };
      }

      let data: unknown;
      try {
        data = JSON.parse(body.text);
      } catch {
        return { content: "Search API returned a non-JSON response", isError: true };
      }
      const results = req.parse(data).slice(0, maxResults);
      if (results.length === 0) {
        return { content: `No results for: ${query}` };
      }
      return { content: JSON.stringify(results, null, 2) };
    },
  };
}

function clampResults(n: number): number {
  return Math.max(1, Math.min(MAX_RESULTS, n));
}

function engineRequest(
  engine: WebSearchEngine,
  apiKey: string,
  query: string,
  maxResults: number,
): EngineRequest {
  switch (engine) {
    case "brave":
      return {
        url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
        method: "GET",
        headers: { accept: "application/json", "accept-encoding": "gzip", "x-subscription-token": apiKey },
        parse: (data) => {
          const results = (data as { web?: { results?: unknown[] } }).web?.results ?? [];
          return results.map((r): WebSearchResult => {
            const e = r as { title?: unknown; url?: unknown; description?: unknown };
            return {
              title: typeof e.title === "string" ? e.title : "",
              url: typeof e.url === "string" ? e.url : "",
              snippet: typeof e.description === "string" ? e.description : "",
            };
          });
        },
      };
    case "tavily":
      return {
        url: "https://api.tavily.com/search",
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, max_results: maxResults }),
        parse: (data) => {
          const results = (data as { results?: unknown[] }).results ?? [];
          return results.map((r): WebSearchResult => {
            const e = r as { title?: unknown; url?: unknown; content?: unknown };
            return {
              title: typeof e.title === "string" ? e.title : "",
              url: typeof e.url === "string" ? e.url : "",
              snippet: typeof e.content === "string" ? e.content : "",
            };
          });
        },
      };
    case "serper":
      return {
        url: "https://google.serper.dev/search",
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ q: query, num: maxResults }),
        parse: (data) => {
          const results = (data as { organic?: unknown[] }).organic ?? [];
          return results.map((r): WebSearchResult => {
            const e = r as { title?: unknown; link?: unknown; snippet?: unknown };
            return {
              title: typeof e.title === "string" ? e.title : "",
              url: typeof e.link === "string" ? e.link : "",
              snippet: typeof e.snippet === "string" ? e.snippet : "",
            };
          });
        },
      };
  }
}
