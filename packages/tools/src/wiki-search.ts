// wiki_search tool — search Wikipedia (any language edition), no API key.
//
// Wikipedia's MediaWiki API is one of the few search backends that is BOTH
// free and browser-friendly: with `origin=*` it sends
// `Access-Control-Allow-Origin: *`, so the SAME tool works client-side, in
// Node, and in mini-programs (HttpTransport permitting). Ideal for
// concept/encyclopedia lookups — "什么是 X", "X 的原理", definitions, facts
// with a stable canonical page behind each hit.
//
// Family discipline: HttpTransport only, byte-capped read, network
// permission, tags ["http", "search"].

import { fetchTransport, type HttpTransport, type Tool, type ToolResultValue } from "@lingjing-agent/core";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { readBodyText, requestError, transportGet } from "./shared.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const RESULT_BODY_CAP = 256 * 1024;

export interface WikiSearchResult {
  title: string;
  url: string;
  snippet: string;
  lang: string;
}

export interface WikiSearchToolOptions {
  /** Wikipedia editions to search, merged in order (e.g. ["zh", "en"]). Default ["en"]. */
  languages?: string[];
  /** Results per edition when the call does not specify `limit`. Default 5 (max 10). */
  limit?: number;
  /** Custom transport (e.g. mini-program wx.request bridge). Default fetchTransport(). */
  transport?: HttpTransport;
  /** Tool-level timeout. Default 15_000 ms. */
  timeoutMs?: number;
}

export function createWikiSearchTool(opts: WikiSearchToolOptions = {}): Tool {
  const languages = (opts.languages ?? ["en"]).map((l) => l.replace(/[^a-z-]/gi, ""));
  const langs = languages.length > 0 && languages[0] !== "" ? languages : ["en"];
  const defaultLimit = clampLimit(opts.limit ?? DEFAULT_LIMIT);
  const transport = opts.transport ?? fetchTransport();
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return {
    name: "wiki_search",
    description:
      "Search Wikipedia and return entries as JSON ([{title, url, snippet, lang}]). " +
      "Free, reliable, and multilingual — the first choice for concepts, " +
      "definitions, and factual lookups; open a hit's url with web_fetch for detail.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          limit: { type: "number", description: `Max entries per language (1-${MAX_LIMIT}). Default ${DEFAULT_LIMIT}.` },
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
      const inputLimit = (raw as { limit?: unknown }).limit;
      const limit = typeof inputLimit === "number" && Number.isFinite(inputLimit)
        ? clampLimit(Math.floor(inputLimit))
        : defaultLimit;

      // One request per language edition; results merged in language order.
      const results = await Promise.all(
        langs.map(async (lang): Promise<WikiSearchResult[] | Error> => {
          const url =
            `https://${lang}.wikipedia.org/w/api.php?action=query&list=search` +
            `&srsearch=${encodeURIComponent(query.trim())}&srlimit=${limit}&format=json&origin=*`;
          try {
            const resp = await transportGet(transport, url, { accept: "application/json", signal: ctx.signal });
            const body = await readBodyText(resp, RESULT_BODY_CAP);
            if (resp.status >= 400) return new Error(`HTTP ${resp.status} from ${lang}.wikipedia.org`);
            const search = (JSON.parse(body.text) as { query?: { search?: unknown[] } }).query?.search ?? [];
            return search.map((r): WikiSearchResult => {
              const e = r as { title?: unknown; snippet?: unknown };
              const title = typeof e.title === "string" ? e.title : "";
              const snippet =
                typeof e.snippet === "string"
                  ? htmlToMarkdown(e.snippet).replace(/\s+/g, " ").trim() // strip <span class="searchmatch"> highlights
                  : "";
              return {
                title,
                url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
                snippet,
                lang,
              };
            });
          } catch (err) {
            return err instanceof Error ? err : new Error(String(err));
          }
        }),
      );

      const out: WikiSearchResult[] = [];
      const errors: string[] = [];
      for (const r of results) {
        if (r instanceof Error) errors.push(r.message);
        else out.push(...r);
      }
      if (out.length === 0) {
        // Zero hits is a valid outcome; every edition failing is not.
        if (errors.length === 0) return { content: `No Wikipedia results for: ${query}` };
        return { content: `Wikipedia search failed: ${errors.join("; ")}`, isError: true };
      }
      const note = errors.length > 0 ? `\n[partial failure: ${errors.join("; ")}]` : "";
      return { content: `${JSON.stringify(out, null, 2)}${note}` };
    },
  };
}

function clampLimit(n: number): number {
  return Math.max(1, Math.min(MAX_LIMIT, n));
}
