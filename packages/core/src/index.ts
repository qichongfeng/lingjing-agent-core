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
export { conversationUsage } from "./loop.js";

export type { Exchange, ExchangeStep, ToolPairStep } from "./exchange.js";
export { groupExchanges } from "./exchange.js";

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

export type {
  PermissionDecision,
  AgentConfirmMode,
  PermissionCall,
  PermissionGate,
  PermissionRule,
  PermissionAskResult,
  PermissionAskHandler,
  RememberedPermission,
  PermissionPersist,
  PermissionRulesGate,
  PermissionRulesOptions,
} from "./permission.js";
export { createPermissionRules } from "./permission.js";

export type {
  HookContext,
  Hooks,
  HookInject,
  BeforeRequestResult,
  BeforeToolCallResult,
  BeforeToolCallCall,
  AfterToolCallCall,
} from "./hooks.js";
export { HookError, HookAbortError, normalizeInjected } from "./hooks.js";

export type { MemorySnippet, MemoryStore, RagInjectOptions, RecallOptions } from "./memory.js";
export { InMemoryStore, ragInjectHook, isRecallInjected, markRecallInjected } from "./memory.js";
export { createRecallStore, tokenize } from "./recall.js";
export type { RecallStore, RecallStoreOptions } from "./recall.js";
export { createVectorRecallStore } from "./recall-vector.js";
export type {
  EmbedFn,
  SavedVectorIndex,
  VectorIndexPersist,
  VectorRecallStore,
  VectorRecallStoreOptions,
} from "./recall-vector.js";
export { IDBStore } from "./idb-store.js";
export type { IDBStoreOptions } from "./idb-store.js";

export type { ContextFitInput, ContextFitResult, ContextManager } from "./context.js";
export { TrimContextManager, CompactContextManager, isSummaryNote, materializeCompactedView } from "./context.js";
export type { CompactContextManagerOptions } from "./context.js";

export type { ModelTiers, ModelForInput, ModelForHook } from "./models.js";

export {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  estimateTextTokens,
  estimateMessagesTokens,
  estimateContextTokens,
  usageAnchor,
} from "./tokens.js";
export type { UsageAnchor } from "./tokens.js";

export { createTitleGenerator } from "./title.js";
export type { TitleGeneratorOptions, TitleInput, TitleGenerator } from "./title.js";

export { AbortError, TimeoutError, anySignal, detectRuntime, sleep } from "./abort.js";

export type { HttpTransportRequest, HttpTransportResponse, HttpTransport } from "./transport.js";
export { fetchTransport } from "./transport.js";

export { concatBytes, decodeUtf8, splitLines, sseDataEvents } from "./sse.js";

export type { RedactPattern, RedactOptions } from "./redact.js";
export { redact, redactEvents, SECRET_PATTERNS } from "./redact.js";

export type { AgentConfig, StreamHandle, ConversationHandle, RespondOptions, Agent } from "./agent.js";
export { createAgent } from "./agent.js";

export { runStructured, StructuredOutputError, RESPOND_TOOL_NAME } from "./structured.js";
export type { RunStructuredOptions, RunStructuredResult } from "./structured.js";

export { inspectRunTail, interruptedToolCarrier } from "./resume.js";
export type { RunTail } from "./resume.js";

export type { SubagentDefinition, SpawnToolOptions, SpawnEventMeta } from "./subagent.js";
export { createSpawnTool, DEFAULT_SPAWN_TIMEOUT_MS, DEFAULT_SUBAGENT_MAX_TURNS } from "./subagent.js";
