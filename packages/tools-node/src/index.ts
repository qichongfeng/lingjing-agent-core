// @lingjing-agent/tools-node — optional built-in tools for Node hosts.
//
// Node/Electron/Tauri-main ONLY (imports node:* builtins) — never bundle this
// package into Edge/browser/mini-program code. Everything is opt-in: the
// factories return plain Tool objects; inject only what you pass to
// createAgent({ tools }).

export { createFsTools } from "./fs.js";
export type { FsToolsOptions } from "./fs.js";
export { createSafeShell } from "./shell.js";
export type { SafeShellOptions } from "./shell.js";
export { createGlobTool, createGrepTool } from "./glob-grep.js";
export type { SearchToolsOptions } from "./glob-grep.js";
