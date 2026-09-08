// @lingjing-agent/core — runtime-agnostic, provider-agnostic agent core.

export type {
  Role,
  TextContent,
  ImageContent,
  ThinkingContent,
  ToolCall,
  ToolResult,
  Content,
  Message,
} from "./types.js";
export { userMessage, randomId, extractText } from "./types.js";

export type {
  StopReason,
  TokenUsage,
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  ProviderChunk,
  ProviderError,
  LLMProvider,
} from "./provider.js";

export type { EventBase, AgentEvent } from "./events.js";

export type {
  ToolInputSchema,
  ToolCallContext,
  ToolResultValue,
  Tool,
} from "./tool.js";
export { defineTool, zodToJsonSchema } from "./tool.js";

export type { PermissionDecision, PermissionGate } from "./permission.js";

export type { HookContext, Hooks, BeforeToolCallCall, AfterToolCallCall } from "./hooks.js";

export type { MemorySnippet, MemoryStore, RagInjectOptions } from "./memory.js";
export { InMemoryStore, ragInjectHook } from "./memory.js";
export { IDBStore } from "./idb-store.js";
export type { IDBStoreOptions } from "./idb-store.js";

export type { ContextFitInput, ContextFitResult, ContextManager } from "./context.js";
export { TrimContextManager, CompactContextManager } from "./context.js";
export type { CompactContextManagerOptions } from "./context.js";

export { AbortError, TimeoutError, anySignal, detectRuntime, sleep } from "./abort.js";

export type { HttpTransportRequest, HttpTransportResponse, HttpTransport } from "./transport.js";
export { fetchTransport } from "./transport.js";

export type { RedactPattern, RedactOptions } from "./redact.js";
export { redact, redactEvents, SECRET_PATTERNS } from "./redact.js";

export type { AgentConfig, StreamHandle, ConversationHandle, Agent } from "./agent.js";
export { createAgent } from "./agent.js";
