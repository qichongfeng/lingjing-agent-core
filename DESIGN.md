# lingjing-agent-core — 设计文档

> 一个 **runtime-agnostic、provider-agnostic** 的 TypeScript agent core。宿主（Next.js Node/Edge、浏览器/Tauri webview、Electron/Tauri 桌面端）嵌入它即可获得智能体能力：agentic loop、工具调用、记忆、可序列化流式事件。core 提供"大脑"，宿主注入"手脚"（fs / shell / http / 存储 / UI）。
>
> **状态：Phase 3 已实现（本轮硬化收口范围内）**（core + provider-openai + tools-node + tools-web + examples；typecheck/全部测试通过/全部构建产出 ESM+CJS+d.ts）。真实端到端需 `OPENAI_API_KEY`（见 `examples/`）。`provider-anthropic` / `host-next` 已从仓库移除（设计见 §6，可按需重引入）。本轮 Phase 3 收口：`CompactContextManager`（本地摘要）、`retry-after` 尊重、`beforeRequest` 注入 + `ragInjectHook`、`redact()`、`tools-web`（http_get / localStorage）、provider-openai（SDK-free、裸 transport）、**HttpTransport**（跨端可注入网络层，小程序零 polyfill）。**明确不做**（Phase 4+）：sub-agents / MCP / 向量记忆 / OTel / 结构化输出强制 / Bedrock/Vertex / Anthropic 服务端 compaction seam。

---

## 1. 设计目标与原则

| 原则 | 含义 | 落地 |
| --- | --- | --- |
| **Runtime-agnostic core** | `@lingjing-agent/core` 零 Node 专属 import（`fs`/`child_process`/`stream`/`Buffer`），只用三端共有全局：`fetch`、`AbortController`/`AbortSignal`、`AsyncIterable`、`crypto.randomUUID`、`TextEncoder/TextDecoder` | Node 能力只在 `tools-node`；浏览器能力只在 `tools-web` |
| **Provider-agnostic LLM 层** | `LLMProvider` 是流式 async-iterable + 中性 chunk 联合类型，**不形似任何厂商 SDK**。适配器各自翻译 | core 永不 import `@anthropic-ai/sdk`；SDK 是各适配器的 `peerDependency` |
| **能力注入（Capability Injection）** | 工具、记忆后端、HTTP transport、权限门都是宿主提供的接口 | core 依赖接口而非实现 |
| **事件驱动流式** | `Agent.stream()` 返回 `AsyncIterable<AgentEvent>`，每个事件 JSON 可序列化 | 宿主可直传 IPC / SSE / WebSocket；core 不用 Node `ReadableStream` |
| **强类型** | `Content`/`AgentEvent`/`ProviderChunk` 均为 discriminated union；`StopReason` 为字面量联合 | `exactOptionalPropertyTypes` 抹去 `undefined` 键 |
| **可测试** | `FakeProvider` 是一等导出（脚本化 chunk + loop-trap） | 终止性是硬保证，有 contract 测试 |
| **最小依赖** | core 仅以 `zod` 为可选 peer dep（`defineTool` helper 用）；无其它运行时依赖 | ESM + CJS + d.ts，tree-shakeable |

### Agentic Loop 数据流

```
                ┌─────────────────────────────────────────────────────────┐
                │                  Agent.run / Agent.stream               │
                └────────────────────────────┬────────────────────────────┘
                                             │
   ┌─────────────────────────────────────────▼──────────────────────────────────────┐
   │  TURN LOOP  (while stopReason ∈ {tool_use, pause_turn, max_tokens} 且 turns<max)│
   │                                                                                │
   │  1. context.fit(messages, tools, tokenBudget)   裁剪/压缩到窗口内              │
   │  2. hooks.beforeRequest(ctx)                    RAG 注入 / 守卫 / 脱敏          │
   │  3. provider.stream({messages, tools, config, signal}) ──► AsyncIterable       │
   │      emit: text_delta / thinking_delta / tool_call_start / tool_call_delta      │
   │      累积 assistant Message（text + tool_call blocks）；记录 stopReason + usage  │
   │  4. hooks.afterResponse(ctx)                                                   │
   │  5. SWITCH(stopReason):                                                        │
   │      end_turn / stop_sequence / refusal            ──► TERMINATE (done)        │
   │      tool_use                                     ──► 执行工具（步骤 6）       │
   │      max_tokens                                   ──► 续跑（带上 partial）     │
   │      pause_turn                                   ──► 原样续跑                │
   │      context_window_exceeded                      ──► 强制压缩 + 重试一次     │
   │  6. TOOL EXEC（仅 tool_use）：                                                   │
   │      schema 校验 ─► beforeToolCall ─► permissionGate（确认门）                  │
   │      ─► Promise.allSettled（每工具超时 + AbortSignal.any 链接）                 │
   │      ─► emit tool_result ─► hooks.afterToolCall                                 │
   │      append: 一条 assistant(tool_calls) + 一条 user(tool_result[])            │
   │  7. turns++; turns>=maxTurns ─► TERMINATE(cap)，否则回到 1                       │
   └────────────────────────────────────────────────────────────────────────────────┘
                                             │
   TERMINATE: emit turn_end(stopReason, usage); emit done(finalText, totalUsage, turns)
```

### 跨端网络层（HttpTransport）

