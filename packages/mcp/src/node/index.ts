// @lingjing-agent/mcp/node — stdio halves: spawn an MCP server child (client)
// and serve core tools over this process's stdin/stdout (server channel).
//
// Node/Electron/Tauri-main ONLY (imports node:* builtins) — never bundle this
// subpath into browser/Edge/mini-program code. The package's main entry is
// the cross-runtime half (HTTP transport + Tool bridge + MCP server).

export { createStdioMcpTransport } from "./stdio.js";
export type { StdioMcpTransportOptions } from "./stdio.js";
export { createStdioMcpServerChannel } from "./stdio-server.js";
export type { StdioMcpServerChannelOptions } from "./stdio-server.js";
