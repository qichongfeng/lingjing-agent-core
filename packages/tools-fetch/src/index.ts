// @lingjing-agent/tools-fetch — cross-runtime web_fetch tool.
//
// Zero node:* imports: safe to bundle into browser/Edge/mini-program hosts.
// Opt-in like every tool factory — inject only if you pass it to
// createAgent({ tools }).

export { createWebFetchTool } from "./web-fetch.js";
export type { WebFetchToolOptions } from "./web-fetch.js";
export { htmlToText } from "./html-to-text.js";