provider 与 tool 不直接碰 Web `Response` / `ReadableStream.getReader()`，而是通过 core 的中性 `HttpTransport` 抽象拿数据：

```ts
type HttpTransport = (req: {
  url: string; method: string;
  headers: Record<string, string>;      // 不用 Headers 对象（小程序无）
  body?: string; signal: AbortSignal;
}) => Promise<{
  status: number; statusText: string;
  headers: Record<string, string>;      // key 统一 lower-case
  body: AsyncIterable<Uint8Array>;      // 一次性流；必须 respect signal（abort 时 throw）
}>;
```

**为什么 body 用 `AsyncIterable<Uint8Array>` 而非 Web `ReadableStream`**：微信小程序的 `wx.request` 没有原生 `Response`/`ReadableStream`，流式靠 `enableChunked` + `onChunkReceived` 回调。把它包成 `AsyncIterable` 是三端唯一共有的形态——Node/浏览器/Edge 的 `ReadableStream` 本就 async-iterable，小程序把回调推队列再用 async iterator 暴露即可。于是**同一份 provider/tool 代码不经任何 polyfill 就跑在小程序里**。

- **默认实现**：core 导出 `fetchTransport(fetchImpl?)`，在有全局 `fetch` 的运行时（Node 18+/浏览器/Edge）把 `Response` 桥接成 transport。`fetch` 在函数体内运行时 `??` 求值（非默认参数），故无 `fetch` 的运行时仅 import core 不会触发 ReferenceError。
- **已迁移**：`provider-openai`（`OpenAIProvider({ transport })`，同时保留 `fetch` 向后兼容）、`tools-web/fetchTool`（`fetchTool({ transport })`）。SSE 解析器 `parseSSE` 改为直接消费 `AsyncIterable<Uint8Array>`。
- **provider-anthropic 例外**：仍用 `@anthropic-ai/sdk`，只透传 `fetch`（SDK 的 `ClientOptions.fetch` 原生支持）。SDK 内部 streaming 对 `ReadableStream` 有隐式依赖，小程序场景建议改用 `provider-openai` + 自定义 transport（指向 Anthropic 的 OpenAI 兼容端点或网关）。

**宿主如何写自定义 transport（微信小程序示意，不进 core）**：

```ts
// 概念示意：真实实现还需从 onHeadersReceived 取 status/headers，
// 并把 onChunkReceived 的回调式数据桥接成 async iterable。
const wxTransport: HttpTransport = (req) => new Promise((resolve, reject) => {
  const task = wx.request({
    url: req.url, method: req.method, header: req.headers,
    data: req.body, enableChunked: true, responseType: "arraybuffer",
    fail: reject,
  });
  req.signal.addEventListener("abort", () => task.abort());   // 取消链接到 signal
  resolve({
    status: 200, statusText: "OK", headers: {},               // 从 onHeadersReceived 填
    body: chunkedToAsyncIterable(task),                        // onChunkReceived → async iterator
  });
});
```

---

## 2. 架构总览

```
                    ┌──────────────────────────────────────────┐
                    │            lingjing-agent-core            │
                    │  ┌──────────────────────────────────────┐ │
                    │  │ AgentRunner（agentic loop）           │ │
                    │  │   stream → tool_calls → 并行 exec     │ │
                    │  │   → feed back → repeat / terminate    │ │
                    │  └─────────────┬────────────────────────┘ │
                    │  ┌─────────────┴─────────────┐            │
                    │  │ ToolRegistry · Hooks       │ MemoryStore│
                    │  │ PermissionGate             │ ContextMgr │
                    │  └─────────────┬─────────────┘            │
                    │  ┌─────────────┴─────────────┐            │
                    │  │ LLMProvider (interface)    │ AgentEvent │
                    │  └───────────────────────────┘  Emitter    │
                    └────────────────┬──────────────────────────┘
                                     │ 注入（host 组合）
            ┌────────────────────────┼────────────────────────────┐
            ▼                        ▼                            ▼
     provider-openai
     (OpenAI 兼容, SDK-free,
      可注入 transport)
            │
            └── 被 host 选用并传入 createAgent({ provider, tools, memory })
```

**依赖方向（关键，无环）：**
- `core` 仅依赖（可选、类型擦除的）`zod`。
- `provider-openai` 依赖 `core`（peer）——SDK-free，裸 `HttpTransport`（默认 `fetchTransport`）。
- `tools-node` / `tools-web` 依赖 `core`（peer）+ 各自平台 API。
- **没有任何包反向依赖 provider 或 tools。** core 只 import 自己的接口；宿主负责组合。
- （`provider-anthropic` / `host-next` 曾在仓库中，已移除；设计见 §6，可按需重引入。）

---

## 3. 核心契约（TypeScript 草图）

> 本节是供审阅的核心。所有类型均为 provider 中性——不含厂商字段名（如 `tool_use_id`、`input_schema`、`cache_control`），适配器负责双向翻译。

### 3.1 多模态 `Message` / `Content`

