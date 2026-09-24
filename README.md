# lingjing-agent

**[简体中文](./README.zh-CN.md)** | English

Runtime-agnostic, provider-agnostic TypeScript agent core. One `@lingjing-agent/core` drives **Node · Browser · Electron/Tauri · WeChat mini-program**. The core provides the brain (agentic loop, tools, memory, serializable streaming events, tiered models with availability fallback); each host injects the hands (fs / shell / http / storage / UI).

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

Conversations persist in a `MemoryStore` (default: in-process `InMemoryStore`; bring your own for Redis/Postgres/`wx` storage). Browsers get a built-in IndexedDB store — conversations survive reloads and share across tabs:

```ts
import { IDBStore } from "@lingjing-agent/core";

const agent = createAgent({ /* … */ memory: new IDBStore() });
```

```ts
const chat = agent.conversation("c1");
await chat.send("What's the weather in Beijing?").done;
await chat.send("And in Shanghai?").done; // remembers the context
```

Conversations recover; **runs don't auto-resume** — if a reply is cut off by a
crash, reload, or dropped connection, the host decides whether to continue it
(core never does so on its own). Turn on `persistRuns` so each message is
durable as it is produced, then:

```ts
const store = new IDBStore();
const agent = createAgent({ /* … */ memory: store, persistRuns: true });

// inspectRunTail() is pure, so the UI can decide whether to offer "continue?":
const tail = inspectRunTail(materializeCompactedView(await store.load(conversationId)));
if (tail.kind !== "at-rest") await agent.conversation(conversationId).resume().done;
```

`resume()` repairs the history as it drives: a tool round whose results were
lost gets honest *"may or may not have run — verify before re-calling"*
results, and a half-written reply is continued from where it stopped.

### Long-term memory across conversations

`createRecallStore` gives any store a working `recall` (BM25 over latin + CJK
tokens, zero dependencies), which `ragInjectHook` then turns into context. No
search tool for the model: relevant history surfaces on its own.

```ts
import { createRecallStore, ragInjectHook } from "@lingjing-agent/core";

const store = new IDBStore();
const memory = createRecallStore({ store }); // pass the WRAPPER, not `store`
const agent = createAgent({
  /* … */
  memory,
  hooks: { beforeRequest: ragInjectHook({ store: memory }) },
});
```

Retrieval happens once per user turn, skips the current conversation (its
content is already in context), and injects the hits as a framed
`[Retrieved context]` block. `examples/rag-inject-demo.ts` is a runnable,
self-checking version of this.

## Any OpenAI-compatible endpoint

`provider-openai` speaks the OpenAI Chat Completions **protocol** (SDK-free) — point `baseURL` at DeepSeek, 豆包/Ark, Kimi/Moonshot, 智谱 GLM, DashScope, Ollama, vLLM, OpenRouter…

```ts
const provider = new OpenAIProvider({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com/v1",
});
```

## Built-in tools (optional)

The core ships none — capability injection is the design. Optional packages provide hardened, opt-in tools; import only what you pass to `tools`:

```bash
npm install @lingjing-agent/tools          # web tools (browser/Edge/mini-program OK); ./node adds fs/shell/glob/grep + Readability
npm install @lingjing-agent/mcp            # bridge an external MCP server's tools (legacy era, tools only)
```

```ts
import { createWebTools } from "@lingjing-agent/tools";
import { createFsTools, createSafeShell, createGrepTool } from "@lingjing-agent/tools/node"; // Node side only

const agent = createAgent({
  /* provider, model, … */
  tools: [
    // web_read (universal URL reader) + wiki_search; add
    // webSearch: { apiKey } for keyed web search (+optional Readability via /node)
    ...createWebTools({ wiki: { languages: ["zh", "en"] } }),
    ...createFsTools({ root: process.cwd() }),                  // path-confined read/write/list/delete
    createSafeShell({ allowlist: ["git", "ls", "cat", "rg"] }), // no metachars, spawn(shell:false), timeout
    createGrepTool({ root: process.cwd() }),                    // content search (+ createGlobTool)
  ],
});
```

Hardened by default: model paths can't escape `root` (`..`/symlink refusal), write/delete/shell are `destructive` (permission-gated), every tool carries tags (`fs:read`, `shell`, `http`, …) for `allowedToolTags` allowlisting.

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
- Built-in tools: [`@lingjing-agent/tools`](./packages/tools/) (main = cross-runtime web tools, `./node` = fs/shell/glob/grep + Readability) · [`@lingjing-agent/mcp`](./packages/mcp/)
- Runnable examples (RAG injection, ask-user tool, node tools, mini-program): [`examples/`](./examples/)
