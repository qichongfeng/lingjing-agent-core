// @lingjing-agent/mcp/node — stdio transport (spawn an MCP server child).
//
// Node/Electron/Tauri-main ONLY (imports node:* builtins) — never bundle this
// subpath into browser/Edge/mini-program code. The package's main entry is
// the cross-runtime half (HTTP transport + Tool bridge).

export { createStdioMcpTransport } from "./stdio.js";
export type { StdioMcpTransportOptions } from "./stdio.js";