```ts
// packages/core/src/types.ts
export type Role = "system" | "user" | "assistant";

export interface TextContent    { type: "text";    text: string }
export interface ImageContent   { type: "image";   mediaType: string; data: string } // base64
export interface ThinkingContent{ type: "thinking"; text: string; signature?: string } // 部分厂商回放所需的不透明签名

/** assistant 发起的工具调用。流式时 inputJson 增量累积，block 结束才解析。 */
export interface ToolCall {
  type: "tool_call";
  id: string;            // 厂商分配；在 ToolResult 中回传
  name: string;
  inputJson: string;     // 流式 delta 累积的原始 JSON 字符串，block 结束自行 JSON.parse
  input?: unknown;       // 解析后输入（block 完成并成功 parse 前为 undefined）
}

/** 工具执行结果，回喂模型。 */
export interface ToolResult {
  type: "tool_result";
  toolCallId: string;    // 对应 ToolCall.id
  content: string | Content[];
  isError?: boolean;     // 执行失败仍回喂模型（is_error）
}

export type Content = TextContent | ImageContent | ThinkingContent | ToolCall | ToolResult;

export interface Message {
  id: string;                   // 宿主分配的稳定 id；UI keying + 去重
  role: Role;
  content: Content[] | string;  // string 是纯文本简写
  createdAt: number;            // epoch ms
  metadata?: Record<string, unknown>;
}
```

**为什么 `ToolCall.inputJson` 是字符串：** 自己累积原始 JSON 再解析，让 Anthropic 的 `input_json_delta` 与 OpenAI 碎片化的 `arguments` delta 映射到同一个 `tool_call_delta`——两种厂商的流式碎片语义统一。解析时一律 `JSON.parse`，绝不字符串匹配（4.6+ 厂商转义可能不同）。

### 3.2 `Tool` 接口 + `defineTool`

```ts
// packages/core/src/tool.ts
import type { z } from "zod"; // 可选，仅类型导入（不用则运行时擦除）

export interface ToolInputSchema {
  jsonSchema: object;          // JSON Schema draft-07；zod 生成或手写
  zodSchema?: z.ZodTypeAny;    // 可选 zod 引用，供宿主侧校验
}

export interface ToolCallContext {
  signal: AbortSignal;         // run 中止或该工具超时即触发
  toolCallId: string;
  conversationId: string;
  runtime: "node" | "browser" | "edge";
  log: (level: "debug" | "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

export interface ToolResultValue { content: string | Content[]; isError?: boolean }

export interface Tool {
  name: string;                          // agent 内唯一
  description: string;                   // 描述「何时调用」——会暴露给模型
  inputSchema: ToolInputSchema;
  execute(input: unknown, ctx: ToolCallContext): Promise<ToolResultValue>;
  /** 人工审批：为真（或谓词为真）则在执行前 emit permission_request */
  requiresConfirmation?: boolean | ((input: unknown) => boolean);
  timeoutMs?: number;                    // 缺省取 AgentConfig.toolTimeoutMs
  permissions?: {
    destructive?: boolean;               // 不可逆 / 沙箱外副作用
    network?: boolean;
    tags?: string[];                     // 供宿主 allowlist 匹配，如 ["shell","fs:write"]
  };
}

/** 从 zod schema 定义工具（zod 仅此 helper 的 peer dep）。 */
export function defineTool<S extends z.ZodTypeAny>(opts: {
  name: string;
  description: string;
  input: S;
  execute: (input: z.infer<S>, ctx: ToolCallContext) => Promise<ToolResultValue>;
  requiresConfirmation?: Tool["requiresConfirmation"];
  timeoutMs?: number;
  permissions?: Tool["permissions"];
}): Tool;
```

### 3.3 `LLMProvider` 接口（流式、provider-agnostic）

```ts
// packages/core/src/provider.ts
export type StopReason =
  | "end_turn"                 // 自然结束 → 终止
  | "tool_use"                 // 要工具 → 执行后续跑
  | "max_tokens"               // 撞输出上限 → 续跑
  | "stop_sequence"            // 命中 stop sequence → 终止
  | "pause_turn"               // 服务端工具迭代上限 → 原样续跑
  | "refusal"                  // 安全拒绝 → 终止，surface stop_details
  | "context_window_exceeded"; // 历史过长 → 压缩 + 重试一次

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ProviderConfig {
  maxTokens: number;
  temperature?: number;        // 部分厂商/模型拒绝（Anthropic 4.7+ 拒绝）
  topP?: number;
  stopSequences?: string[];
  thinking?: { type: "adaptive" | "disabled"; display?: "summarized" | "omitted" };
  effort?: "low" | "medium" | "high" | "xhigh" | "max"; // 映射到厂商的 output_config.effort
  toolChoice?:
    | { type: "auto" }
    | { type: "any" }                  // 至少一个工具
    | { type: "tool"; name: string }   // 强制特定工具
    | { type: "none" };
  providerOptions?: Record<string, unknown>; // beta flag / 额外 header / cache_control 透传
}

export interface ProviderRequest {
  model: string;
  system?: string | TextContent[];
  messages: Message[];
  tools?: Tool[];
  config: ProviderConfig;
  signal: AbortSignal;
  conversationId?: string;     // 支持 prompt-cache 粘性
}

/** 中性流式 chunk——discriminated union，JSON 可序列化（无函数）。 */
export type ProviderChunk =
  | { type: "message_start"; messageId: string; model: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; toolCallId: string; name: string }
  | { type: "tool_call_delta"; toolCallId: string; inputJsonDelta: string }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "message_delta"; stopReason?: StopReason; usage?: Partial<TokenUsage> }
  | { type: "message_end"; stopReason: StopReason; usage: TokenUsage };

export interface ProviderResponse { message: Message; stopReason: StopReason; usage: TokenUsage }

export interface LLMProvider {
  readonly id: string;         // "anthropic" | "openai" | "fake"
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk>;
  complete?(req: ProviderRequest): Promise<ProviderResponse>; // 缺省：drain stream
  countTokens?(messages: Message[], model: string): Promise<number>; // 可选；缺省启发式估算
  readonly capabilities: {
    stopReasons: readonly StopReason[];
    streaming: boolean;
    thinking?: boolean;
    promptCaching?: boolean;
  };
}
```

