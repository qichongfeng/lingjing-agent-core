# lingjing-agent-core — 设计文档

> 一个 **runtime-agnostic、provider-agnostic** 的 TypeScript agent core。宿主（Next.js Node/Edge、浏览器/Tauri webview、Electron/Tauri 桌面端）嵌入它即可获得智能体能力：agentic loop、工具调用、记忆、可序列化流式事件。core 提供"大脑"，宿主注入"手脚"（fs / shell / http / 存储 / UI）。
>
> **状态：Phase 3 加固已完成；0.1.0-beta.9**（5 包：`core` + `provider-openai` + `provider-anthropic` + `tools` + `mcp`，另有 `examples`；typecheck / 全部测试通过 / 全部构建产出 ESM+CJS+d.ts）。真实端到端需 provider key（见 `examples/`）。`host-next` 不在仓库内（设计见 §6，可按需自行实现）。
>
> 已落地：agentic loop、工具调用与并行执行、`CompactContextManager` 压缩闭环、`retry-after` 尊重、`beforeRequest` 注入 + `ragInjectHook`、词法被动记忆（`createRecallStore`，BM25 装饰任意 `MemoryStore`）、`redact()`、**HttpTransport**（跨端可注入网络层，小程序零 polyfill）、**sub-agents**（`createSpawnTool`）、**MCP client**、**结构化输出**（`agent.respond` 强制工具路线）、**run 级续跑**（`agent.resume` + `inspectRunTail` + `persistRuns`）、三档模型 + 可用性降级、**hook 双通道契约**（§3.7，2026-09-22 加固）、**agent 级 confirm 覆盖**（`confirm`，2026-09-23）、**向量语义召回**（`createVectorRecallStore`，宿主 embedder + cosine，2026-09-23）、**MCP server 侧**（`createMcpServer`，2026-09-23）。
>
> **明确不做**（Phase 4+）：OTel tracing（挂事件流，见 §10）、Bedrock/Vertex 适配器、Anthropic 服务端 compaction seam、更多记忆后端。

---

## 1. 设计目标与原则

| 原则 | 含义 | 落地 |
| --- | --- | --- |
| **Runtime-agnostic core** | `@lingjing-agent/core` 零 Node 专属 import（`fs`/`child_process`/`stream`/`Buffer`），只用三端共有全局：`fetch`、`AbortController`/`AbortSignal`、`AsyncIterable`、`crypto.randomUUID`、`TextEncoder/TextDecoder` | Node 能力只在 `@lingjing-agent/tools/node`（fs / shell / glob / grep）与 `@lingjing-agent/mcp/node`；`tools` 主入口是跨端 web 工具。由 `scripts/check-runtime-purity.mjs` 在 CI 把守 |
| **Provider-agnostic LLM 层** | `LLMProvider` 是流式 async-iterable + 中性 chunk 联合类型，**不形似任何厂商 SDK**。适配器各自翻译 | core 永不 import 厂商 SDK；两个适配器也都 **SDK-free**——各自实现 `map-request`/`map-stream`/`map-stop` + 本地 SSE 解析，走 core `HttpTransport`（见 §3.3） |
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
   │  2. hooks.beforeRequest(ctx)                    RAG 注入 / 拦截（fail-closed）  │
   │  3. provider.stream({messages, tools, config, signal}) ──► AsyncIterable       │
   │      emit: text_delta / thinking_delta / tool_call_start / tool_call_delta      │
   │      累积 assistant Message（text + tool_call blocks）；记录 stopReason + usage  │
   │  4. hooks.afterTurn(ctx)                        观察（每轮触发，含 tool_use 轮）│
   │  5. SWITCH(stopReason):                                                        │
   │      end_turn / stop_sequence / refusal            ──► TERMINATE (done)        │
   │      tool_use                                     ──► 执行工具（步骤 6）       │
   │      max_tokens                                   ──► 续跑（带上 partial）     │
   │      pause_turn                                   ──► 原样续跑                │
   │      context_window_exceeded                      ──► 强制压缩 + 重试一次     │
   │  6. TOOL EXEC（仅 tool_use）：                                                   │
   │      schema 校验 ─► beforeToolCall ─► permissionGate（确认门）                  │
   │      ─► Promise.allSettled（每工具超时 + AbortSignal.any 链接）                 │
   │      ─► hooks.afterToolCall ─► emit tool_result（成功/失败/超时都走，abort 除外）│
   │      append: 一条 assistant(tool_calls) + 一条 user(tool_result[])            │
   │  7. turns++; turns>=maxTurns ─► TERMINATE(cap)，否则回到 1                       │
   └────────────────────────────────────────────────────────────────────────────────┘
                                             │
   TERMINATE: emit turn_end(stopReason, usage); emit done(finalText, totalUsage, turns)
```

图中 `emit` 与 `hooks` 是**两条不同的通道**，不可互换：`emit` 出去的是 `AgentEvent`——可序列化、单向、事后观察，跨 IPC/SSE 原样转发，永远无法改变 run；`hooks` 是进程内拦截，拿到活对象（`Tool[]`、`AbortSignal`）并能**返回决策**（注入 / 否决 / 改写输入 / 中止 run）。UI、埋点、审计用事件；需要改变 run 行为才用 hook。详见 §3.7。

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
- **已迁移**：`provider-openai`（`OpenAIProvider({ transport })`，同时保留 `fetch` 向后兼容）、`tools` 主入口的 web 工具（`web_read` / `wiki_search`，走注入的 transport）。SSE 解析器 `parseSSE` 改为直接消费 `AsyncIterable<Uint8Array>`。
- **provider-anthropic 同样 SDK-free**：自建 `map-request`/`map-stream`/`map-usage` + 本地 `parseSSE`，与 provider-openai 同构。因此它也走注入的 `HttpTransport`，小程序场景无需任何 polyfill，两个适配器地位相同。**全仓零厂商 SDK 依赖**——引入任何厂商 SDK（`openai` / `@anthropic-ai/sdk` 等）都违反本原则。

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
                    │  │ ToolRegistry · Hooks(拦截)  │ MemoryStore│
                    │  │ PermissionGate             │ ContextMgr │
                    │  └─────────────┬─────────────┘            │
                    │  ┌─────────────┴─────────────┐            │
                    │  │ LLMProvider (interface)    │ AgentEvent │
                    │  └───────────────────────────┘  Emitter(观察)│
                    └────────────────┬──────────────────────────┘
                                     │ 注入（host 组合）
            ┌────────────────────────┼────────────────────────────┐
            ▼                        ▼                            ▼
     provider-openai           provider-anthropic          tools / mcp
     (OpenAI 兼容, SDK-free,   (Anthropic Messages,        (主入口跨端 +
      可注入 transport)        SDK-free, thinking/caching)  ./node 平台专属)
            │
            └── 被 host 选用并传入 createAgent({ provider, tools, memory })
```

**依赖方向（关键，无环）：**
- `core` 仅依赖（可选、类型擦除的）`zod`。
- `provider-openai` 依赖 `core`（peer）——SDK-free，裸 `HttpTransport`（默认 `fetchTransport`）。
- `provider-anthropic` 依赖 `core`（peer）——同样 SDK-free，自建 `map-*` + 本地 SSE 解析。
- `tools` 依赖 `core`（peer）；主入口走 `HttpTransport`（跨端），`./node` 子入口额外用平台 API。`mcp` 同构（主入口跨端 + `./node` 用 stdio）。
- **没有任何包反向依赖 provider 或 tools。** core 只 import 自己的接口；宿主负责组合。
- （`host-next` 不在仓库内；设计见 §6，可按需自行实现。）

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
  | (EventBase & { type: "model_fallback"; from: string; to: string; status?: number; code?: string })
  | (EventBase & { type: "context_compacted"; reason: "soft" | "overflow"; tokensSaved?: number })
  | (EventBase & { type: "permission_request"; toolCallId: string; name: string; input: unknown; destructive: boolean })
  | (EventBase & { type: "error"; message: string; code: string; recoverable: boolean })
  | (EventBase & { type: "done"; finalText: string; totalUsage: TokenUsage; turns: number });
