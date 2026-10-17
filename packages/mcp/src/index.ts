// @lingjing-agent/mcp — MCP client bridge + MCP server side for @lingjing-agent/core.
//
// Client: bridges an external MCP server's tools into core `Tool` objects
// (createMcpTools). Server: exposes core `Tool`s to external MCP clients
// (createMcpServer). Hand-rolled JSON-RPC, dual-era: legacy initialize era
// (2024-11-05 … 2025-11-25) and modern stateless era (2026-07-28+, no
// handshake — per-request _meta + mirrored HTTP headers, era probed via
// server/discover with per-origin caching). Tools, resources, and prompts are
// bridged (as tools — core has no first-class resource/prompt surface).
//
// Zero node:* imports: safe to bundle into browser/Edge/mini-program hosts.
// The Streamable HTTP transport rides core's HttpTransport (inject a
// wx.request bridge for mini-programs). stdio (both halves — the client
// transport and the server channel) lives in "@lingjing-agent/mcp/node".

export { createMcpTools } from "./tools.js";
export type { McpToolsOptions, McpToolsSession, McpToolResultValue } from "./tools.js";

export { createMcpServer } from "./server.js";
export type {
  McpServerChannel,
  McpServerOptions,
  McpServerHandle,
} from "./server.js";

export {
  McpClient,
  REQUESTED_PROTOCOL_VERSION,
  KNOWN_PROTOCOL_VERSIONS,
  negotiateProtocolVersion,
  McpUnsupportedProtocolError,
} from "./client.js";
export type {
  McpClientOptions,
  McpRequestOptions,
  McpRetryOptions,
  McpInitializeResult,
  McpServerInfo,
  McpToolAnnotations,
  McpToolDescriptor,
  McpToolContentBlock,
  McpToolCallResult,
  McpResourceDescriptor,
  McpResourceContent,
  McpPromptArgument,
  McpPromptDescriptor,
  McpPromptMessage,
  McpPromptGetResult,
} from "./client.js";

export { createHttpMcpTransport, McpHttpError } from "./http-transport.js";
export type { HttpMcpTransportOptions } from "./http-transport.js";

export { OAuthSession } from "./oauth.js";
export type { OAuthTokens, TokenStore, McpOAuthConfig } from "./oauth.js";

export { McpSessionExpiredError } from "./mcp-transport.js";
export type { McpTransport, McpTransportSendOptions } from "./mcp-transport.js";

// Modern era (2026-07-28+): wire rules, era cache, probe classification.
export {
  MODERN_PROTOCOL_VERSION,
  MODERN_KNOWN_PROTOCOL_VERSIONS,
  MCP_ERR_HEADER_MISMATCH,
  MCP_ERR_MISSING_CAPABILITY,
  MCP_ERR_UNSUPPORTED_VERSION,
  McpInputRequiredError,
} from "./modern.js";
export type { McpEra, McpDiscoverResult, ModernErrorKind, RpcErrorShape } from "./modern.js";

export { JsonRpcRemoteError } from "./json-rpc.js";
export type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcErrorObject,
} from "./json-rpc.js";