**Leak-free 论证：** `StopReason` 用中性名。Anthropic 适配器 1:1 映射 `tool_use`/`pause_turn`/`end_turn`/`max_tokens`/`stop_sequence`/`refusal`，并把 `model_context_window_exceeded` 映射到 `context_window_exceeded`；OpenAI 适配器把 `finish_reason` 的 `tool_calls`→`tool_use`、`length`→`max_tokens`、`stop`→`stop_sequence`、`content_filter`→`refusal`。`cache_control`、`anthropic-beta` header、`stop_details`（refusal 的 category/explanation）都只活在适配器的 `providerOptions` 里，core 永不可见。`ThinkingContent.signature` 中性——Anthropic 适配器填充，OpenAI 适配器不产出 thinking。

### 3.4 `AgentEvent`（可序列化；IPC/SSE/WS 安全）

每个事件 `JSON.stringify` 安全（无函数、无 `AbortSignal`）。宿主可直接转发上线路。

```ts
// packages/core/src/events.ts
export interface EventBase { conversationId: string; turn: number; ts: number }

export type AgentEvent =
  | (EventBase & { type: "start"; model: string })
  | (EventBase & { type: "text_delta"; text: string })
  | (EventBase & { type: "thinking_delta"; text: string })
  | (EventBase & { type: "tool_call"; toolCallId: string; name: string; input: unknown })
  | (EventBase & { type: "tool_result"; toolCallId: string; content: Content[]; isError: boolean; ms: number })
  | (EventBase & { type: "turn_end"; stopReason: StopReason; usage: TokenUsage })
  | (EventBase & { type: "permission_request"; toolCallId: string; name: string; input: unknown; destructive: boolean })
  | (EventBase & { type: "error"; message: string; code: string; recoverable: boolean })
  | (EventBase & { type: "done"; finalText: string; totalUsage: TokenUsage; turns: number });
```

### 3.5 `AgentConfig` + `Agent` 公共 API

```ts
// packages/core/src/agent.ts
export interface AgentConfig {
  provider: LLMProvider;
  model: string;                      // 如 "claude-opus-4-8"（宿主配置，不硬编码）
  system?: string | TextContent[];
  tools?: Tool[];
  maxTokens: number;                  // 单响应上限（非流式默认 16000；流式 64000）
  maxTurns?: number;                  // 默认 25——硬熔断，保证终止
  effort?: ProviderConfig["effort"];
  thinking?: ProviderConfig["thinking"];
  temperature?: number;
  stopSequences?: string[];
  toolTimeoutMs?: number;             // 默认 30000
  toolChoice?: ProviderConfig["toolChoice"];
  context?: ContextManager;
  memory?: MemoryStore;
  hooks?: Hooks;
  permissionGate?: PermissionGate;
  retry?: { maxRetries: number; baseDelayMs: number; maxDelayMs: number }; // 默认 {2, 1000, 30000}
  providerOptions?: Record<string, unknown>;
  allowedToolTags?: string[];         // 工具 tag 白名单；注册时校验
}

export type PermissionDecision =
  | { allow: true }
  | { allow: true; modifiedInput: unknown }
  | { allow: false; reason: string };

export interface PermissionGate {
  request(call: { toolCallId: string; name: string; input: unknown; destructive: boolean }, signal: AbortSignal): Promise<PermissionDecision>;
}

export interface Agent {
  stream(input: string | Message[], opts?: { signal?: AbortSignal; conversationId?: string }): {
    events: AsyncIterable<AgentEvent>;
    abort: () => void;
    done: Promise<Message>;          // 最终 assistant message（出错则 reject）
  };
  run(input: string | Message[], opts?: { signal?: AbortSignal; conversationId?: string }): Promise<Message>;
  registerTool(tool: Tool): void;
  unregisterTool(name: string): void;
  listTools(): readonly Tool[];
  reset(): void;                      // 重置会话状态（不动已持久化 memory）
  conversation(id: string): ConversationHandle;
}

export interface ConversationHandle {
  readonly id: string;
  send(input: string, opts?: { signal?: AbortSignal }): ReturnType<Agent["stream"]>;
  history(): Promise<Message[]>;
}
```

### 3.6 `MemoryStore` + `ContextManager`（裁剪 vs 压缩）

