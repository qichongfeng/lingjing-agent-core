// @lingjing-agent/tools — cross-runtime web tools for @lingjing-agent/core
// hosts. This is the package's MAIN entry: zero node:* imports, safe to
// bundle into browser/Edge/mini-program hosts. Opt-in like every tool
// factory — inject only the tools you pass to createAgent({ tools }).
//
// Node-only tools (fs/shell/glob/grep) and the Readability extractor live
// behind the "./node" subpath — same package, explicit opt-in for the Node
// layer; importing "./node" is the only step where platform-specific code
// enters your bundle.
//
// The reliable-first web toolbox: wiki_search / news_search (keyless) and
// web_search (host-keyed) for discovery, and web_fetch — the universal URL
// reader that auto-dispatches JSON / RSS·Atom / HTML by what the server
// returns. parseFeed / htmlToMarkdown are exported for direct use.

export { createWebFetchTool } from "./web-fetch.js";
export type { WebFetchToolOptions, HtmlExtractor } from "./web-fetch.js";
export { createWebSearchTool } from "./web-search.js";
export type { WebSearchToolOptions, WebSearchEngine, WebSearchResult } from "./web-search.js";
export { createWikiSearchTool } from "./wiki-search.js";
export type { WikiSearchToolOptions, WikiSearchResult } from "./wiki-search.js";
export { createNewsSearchTool } from "./news-search.js";
export type { NewsSearchToolOptions, NewsSearchResult } from "./news-search.js";
export { htmlToMarkdown } from "./html-to-markdown.js";
export { parseFeed } from "./feed-parse.js";
export type { FeedItem, ParsedFeed } from "./feed-parse.js";
export { createWebTools } from "./web-tools.js";
export type { WebToolsOptions } from "./web-tools.js";
