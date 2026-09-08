# @lingjing-agent/provider-openai

OpenAI Chat Completions adapter for [`@lingjing-agent/core`](../core).

**Speaks the OpenAI Chat Completions protocol — not just OpenAI's own API.** Set
`baseURL` to ANY compatible endpoint: OpenAI (`api.openai.com/v1`), DeepSeek
(`api.deepseek.com/v1`), 豆包/火山 (`ark.cn-beijing.volces.com/api/v3`), 通义
DashScope compatible-mode, Kimi/Moonshot, 智谱 GLM, Ollama (`localhost:11434/v1`),
vLLM, OneAPI/OpenRouter gateways, … The protocol is the de-facto standard; only
the URL / API key / model name differ.

**SDK-free.** This adapter talks to the REST API over the global `fetch` — no
`openai` dependency — so it runs unchanged in Node 18+, browsers, and Edge
runtimes (matching core's runtime-agnostic philosophy). Retry/backoff is owned by
core's loop, not duplicated here.

## Install

```sh
pnpm add @lingjing-agent/core @lingjing-agent/provider-openai
```

## Usage

```ts
import { createAgent } from "@lingjing-agent/core";
import { OpenAIProvider } from "@lingjing-agent/provider-openai";

const agent = createAgent({
  provider: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }),
  model: "gpt-4o",
  maxTurns: 10,
});

for await (const event of agent.stream("List the files in the current dir and summarize.").events) {
  // message_start, text_delta, tool_call_*, message_end, turn_end, ...
}
```

A custom `fetch` (Tauri proxy, Edge, tests) and `baseURL` (proxies/gateways) are
supported:

```ts
new OpenAIProvider({ apiKey, baseURL: "https://gateway.example/v1", fetch: myFetch });
```

## API

- `OpenAIProvider(opts)` — `opts: { apiKey?, baseURL?, fetch?, headers? }`.
  - `apiKey` is sent as `Authorization: Bearer <key>`. Omit to rely on a proxy.
  - Implements core's `LLMProvider`: `stream`, `complete` (non-streaming), and a
    char/4 `countTokens` heuristic for budget checks.
- Exports the pure mapping helpers for direct testing: `mapRequest`, `mapStream`,
  `mapStop`, `mapUsage`, `parseSSE`, `parseRetryAfter`, `enrichError`,
  `isRetryableStatus`.

## Mapping notes

| OpenAI field        | Core field            |
| ------------------- | --------------------- |
| `finish_reason`     | `StopReason`          |
| `stop`              | `stop_sequence`       |
| `length`            | `max_tokens`          |
| `tool_calls`        | `tool_use`            |
| `content_filter`    | `refusal`             |
| `null` / unknown    | `end_turn`            |
| index-keyed `tool_calls[].function.arguments` | id-keyed `tool_call_delta.inputJsonDelta` (concatenated per index) |
| multi-`tool_result` user message               | multiple `{role:"tool", tool_call_id}` messages |
| o-series `reasoning_effort`                    | `config.effort` (omitted for non-o-series; `xhigh`/`max` clamp to `high`, `thinking:{type:"disabled"}` → `"none"`) |
| `delta.reasoning_content` / `delta.reasoning`  | `thinking_delta` chunks + one `thinking_end` (DeepSeek R1 / Kimi / GLM / Qwen / 豆包 use `reasoning_content`; OpenRouter uses `reasoning`) |
| `delta.refusal` / `message.refusal`            | surfaced as text (with `content_filter` → stopReason `refusal`) |
| `prompt_tokens_details.cached_tokens`          | `usage.cacheReadTokens` |
| `completion_tokens_details.reasoning_tokens`   | `usage.reasoningTokens` |
| `providerOptions.body` (host-supplied, merged last) | any endpoint-specific request param — GLM `thinking`, Qwen `enable_thinking`, gpt-5 `verbosity`, `response_format`, … |

**Thinking replay:** reasoning blocks map to core `thinking` blocks for display/persistence, but are DROPPED on the way back into requests — compatible endpoints treat `reasoning_content` as display-only (DeepSeek returns 400 if it is replayed).

**`stop` → `stop_sequence`:** OpenAI's `"stop"` fires for both natural completion
and an explicit stop-sequence hit (the wire format does not distinguish them).
DESIGN mandates `stop → stop_sequence`; in core's loop, `stop_sequence` and
`end_turn` are treated identically (both terminal → done), so behavior is
unchanged — only the surfaced stopReason differs.

**Overflow:** OpenAI signals an over-length conversation with an HTTP 400
(`context_length_exceeded`) error, **not** a stop reason. Accordingly,
`capabilities.stopReasons` omits `pause_turn`/`context_window_exceeded`. Core's
overflow path is reached when this adapter throws a non-retryable `ProviderError`
(status 400); it does not drive the same `compact()`-and-retry cycle the
Anthropic adapter's `context_window_exceeded` stop reason does.

**`message_end`:** OpenAI only emits usage in a final chunk (empty `choices`) when
`stream_options.include_usage` is set. We emit `message_delta` at `finish_reason`
and defer `message_end` until that usage chunk — emitting exactly one per turn,
with a zeroed-usage fallback if usage never arrives.

## Error handling

HTTP/network errors are re-thrown as core `ProviderError` carrying `status`,
`retryable` (408/409/429/5xx and network errors), and `retryAfterMs` (parsed
from a `retry-after` header). Core's loop honors these for backoff. A caller
abort (`AbortSignal`) is propagated as-is and never masked as retryable.