```ts
// packages/core/src/memory.ts
export interface MemoryStore {
  load(conversationId: string): Promise<Message[]>;
  append(conversationId: string, messages: Message[]): Promise<void>;
  /** 可选：长期语义召回（路线图；Phase 1 stub 返回 []）。 */
  recall?(query: string, opts?: { topK?: number }): Promise<MemorySnippet[]>;
}
export interface MemorySnippet { content: string; score?: number; source?: string }

// packages/core/src/context.ts
export interface ContextManager {
  fit(input: {
    messages: Message[]; tools: Tool[]; system: string | TextContent[] | undefined;
    tokenBudget: number;
    countTokens: (msgs: Message[]) => Promise<number>;
  }): Promise<{ messages: Message[]; compacted: boolean; tokensSaved?: number }>;
}

/** Phase 1 默认：裁剪最老的 tool_result+tool_call 对，直至低于预算。 */
export class TrimContextManager implements ContextManager { /* ... */ }

/** Phase 2：接近上限时用 provider 摘要旧轮次为一条 system 文本。 */
export class CompactContextManager implements ContextManager {
  constructor(opts: { provider: LLMProvider; model: string; triggerRatio?: number /* 默认 0.75 */; keepLastN?: number /* 默认 6 */ });
}
```

**裁剪 vs 压缩：** `TrimContextManager`（默认、Phase 1）丢弃最老的 `tool_result`+`tool_call` 对——最便宜、三端通用。`CompactContextManager`（Phase 2）调用 provider 摘要被丢弃的轮次为一条 system 备注——仅当 provider 支持独立廉价摘要调用时可用。两者都保留 system prompt 与最近 N 轮原文。
> 注：Anthropic 已有服务端 compaction（beta `compact-2026-01-12`），需原样回传 `response.content`（含 compaction block）而非仅文本。`CompactContextManager` 在 Anthropic 适配器下可委托服务端 compaction；本地压缩为不支持服务端压缩时的回退。

### 3.7 `Hooks`（中间件）

```ts
// packages/core/src/hooks.ts
export interface HookContext {
  conversationId: string; turn: number; messages: Message[]; tools: Tool[]; signal: AbortSignal;
}

export interface Hooks {
  /** 发往 provider 前。可改 messages（RAG 注入）、加 system 备注、或 abort。 */
  beforeRequest?(ctx: HookContext): Promise<void | { abort: true; reason: string }>;
  /** provider 响应后、工具执行前。日志 / 指标。 */
  afterResponse?(ctx: HookContext & { response: Message; stopReason: StopReason; usage: TokenUsage }): Promise<void>;
  /** 工具执行前。可进一步校验、改 input、或 veto。 */
  beforeToolCall?(call: { toolCallId: string; name: string; input: unknown; ctx: HookContext }): Promise<void | { abort: true; reason: string } | { modifiedInput: unknown }>;
  /** 工具执行后。日志 / 审计。 */
  afterToolCall?(call: { toolCallId: string; name: string; result: ToolResultValue; isError: boolean; ctx: HookContext }): Promise<void>;
}
```

---

## 4. Agentic Loop 语义

### 4.1 终止条件（loop 必须结束）
1. `stop_reason === "end_turn"` → emit `turn_end` + `done`，返回。
2. `stop_reason === "stop_sequence"` → 同上。
3. `stop_reason === "refusal"` → emit `error{code:"refusal", recoverable:false}`（适配器可经 `providerOptions` 透出厂商 `stop_details`）+ `done`，返回。
4. `turns >= maxTurns`（默认 25）→ emit `turn_end` + `error{code:"max_turns_exceeded", recoverable:true}` + `done`。**硬保证**——即使 provider 永远返回 `tool_use`，计数器也兜住。
5. `AbortSignal` 中止 → emit `error{code:"aborted"}`，`done` reject。
6. 不可恢复 provider 错误（重试耗尽）→ emit `error`，`done` reject。

### 4.2 续跑条件
- `tool_use` → 执行工具，append 结果，loop。
- `max_tokens` → emit `turn_end`（可恢复），append 部分 assistant message，loop 让模型续写。连续 3 次 `max_tokens` 无进展 → 终止（`max_tokens_stalled`），避免无限尾巴。
- `pause_turn` → 原样 append assistant message，**不**加额外 user 消息，重发续跑（服务端自动续）。上限 `maxContinuations`（默认 5）。
- `context_window_exceeded` → 调 `context.fit()` 强制压缩，重试请求一次。再发生 → 终止（`context_overflow`）。

### 4.3 并行工具执行（assistant 含 N 个 `tool_call` block 时）
1. 每个 `tool_call.input` 先按工具 schema 校验。非法 → 合成 `tool_result{isError:true}` + schema 违规说明（**不执行**）。
2. 每个合法调用：跑 `hooks.beforeToolCall`；veto → denied 结果。
3. `requiresConfirmation` 为真者：emit `permission_request`，await `permissionGate.request()`。`allow` → 执行（可选 `modifiedInput`）；`deny` → `tool_result` 带拒绝原因。run 的 `AbortSignal` 在等待期间保持活跃；abort 取消待确认。
4. 所有确认的调用用 `Promise.allSettled` 并发执行。每调用独立 `AbortSignal = AbortSignal.any([runSignal, timeoutSignal])`（缺 `AbortSignal.any` 的运行时由 core 提供轻量 polyfill）。每工具 `timeoutMs`（工具级或 `config.toolTimeoutMs`）。
5. `allSettled` 结果：fulfilled → 工具结果；rejected/timeout → `tool_result{isError:true}` + 错误信息（**绝不抛出 loop 之外**——工具失败是给模型的数据）。
6. append **一条** assistant（全部 `tool_call` block）+ **一条** user（全部 `tool_result` block）到历史。把结果拆到多条 user 消息会训练模型串行化——禁止。
7. 每个工具 emit `tool_result` 事件。

