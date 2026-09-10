// createWebTools — the one-call toolbox. Aggregation happens at the FACTORY
// level, never at the tool level: the model still sees focused, well-named
// tools (routing by name+description beats a multi-mode dispatcher whose
// errors hide in parameter validation). Returns the recommended set:
//
//   web_fetch   universal URL reader (JSON / feeds / HTML → Markdown)
//   wiki_search keyless Wikipedia search
//   news_search keyless Hacker News search (recent option)
//   web_search  keyed web search — included ONLY when configured (apiKey)
//
// Each entry: pass options to configure, or `false` to leave it out.

import type { Tool } from "@lingjing-agent/core";
import { createWebFetchTool, type WebFetchToolOptions } from "./web-fetch.js";
import { createWikiSearchTool, type WikiSearchToolOptions } from "./wiki-search.js";
import { createNewsSearchTool, type NewsSearchToolOptions } from "./news-search.js";
import { createWebSearchTool, type WebSearchToolOptions } from "./web-search.js";

export interface WebToolsOptions {
  /** Universal URL reader. Default: enabled. */
  fetch?: false | WebFetchToolOptions;
  /** Keyless Wikipedia search. Default: enabled. */
  wiki?: false | WikiSearchToolOptions;
  /** Keyless Hacker News (tech news) search. Default: enabled. */
  news?: false | NewsSearchToolOptions;
  /** Keyed web search (Brave/Tavily/Serper). Included only when provided —
   *  requires a host-owned apiKey; never ship a key in client-side code. */
  webSearch?: WebSearchToolOptions;
}

/** Build the recommended web toolset in one call: `tools: [...createWebTools({ wiki: { languages: ["zh","en"] } })]`. */
export function createWebTools(opts: WebToolsOptions = {}): Tool[] {
  const tools: Tool[] = [];
  if (opts.fetch !== false) tools.push(createWebFetchTool(opts.fetch ?? {}));
  if (opts.wiki !== false) tools.push(createWikiSearchTool(opts.wiki ?? {}));
  if (opts.news !== false) tools.push(createNewsSearchTool(opts.news ?? {}));
  if (opts.webSearch !== undefined) tools.push(createWebSearchTool(opts.webSearch));
  return tools;
}