```

`model_fallback`：档位降级永不静默——`from` 模型出现可用性故障（529/overloaded/model_not_found/5xx），当前 turn 改由 `to` 模型重试；`status`/`code` 携带原始错误分类（存在才带键，保持 JSON 精简）。`start` 惰性发射：turn 1 生效模型解析后才发（`turn: 0` 不变），因此上报的 model 一定是真正服务第一 turn 的模型。

### 3.5 `AgentConfig` + `Agent` 公共 API

```ts
// packages/core/src/agent.ts
export interface AgentConfig {
  provider: LLMProvider;
  model?: string;                     // 如 "claude-opus-4-8"（宿主配置，不硬编码）
  models?: ModelTiers;                // { fast?, main, max? }——与 model 二选一（都给须相等）
  modelFor?: ModelForHook;            // 宿主策略钩子：逐 turn 选起始模型（可 async；被 per-send 覆盖短路）
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
  persistRuns?: boolean;              // 逐消息增量落库（崩溃安全）；resume 的前提（见 4.6）
  hooks?: Hooks;                      // 拦截通道；对 subagent 子 run 无效（见 §3.7）
  permissionGate?: PermissionGate;
  retry?: { maxRetries: number; baseDelayMs: number; maxDelayMs: number }; // 默认 {2, 1000, 30000}
  providerOptions?: Record<string, unknown>;
  allowedToolTags?: string[];         // 工具 tag 白名单；注册时校验
}

export type PermissionDecision =
  | { allow: true }
  | { allow: true; modifiedInput: unknown }
  | { allow: false; reason: string };

// packages/core/src/models.ts —— 三档模型与策略钩子
export interface ModelTiers { fast?: string; main: string; max?: string }
export type ModelForHook = (input: {
  conversationId: string; turn: number; messages: Message[]; defaultModel: string;
}) => string | Promise<string>;

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
  respond<T>(input: string | Message[], opts: RespondOptions & { conversationId: string }): Promise<T>; // 强制工具结构化输出
  resume(opts: { conversationId: string; signal?: AbortSignal; model?: string }): ReturnType<Agent["stream"]>; // run 级续跑（见 4.6）
  compact(conversationId: string, opts?: { signal?: AbortSignal }): Promise<{ tokensSaved?: number } | null>;  // /compact 逃生口
  registerTool(tool: Tool): void;
  unregisterTool(name: string): void;
  listTools(): readonly Tool[];
  reset(): void;                      // 重置会话状态（不动已持久化 memory）
  conversation(id: string): ConversationHandle;
}

export interface ConversationHandle {
  readonly id: string;
  send(input: string, opts?: { signal?: AbortSignal }): ReturnType<Agent["stream"]>;
  resume(opts?: { signal?: AbortSignal; model?: string }): ReturnType<Agent["stream"]>;
  respond<T>(input: string | Message[], opts: RespondOptions): Promise<T>;
  compact(opts?: { signal?: AbortSignal }): Promise<{ tokensSaved?: number } | null>;
  // 历史不在此暴露：唯一真相源是 memory.load(id)（UI 渲染读全量 store，
  // 发请求的视图走 materializeCompactedView —— 两者刻意不同，见 3.6）。
}

// packages/core/src/resume.ts —— 纯函数，从包根导出
export type RunTail =
  | { kind: "at-rest" }
  | { kind: "continue" }
  | { kind: "answer-tools"; calls: ToolCall[]; message: Message }
  | { kind: "continue-partial" };
export function inspectRunTail(messages: readonly Message[]): RunTail;
export function interruptedToolCarrier(assistant: Message, calls: ToolCall[], now: () => number): Message;
```

### 3.6 `MemoryStore` + `ContextManager`（裁剪 vs 压缩）

```ts
// packages/core/src/memory.ts
export interface MemoryStore {
  load(conversationId: string): Promise<Message[]>;
  append(conversationId: string, messages: Message[]): Promise<void>;
  /** 可选：长期召回。`createRecallStore` 提供词法（BM25）实现；语义/向量后端直接实现本方法。 */
  recall?(query: string, opts?: RecallOptions): Promise<MemorySnippet[]>;
  /** 可选：枚举已知会话。能实现的 store（IDBStore / InMemoryStore）实现它，
   *  召回后端才能发现语料；缺省则只看得见流经 `append` 的内容。 */
  list?(): Promise<string[]>;
}
export interface MemorySnippet {
  content: string; score?: number;
  source?: string;    // 宿主的展示标签（词法后端用 conversationId）
  messageId?: string; // 片段出自哪条消息——宿主可深链回去
}
export interface RecallOptions {
  topK?: number;
  exclude?: string[];    // 查询期排除的会话（`ragInjectHook` 传当前会话）
  signal?: AbortSignal;  // 检索跑在请求路径上，run 被取消就不该再等它
}

// packages/core/src/context.ts
export interface ContextManager {
  fit(input: {
    messages: Message[]; tools: Tool[]; system: string | TextContent[] | undefined;
    tokenBudget: number;
    countTokens: (msgs: Message[]) => Promise<number>;
    currentTokens?: number; // 真值锚定的总量估算（见下「真值锚定」）
  }): Promise<{ messages: Message[]; compacted: boolean; tokensSaved?: number }>;
}

/** Phase 1 默认：裁剪最老的 tool_result+tool_call 对，直至低于预算。 */
export class TrimContextManager implements ContextManager { /* ... */ }

