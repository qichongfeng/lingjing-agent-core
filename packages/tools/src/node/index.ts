// @lingjing-agent/tools — Node layer (the "./node" subpath).
//
// Node/Electron/Tauri-main ONLY (imports node:* builtins and DOM-dependent
// packages) — never bundle this entry into Edge/browser/mini-program code.
// Everything is opt-in: import a factory, pass its tools to
// createAgent({ tools }).
//
// Contents:
// - fs (path-confined read/write/list/delete) + hardened shell + glob/grep,
//   carried over from the former @lingjing-agent/tools-node package;
// - createReadabilityExtractor: Firefox Reader Mode content scoring for
//   web_fetch (@mozilla/readability + linkedom, OPTIONAL peerDependencies —
//   install them yourself).

export { createFsTools } from "./fs.js";
export type { FsToolsOptions } from "./fs.js";
export { createSafeShell } from "./shell.js";
export type { SafeShellOptions } from "./shell.js";
export { createGlobTool, createGrepTool } from "./glob-grep.js";
export type { SearchToolsOptions } from "./glob-grep.js";
export { createReadabilityExtractor } from "./readability.js";
export type { ReadabilityExtractorOptions } from "./readability.js";