### 4.4 Abort / 取消语义
- `Agent.stream()` 返回 `{ events, abort, done }`。`abort()` 调 run signal 的 `AbortController.abort()`。
- 该 signal 链接到：(a) provider `stream()`，(b) 每个工具的 `ToolCallContext.signal`，(c) 任何 pending 的 `permissionGate.request()`。
- abort 时：在途工具执行其 signal 触发、promise reject；loop emit `error{code:"aborted"}` 后 `done`；`done` promise reject `AbortError`。abort 幂等。

### 4.5 provider 瞬时错误退避重试
- 可重试：网络错误、HTTP 408/409/429/5xx（适配器用 `isRetryable(err)` 谓词分类）。不可重试：400/401/403/404/413 → emit `error`，终止。
- 指数退避 + 抖动：`baseDelayMs`（默认 1000）× `2^attempt`，封顶 `maxDelayMs`（默认 30000），最多 `maxRetries`（默认 2，对齐 SDK 默认）。适配器若暴露 `retry-after` header 则尊重。
- 重试**不增加 turn 计数**（重试的请求是同一 turn）。run signal 已 abort 则跳过。

---

## 5. 包 / Monorepo 结构（pnpm workspace）

```
lingjing-agent-core/                      (pnpm workspace 根)
├── pnpm-workspace.yaml
├── package.json                          (仅根 devDeps: tsup, typescript, vitest, prettier, eslint)
├── tsconfig.base.json
└── packages/
    ├── core/                             @lingjing-agent/core   (零 provider-SDK 依赖)
    │   ├── src/{index,types,tool,provider,events,agent,loop,context,memory,hooks,permission,schema,abort}.ts
    │   ├── src/testing/{fake-provider,stub-tools}.ts
    │   └── package.json                  peerDeps: zod@>=3.23 (optional)
    ├── provider-openai/                  @lingjing-agent/provider-openai     (参考实现；SDK-free，可注入 transport)
    └── memory-*                          (Phase 2+: redis / postgres / 向量)
```

**依赖方向：** 见 §2。**没有任何包反向依赖 provider 或 tools。** 宿主组合：`createAgent({ provider: new AnthropicProvider({...}), tools: [...nodeTools], memory: ... })`。

**subpath exports（每个包）：**
```jsonc
// packages/core/package.json
{
  "name": "@lingjing-agent/core",
  "type": "module",
  "exports": {
    ".":         { "types": "./dist/index.d.ts",          "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./testing": { "types": "./dist/testing/index.d.ts",  "import": "./dist/testing/index.js", "require": "./dist/testing/index.cjs" },
    "./package.json": "./package.json"
  },
  "sideEffects": false,
  "peerDependencies": { "zod": ">=3.23.0" },
  "peerDependenciesMeta": { "zod": { "optional": true } }
}
```

---

## 6. 宿主集成模式

### 6.1 Next.js（Node 或 Edge runtime）

> ⚠️ `@lingjing/host-next` 包已从仓库移除。以下为 Next.js 接入的设计模式，可自行实现（约几十行：`createAgentRoute` = 把 `AgentEvent` 流写成 SSE `Response`；`useAgent` = 前端 fetch + ReadableStream reader 的 React hook）。

- `createAgentRoute(agent)` 返回 POST handler：接收 `{ input, conversationId? }` JSON，返回 `Content-Type: text/event-stream` 的 `Response`，body 为 web `ReadableStream`，把 `AgentEvent` 序列化为 `data: {json}\n\n` SSE 帧。Edge 安全（web `ReadableStream` + `TextEncoder`，无 Node stream）。把 HTTP `Request.signal` 接入 `agent.stream({ signal })`，客户端断开即中止 run。
- `useAgent(path)` React hook：`fetch` + `ReadableStream` reader，每个 `AgentEvent` 重渲染；暴露 `abort()`。

### 6.2 浏览器 / Tauri webview
- provider（如 `OpenAIProvider`）用全局 `fetch`（经 `fetchTransport`；浏览器 + Tauri webview + Edge 均可用）。Tauri 下密钥留在 Rust 侧，webview 调 Tauri command 代理请求（密钥永不进 renderer）——这正是 provider 接受自定义 `transport`/`fetch` 的用途。

### 6.3 Node / 桌面（Electron / Tauri main）

> 内置工具已回归为可选包：`@lingjing-agent/tools-node`（`createFsTools` / `createSafeShell` / `createGlobTool` / `createGrepTool`，Node/Electron/Tauri-main 专属）与 `@lingjing-agent/tools-fetch`（`createWebFetchTool`，零 `node:` import、走 core `HttpTransport`，跨端可用）。均按 §7 硬化，可选注入 —— 不 import 即不进 bundle。

- 注入 `createSafeShell({ allowlist: ["git","ls","cat","rg"], timeoutMs })` + `createFsTools({ root: process.cwd() })`（路径 confinement）。`permissionGate` 弹 Electron 对话框 / 推送到 Tauri UI 并 await。

