# lingjing-agent-core — 交接说明

**通用、runtime-agnostic、provider-agnostic 的 TypeScript agent 内核。** 一份 `@lingjing-agent/core` 驱动 Node / 浏览器 / Edge / 微信小程序;core 是「大脑」(agentic loop + 工具框架 + 记忆 + 事件流),宿主注入「手脚」(provider 连哪家模型、tools 能干什么、transport 网络怎么发)。

## 仓库结构(已精简)
```
packages/
├── core/               @lingjing-agent/core                大脑 + HttpTransport(零运行时依赖,仅可选 zod)
├── provider-openai/    @lingjing-agent/provider-openai     OpenAI 兼容协议(SDK-free,网络可注入)
├── provider-anthropic/ @lingjing-agent/provider-anthropic  Anthropic Messages 协议(SDK-free,thinking/caching)
├── tools/              @lingjing-agent/tools               主入口 = web 工具(web_read / wiki_search,跨端)
│                                                            ./node = fs / shell / glob / grep / Readability
└── mcp/                @lingjing-agent/mcp                 MCP client + server;./node = stdio 传输 + stdio 服务端信道
examples/
├── rag-inject-demo.ts         FakeProvider + RAG 注入(无网络可跑)
├── miniprogram-transport.ts   wx.request → HttpTransport 适配器(+ self-test)
├── miniprogram-stub/          微信小程序完整骨架(聊天页 + polyfill + transport)
├── node-tools-demo.ts         fs / shell / glob / grep 接入
├── ask-user-tool.ts           ask_user 人机澄清工具
└── media-store.ts             媒体/大对象宿主存储
```
没有独立的 `tools-node` / `tools-web` 包(2026-09-10 合并为 `tools`);测试脚手架在 `packages/core/test/helpers/`,不发布。
**依赖方向单向**: `provider-openai → core`、`provider-anthropic → core`;core 不反向依赖任何包。加别的后端(Bedrock / 豆包 / 通义)照这两个实现 `LLMProvider`,core 零改动。

## 运行逻辑(agentic loop)
`agent.stream(input, { conversationId }) → { events, abort, done }`(`conversationId` 必填),内部 turn 循环:
```
每轮:context.fit(裁剪/压缩) → hooks.beforeRequest(RAG 注入 / 拦截,fail-closed) → provider.stream(经 transport 拿 LLM 流)
      → emit 事件(text_delta / tool_call / …) + 累积 assistant → hooks.afterTurn(观察) → switch(stopReason):
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
- **被动记忆两条后端**:`createRecallStore`(BM25 词法,装饰任意 `MemoryStore`)+ `createVectorRecallStore`(语义,宿主提供 embedder + cosine,可选 `persistIndex` 跨重启复用向量),接口同一、一行互换;经 `ragInjectHook` 注入,scope 越权内容根本不 load。
- **续跑与子代理**:`agent.resume` + `inspectRunTail` 四态(用户 abort 的 partial 与崩溃残留同形,宿主控时,core 从不自动续跑);`createSpawnTool`(独立会话 + 工具白名单 + 只回报告 + 共享并发信号量 + 深度上限)。
- **受控决策**:`createPermissionRules`(deny 恒胜 + 会话记忆 + persist 跨会话)、agent 级 `confirm` 三档(默认按工具声明 / `"never"` 全跳过宿主全责 / `"always"` 全过门)、结构化输出 `agent.respond`(强制工具路线)。
- **MCP 双向**:client 桥 + `createMcpServer` 把 core 工具以 MCP server 暴露(stdio 两半都在 `@lingjing-agent/mcp/node`)。

## 可调参数(`AgentConfig`)
- `maxTurns`(默认 25):turn 硬熔断上限。
- `maxContinuations`(默认 5):`pause_turn` 连续续跑上限。
- `maxStalledTurns`(默认 3):连续 `max_tokens` 无进展上限。
- `contextTokenBudget`(默认 1_000_000,`DEFAULT_CONTEXT_TOKEN_BUDGET`):传给 `context.fit`/`compact` 的 token 预算;未设时按 `models.contextWindow` 解析。
- provider 无 `countTokens` 时,loop 用启发式(char/4)估算,保证 context 管理仍生效(不静默失效)。
- OpenAI 撞上下文上限(HTTP 400 `context_length_exceeded`)时,loop 自动 `compact` 重试一次,再溢出才终止。

## 已知限制
- **`redact()` 是 best-effort**:跨流式 chunk 拆开的秘密抓不到;要 whole-text 覆盖用 `redact(Message)`。真正的密钥边界在 provider-key / 网络层。
- **事件流单消费者**:`agent.stream()` 的 `events` 假设单消费者(多消费者会抢消息)。
- **流式重试只在首个 chunk 前**(业界标准,对齐 OpenAI / Anthropic SDK):一旦开始吐数据,中途断流是终端错误,已发给前端的 partial 输出**保留**(不回滚、不重放);只有首个 chunk 前的失败才自动重试。需要"流后也自动恢复"由应用层自己做(整体重发 + 去重)。
- **thinking + signature 保留**:core 维护 `thinking` block 的 `signature`,`provider-anthropic` 会累积 `signature_delta` 并在 `thinking_end` 发出、回放时原样带上(多轮 replay 必需)。`{type:"adaptive"}` 一跳即触发。

## 工具怎么做
可选包 `@lingjing-agent/tools` 提供硬化过的内置工具(不 import 即不进 bundle)。各端仍可用 `defineTool` 注入自己的能力:
- 跨端:`createWebTools()` → `web_read`(全能 URL 读取器) + `wiki_search`(+ keyed `createWebSearchTool`);`ask_user`(人机澄清,配 `handler` 契约 + 提问卡);`update_plan`(任务计划);`preview`(iframe 沙箱)
- Node(`@lingjing-agent/tools/node`):`createFsTools`(路径 confinement)、`createSafeShell`(可执行白名单 + 拒元字符 + `spawn(shell:false)` + 超时)、`createGlobTool` / `createGrepTool`、`createReadabilityExtractor`
- MCP:`@lingjing-agent/mcp` 把外部 MCP server 的工具桥进来(client 侧)+ 把 core 工具以 MCP server 暴露(`createMcpServer`,stdio 信道在 `@lingjing-agent/mcp/node`)
- 其余自定义:小程序 `wx.getStorageSync` / `wx.scanCode` / `wx.getLocation` …;自建工具务必按 `DESIGN.md` §7 硬化,并声明 `permissions.tags` / `destructive` 以便 `allowedToolTags` 与 `permissionGate` 生效

## 开发
```bash
pnpm install
pnpm typecheck && pnpm test && pnpm check:purity   # 全绿:704 测试 / 47 文件
# core 319 · tools 200 · mcp 111 · openai 48 · anthropic 26
```

仓库**没有** lint / format 工具链(根 devDeps 只有 `@types/node` / `tsup` / `typescript` / `vitest`),运行时边界由 `scripts/check-runtime-purity.mjs` 把守。

## 注意
- `@lingjing-agent/*` 包已发布到 npm(当前 `0.1.0-beta.10`,见各包 `package.json`)。发版走 `scripts/release-snapshot.sh`;本仓内跨包引用用 `workspace:*`。prerelease 必须显式 `--tag`,registry 读取有滞后。
- 真机端到端需在小程序开发者工具里跑(需 `OPENAI_API_KEY` + 后台配 request 合法域名)。

---
完整设计原理见 [`DESIGN.md`](./DESIGN.md);项目入口见 [`README.md`](./README.md)。
