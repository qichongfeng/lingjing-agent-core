# lingjing-agent

简体中文 | **[English](./README.md)**

跨运行时、跨厂商的 TypeScript agent core。一份 `@lingjing-agent/core` 驱动 **Node · 浏览器 · Electron/Tauri · 微信小程序**。core 提供「大脑」（agentic loop、工具、记忆、可序列化流式事件），各端注入「手脚」（fs / shell / http / 存储 / UI）。

## 安装

```bash
npm install @lingjing-agent/core @lingjing-agent/provider-openai
npm install zod   # 可选 — 仅 defineTool 用 zod 写 schema 时需要
```

## 快速开始

```ts
import { createAgent, defineTool } from "@lingjing-agent/core";
import { OpenAIProvider } from "@lingjing-agent/provider-openai";
import { z } from "zod";

const weather = defineTool({
  name: "get_weather",
  description: "查询指定城市的实时天气。用户问到天气时调用。",
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ content: `${city}:22°C,晴` }),
});

const agent = createAgent({
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  model: "gpt-4o-mini",
  system: "你是一个简洁的助手。",
  tools: [weather],
  maxTurns: 25, // 硬上限 —— loop 保证终止
});

const { events, abort, done } = agent.stream("北京天气怎么样?", {
  conversationId: "c1",
});

for await (const e of events) {
  if (e.type === "text_delta") process.stdout.write(e.text);
  if (e.type === "tool_call") console.log(`\n→ ${e.name}(${JSON.stringify(e.input)})`);
}
const finalMessage = await done; // Promise<Message>
```

每个事件都是 JSON 可序列化的 —— 可直传 IPC / SSE / WebSocket / 小程序 `setData`。

## 多轮对话

对话状态持久化在 `MemoryStore`（默认进程内 `InMemoryStore`;需要跨进程持久化可自行接入 Redis/Postgres/`wx` 存储）。浏览器内置 IndexedDB 实现 —— 刷新页面对话不丢、多标签页共享:

```ts
import { IDBStore } from "@lingjing-agent/core";

const agent = createAgent({ /* … */ memory: new IDBStore() });
```

```ts
const chat = agent.conversation("c1");
await chat.send("北京天气怎么样?").done;
await chat.send("那上海呢?").done; // 记得上下文
```

## 任意 OpenAI 兼容端点

`provider-openai` 说的是 OpenAI Chat Completions **协议**（SDK-free）—— 改 `baseURL` 即可接 DeepSeek、豆包/火山、Kimi/Moonshot、智谱 GLM、通义 DashScope、Ollama、vLLM、OpenRouter……

```ts
const provider = new OpenAIProvider({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com/v1",
});
```

## 内置工具(可选注入)

core 本身不内置任何工具——能力注入是设计原则。两个可选包提供硬化过的工具,按需 import、只把要用的传进 `tools`:

```bash
npm install @lingjing-agent/tools-node   # 仅 Node/Electron/Tauri 主进程
npm install @lingjing-agent/tools-fetch  # 跨端(浏览器/Edge/小程序均可用)
```

```ts
import { createFsTools, createSafeShell, createGrepTool } from "@lingjing-agent/tools-node";
import { createWebReadTool } from "@lingjing-agent/tools-fetch";

const agent = createAgent({
  /* provider、model 等 */
  tools: [
    ...createFsTools({ root: process.cwd() }),                  // 路径 confinement 的读/写/列/删
    createSafeShell({ allowlist: ["git", "ls", "cat", "rg"] }), // 拒元字符 + spawn(shell:false) + 超时
    createGrepTool({ root: process.cwd() }),                    // 内容搜索(另有 createGlobTool)
    createWebReadTool(),                                       // http(s) GET → 可读文本
  ],
});
```

默认即硬化:模型给的路径逃不出 `root`(`..`/symlink 拒绝)、写/删/shell 出厂 `destructive`(过权限门)、每个工具带 tag(`fs:read`、`shell`、`http`……)供 `allowedToolTags` 白名单匹配。

## 微信小程序

小程序没有 `fetch` / `AbortController` / `ReadableStream` —— 注入自定义 `HttpTransport`（桥接 `wx.request`），同一份代码零 polyfill 跑起来：

```ts
const agent = createAgent({
  provider: new OpenAIProvider({ apiKey, baseURL, transport: createWxTransport(wx) }),
  model: "gpt-4o-mini",
  tools: [/* 小程序自定义工具 */],
});
```

可直接复制的 `createWxTransport` 适配器和完整聊天页骨架见 [`examples/`](./examples/)（`miniprogram-transport.ts`、`miniprogram-stub/`）。

## 中止

```ts
const handle = chat.send(input, { signal: someExternalSignal }); // 或调用 handle.abort()
```

`abort()` / signal 被触发时，`done` 以 `AbortError` reject;工具侧通过 `ctx.signal` 感知取消。

## 更多

- 完整设计与架构：[`DESIGN.md`](./DESIGN.md)
- 内置工具包：[`@lingjing-agent/tools-node`](./packages/tools-node/) · [`@lingjing-agent/tools-fetch`](./packages/tools-fetch/)
- 可运行示例（RAG 注入、ask-user 工具、node 工具、小程序）：[`examples/`](./examples/)