### 6.4 Edge 运行时兼容性
- `core` + `provider-openai` Edge 安全（仅 `fetch`/`AbortController`/`crypto.randomUUID`/`TextEncoder`）。Node 专属能力（fs/shell）不在仓库内；若自建 Node 工具，在 Edge bundle 里 import 它必须让构建失败（宿主在 Edge 路由里不 import）。

---

## 7. 安全默认

1. **破坏性工具 deny-by-default。** `permissions.destructive === true` 必须过权限门，除非宿主显式设 `requiresConfirmation:false`（agent 创建时记一条 warning）。`safeShell`、`fs.write`、`fs.delete` 出厂带 `destructive:true`。
2. **工具 tag 白名单。** `createAgent` 接 `allowedToolTags?: string[]`。工具 `permissions.tags` 不在白名单则在注册时拒绝（抛错）。让宿主按路由钉最小工具面。
3. **execute 前 schema 校验。** 每个 `tool_call.input` 在 `execute` 前对 `tool.inputSchema.jsonSchema` 校验。非法 → `tool_result{isError:true}`，无副作用。
4. **密钥永不入日志 / 永不入消息。** provider（如 `OpenAIProvider`）把 key 存闭包、仅作 header 发送。事件上报路径只收 `Message`/`usage`——永不收 header 或 client。`redact()` helper 在事件上线路前清洗 `providerOptions` 及任何匹配 `/key|token|secret/i` 的 `metadata` key。system prompt 与 user 消息**永不**携带凭证（它们会持久化进历史）。
5. **Shell 工具硬化。** `safeShell`：可执行文件白名单；拒绝 `&&`/`|`/`;`/反引号/`$()`；confined cwd；每调用超时；记录每条命令。白名单为默认，非黑名单。
6. **路径 confinement。** 所有 fs 工具把模型给的 path 解析为 canonical 形式并校验仍在配置 root 内；拒绝 `..`、逃逸符号链接、root 外绝对路径。
7. **abort 必须传播。** 没有工具能忽略其 `AbortSignal`——长任务必须检查 `signal.aborted` 或把它透传给底层原语。

---

## 8. 测试策略

### 8.1 `FakeProvider`（确定性 loop 测试）
脚本化的 `ProviderChunk` 序列（或按入站 messages 的状态机函数）；确定性 `stop_reason`；可选 `countTokens` stub。**loop-trap 模式**：永远返回 `stop_reason:"tool_use"`——用于证明 `maxTurns` 终止保证。

### 8.2 终止性保证测试（必过，keystone）
```
Given 一个永远 emit tool_use 的 FakeProvider,
When  agent.run 以 maxTurns:10 调用,
Then  loop 恰好在 10 turn 后终止,
      且 emit error{code:"max_turns_exceeded", recoverable:true},
      且 done resolve（不挂起）。
```
这是唯一最重要的 contract 测试——防经典「无限工具循环」bug。

### 8.3 每适配器 contract 测试（fixture，无网络）
每个适配器带 `contract.test.ts` 断言：`map-request` 产出厂商期望的请求形状；`map-stream` 把厂商 SSE 转成正确 `ProviderChunk` 序列（含 `tool_call_delta` JSON 累积）；`map-stop` 把厂商每个 `stop_reason`/`finish_reason` 映射到 core `StopReason`，且 `capabilities.stopReasons` 恰好列出这些；类型级测试断言无厂商字段泄漏到 core `Message`/`Content`。真实 API 集成测试为可选，env var 门控，仅 CI nightly。

---

## 9. 构建 / 工具

- **pnpm workspace**，Node >= 20（根 `engines`）。
- **TypeScript** 5.5+，`strict:true`、`exactOptionalPropertyTypes:true`、`moduleResolution:"bundler"`、`isolatedModules:true`。
- **tsup**（每包）：`format:["esm","cjs"]`、`dts:true`、`clean:true`、`treeshake:true`、`target:"es2022"`（Edge 安全）。
- **subpath exports** 如上；`sideEffects:false` 利 tree-shaking。
- **vitest** + `@vitest/coverage-v8`。
- **prettier** + **eslint**（`@typescript-eslint`、`import`、`n`——`core/src` 内除 `testing/` 外不得出现 Node API；`tools-node` 例外）。
- CI：typecheck → lint → unit（FakeProvider）→ contract（fixture）→ build。changesets 版本管理；`pnpm -r publish`。

---

## 10. 分阶段构建顺序

> 文档明确标注 Phase 1 边界与「路线图、非 Phase 1」项。

### Phase 1 — 证明 loop 端到端（MVP）
1. 脚手架 pnpm workspace + tsconfig + tsup + vitest。
2. `core/src/types.ts`（Message/Content/Role）。
3. `core/src/provider.ts`（LLMProvider/ProviderChunk/StopReason/ProviderConfig）。
4. `core/src/tool.ts` + `defineTool`（zod glue 可选；先支持原生 JSON Schema）。
5. `core/src/events.ts`（AgentEvent）。
6. `core/src/testing/fake-provider.ts`（脚本化 + loop-trap）。
7. `core/src/loop.ts`（stream→累积→工具 exec `Promise.allSettled`+超时+abort→回喂→终止）。`TrimContextManager`。
8. `core/src/agent.ts`（`createAgent`、`stream`、`run`）。
9. 测试：终止性保证；单工具；并行工具；abort；工具错误→`tool_result` isError；max_tokens 续跑。

