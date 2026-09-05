# @lingjing/provider-anthropic

Anthropic Messages adapter for [`@lingjing/agent-core`](../core).

**SDK-free.** This adapter talks to the Anthropic REST API (`POST /v1/messages`)
over core's neutral `HttpTransport` (default: global `fetch`) — no
`@anthropic-ai/sdk` dependency — so it runs unchanged in Node 18+, browsers,
Edge, **and** runtimes without a global `fetch` (e.g. WeChat mini-programs:
inject your own transport bridging `wx.request`). Retry/backoff is owned by
core's loop, not duplicated here.

## Install

```sh
pnpm add @lingjing/agent-core @lingjing/provider-anthropic
```

## Usage

```ts
import { createAgent } from "@lingjing/agent-core";
import { AnthropicProvider } from "@lingjing/provider-anthropic";

const agent = createAgent({
  provider: new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
  model: "claude-opus-4-8",
  maxTurns: 25,
  tools: [/* ... */],
});

const { events, done } = agent.stream("Hello", { conversationId: "c1" });
for await (const e of events) {
  if (e.type === "text_delta") process.stdout.write(e.text);
}
await done;
```

### Mini-program (no global `fetch`)

```ts
new AnthropicProvider({ apiKey, baseURL, transport: createWxTransport(wx) })
```

### Extended thinking + prompt caching

```ts
createAgent({
  provider: new AnthropicProvider({ apiKey }),
  model: "claude-opus-4-8",
  thinking: { type: "adaptive" },                       // → Anthropic thinking:{type:"enabled",budget_tokens}
  providerOptions: {
    thinkingBudget: 8000,                               // optional budget override
    cacheControl: { targets: ["system", "last_user"] }, // Anthropic prompt caching
  },
});
```

## Protocol notes (why a separate adapter)

Anthropic Messages ≠ OpenAI Chat Completions: `system` is top-level (not a
message), no `tool` role (tool_result lives in user content), id-keyed
`content_block_*` streaming events (vs OpenAI index-keyed), `stop_reason` carries
`context_window_exceeded`/`pause_turn` (vs OpenAI's HTTP 400), first-class
`thinking`/`signature`, and `cache_control`. This adapter maps all of them to
core's neutral `ProviderChunk` / `StopReason`.

## Develop

```sh
pnpm --filter @lingjing/provider-anthropic typecheck
pnpm --filter @lingjing/provider-anthropic test
pnpm --filter @lingjing/provider-anthropic build
```
