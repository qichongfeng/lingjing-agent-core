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
// The reliable-first web toolbox: wiki_search (keyless) and web_search
// (host-keyed) for discovery, and web_read — the universal URL reader that
// auto-dispatches JSON / RSS·Atom / HTML by what the server returns.
// parseFeed / htmlToMarkdown are exported for direct use. Five non-web tools
// also live here: ask_user (human-in-the-loop clarification, host-injected
// handler) and update_plan (the agent's shared task list, Codex-style) —
// universal by construction, they need no transport at all — plus the
// artifact family: write_file / edit_file / read_file / manage_file (host-injected
// storage, one shared path namespace; manage = move/delete with a recursive
// opt-in) and preview (the agent's sandboxed window onto its OWN HTML
// artifacts: act/read/eval/shot over a driver-injected iframe; browser-like
// runtimes only, refuses gracefully elsewhere).

export { createAskUserTool } from "./ask-user.js";
export type { AskUserToolOptions, AskUserQuestion, AskUserOption, AskUserHandler } from "./ask-user.js";
export { createPlanTool } from "./plan.js";
export type { PlanToolOptions, PlanStep, PlanStatus, PlanUpdateInfo } from "./plan.js";
export { createWebReadTool } from "./web-read.js";
export type { WebReadToolOptions, HtmlExtractor, UrlForward } from "./web-read.js";
export { createWebSearchTool } from "./web-search.js";
export type { WebSearchToolOptions, WebSearchResult } from "./web-search.js";
export { createWikiSearchTool } from "./wiki-search.js";
export type { WikiSearchToolOptions, WikiSearchResult } from "./wiki-search.js";
export { htmlToMarkdown } from "./html-to-markdown.js";
export { parseFeed } from "./feed-parse.js";
export type { FeedItem, ParsedFeed } from "./feed-parse.js";
export { createWebTools } from "./web-tools.js";
export type { WebToolsOptions } from "./web-tools.js";
export { createPreviewTool } from "./preview.js";
export type {
  PreviewToolOptions,
  PreviewFrame,
  PreviewFrameInit,
  PreviewFrameFactory,
  PreviewAction,
} from "./preview.js";
export { createWriteFileTool } from "./write-file.js";
export type { WriteFileToolOptions } from "./write-file.js";
export { createEditFileTool } from "./edit-file.js";
export type { EditFileToolOptions } from "./edit-file.js";
export { createReadFileTool } from "./read-file.js";
export type { ReadFileToolOptions } from "./read-file.js";
export { createManageFileTool } from "./manage-file.js";
export type { ManageFileToolOptions } from "./manage-file.js";
export { createOpfsFilesystem, createFsaFilesystem, normalizeFsPath } from "./filesystem.js";
export type { Filesystem, DirHandle, FileHandle, FileWritable } from "./filesystem.js";