/** Phase 2：接近上限时用 provider 摘要旧轮次为一条 system 文本。 */
export class CompactContextManager implements ContextManager {
  constructor(opts: { provider: LLMProvider; model: string; triggerRatio?: number /* 默认 0.75 */; keepLastN?: number /* 默认 6 */ });
}
```

**自动接线（角色路由）：** `createAgent` 在配置了 `models` 且未显式传 `context` 时，自动构造 `CompactContextManager({ provider, model: models.fast ?? models.main })`——压缩摘要跑在 fast 档（成本降一个量级）。显式传 `context` 的宿主保持完全控制；纯 `model` 配置维持现状（无上下文管理）。

**增量摘要（2026-09-15）：** 摘要备注在 `metadata.coveredUntil` 记录它覆盖到的最后一条消息 id。下次 fit 超线时：边界未越过覆盖范围（覆盖之后头部只剩备注）→ **原样复用备注，零模型调用**；有新消息掉出尾部窗口 → **只把「旧摘要 + 增量」折叠成一条新滚动备注**（单次调用，输入 O(增量) 而非 O(全头部)）。没有覆盖戳的旧备注走一次全量摘要后进入增量轨道。存档仍 append-only（原件永不丢），但「一旦超线每个消息都重摘全头部」的税降为增量口径。宿主可用导出的 `isSummaryNote()` 识别备注（如 UI 隐藏——备注是给模型的上下文,不是对话内容）。

**微压缩（2026-09-15，摘要前置层）：** fit 超线后先不走摘要——对 head 区的**旧 tool_result 打桩**（内容替换为 `[cleared for context: old tool result]`，调用保留，模型需要时可重跑工具）并**丢弃旧 thinking 块**（单轮作用域、体积大、过轮即死重）。零模型调用、保真度严格高于摘要；估算回到线内则本轮直接返回，仍超线才落摘要。与 Claude Code 的 clear-old-tool-results / Anthropic context editing 同一阶梯：清理工具输出是第一级，整段摘要才是第二级。打桩幂等、消息 id 不动（持久化过滤与 coveredUntil 戳不受影响）；存档原件不受影响（下轮 fit 重新打桩，确定性无成本）。

**口径细化（2026-09-15 末）：** ① `keepLastN` 数窗口时**摘要备注不计入**（备注是模型侧上下文而非对话内容，计入会把边界推后一格——每追加一条备注就多暴露一条原件，增量永远追不上）；② 增量路径的备注查找扩到**全数组**（store 顺序里备注排在它覆盖的原件之后，常落在尾部窗口），装配时尾部的旧备注让位给置顶的那条；③ 摘要标签自描述化（`[Earlier conversation summary — auto-generated recap of earlier turns, not a user message]`），识别走公共前缀（旧标签备注仍被识别）；④ `Agent.compact(conversationId)` 手动压缩（/compact 式）：对存档历史跑 context.compact 并把新备注落库（append-only），下一轮 fit 增量接力——想在触发线之前主动瘦身的逃生口。

**真值锚定（2026-09-16）：** 上下文计量从「纯 char/4 启发式」升级为 **Claude Code / Codex 同款双信号**：① **真值锚**——每次 provider 响应的 `usage.inputTokens` 就是服务器刚处理的精确输入规模，loop 每轮响应后重新锚定（含 system+tools+缓存这些本地算不到的部分；`inputTokens` 语义对齐为**总输入**：Anthropic 侧合并 cache_read/cache_creation，与 OpenAI prompt_tokens 一致——缓存 token 占窗口、只省成本）；② **CJK 感知增量估算**（`tokens.ts`：CJK 字符 ≈1 token/字，其余 ≈4 字符/token；旧 char/4 对中文低报 4-8×，中文会话会冲过软触发线很久才靠 overflow 硬报错兜底）。fit 的 `currentTokens` = 锚 + 请求之后新增内容的估算；触发判断用绝对口径（overhead 加性携带，微压缩/裁剪的进度比较仍用启发式相对口径）。runLoop 启动时从持久历史的 `metadata.usage` 播种锚（恢复的会话第一轮就准）；压缩改写历史会使锚失效（版本计数），下一轮响应重新锚定。`turn_end` 事件带 `contextTokens`（宿主渲染额度环直接用，免重算）；`estimateContextTokens()`/`usageAnchor()`/`estimateMessagesTokens()` 从包根导出。预算分母也按模型解析：`contextTokenBudget` 显式值 > `models.contextWindow`（per-tier）> `DEFAULT_CONTEXT_TOKEN_BUDGET`（1M——同日按用户决定从 250k 上调；真值锚定后触发线跟着实际上下文走，默认值可以贴模型窗口而不再为估算误差预缩水；常量移至 tokens.ts）。

**裁剪 vs 压缩：** `TrimContextManager`（默认、Phase 1）丢弃最老的 `tool_result`+`tool_call` 对——最便宜、三端通用。`CompactContextManager`（Phase 2）调用 provider 摘要被丢弃的轮次为一条 system 备注——仅当 provider 支持独立廉价摘要调用时可用。两者都保留 system prompt 与最近 N 轮原文。
> 注：Anthropic 已有服务端 compaction（beta `compact-2026-01-12`），需原样回传 `response.content`（含 compaction block）而非仅文本。`CompactContextManager` 在 Anthropic 适配器下可委托服务端 compaction；本地压缩为不支持服务端压缩时的回退。

**压缩闭环（2026-09-22，审查修复）：** 压缩状态此前只活在单次 run 内，两个缺口一并补上。① **改写前先落库（append-only 兑现）**：run 内压缩在原地改写视图前，把将被丢弃的原件交给 `persistDropped` 回调持久化（宿主按 loadedIds 过滤后 append）——store 永远保有逐字原件，摘要备注追加在后，宿主 UI 从 store 重建完整对话不再缺轮。② **加载时物化（`materializeCompactedView`，从包根导出）**：下次 run 从 store 加载后，若最新备注的 `coveredUntil` 可解析，丢弃被覆盖原件、备注置顶作为请求视图——否则播种锚反映的是压缩视图尺寸（比全量 store 小），fit 触发线漏判，会把未压缩全量历史原样重发一次（白付 input 或 overflow 多一个来回）后才自愈。物化是保守的：无备注 / 戳不可解析 → 返回原数组（即旧行为）；宿主渲染完整对话仍直接读 store，物化只影响 loop 发送什么。③ 同批修复：`max_tokens` 截断的 partial **不再携带 tool_call 块**进历史（调用无论完整与否都不会被执行，未应答的 tool_use 在续写后的请求上会被 Anthropic/OpenAI 严格校验 400——与 abort salvage 同一条规则：文本存活、调用由模型续写时重新决定；`pause_turn` 保留其调用，服务端工具靠重发续跑）；permissionGate 的 `modifiedInput` 改写后**重新过 schema**（与 beforeToolCall 同契约）；`computeBackoff` 加 equal-part jitter（`[chosen/2, chosen]`，retry-after 仍是上界，防限流共享下的同步重放）；`estimateMessagesTokens` 计入 **thinking 文本**（provider 会回放 thinking，紧窗口模型上它占窗口）；`AgentConfig.logger` 接入 `ctx.log`（原为 noop，afterToolCall 告警不再静默）。

**会话串行（2026-09-22 下，同批审查的第 9 项）：** 同会话并发 send 无互斥——两个 run 各自 load 同一基线（互相看不见）、各自跑、各自 append，store 落成两条平行分支压平的单列表；最窄窗口 = abort 后立即重发（重发的 load 抢在被打断 run 的持久化 flush 之前，基线缺 salvage partial，转录与模型上下文从此错位）。修法 = **per-conversation promise 链排队**（agent.ts `enqueueConversation`）：`streamInto` 整体（load→runLoop→append，含 abort 路径的 flush）与 `Agent.compact` 都排在链尾，上一 run（无论成败）完全落定后下一个才 load——基线永远干净。语义细则：handle 仍同步返回（排队期间 events 空、done pending）；**排队中被 abort 的 run 与「启动前就 abort」行为一致**（持久化输入、发 error、done reject）；链空自清理（identity 比对防误删新链）不积攒 Map 条目；跨会话完全并行（队列按 conversationId 隔离，锁粒度 = 会话非 agent——跨 agent 实例共享同一 store 的宿主需自行串行）。与 Claude Code 的会话排队语义对齐。

**Skill 非目标（2026-09-22 下，用户拍板「agent 终态发展不需要 skill」，别再翻案）：** 评审过 Agent Skills（SKILL.md 渐进披露指令包：roster 常驻、正文按需加载）后明确**不引入**。判断依据：其真实需求面已被现有机制全覆盖且更贴合本库形态——①能力说明常驻模型视野走**工具 description**（本库铁律「工具能力只在各工具自己的 description 里」）；②按需指令 + 受限工具集走 **subagent definition**（description/system 即是宿主写的"技能"，且带隔离执行）；③宿主程序化注入走 **hooks.beforeRequest inject**（含 compaction 后重注入）；④用户侧长内容（规范/资料/模板）走 **FSA 工作区 + read_file/edit_file**——模型已经能自主读文件，"加载指令"就是"读那个文件"，不需要专门的 skill 包装。skill 的增量只剩「roster → 正文」的渐进披露格式本身，代价则是 roster 维护、SKILL.md 兼容解析、第三层资源语义——为格式付架构，不值。全仓 grep 证实从未实现过（零代码可删）；`.claude/settings.local.json` 里的 `Skill(claude-api)` 是本机 Claude Code 会话权限项，与库无关。若未来系统提示词真的膨胀，优先做的也是收敛提示词，而非引入 skill。

**结构化输出（2026-09-22 夜，通用框架缺口第 1 项）：** `agent.respond(input, {schema})` / `ConversationHandle.respond` —— 一跳强制工具提取：请求只带一个合成 `respond` 工具（inputSchema = 宿主 schema，根必须 `{type:"object"}`）+ `toolChoice:{type:"tool"}`，模型必须以该工具的 input 作答；`runStructured()`（structured.ts，从包根导出）复用 loop 的 streamTurn（重试/降级阶梯同款）+ consumeStream（chunk 折叠单实现），抽出 tool_call.input 后走 `validateJsonSchema`。**关键取舍：统一 forced-tool、不走原生 response_format**——跨适配器行为一致、零适配器改动、compat 方言（DashScope 等）天然可用；原生 json_schema 可作将来某适配器的私有优化而不动本契约。**respond 轮内工具不可用**（tool_choice 是请求级的，强制 respond 即排除其它工具）——定位为「对当前对话的提取调用」，要研究的场景由宿主组合 run()→respond()（第二次调用看见全部持久历史）。**修复阶梯协议干净**：坏调用（未调 respond / 参数非法 JSON / 校验失败）用 isError tool_result 应答后重试一次（无调用轮用纯文本纠偏——绝不给未应答 tool_use 后面塞裸文本轮）；重试仍失败抛 `StructuredOutputError`（带 details）。**持久化不变式**：成功落 [input, assistant(respond tool_use), carrier(tool_result "Recorded.")]（usage/stopReason 照常 stamp，协议完整）；失败/abort 只落 input——历史里永远不允许出现没有 tool_result 的 respond tool_use（下个请求会被严格 API 400）。respond 走会话串行队列；修复轮只进请求不进存档。**hooks 覆盖**：`AgentConfig.hooks.beforeRequest` 在 respond 上会跑（在此之前是静默失效的绕过路径），只跑一次、只取 `beforeRequest`——理由见 §3.7。

**权限规则引擎 + 缓存默认（2026-09-22 夜二，通用框架缺口第 2/3 项）：** ① `createPermissionRules`（permission.ts，从包根导出）——规则型 gate 的标准实现，宿主不再各造一遍：静态规则 `{tool?, tag?, when?, effect}` 三维匹配（未指定即通配）；**评估与顺序无关，deny 恒胜**（宿主不可能把自己排进绕过硬拒绝的顺序里）；决策阶梯 = 静态 deny → 记忆决策（tool+fingerprint）→ 静态 allow → onAsk 人询（可回 `remember`+`modifiedInput`）→ 默认拒。**会话记忆**：`fingerprintOf` 定义「同一件事」（默认=工具名；宿主可给 path/cmd 粒度），remember 存 Map、`snapshot()` 可序列化跨会话播种（须配同一 fingerprintOf）；`remember()`/`forgetAll()` 供「总是允许/拒绝」UI 按钮直调。PermissionCall 从 gate 签名里抽出成导出类型并加 `tags?`——loop 把 `tool.permissions.tags` 透传给 gate，tag 规则（如 `fs:write`）不用硬编码工具名。② **Anthropic prompt cache 构造器默认**：`new AnthropicProvider({ cacheControl: {} })` 一行开启——默认 system+last_user 双断点（官方推荐配方，2/4 上限内），请求级 `providerOptions.cacheControl` 仍覆盖；顺修既有缺口：last_user 断点此前只认块数组 content，**字符串 content 的 user 消息（run 首条）会被提升为单 text 块再打标**——opt-in 路径同样受益。OpenAI 侧缓存全自动无需配置。**权限跨会话补齐（同夜三）：** `PermissionPersist {load, save}`——`createPermissionRules({persist})` 一行接 localStorage/IDB 即得跨会话的「总是允许/拒绝」：load 只跑一次（首个 request await 它，坏存储=空记忆不阻塞），save 在每次变更（ask-remember/remember/forgetAll）后 fire-and-forget 全量快照、失败静默（内存决策照常生效）。与 snapshot()/remembered: 的关系：persist 是自动版（持续同步），snapshot 是手动版（一次性搬运），二选一。**确认开关的三层定论（用户问「关闭与否宿主决定」）：①工具声明 requiresConfirmation（含 input 谓词）=默认层；②宿主 gate =策略层（通配 allow 空规则 `{effect:"allow"}` 即全放行=等效关闭；不配 gate 则声明了的一律拒绝=deny-by-default 非自动放行）；③allowedToolTags =注册层。已知边界："tool" 模式（默认，`confirm` 未配置）gate 只在工具声明 requiresConfirmation 时被咨询；agent 级 `confirm` 覆盖（2026-09-23 已实现，`AgentConfirmMode`）让宿主可关可强制开——`confirm:"never"` 全跳过（宿主全责，含破坏性工具）、`confirm:"always"` 全过门（read 类 included；需配 gate，不配则逐调用皆拒）。**

**被动记忆：词法召回后端（2026-09-22 夜三，通用框架缺口第 4 项）：** `ragInjectHook` 早已完整实现，缺的只是 `recall` 的实现——`InMemoryStore.recall` 恒返回 `[]`，整条被动记忆路径是死代码。`createRecallStore`（recall.ts，从包根导出）补上它。**形态 = 装饰器，不是 store 实现、也不是面向模型的工具**：`createRecallStore({store})` 代理 load/append（append 时增量索引）并用自己的索引回答 `recall`，于是**任何** store（InMemoryStore / IDBStore / 宿主的 Redis·wx 桥接）零改动获得检索——机制归 core、数据仍归宿主，正是「不做主动检索工具」那个用户决策的技术形态（模型无感，相关历史自动进 context）。跨端零依赖（纯 JS，`check:purity` 扫得到）。

**检索口径：** BM25（k1=1.2、b=0.75，Lucene 的 `ln(1+(N-df+0.5)/(df+0.5))` idf 形式——经典式在 df>N/2 时转负，会让长文档反而丢分）。**分词 = NFKC 归一再切**：latin 词元（小写、去单字符）+ **CJK 一元组与二元组并用**——二元组拿精度（「北京」不匹配「東京」），但只切二元组有个硬伤：**单字查询（「京」）切不出 token，永远零命中**，而中文里单字查询很常见；一元组的噪声（的/了到处命中）正是 IDF 存在的意义。**分词器自带词字符判定，不复用 `tokens.ts` 的 `isCjkUnit`**——那是个**估算**谓词（标点、全角、代理对都算「一个 token 的成本」），拿它切词会让「好。今天」连成一个 run 吐出「好。」这类垃圾二元组、且全角「ＡＢＣ」永远匹配不上 abc；NFKC 归一 + 按**码点**（非 UTF-16 单元）遍历顺带解决星形 CJK 被劈成代理对的问题。**索引内容 = `extractText()` 的文本块**：thinking / 工具参数 / tool_result（整页 HTML、体积大噪声高）/ 图片天然落空，不需要额外过滤谓词，carrier 消息取到空串自动跳过；**RAG 注入块自身不入索引**（`markRecallInjected`/`isRecallInjected` 标记），否则 A 会话里那份来自 B 的注入文本会变成 A 的"用户原文"再被召回进 C——模型从没说过的话在会话间传递性洗白。

**索引生命周期：惰性构建 + append 增量 + 每次 recall 用 `list()` 对账，不持久化。** 首次 recall 按 scope 扫全量建索引，之后靠 append 增量；**每次 recall 再读一次 `list()`**（廉价：Map keys / IDB getAllKeys）补齐新增、**删掉已消失的会话并释放内存**——这一个动作同时解决 scope 变化、`IDBStore.delete()` 删了会话、长跑进程索引只增不减三件事（不删除的话被删会话的内容会永远留在内存里继续被检索出来，既是陈旧结果也是隐私问题）。所有索引变更走一条 promise 链串行，避免 reconcile / 增量 / reset 跨 await 交错。刷新后重建（几十~几百会话可接受）；持久化索引由向量后端（`createVectorRecallStore` 的 `persistIndex`）承担。无 `list()` 的 store 退化为「只索引见过的 append」，无法对账。

**边界归宿主：`scope`**。`scope?: () => Promise<string[]>` 返回本包装器可见的会话 id，缺省 = `list()` 全部（纯本地单用户场景的合理默认）。**不在 scope 内的不索引——不是「不返回」而是根本不 `load`**，越权内容不进内存。多租户宿主必须传（core 无从知道会话属于谁）。

**两个 hook 行为变更（同批修复，落地即生效）：** ① **只在新用户轮注入**。`beforeRequest` 每轮都跑（含工具循环的每一轮），而注入是**落库的**、hook 又不能删消息——每轮都注入等于把同一批片段层层堆进历史且永远撤不掉。判定 = 末条消息是用户本人发言（非 tool carrier、非上一次注入块）；**压缩备注算「新用户轮」**（它正是"上下文变了"的信号，压缩后重注入是刻意的，与 `ctx.compacted` 同义）。② **查询取最后一条"用户自己打的字"**（`defaultQuery` 跳过 tool carrier / 注入块 / 压缩备注，且**不因取到空串就停**）——原实现从尾往前撞见第一条 user 角色消息就返回，工具轮末尾的 carrier（role 是 user、`extractText` 得空）会让检索从第 2 轮起静默失效。③ 顺带：`ragInjectHook` 现在传 `ctx.signal` 并在 `recall` 失败/被取消时**降级为不注入**（检索是增强项，让异常穿出 hook 会变成 run 级错误）；默认渲染加一句**框架声明**（检索文本是引用数据、不是指令，缓解跨会话的间接提示注入），并给注入块打 `metadata.recallInjected`；`excludeCurrentConversation`（默认 true）给出「我要对自己做跨段 RAG」的逃生口。

### 3.7 `Hooks`（拦截通道）

**先分清两条通道，它们不可互换：**

| | `AgentEvent`（events.ts） | `Hooks`（hooks.ts） |
|---|---|---|
| 通道性质 | **观察** | **拦截** |
| 载荷 | 可序列化纯数据 | 进程内活对象（`Tool[]`、`AbortSignal`） |
| 方向 | 单向，事后 | 请求前/后有返回值 |
| 能否改变 run | **不能** | **能**（注入 / 否决 / 改写 input / 中止 run） |
| 用途 | UI、埋点、审计、跨 IPC/SSE 转发 | 守卫、策略、RAG 注入 |

人工审批两条都不是——它是 `permissionGate` 一等原语 + `permission_request` 事件（§3.5 `PermissionGate`）。hook 无法问人，因为它没有把问题送进事件流的通道。

**命名约定**：`before*` = 拦截（可改变或阻止动作），`after*` = 观察（返回值被忽略，改不了任何东西）。

```ts
// packages/core/src/hooks.ts
export interface HookContext {
  conversationId: string; turn: number;
  /** 快照 —— 原地修改是静默无操作，只能经 `{inject}` 追加。 */
  messages: Message[];
  /** **活数组** —— push 会改变本次请求的工具集（目前唯一的逐轮工具收敛手段）。 */
  tools: Tool[];
  signal: AbortSignal;
  compacted?: boolean; // 压缩(软/溢出)后的第一个请求为 true——钩子可重注入被摘要折叠的持久状态(如当前计划)
}

