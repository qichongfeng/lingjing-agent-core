// @lingjing-agent/mcp — MCP client bridge + MCP server side for @lingjing-agent/core.
//
// Client: bridges an external MCP server's tools into core `Tool` objects
// (createMcpTools). Server: exposes core `Tool`s to external MCP clients
// (createMcpServer). Hand-rolled JSON-RPC, legacy initialize era
// (2024-11-05 … 2025-11-25). Tools, resources, and prompts are bridged
// (as tools — core has no first-class resource/prompt surface); the modern
// (2026-07-28+) stateless era is a separate, later concern.
//
// Zero node:* imports: safe to bundle into browser/Edge/mini-program hosts.
// The Streamable HTTP transport rides core's HttpTransport (inject a
// wx.request bridge for mini-programs). stdio (both halves — the client
// transport and the server channel) lives in "@lingjing-agent/mcp/node".

export { createMcpTools } from "./tools.js";
export type { McpToolsOptions, McpToolsSession } from "./tools.js";

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

export { JsonRpcRemoteError } from "./json-rpc.js";
export type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcErrorObject,
} from "./json-rpc.js";
