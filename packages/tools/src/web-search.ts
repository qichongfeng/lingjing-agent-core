// web_search tool — web search via Serper (google.serper.dev), returning
// {title, url, snippet} entries (Google results).
//
// Search is the reliable answer to "the model needs to know something
// current": snippets are server-rendered by the provider, immune to the SPA
// and anti-bot failures that make direct page reads (web_read) unreliable
// — and often answer the question without fetching anything at all.
//
// Why Serper as the single engine (probed 2026-09-14, from a mainland
// network): it is the only keyed search API that is BOTH browser-readable
// (Access-Control-Allow-Origin: * on the preflight AND on actual responses)
// AND reachable without a proxy. A pure browser host may therefore call it
// direct, accepting that the key ships in the bundle — with a free-tier key
// the worst case is quota theft, bounded. The alternatives failed the probe:
// Tavily answers preflights but sends no ACAO on actual responses (the
// browser cannot read the body); Brave sends no CORS headers at all; Jina
// s.jina.ai is CORS-open but unreachable from the mainland. Server-side
// hosts don't care about any of this and get Google-quality results.
//
// The API key is HOST-owned configuration (opts.apiKey), exactly like OAuth
// credentials in the MCP package — never something the model supplies. The
// ENDPOINT is customizable (opts.endpoint) for hosts that route through a
// gateway or a Serper-protocol-compatible backend — but the wire protocol
// itself is FIXED by this tool: POST with a {q, num} JSON body, an x-api-key
// header (ALWAYS sent — the key is part of the protocol, so it is required
// with every endpoint), and an organic[] response. Customize WHERE, never
// HOW. Same family discipline: HttpTransport only (zero node:* imports),
// byte-capped reads, network permission, tags ["http", "search"].

import { fetchTransport, type HttpTransport, type Tool, type ToolResultValue } from "@lingjing-agent/core";
import { DEFAULT_USER_AGENT, readBodyText, requestError } from "./shared.js";

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 10;
const RESULT_BODY_CAP = 256 * 1024;
const ENDPOINT = "https://google.serper.dev/search";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchToolOptions {
  /** Host-owned Serper API key (serper.dev — or the host gateway's own token
   *  when `endpoint` points at a proxy that swaps in the real key). Required
   *  with every endpoint: x-api-key is part of the wire protocol and is
   *  always sent. */
  apiKey: string;
  /** Serper-protocol endpoint to POST to. Default https://google.serper.dev/search.
   *  The wire protocol is FIXED by the tool ({q, num} body, x-api-key header,
   *  organic[] response) — this customizes WHERE requests go (own gateway
   *  route, Serper-compatible backend), never HOW they look. */
  endpoint?: string;
  /** Custom transport (e.g. mini-program wx.request bridge). Default fetchTransport(). */
  transport?: HttpTransport;
  /** Results returned when the call does not specify `maxResults`. Default 5 (max 10). */
  maxResults?: number;
  /** Tool-level timeout. Default 15_000 ms. */
  timeoutMs?: number;
}

export function createWebSearchTool(opts: WebSearchToolOptions): Tool {
  if (typeof opts.apiKey !== "string" || opts.apiKey === "") {
    throw new Error("createWebSearchTool: opts.apiKey is required with every endpoint (Serper key or gateway token)");
  }
  const endpoint = opts.endpoint ?? ENDPOINT;
  const transport = opts.transport ?? fetchTransport();
  const defaultMaxResults = clampResults(opts.maxResults ?? DEFAULT_MAX_RESULTS);
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return {
    name: "web_search",
    description:
      "Search the web (Google results) and return entries as JSON ([{title, url, snippet}]). " +
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

      let resp;
      try {
        resp = await transport({
          url: endpoint,
          method: "POST",
          headers: {
            "user-agent": DEFAULT_USER_AGENT,
            accept: "application/json",
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
          },
          body: JSON.stringify({ q: query.trim(), num: maxResults }),
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
      const organic = (data as { organic?: unknown[] }).organic ?? [];
      const results = organic.map((r): WebSearchResult => {
        const e = r as { title?: unknown; link?: unknown; snippet?: unknown };
        return {
          title: typeof e.title === "string" ? e.title : "",
          url: typeof e.link === "string" ? e.link : "",
          snippet: typeof e.snippet === "string" ? e.snippet : "",
        };
      });
      if (results.length === 0) {
        return { content: `No results for: ${query}` };
      }
      return { content: JSON.stringify(results.slice(0, maxResults), null, 2) };
    },
  };
}

function clampResults(n: number): number {
  return Math.max(1, Math.min(MAX_RESULTS, n));
}