**Phase 1 退出 demo：** `agent.run("echo hello")` 用 FakeProvider 返回正确 message；`maxTurns:10` 对 loop-trap provider 终止。

### Phase 2 — 真实 provider + 宿主接线
1. `provider-anthropic`：`map-request`、`map-stream`（处理 `content_block_delta` 的 `text_delta`/`input_json_delta`/`thinking_delta`、`message_delta` 的 stop_reason/usage）、`map-stop`。仅 adaptive thinking（`thinking:{type:"adaptive", display:"summarized"}`，无 `budget_tokens`）；无 prefill。prompt-cache `cache_control` 打在 system + 末尾 user turn。
2. `tools-node`：`safeShell`（白名单）、`fsTools`（路径 confinement）。
3. `host-next`：`createAgentRoute`（SSE over web `ReadableStream`，Edge 安全）+ `useAgent` hook。
4. 集成：一个 Next.js 路由 + 真实 Anthropic key 跑通工具调用 agent 端到端（如「列出 /tmp 文件并总结」）。

### Phase 3 — 加固 ✅ 已实现（本轮收口）
1. ✅ `CompactContextManager`（provider 本地摘要：drain `provider.stream()` 把 head 摘要为 `[Earlier conversation summary]` user note；provider 错误吞掉回退 trim。**不做** Anthropic 服务端 compaction beta seam——列为后续轮）。
2. ✅ `PermissionGate` + `permission_request` 事件 + `useAgent` 的人工审批流（Phase 2 即上线，本轮补测试）。
3. ✅ 重试/退避 + `retry-after` 处理：core `ProviderError.retryAfterMs` + `computeBackoff`；provider-anthropic `parse-retry-after` + `enrichError` 包 `stream()`。
4. ✅ `pause_turn` + `context_window_exceeded` 处理（已上线，本轮补测试）。
5. ✅ `MemoryStore` 接口 + `localStorageMemory`（`tools-web`）+ in-memory store（Node/测试）。
6. ✅ Hooks：beforeRequest/afterResponse/beforeToolCall/afterToolCall；`beforeRequest` 扩展 `{inject}` + `ragInjectHook` + `examples/rag-inject-demo.ts`。
7. ✅ `redact()` best-effort 清洗（defense-in-depth，跨 chunk 拼接的秘密会漏）。
8. ✅ `tools-web`（http_get 带 SSRF 守卫 / localStorage KV）。
9. ✅ `host-next` Edge 工厂（`createEdgeAgent`/`createEdgeAgentRoute`，shell/fs tag 守卫）。
10. ✅ `provider-openai`（SDK-free、裸 `fetch` 直连 REST + 本地 SSE 解析；镜像 anthropic 的 map-* 契约）。

### Phase 4+ — 路线图（明确非 Phase 1）
- **Sub-agents / 委托**：`spawn` 工具创建带子上下文的子 agent。
- **MCP client/server**：消费外部 MCP server 作为工具；把 agent 工具以 MCP server 暴露。
- **向量长期记忆**：`memory.recall` 语义检索（pgvector / embedding 后端）。
- **OpenTelemetry tracing**：`hooks` + `TracingProvider` 每 turn/tool/provider call 发 span。
- **结构化输出强制**：`output_config.format` 包装 + `respondSchema()` helper。
- **更多适配器**：`provider-bedrock` / `provider-vertex` / `provider-foundry`。
- **记忆后端**：`memory-redis` / `memory-postgres`。

---

## 附：Anthropic 适配器映射要点（Phase 2 落地参考）

| 中性 core | Anthropic |
| --- | --- |
| `Message`/`Content` | `MessageParam` / `content_block`（`text`/`image`/`thinking`/`tool_use`/`tool_result`） |
| `ToolCall.id` / `ToolResult.toolCallId` | `tool_use.id` / `tool_result.tool_use_id` |
| `ToolCall.inputJson`（字符串累积） | 流式 `input_json_delta` 累积 |
| `StopReason` | `stop_reason`（`tool_use`/`pause_turn`/`end_turn`/`max_tokens`/`stop_sequence`/`refusal`；`model_context_window_exceeded`→`context_window_exceeded`） |
| `thinking:{type:"adaptive",display:"summarized"}` | 同名透传；**禁** `budget_tokens`（4.7/4.8/Fable5 报 400） |
| `effort` | `output_config.effort`（`low`/`medium`/`high`/`xhigh`/`max`） |
| `toolChoice` | `tool_choice`（`auto`/`any`/`tool`/`none`） |
| prompt caching | `cache_control:{type:"ephemeral"}`（max 4 断点；render 顺序 tools→system→messages） |
| `providerOptions` | `anthropic-beta` header、`stop_details`（refusal 的 category/explanation）、`cache_control` 精细放置 |
| token 计数 | `POST /v1/messages/count_tokens`（模型相关；禁用 tiktoken） |
| 长对话 | 服务端 compaction beta `compact-2026-01-12`——必须原样回传 `response.content`（含 compaction block），不可只取文本 |

默认模型示例：`claude-opus-4-8`（宿主在 `AgentConfig.model` 配置，core 不硬编码）。
