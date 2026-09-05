# @lingjing/agent-core

Runtime-agnostic, provider-agnostic TypeScript agent core: agentic loop, tools,
streaming events, context management — bring your own LLM provider.

**Zero runtime dependencies.** No SDK, no `openai`/`@anthropic-ai/sdk`, no
Node-only APIs — runs unchanged in Node 18+, browsers, Edge, and runtimes
without a global `fetch` (e.g. WeChat mini-programs, via an injectable
`HttpTransport`).

## Features

- **Agentic loop** — multi-turn tool calling with a hard `maxTurns` cap that
  guarantees termination. Provider errors are classified (`status`,
  `retryable`, `retryAfterMs`) and retried with backoff by the loop, not by
  adapters.
- **Streaming events** — one typed event stream per run: `message_start`,
  `text_delta`, `thinking_delta`, `tool_call_delta`, `tool_result`, `turn_end`,
  … Turn-level buffering keeps delta replay safe across retries.
- **Tools** — declare with JSON Schema or zod (optional peer; a built-in
  `zodToJsonSchema` converter, no zod import needed at runtime). Timeouts,
  parallel calls, and a permission gate for approval flows.
- **Hooks & memory** — `beforeToolCall`/`afterToolCall` hooks, `InMemoryStore`,
  and a `ragInjectHook` for retrieval-augmented context injection.
- **Context management** — `TrimContextManager` and `CompactContextManager`
  (auto-compact on overflow) with configurable token budgets and a
  `countTokens` heuristic fallback.
- **Redaction** — `redact`/`redactEvents` scrub secrets from messages and event
  streams before logging.

## Install

```sh
pnpm add @lingjing/agent-core
```

## Usage

```ts
import { createAgent, defineTool } from "@lingjing/agent-core";
import { OpenAIProvider } from "@lingjing/provider-openai";

const getTime = defineTool({
  name: "get_time",
  description: "Current time in ISO format",
  inputSchema: { type: "object", properties: {}, required: [] },
  async execute(_input, ctx) {
    return new Date().toISOString();
  },
});

const agent = createAgent({
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  model: "gpt-4o",
  system: "You are a terse assistant.",
  tools: [getTime],
  maxTurns: 10,
});

const run = agent.stream("What time is it?");
for await (const event of run.events) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "tool_result":
      console.log("\n[tool]", event.name, "→", event.output);
      break;
  }
}
const finalMessage = await run.done; // settles with the final assistant Message
```

## API

- `createAgent(config)` — `config: { provider, model, system?, tools?, maxTurns?,
  maxTokens?, effort?, thinking?, hooks?, permission?, memory?, context? }`.
- `Agent` — `.stream(input)` / `.run(input)`; streaming runs expose
  `.events`, `.abort()`, `.result`.
- `defineTool({ name, description, inputSchema, execute })` — JSON Schema or
  zod input; `execute(input, ctx)` with an abort `signal`.
- Providers implement `LLMProvider` (`stream`, `complete`, `countTokens`);
  see [`@lingjing/provider-openai`](../provider-openai) for a reference adapter
  that speaks the OpenAI Chat Completions protocol (works with DeepSeek, 豆包,
  通义, Kimi, 智谱, Ollama, vLLM, gateways, …).
- `fetchTransport(fetch?)` — default HTTP transport; inject a custom
  `HttpTransport` where no global `fetch` exists.

## Design

See [DESIGN.md](../../DESIGN.md) for the architecture: neutral message/content
types, one event stream, providers as pure protocol adapters, loop-owned
retry/overflow handling.
