# lingjing-agent-core — 交接说明

**通用、runtime-agnostic、provider-agnostic 的 TypeScript agent 内核。** 一份 `@lingjing-agent/core` 驱动 Node / 浏览器 / Edge / 微信小程序;core 是「大脑」(agentic loop + 工具框架 + 记忆 + 事件流),宿主注入「手脚」(provider 连哪家模型、tools 能干什么、transport 网络怎么发)。

## 仓库结构(已精简)
```
packages/
├── core/            @lingjing-agent/core       大脑 + HttpTransport(零运行时依赖,仅可选 zod)
├── provider-openai/   @lingjing-agent/provider-openai    OpenAI 兼容协议(SDK-free,网络可注入)
└── provider-anthropic/ @lingjing-agent/provider-anthropic  Anthropic Messages 协议(SDK-free,thinking/caching)
examples/
├── rag-inject-demo.ts         FakeProvider + RAG 注入(无网络可跑)
├── miniprogram-transport.ts   wx.request → HttpTransport 适配器(+ self-test)
└── miniprogram-stub/          微信小程序完整骨架(聊天页 + polyfill + transport)
```
**依赖方向单向**: `provider-openai → core`、`provider-anthropic → core`;core 不反向依赖任何包。加别的后端(Bedrock / 豆包 / 通义)照这两个实现 `LLMProvider`,core 零改动。

## 运行逻辑(agentic loop)
`agent.stream(input, { conversationId }) → { events, abort, done }`(`conversationId` 必填),内部 turn 循环:
```
每轮:context.fit(裁剪/压缩) → hooks.beforeRequest(RAG 注入) → provider.stream(经 transport 拿 LLM 流)
      → emit 事件(text_delta / tool_call / …) + 累积 assistant → switch(stopReason):
        tool_use        → 跑工具(schema 校验 / permission / 并行) → 回填 → 下一轮
        end_turn/refusal → 终止
        max_tokens/pause_turn → 续跑
        turns ≥ maxTurns → 硬熔断
产出 AsyncIterable<AgentEvent>(JSON 可序列化,直传 IPC / SSE / WebSocket / 小程序 setData)
```

## 三端接入

**Node / 浏览器**(默认全局 `fetch`):
```ts
import { createAgent } from "@lingjing-agent/core";
import { OpenAIProvider } from "@lingjing-agent/provider-openai";

const agent = createAgent({
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  model: "gpt-4o-mini",
  tools: [/* defineTool 自定义 */],
});
```

**微信小程序**(无 `fetch` / `ReadableStream`,注入 transport):
```ts
provider: new OpenAIProvider({ apiKey, baseURL, transport: createWxTransport(wx) })
```
+ `app.js` 里 `AbortController` polyfill(必须在 `require(core)` 之前)。完整骨架见 `examples/miniprogram-stub/`。

## 跨端关键:HttpTransport
core 定义的接口:`(req) → { status, headers, body: AsyncIterable<Uint8Array> }`。body 用 `AsyncIterable` 而非 Web `ReadableStream` —— 小程序能原生提供(`wx.request` + `onChunkReceived` → async iterable),Node/浏览器用默认 `fetchTransport`。**同一份 provider 代码零 polyfill 跨端**。

## 关键保证
- **终止性**:`maxTurns`(默认 25)硬熔断,即使 provider 永远要工具也必停(有 contract 测试)。
- **取消**:`handle.abort()` 一键取消,signal 链穿透到 transport;`AbortError` 不被误判为可重试。
- **安全**:破坏性工具 deny-by-default、`permissionGate` 人工审批、工具 tag 白名单、execute 前 schema 校验、密钥 `redact()` 不入事件。
- **provider-agnostic / runtime-agnostic**:core 零 Node import,只用跨端全局(`fetch`/`AbortController`/`AsyncIterable`/`crypto.randomUUID`)。

## 可调参数(`AgentConfig`)
- `maxTurns`(默认 25):turn 硬熔断上限。
- `maxContinuations`(默认 5):`pause_turn` 连续续跑上限。
- `maxStalledTurns`(默认 3):连续 `max_tokens` 无进展上限。
- `contextTokenBudget`(默认 100_000):传给 `context.fit`/`compact` 的 token 预算。
- provider 无 `countTokens` 时,loop 用启发式(char/4)估算,保证 context 管理仍生效(不静默失效)。
- OpenAI 撞上下文上限(HTTP 400 `context_length_exceeded`)时,loop 自动 `compact` 重试一次,再溢出才终止。

## 已知限制
- **`redact()` 是 best-effort**:跨流式 chunk 拆开的秘密抓不到;要 whole-text 覆盖用 `redact(Message)`。真正的密钥边界在 provider-key / 网络层。
- **事件流单消费者**:`agent.stream()` 的 `events` 假设单消费者(多消费者会抢消息)。
- **流式重试只在首个 chunk 前**(业界标准,对齐 OpenAI / Anthropic SDK):一旦开始吐数据,中途断流是终端错误,已发给前端的 partial 输出**保留**(不回滚、不重放);只有首个 chunk 前的失败才自动重试。需要"流后也自动恢复"由应用层自己做(整体重发 + 去重)。
- **thinking + signature 保留**:core 维护 `thinking` block 的 `signature`(为支持多轮 replay 的 provider);当前仓库无 provider 触发,但代码保留。

## 工具怎么做(各端自行)
仓库**不内置** fs / shell / http 工具(已摘除 `tools-node` / `tools-web`)。各端 `defineTool` 注入自己的能力:
- 小程序:`wx.getStorageSync` / `wx.scanCode` / `wx.getLocation` …
- Node:`child_process` / `fs`(自行做白名单 + 路径 confinement,硬化要点见 `DESIGN.md` §7)
- Web:`fetch` / `localStorage`

## 开发
```bash
pnpm install
pnpm -r typecheck && pnpm -r test && pnpm -r build   # 全绿:108 测试(core 65 · anthropic 13 · openai 30)
```

## 注意
- `@lingjing/*` 包目前 `private`(`version 0.0.0`,未发布 npm)。接入方式:`file:` 依赖 / 拷 `dist/` / 私有 npm(详见 `examples/miniprogram-stub/README.md`)。
- 真机端到端需在小程序开发者工具里跑(需 `OPENAI_API_KEY` + 后台配 request 合法域名)。

---
完整设计原理见 [`DESIGN.md`](./DESIGN.md);项目入口见 [`README.md`](./README.md)。