export type HookInject = string | Message | Array<string | Message>; // string 会变成 user message

export type BeforeRequestResult =
  | void
  | { abortRun: true; reason: string }
  | { inject: HookInject }
  | { abort: true; reason: string };   // @deprecated：按 abortRun 读，0.2 删

export type BeforeToolCallResult =
  | void
  | { veto: true; reason: string }
  | { modifiedInput: unknown }
  | { abort: true; reason: string };   // @deprecated：按 veto 读，0.2 删

export interface Hooks {
  /** 拦截（run 级）。每轮都触发，含工具循环的每一次迭代。 */
  beforeRequest?(ctx: HookContext): Promise<BeforeRequestResult>;
  /** 观察。每轮都触发，含 `tool_use` 轮 —— 不是"拿到终答"钩子；
   *  终答是 stopReason 为 end_turn/stop_sequence 的那一轮。 */
  afterTurn?(ctx: HookContext & { response: Message; stopReason: StopReason; usage: TokenUsage }): Promise<void>;
  /** 拦截（工具级）。schema 校验后、权限门前。 */
  beforeToolCall?(call: BeforeToolCallCall): Promise<BeforeToolCallResult>;
  /** 观察。工具结算后（成功/失败/超时都走，run 被 abort 时跳过），
   *  `tool_result` 事件发出之前。 */
  afterToolCall?(call: AfterToolCallCall): Promise<void>;
}
```

**`beforeRequest` 不能做的事**：它收到 `ctx.messages` 的**快照**（`[...messages]`），只能经 `{inject}` **追加**；历史是 append-only 契约，无法改写或删除已发消息。因此**脱敏不是 hook 的职责**——出口侧请用 `redact()`（redact.ts），它挂在事件流边界上。

**错误隔离契约**（不变量：*拦截 hook 抛错，绝不放行被守卫的动作；观察 hook 抛错，绝不失败 run*）：

| hook | 通道 | 抛错时 | 上报 |
|---|---|---|---|
| `beforeRequest` | 拦截（run 级） | **fail-closed**：run 终止，请求不发 | `error{code:"hook_error"}` + `done` reject `HookError`（带 `.hook` / `.cause`） |
| `beforeToolCall` | 拦截（工具级） | **fail-closed**：工具不执行，模型收到 isError 结果 | isError `tool_result`（run 继续） |
| `afterTurn` | 观察 | **fail-soft**：`AgentConfig.logger("warn")` + 继续 | 无事件 |
| `afterToolCall` | 观察 | **fail-soft**：同上 | 无事件 |

`hook_error` 与 `provider_error` 分开是刻意的：宿主必须能分清「守卫坏了」和「API 挂了」。

**覆盖范围**：hook 在 `agent.stream/run`、`agent.respond()`（只取 `beforeRequest`，见下）、subagent 子 run（`SpawnToolOptions.hooks`，只取 `beforeRequest`，**不自动继承父级**）三条路径上都会触发。`{abortRun}` 是 run 级中止；`{abort}` 旧拼写在 `beforeRequest` 读作 run 中止、在 `beforeToolCall` 读作工具否决——始终按**最安全**的解读生效，不做静默 fail-open。

**绕过路径的收口（2026-09-22）**：
- `agent.respond()`（结构化输出）：只接 `beforeRequest`。理由——强制抽取只有一个人造 `respond` 工具且**从不执行**（工具类 hook 无从触发），也没有 turn 循环（`afterTurn` 会报告一个不存在的轮次）。**只触发一次**：修正重试是同一次逻辑 turn 的协议重试，每次重试都注入会把同一段上下文叠进每一轮。安全动因：抽取请求携带完整历史，是最可能被用来批量提取敏感内容的调用，此前守卫对它完全无效。
- subagent：`SpawnToolOptions.hooks?: Pick<Hooks, "beforeRequest">`——**类型层面**就只给这一档。不做自动继承，两个理由：① 子 agent 有自己的工具白名单，继承父级 `beforeToolCall` 的 veto 规则会误伤；② `Tool` 没有对 agent 的反向引用，要自动继承只能把 hooks 穿进 `ToolCallContext`，等于给每个工具一个改 agent 策略的句柄。**SECURITY**：子 agent 在无 permission gate 的无头模式下运行，工具白名单是主控——必须在 hook 生效的守卫，得在这里再声明一次，只配在 `AgentConfig.hooks` 上对子 agent 无效。测试钉住了这个默认。

**明确不做（2026-09-22 记录理由）**：
- **组合机制（`composeHooks` / `Hooks | Hooks[]`）**——本次范围外。真需要时，`composeHooks(...)` 助手优于数组槽位（洋葱序：`before*` 正序 / `after*` 倒序，逐 hook 错误隔离），与 `createPermissionRules` / `createRecallStore` 的「提供标准实现」惯例对齐。
- **per-tool matcher 语法**——进程外 hook 系统（Claude Code）需要 matcher 是因为匹配决定**要不要起进程**；进程内 hook 是闭包，已拿到完整的类型化 call，`switch (call.name)` 就两行。真要糖，导出 permission.ts 现有的私有 `ruleMatches` 即可，不必新造匹配语义。
- **`beforeRequest` 的 `{replace: Message[]}`（真·请求改写/删改）**——唯一一条「有争议地拒绝」。它能实现且能与 `persistDropped` 配合保持 append-only，但无消费者、出口侧 `redact()` 已覆盖，且会在最安全敏感的调用点加一条带持久化语义的重写分支。**改为修文档**，指向 `redact()`。
- **把 hooks 穿进 `ToolCallContext`**——见上。
- **hook 失败发新事件**——`logger` 是既定的诊断汇（`AgentConfig.logger` 本就承诺 "hook warnings"）。
- **在 hooks 里做审批原语** / **独立的 `*_error` hook 家族** / **压缩前后 hook（PreCompact）**——分别由 `permissionGate` + `permission_request` 事件、`error` 事件（含 `code`/`recoverable`）、`ctx.compacted` + `context_compacted` 事件覆盖。

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
2. 每个合法调用：跑 `hooks.beforeToolCall`；`{veto, reason}` → 合成 `tool_result{isError:true}`（"Vetoed by beforeToolCall: …"），工具不执行、run 继续；`{modifiedInput}` → 改写后**重新过 schema 校验**；**hook 抛错 = fail-closed**：工具不执行，同样以 isError 结果上报，run 全程不受影响。
3. `requiresConfirmation` 为真者：emit `permission_request`，await `permissionGate.request()`。`allow` → 执行（可选 `modifiedInput`）；`deny` → `tool_result` 带拒绝原因。run 的 `AbortSignal` 在等待期间保持活跃；abort 取消待确认。
4. 所有确认的调用用 `Promise.allSettled` 并发执行。每调用独立 `AbortSignal = AbortSignal.any([runSignal, timeoutSignal])`（缺 `AbortSignal.any` 的运行时由 core 提供轻量 polyfill）。每工具 `timeoutMs`（工具级或 `config.toolTimeoutMs`）。
5. `allSettled` 结果：fulfilled → 工具结果；rejected/timeout → `tool_result{isError:true}` + 错误信息（**绝不抛出 loop 之外**——工具失败是给模型的数据）。
6. append **一条** assistant（全部 `tool_call` block）+ **一条** user（全部 `tool_result` block）到历史。把结果拆到多条 user 消息会训练模型串行化——禁止。
7. 每个工具 emit `tool_result` 事件。

### 4.4 Abort / 取消语义
- `Agent.stream()` 返回 `{ events, abort, done }`。`abort()` 调 run signal 的 `AbortController.abort()`。
- 该 signal 链接到：(a) provider `stream()`，(b) 每个工具的 `ToolCallContext.signal`，(c) 任何 pending 的 `permissionGate.request()`。
- abort 时：在途工具执行其 signal 触发、promise reject；loop emit `error{code:"aborted"}` 后 `done`；`done` promise reject `AbortError`。abort 幂等。

### 4.5 provider 瞬时错误退避重试与档位降级
- 可重试：网络错误、HTTP 408/409/429/5xx（适配器用 `isRetryable(err)` 谓词分类）。不可重试：400/401/403/404/413 → emit `error`，终止。
- 指数退避 + 抖动：`baseDelayMs`（默认 1000）× `2^attempt`，封顶 `maxDelayMs`（默认 30000），最多 `maxRetries`（默认 2，对齐 SDK 默认）。适配器若暴露 `retry-after` header 则尊重。
- 重试**不增加 turn 计数**（重试的请求是同一 turn）。run signal 已 abort 则跳过。
- **档位降级**（配置 `models` 后生效）：同模型重试预算耗尽（或错误不可重试但属可用性故障，如 404 `model_not_found` → 零同模型重试立即切换）且错误属可用性故障——`status===529 || code==="overloaded" || code==="model_not_found" || status>=500`，**不含 429**（账户级配额，换档无益）——沿链降一档（max→main→fast，链从本 turn 起始模型现推、去重、≤3），`attempt` 重置，emit `model_fallback` 事件，**立即重试不 sleep**（换了端点，旧模型的 retry-after 无意义——勿"修复"）。非粘性：下一 turn 回到起始模型（由 `modelFor`/per-send 覆盖/默认 main 决定）。首块 delta 守卫绝对优先：流中途失败不重试也不降档。链尽 → 抛原始错误。最坏情况每 turn `链长 × (1+maxRetries)` 次调用（默认 ≤9），有界。
- 起始模型解析在 maxTurns 检查后、`context.fit` 前（countTokens 闭包需用生效模型）；`modelFor` 每 turn 恰一次，降级后不重新咨询。

### 4.6 持久化边界与 run 级续跑（resume，2026-09-22 深夜）

**两个取消轴必须分开：** `abort` 是**用户主动喊停**——语义是「就要这么多」，产出保留（salvage partial 落库，`stopReason:"aborted"`）但**不应自动续跑**；崩溃（进程被杀 / 页面刷新 / 断网）是**用户没喊停而 run 没跑完**——这才是 resume 的目标场景。所以判断依据不是「有没有 error」，而是**持久化历史尾巴的形状**（`inspectRunTail`，纯函数、无副作用、可被宿主单独调用来决定「要不要给用户看『未完成的回复，继续？』」）。

**注意分类的粒度界限：** `inspectRunTail` 只看尾巴形状——**用户 abort 的 partial 与崩溃留下的 partial 在持久化形态上是同一类**（都是非终态 assistant），都归 `continue-partial`。这不是缺陷而是刻意的：分类器的任务是「这里有没有未完成的回复」，而「是不是用户自己喊停的」只有宿主知道（是它调的 `abort()`），且 partial 的 `metadata.stopReason === "aborted"` 可精确区分。所以兜底规则是**宿主一侧过滤**，不是分类器猜：
```ts
const partial = tail.kind === "continue-partial" && lastMeta.stopReason !== "aborted";
const offerResume = tail.kind !== "at-rest" && !userJustStopped;
```

**边界（README 已同步的定论）：** 接 `MemoryStore` 的会话**可恢复**（接着聊，历史全在）；**run 不自动恢复**——core 从不自行续跑，宿主 inspect 后决定何时续（刷新恢复、一个「继续」按钮、或永不）。这条边界是刻意的：自动续跑等于替用户重放一次他可能已经不想继续的 run，还会在重放时重复花钱。

| 尾巴 `RunTail` | 形态 | resume 动作 |
| --- | --- | --- |
| `at-rest` | 结束于终态 stop（`end_turn`/`stop_sequence`）或空历史 | 不发请求，emit `error{code:"nothing_to_resume", recoverable:true}` + 正常 `done`（宿主 UI 与普通结束同构），`done` resolve 为最后一条消息 |
| `continue` | 尾巴是 user 消息（新输入没被应答，或 tool_result carrier 之后的那轮没发生） | 直接驱动下一 turn |
| `answer-tools` | 尾巴是带 `tool_call` 块、却没收齐 `tool_result` 的 assistant 轮 | **先协议修复再驱动**：为**每一个**未应答调用合成一条 `tool_result`（单条 user 消息装全部，与 loop 的 carrier 同形），`isError:true`，内容诚实声明「上次 run 在结果落库前结束——该调用**可能执行了也可能没有**，不要盲目重放有副作用的调用，先验证效果（如读文件）再决定」，并 **先持久化**它再发请求 |
| `continue-partial` | 尾巴是非终态 assistant（abort 残留 / `max_tokens` / `pause_turn` / 无 stopReason 戳的旧数据） | 不改历史：请求**以这条 assistant 结尾**，两个 provider 家族都从该前缀续写（prefill） |

**协议修复为什么不能省：** 悬空的 `tool_use` 后面直接接新请求，Anthropic/OpenAI 的严格校验会 400（每个 tool_use 必须有配对 tool_result）。合成 carrier 是**唯一**能在保住已有上下文的前提下把历史修回协议完整的做法；内容措辞是刻意的诚实——resume 无法知道那个调用到底跑没跑（结果丢了而已），所以引导模型验证而非重放（幂等读类工具可直接重跑，`write_file`/`shell` 类必须谨慎）。合成 carrier 携带原 assistant 的 `runId`，历史视图里该轮仍与旧 run 同组。

**`persistRuns`（崩溃安全的前提，opt-in）：** 默认落库是**run 结束批量 append**——进程被杀 = 整个 run 什么都没存下。`persistRuns: true` 改为 loop 内逐消息增量落库（输入、每个 assistant 轮、tool_result carrier 各自在 append 后立刻 `memory.append`），run 中途任意时刻崩溃，已产生的轮次都在。`persistedIds` 记账避免 run 末的批量 append 重复写；增量 append 失败则 id 不记账，批量兜底仍然覆盖（best-effort，持久化失败绝不遮蔽原始错误）。未开启时 resume 照样工作，只是从「上次真正落库的状态」起续——优雅降级，粒度更粗。

**与其它机制的接线：** resume 与 `send` 共用同一条 per-conversation 串行队列（排队语义、abort 语义、持久化 flush 全一致）；走同一条 `materializeCompactedView` 加载路径，所以在压缩过的会话上续跑不会漏看摘要备注；`persistDropped` 同样接好，续跑中的新压缩也遵守 append-only。resume 的 run 有自己的新 `runId`，续写产生的轮次与旧 run 不混组。

---

## 5. 包 / Monorepo 结构（pnpm workspace）

```
lingjing-agent-core/                      (pnpm workspace 根)
├── pnpm-workspace.yaml
├── package.json                          (仅根 devDeps: @types/node, tsup, typescript, vitest)
├── scripts/{check-runtime-purity.mjs, release-snapshot.sh}
├── tsconfig.base.json
└── packages/
    ├── core/                             @lingjing-agent/core   (零 provider-SDK 依赖)
    │   ├── src/{index,types,tool,provider,events,agent,loop,context,memory,hooks,permission,schema,abort,
    │   │        models,recall,resume,structured,subagent,title,tokens,redact,sse,transport,exchange,idb-store}.ts
    │   ├── test/helpers/{fake-provider,stub-tools,gate-helpers}.ts   (包内测试脚手架，不发布)
    │   └── package.json                  peerDeps: zod@>=3.23 (optional)
    ├── provider-openai/                  @lingjing-agent/provider-openai     (SDK-free，可注入 transport)
    ├── provider-anthropic/               @lingjing-agent/provider-anthropic  (SDK-free，同 provider-openai 形态)
    ├── tools/                            @lingjing-agent/tools               (主入口 = web 工具；./node = fs / shell / glob / grep / Readability)
    └── mcp/                              @lingjing-agent/mcp                 (MCP client；./node = stdio 传输)
