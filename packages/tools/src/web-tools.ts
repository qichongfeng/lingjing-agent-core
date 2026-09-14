// createWebTools — the one-call toolbox. Aggregation happens at the FACTORY
// level, never at the tool level: the model still sees focused, well-named
// tools (routing by name+description beats a multi-mode dispatcher whose
// errors hide in parameter validation). Returns the recommended set:
//
//   web_read    universal URL reader (JSON / feeds / HTML → Markdown)
//   wiki_search keyless Wikipedia search
//   web_search  keyed web search — included ONLY when configured (apiKey)
//
// Each entry: pass options to configure, or `false` to leave it out.

import type { Tool } from "@lingjing-agent/core";
import { createWebReadTool, type WebReadToolOptions } from "./web-read.js";
import { createWikiSearchTool, type WikiSearchToolOptions } from "./wiki-search.js";
import { createWebSearchTool, type WebSearchToolOptions } from "./web-search.js";

export interface WebToolsOptions {
  /** Universal URL reader (web_read). Default: enabled. */
  read?: false | WebReadToolOptions;
  /** Keyless Wikipedia search. Default: enabled. */
  wiki?: false | WikiSearchToolOptions;
  /** Keyed web search (Serper). Included only when provided — requires a
   *  host-owned apiKey; see web-search.ts for the browser-direct caveat. */
  webSearch?: WebSearchToolOptions;
}

/** Build the recommended web toolset in one call: `tools: [...createWebTools({ wiki: { languages: ["zh","en"] } })]`. */
export function createWebTools(opts: WebToolsOptions = {}): Tool[] {
  const tools: Tool[] = [];
  if (opts.read !== false) tools.push(createWebReadTool(opts.read ?? {}));
  if (opts.wiki !== false) tools.push(createWikiSearchTool(opts.wiki ?? {}));
  if (opts.webSearch !== undefined) tools.push(createWebSearchTool(opts.webSearch));
  return tools;
}
