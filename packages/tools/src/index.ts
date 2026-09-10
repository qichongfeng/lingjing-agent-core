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
// The reliable-first web toolbox: web_search (host-keyed search API) and
// read_feed (RSS/Atom) for discovery and structured reads, fetch_json for
// JSON APIs, and web_fetch as a best-effort Markdown reader for static,
// server-rendered pages.

export { createWebFetchTool } from "./web-fetch.js";
export type { WebFetchToolOptions, HtmlExtractor } from "./web-fetch.js";
export { createFetchJsonTool } from "./fetch-json.js";
export type { FetchJsonToolOptions } from "./fetch-json.js";
export { createReadFeedTool } from "./read-feed.js";
export type { ReadFeedToolOptions, FeedItem } from "./read-feed.js";
export { createWebSearchTool } from "./web-search.js";
export type { WebSearchToolOptions, WebSearchEngine, WebSearchResult } from "./web-search.js";
export { htmlToMarkdown } from "./html-to-markdown.js";