```

> 没有独立的 `tools-node` / `tools-web` 包——2026-09-10 起合并为单一 `tools`，靠子路径分层（见 §6.3）。测试脚手架走 `test/helpers/`，**不**作为 `./testing` 子路径发布。

**依赖方向：** 见 §2。**没有任何包反向依赖 provider 或 tools。** 宿主组合：`createAgent({ provider: new AnthropicProvider({...}), tools: [...nodeTools], memory: ... })`。

**subpath exports（每个包）：**
```jsonc
// packages/core/package.json —— core 只有根入口（测试脚手架不发布）
{
  "name": "@lingjing-agent/core",
  "type": "module",
  "exports": {
    ".":              { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./package.json": "./package.json"
  },
  "sideEffects": false,
  "peerDependencies": { "zod": ">=3.23.0" },
  "peerDependenciesMeta": { "zod": { "optional": true } }
}
```

```jsonc
// packages/tools/package.json —— 跨端主入口 + Node 专属子入口（mcp 同构）
{
  "exports": {
    ".":              { "types": "./dist/index.d.ts",  "import": "./dist/index.js",  "require": "./dist/index.cjs" },
    "./node":         { "types": "./dist/node.d.ts",   "import": "./dist/node.js",   "require": "./dist/node.cjs" },
    "./package.json": "./package.json"
  },
  "peerDependencies": { "@lingjing-agent/core": ">=0.1.0-beta.1" }
}
```

---

## 6. 宿主集成模式

### 6.1 Next.js（Node 或 Edge runtime）

> ⚠️ `@lingjing/host-next` 不在仓库内。以下为 Next.js 接入的设计模式，可自行实现（约几十行：`createAgentRoute` = 把 `AgentEvent` 流写成 SSE `Response`；`useAgent` = 前端 fetch + ReadableStream reader 的 React hook）。

- `createAgentRoute(agent)` 返回 POST handler：接收 `{ input, conversationId? }` JSON，返回 `Content-Type: text/event-stream` 的 `Response`，body 为 web `ReadableStream`，把 `AgentEvent` 序列化为 `data: {json}\n\n` SSE 帧。Edge 安全（web `ReadableStream` + `TextEncoder`，无 Node stream）。把 HTTP `Request.signal` 接入 `agent.stream({ signal })`，客户端断开即中止 run。
- `useAgent(path)` React hook：`fetch` + `ReadableStream` reader，每个 `AgentEvent` 重渲染；暴露 `abort()`。

### 6.2 浏览器 / Tauri webview
- provider（如 `OpenAIProvider`）用全局 `fetch`（经 `fetchTransport`；浏览器 + Tauri webview + Edge 均可用）。Tauri 下密钥留在 Rust 侧，webview 调 Tauri command 代理请求（密钥永不进 renderer）——这正是 provider 接受自定义 `transport`/`fetch` 的用途。

### 6.3 Node / 桌面（Electron / Tauri main）

> 内置工具现为单一可选包 `@lingjing-agent/tools`，包内分层（2026-09-10 合并自原 `tools-node` + `tools-fetch` 两包）：主入口 = web 工具（`createWebTools` 聚合器 → `web_read` 全能 URL 读取器[JSON/RSS·Atom/HTML 内容自动分流] + `wiki_search`，另有 keyed `createWebSearchTool`；`parseFeed`/`htmlToMarkdown` 亦直接导出。零 `node:` import、走 core `HttpTransport`，跨端可用）；`./node` 子入口 = `createFsTools` / `createSafeShell` / `createGlobTool` / `createGrepTool`（Node/Electron/Tauri-main 专属）+ `createReadabilityExtractor`（web_read 的 Readability 正文提取，可选 peer 依赖 @mozilla/readability + linkedom）。均按 §7 硬化，可选注入 —— 不 import 即不进 bundle。

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
每个适配器带 `contract.test.ts` 断言：`map-request` 产出厂商期望的请求形状；`map-stream` 把厂商 SSE 转成正确 `ProviderChunk` 序列（含 `tool_call_delta` JSON 累积）；`map-stop` 把厂商每个 `stop_reason`/`finish_reason` 映射到 core `StopReason`，且 `capabilities.stopReasons` 恰好列出这些；类型级测试断言无厂商字段泄漏到 core `Message`/`Content`。真实 API 集成测试为可选，env var 门控，本地手动跑（仓库无 CI）。

---

## 9. 构建 / 工具

- **pnpm workspace**，Node >= 20（根 `engines`）。
- **TypeScript** 5.5+，`strict:true`、`exactOptionalPropertyTypes:true`、`moduleResolution:"bundler"`、`isolatedModules:true`。
- **tsup**（每包）：`format:["esm","cjs"]`、`dts:true`、`clean:true`、`treeshake:true`、`target:"es2022"`（Edge 安全）。
- **subpath exports** 如上；`sideEffects:false` 利 tree-shaking。
- **vitest**（每包 `test/**/*.test.ts`，`FakeProvider` 驱动 unit + contract fixture）。
- **无 lint / format 工具链**：根 devDeps 只有 `@types/node` / `tsup` / `typescript` / `vitest`。Node API 的边界由 **`scripts/check-runtime-purity.mjs`**（`pnpm check:purity`，先 `pnpm -r build` 再扫 5 个跨端主入口）把守——`core` 与各包主入口不得出现 `node:` import，平台专属代码只准待在 `./node` 子入口。
- 本地校验链：`pnpm typecheck` → `pnpm test` → `pnpm check:purity`（含 build）。发版走 `scripts/release-snapshot.sh`；无 CI 配置、无 changesets。

---

## 10. 分阶段构建顺序

> 文档明确标注 Phase 1 边界与「路线图、非 Phase 1」项。

### Phase 1 — 证明 loop 端到端（MVP）
1. 脚手架 pnpm workspace + tsconfig + tsup + vitest。
2. `core/src/types.ts`（Message/Content/Role）。
3. `core/src/provider.ts`（LLMProvider/ProviderChunk/StopReason/ProviderConfig）。
4. `core/src/tool.ts` + `defineTool`（zod glue 可选；先支持原生 JSON Schema）。
5. `core/src/events.ts`（AgentEvent）。
6. `core/test/helpers/fake-provider.ts`（脚本化 + loop-trap）。
7. `core/src/loop.ts`（stream→累积→工具 exec `Promise.allSettled`+超时+abort→回喂→终止）。`TrimContextManager`。
8. `core/src/agent.ts`（`createAgent`、`stream`、`run`）。
9. 测试：终止性保证；单工具；并行工具；abort；工具错误→`tool_result` isError；max_tokens 续跑。

**Phase 1 退出 demo：** `agent.run("echo hello")` 用 FakeProvider 返回正确 message；`maxTurns:10` 对 loop-trap provider 终止。

### Phase 2 — 真实 provider + 宿主接线
1. `provider-anthropic`：`map-request`、`map-stream`（处理 `content_block_delta` 的 `text_delta`/`input_json_delta`/`thinking_delta`、`message_delta` 的 stop_reason/usage）、`map-stop`。仅 adaptive thinking（`thinking:{type:"adaptive", display:"summarized"}`，无 `budget_tokens`）；无 prefill。prompt-cache `cache_control` 打在 system + 末尾 user turn。
2. Node 工具：`safeShell`（白名单）、`fsTools`（路径 confinement）。（当时叫 `tools-node`，2026-09-10 并入 `@lingjing-agent/tools` 的 `./node` 子入口。）
3. `host-next`：`createAgentRoute`（SSE over web `ReadableStream`，Edge 安全）+ `useAgent` hook。（该包已移出仓库，接入模式保留在 §6.1。）
4. 集成：一个 Next.js 路由 + 真实 Anthropic key 跑通工具调用 agent 端到端（如「列出 /tmp 文件并总结」）。

### Phase 3 — 加固 ✅ 已实现（本轮收口）
1. ✅ `CompactContextManager`（provider 本地摘要：drain `provider.stream()` 把 head 摘要为 `[Earlier conversation summary]` user note；provider 错误吞掉回退 trim。**不做** Anthropic 服务端 compaction beta seam——列为后续轮）。
2. ✅ `PermissionGate` + `permission_request` 事件 + `useAgent` 的人工审批流（Phase 2 即上线，本轮补测试）。
3. ✅ 重试/退避 + `retry-after` 处理：core `ProviderError.retryAfterMs` + `computeBackoff`；provider-anthropic `parse-retry-after` + `enrichError` 包 `stream()`。
4. ✅ `pause_turn` + `context_window_exceeded` 处理（已上线，本轮补测试）。
5. ✅ `MemoryStore` 接口 + in-memory store（`InMemoryStore`，Node/测试）+ `IDBStore`（core，持久化）。（早期 `tools-web` 里的 localStorage 实现已随包合并退役，持久化统一走 `IDBStore` 或宿主自备 store。）
6. ✅ Hooks：beforeRequest/afterTurn/beforeToolCall/afterToolCall；`beforeRequest` 扩展 `{inject}` + `ragInjectHook` + `examples/rag-inject-demo.ts`。（2026-09-22 正确性加固见 §3.7 决策记录。）
7. ✅ `redact()` best-effort 清洗（defense-in-depth，跨 chunk 拼接的秘密会漏）。
8. ✅ web 工具（SSRF 守卫）。（原 `tools-web` 包；2026-09-10 起并入 `@lingjing-agent/tools` 主入口，现为 `createWebTools` → `web_read` / `wiki_search`，见 §6.3。）
9. ✅ `host-next` Edge 工厂（`createEdgeAgent`/`createEdgeAgentRoute`，shell/fs tag 守卫）。（**该包后已移出仓库**——接入模式见 §6.1，可自行实现。）
10. ✅ `provider-openai`（SDK-free、裸 `fetch` 直连 REST + 本地 SSE 解析；镜像 anthropic 的 map-* 契约）。

### Phase 3.5 — 通用框架缺口收口 ✅ 已实现（2026-09-21 → 09-22）
1. ✅ **Run 级续跑**（`agent.resume` + `inspectRunTail` + `persistRuns`）——见 4.6；崩溃/刷新/断网后可续，宿主控时。
2. ✅ **Sub-agents / 委托**（`createSpawnTool`）：隔离会话 + 工具白名单 + 共享并发信号量 + 深度上限，只回报告；`SpawnToolOptions.hooks`（只 `beforeRequest`，**不继承父级**，见 §3.7）。（**Skill/技能包机制为明确非目标**——见 2026-09-22 决策条；按需指令走 subagent definition / hooks / 工作区文件，勿再提案。）
3. ✅ **结构化输出**（`agent.respond`，强制工具路线而非 `output_config.format`）——见 3.7 后段落。
4. ✅ **权限规则引擎**（`createPermissionRules` + 会话记忆 + `persist` 跨会话）——见 3.5 后段落。
5. ✅ **压缩闭环修复**（改写前 `persistDropped` + 加载时 `materializeCompactedView` + 会话串行）——见 3.6 后段落。
6. ✅ **被动记忆：词法召回后端**（`createRecallStore`，BM25 + CJK 一元/二元组；接上早已实现却无后端可接的 `ragInjectHook`）——见 3.6 后段落。

### Phase 4+ — 路线图（明确非 Phase 1）
- **MCP server 侧**：已落地——`createMcpServer`（2026-09-23，宿主经 `McpServerChannel` 供读取，stdio 信道在 `@lingjing-agent/mcp/node`；把 core 工具以 MCP server 暴露，client 侧同包 `packages/mcp`）。
- **向量长期记忆**：已落地——`createVectorRecallStore`（2026-09-23，宿主 embedder + cosine + `persistIndex`，接口与词法后端同一）。
- **OpenTelemetry tracing**：**挂在事件流上**，不是把 hooks 改造成 span——`turn_end` / `tool_call` / `tool_result` / `provider_*` 本就坐在 semconv 的 span 边界上，且事件可序列化、天然可跨进程导出；hooks 是拦截通道，让它承担 tracing 会把「观察」和「拦截」两个语义搅在一起（§3.7）。
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

默认模型示例：`claude-opus-4-8`（宿主在 `AgentConfig.model` 或 `AgentConfig.models.main` 配置，core 不硬编码）。
