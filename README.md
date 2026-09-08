# lingjing-agent

**[简体中文](./README.zh-CN.md)** | English

Runtime-agnostic, provider-agnostic TypeScript agent core. One `@lingjing-agent/core` drives **Node · Browser · Electron/Tauri · WeChat mini-program**. The core provides the brain (agentic loop, tools, memory, serializable streaming events); each host injects the hands (fs / shell / http / storage / UI).

## Install

```bash
npm install @lingjing-agent/core @lingjing-agent/provider-openai
npm install zod   # optional — only for defineTool zod schemas
```

## Quick start

```ts
import { createAgent, defineTool } from "@lingjing-agent/core";
import { OpenAIProvider } from "@lingjing-agent/provider-openai";
import { z } from "zod";

const weather = defineTool({
  name: "get_weather",
  description: "Get current weather for a city. Use when the user asks about weather.",
  input: z.object({ city: z.string() }),
  execute: async ({ city }) => ({ content: `${city}: 22°C, sunny` }),
});

const agent = createAgent({
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  model: "gpt-4o-mini",
  system: "You are a concise assistant.",
  tools: [weather],
  maxTurns: 25, // hard cap — the loop always terminates
});

const { events, abort, done } = agent.stream("What's the weather in Beijing?", {
  conversationId: "c1",
});

for await (const e of events) {
  if (e.type === "text_delta") process.stdout.write(e.text);
  if (e.type === "tool_call") console.log(`\n→ ${e.name}(${JSON.stringify(e.input)})`);
}
const finalMessage = await done; // Promise<Message>
```

Every event is JSON-serializable — pipe it straight through IPC / SSE / WebSocket / mini-program `setData`.

## Multi-turn conversations

Conversations persist in a `MemoryStore` (default: in-process `InMemoryStore`; bring your own for Redis/Postgres/`wx` storage).

```ts
const chat = agent.conversation("c1");
await chat.send("What's the weather in Beijing?").done;
await chat.send("And in Shanghai?").done; // remembers the context
```

## Any OpenAI-compatible endpoint

`provider-openai` speaks the OpenAI Chat Completions **protocol** (SDK-free) — point `baseURL` at DeepSeek, 豆包/Ark, Kimi/Moonshot, 智谱 GLM, DashScope, Ollama, vLLM, OpenRouter…

```ts
const provider = new OpenAIProvider({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com/v1",
});
```

## WeChat mini-program

No `fetch` / `AbortController` / `ReadableStream` there — inject a custom `HttpTransport` (bridge `wx.request`) and the same code runs with zero polyfills:

```ts
const agent = createAgent({
  provider: new OpenAIProvider({ apiKey, baseURL, transport: createWxTransport(wx) }),
  model: "gpt-4o-mini",
  tools: [/* your mini-program tools */],
});
```

A copy-paste `createWxTransport` adapter plus a full chat-page skeleton live in [`examples/`](./examples/) (`miniprogram-transport.ts`, `miniprogram-stub/`).

## Aborting

```ts
const handle = chat.send(input, { signal: someExternalSignal }); // or call handle.abort()
```

`abort()` / an aborted signal rejects `done` with `AbortError`; tools receive the signal via `ctx.signal`.

## More

- Design & architecture: [`DESIGN.md`](./DESIGN.md)
- Runnable examples (RAG injection, ask-user tool, mini-program): [`examples/`](./examples/)
