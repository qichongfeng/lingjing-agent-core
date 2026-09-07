# lingjing-agent-core

> 通用、runtime-agnostic、provider-agnostic 的 TypeScript agent core。
> 一份 `@lingjing-agent/core`，驱动 **Node · 浏览器/Tauri webview · Electron/Tauri 桌面端 · 微信小程序**。
> core 提供「大脑」（agentic loop、工具、记忆、可序列化流式事件），宿主注入「手脚」（fs/shell/http/存储/UI）。

**状态：Phase 3 已实现。** `@lingjing-agent/core`（loop + 工具 + CompactContextManager + RAG 注入 + redact + 事件 + HttpTransport）+ `provider-openai`（OpenAI 兼容协议,SDK-free）+ `provider-anthropic`（Anthropic Messages 协议,SDK-free）+ 微信小程序骨架 —— 全部 typecheck/测试通过/构建产出 ESM+CJS+d.ts。真实端到端需 `OPENAI_API_KEY`（见 `examples/`）。完整设计见 [`DESIGN.md`](./DESIGN.md)。

## 开发

```bash
pnpm install
pnpm -r typecheck      # tsc --noEmit
pnpm -r test           # vitest run（含终止性保证 keystone 测试）
pnpm -r build          # tsup → dist/（ESM + CJS + d.ts）
```

## 设计要点

- **Runtime-agnostic core** — 零 Node 专属 import，只用跨端共有全局（`fetch`/`AbortController`/`AsyncIterable`/`crypto.randomUUID`）。
- **Provider-agnostic** — `LLMProvider` 接口 + 中性 `ProviderChunk` 联合类型，**不形似任何厂商 SDK**；core 永不 import 厂商 SDK。仓库带 `provider-openai` 作参考实现，可按需加其他。
- **能力注入** — 工具、记忆、HTTP transport、权限门都是宿主提供的接口。
- **跨端网络层** — core 提供 `HttpTransport` 抽象（body 为 `AsyncIterable<Uint8Array>`）+ `fetchTransport` 默认实现；provider/tool 不碰 Web `Response`/`ReadableStream`，小程序等无 `fetch` 的运行时注入自定义 transport 即零 polyfill 共用同一份代码。
- **事件驱动流式** — `Agent.stream()` 返回 `AsyncIterable<AgentEvent>`，每个事件 JSON 可序列化，可直传 IPC/SSE/WebSocket/小程序 setData。
- **终止性是硬保证** — `maxTurns`（默认 25）即使 provider 永远要工具也必终止（有 contract 测试）。
- **安全默认** — 破坏性工具 deny-by-default、工具 tag 白名单、execute 前 schema 校验、密钥永不入日志/消息。（shell/fs 工具的额外硬化见 DESIGN §7；本仓库不内置这类工具）

## 包结构（pnpm workspace）

```
packages/
├── core/            @lingjing-agent/core      AgentRunner · Tool · Memory · Provider 接口 · Events · HttpTransport
├── provider-openai/   @lingjing-agent/provider-openai    **OpenAI 兼容协议**适配器（SDK-free，改 `baseURL` 连 DeepSeek/豆包/Kimi/Ollama/网关…）
└── provider-anthropic/ @lingjing-agent/provider-anthropic  **Anthropic Messages** 适配器（SDK-free，thinking/caching/pause_turn/context_window_exceeded）
examples/
├── rag-inject-demo.ts          FakeProvider + RAG 注入（无网络）
├── miniprogram-transport.ts    wx.request → HttpTransport 适配器（+ self-test）
└── miniprogram-stub/           微信小程序最小骨架（app.js polyfill + 聊天页 + transport）
```

provider-agnostic：内置 `provider-openai`（OpenAI 兼容协议）+ `provider-anthropic`（Anthropic Messages）两个参考实现；要加别的后端（Bedrock / 豆包 / 通义…），照它们实现一个 `LLMProvider` 即可，core 不变。

## 目标用法（Node / 浏览器）

```ts
import { createAgent } from "@lingjing-agent/core";
import { OpenAIProvider } from "@lingjing-agent/provider-openai";

const agent = createAgent({
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  model: "gpt-4o-mini",
  system: "你是一个简洁的助手。",
  tools: [
    // 工具按需自定义（defineTool）；本仓库不内置 fs/shell/http 工具——
    // 各端注入自己的能力（小程序包 wx.*、Node 包 child_process/fs、Web 包 fetch…）。
  ],
  maxTurns: 25,
});

const { events, done } = agent.stream("用一句话介绍你自己", { conversationId: "c1" });
for await (const e of events) {
  if (e.type === "text_delta") process.stdout.write(e.text);
  if (e.type === "tool_call") console.log(`\n→ ${e.name}(${JSON.stringify(e.input)})`);
}
await done;
```

### 微信小程序

小程序没有 `fetch`/`AbortController`/`ReadableStream`，但 core 的 `HttpTransport` 抽象让同一份 provider 代码零 polyfill 跑进去：

```ts
import { createAgent } from "@lingjing-agent/core";
import { OpenAIProvider } from "@lingjing-agent/provider-openai";
import { createWxTransport } from "./miniprogram-transport";

const agent = createAgent({
  provider: new OpenAIProvider({ apiKey, baseURL, transport: createWxTransport(wx) }),
  model: "gpt-4o-mini",
  tools: [/* 小程序自定义工具 */],
});
```

完整骨架（含 `AbortController` polyfill、聊天页、`onUnload` abort）见 `examples/miniprogram-stub/`。

### 无网络测试
core 自带测试 helpers（`FakeProvider` / `scriptedProvider` / gate stub 等）在 `packages/core/test/helpers/`，用于 core 自己的 contract 测试（含终止性 keystone）。**不是公共导出** —— 要无网络测自己的 agent，可参考或复制这些 helpers（`echoTool` / `loopTrapProvider` / `failingThenRecover` 等）到自己的测试里。`examples/rag-inject-demo.ts` 就是这样 inline 了一个 mini FakeProvider。

## 路线

- **Phase 1** core + FakeProvider + 测试（loop 端到端、终止性保证）。
- **Phase 2** provider + tools-node（真实端到端）。
- **Phase 3** ✅ CompactContextManager / PermissionGate / 重试+retry-after / pause_turn / MemoryStore / Hooks+RAG注入 / redact / tools-web / provider-openai（SDK-free）/ HttpTransport（跨端可注入）。
- **Phase 4+** sub-agents、MCP client/server、向量长期记忆、OpenTelemetry、结构化输出强制、Bedrock/Vertex、更多 provider。

详见 [`DESIGN.md`](./DESIGN.md) §10。
