# @lingjing-agent/core

Runtime-agnostic, provider-agnostic TypeScript agent core: agentic loop, tools,
streaming events, context management — bring your own LLM provider.

**Zero runtime dependencies.** No SDK, no `openai`/`@anthropic-ai/sdk`, no
Node-only APIs — runs unchanged in Node 18+, browsers, Edge, and runtimes
without a global `fetch` (e.g. WeChat mini-programs, via an injectable
`HttpTransport`).

## Features

- **Agentic loop** — multi-turn tool calling with a hard `maxTurns` cap that
  guarantees termination. Provider errors are classified (`status`,
  `retryable`, `retryAfterMs`, machine `code`) and retried with backoff by the
  loop, not by adapters. With tiered models configured, availability failures
  (529/overloaded, 5xx, model gone — never 429) additionally step down the
  tier chain (max→main→fast) for the current turn only.
- **Streaming events** — one typed event stream per run: `message_start`,
  `text_delta`, `thinking_delta`, `tool_call_delta`, `tool_result`, `turn_end`,
  … Turn-level buffering keeps delta replay safe across retries.
- **Tools** — declare with JSON Schema or zod (optional peer; a built-in
  `zodToJsonSchema` converter, no zod import needed at runtime). Timeouts,
  parallel calls, and a permission gate for approval flows.
- **Permission rules** — `createPermissionRules({ rules, onAsk,
  fingerprintOf, persist })` is the ready-made gate: static allow/deny rules
  matched by tool name / permission tag / input predicate (deny always wins,
  order independent; `rules: [{ effect: "allow" }]` is the wildcard
  auto-approve switch — turning confirmation off is a host decision), an ask
  handler for unmatched calls with "always allow/deny" memory keyed by a
  host-defined fingerprint (per tool by default, per path/command when
  `fingerprintOf` says so), and `persist: { load, save }` for cross-session
  durability (localStorage / IDB — best-effort both ways). Deny-by-default
  when nothing matches.
- **Structured output** — `agent.respond(input, { schema })` forces one
  extraction turn answered as a JSON object validated against a JSON Schema
  (the same draft-07 subset tools use). Provider-portable by design: it goes
  through a single forced `respond` tool on every adapter. One corrective
  retry on violations; history stays protocol-complete (failed attempts are
  never persisted).
- **Two channels: observe vs. intercept** — these are not interchangeable, and
  picking the right one is the main integration decision. Use **events** to
  watch (`StreamHandle.events` — serializable, one-way, post-hoc: UI, metrics,
  audit, forwarding over IPC/SSE); use **hooks** to change behavior
  (`beforeRequest` / `afterTurn` / `beforeToolCall` / `afterToolCall` —
  in-process, receives live objects, can return a decision).
  | you want to… | reach for |
  |---|---|
  | watch / log / render / export | `StreamHandle.events` |
  | guard, inject context, veto, rewrite tool input | `hooks.before*` |
  | ask a human before a tool runs | `permissionGate` + `permission_request` event |
  | redact secrets on the way out | `redact()` over the event stream at egress |
  Naming: `before*` intercepts, `after*` observes. Error isolation follows the
  same split — an intercept hook that throws fails **closed** (the guarded
  action never runs; run-scope failures surface as `error{code:"hook_error"}`,
  distinct from `provider_error`), an observe hook that throws fails **soft**
  (logged, run continues). `beforeRequest` gets a *snapshot* of the history —
  it can only append via `{inject}`, never rewrite or delete.
- **Memory** — `InMemoryStore` / `IDBStore`, and `ragInjectHook` for
  retrieval-augmented context injection through `beforeRequest`.
- **Passive long-term memory** — `createRecallStore({ store })` wraps any
  `MemoryStore` and gives it working `recall`: BM25 over latin + CJK
  (unigram/bigram) tokens, incremental indexing, zero dependencies, cross-runtime.
  Wire it as `config.memory` alongside `ragInjectHook` and relevant history from
  *other* conversations is retrieved into the prompt automatically — the model
  never sees a search tool. The visibility boundary is the host's: pass `scope`
  and out-of-scope conversations are never even loaded.
- **Context management** — `TrimContextManager` and `CompactContextManager`
  with a compaction ladder: microcompact first (stub old tool_results, drop old
  thinking — zero model calls), then incremental rolling summaries on the fast
  tier (a note's `coveredUntil` stamp means only new material gets
  re-summarized), original history append-only in the store. `context_compacted`
  events and `hooks.beforeRequest`'s `ctx.compacted` keep hosts informed (plan
  re-injection etc.).
- **Tiered models** — `models: { fast, main, max? }` + a per-turn `modelFor`
  policy hook and a per-send `model` override (the UI model picker); fallbacks
  are never silent (`model_fallback` events name the model that took over).
- **Subagents (spawn pattern)** — `createSpawnTool` turns a registry of
  definitions into a `spawn_agent` tool: each run gets a fresh isolated
  conversation, a restricted toolset, and only its final report flows back to
  the parent (context isolation, not role play). Parallel calls share one
  concurrency semaphore; nesting depth is capped; child events forward to the
  host tagged with `agent`/`runId`/`depth`; usage rides the tool result.
- **Run resume** — `agent.resume({ conversationId })` re-drives a run that was
  cut off by a crash, reload, or dropped connection, with no new user input.
  Host-controlled by contract (core never auto-resumes; `inspectRunTail` is a
  pure function so the UI can offer "continue?" first). It repairs the history
  as it goes — dangling tool rounds get honest synthetic results, partial
  replies are prefilled and continued. `persistRuns: true` makes each message
  durable as it is produced, so a killed process loses nothing.
- **Redaction** — `redact`/`redactEvents` scrub secrets from messages and event
  streams before logging.

## Install

```sh
pnpm add @lingjing-agent/core
```

## Usage

```ts
import { createAgent, defineTool } from "@lingjing-agent/core";
import { OpenAIProvider } from "@lingjing-agent/provider-openai";

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

### Tiered models (fast / main / max)

```ts
const agent = createAgent({
  provider,
  models: { main: "glm-4.7", fast: "glm-4-flash", max: "glm-5" },
  // Optional per-turn policy hook — the host decides, core never guesses:
  modelFor: ({ turn, messages, defaultModel }) =>
    messages.length > 40 ? "glm-5" : defaultModel,
});

// One-off override for a single run (a UI model picker); suppresses modelFor:
agent.stream("go", { conversationId, model: "glm-4.7" });
```

Setting `models` enables: availability fallback (529/`overloaded`/
`model_not_found`/5xx step down max→main→fast for the current turn only —
never 429, never mid-stream; next turn retries the primary), fast-tier
auto-compact summarization (unless you pass your own `context`), and
`model_fallback` events so the UI can surface every switch.

### Subagents (spawn pattern)

```ts
import { createSpawnTool } from "@lingjing-agent/core";

const spawn = createSpawnTool(
  [
    {
      name: "researcher",
      description: "parallel research across several sources — use for multi-source lookup", // routing surface
      system: "You research exhaustively and report conclusions with citations.",
      tools: [webRead],       // the whitelist IS the guardrail (no permission gate inside)
      model: "glm-4-flash",  // optional per-subagent model (fast tier saves tokens)
    },
  ],
  {
    provider, model: "glm-4.7",   // default model (or `models` for tier pass-through)
    maxDepth: 1,        // subagents don't spawn further subagents (default)
    maxConcurrent: 3,   // shared cap across all nesting levels — set low on 小程序
    onEvent: (e, { agent, runId, depth }) => ui.emit(`sub:${runId}`, e), // progress
  },
);

const agent = createAgent({ provider, model: "glm-4.7", tools: [spawn, /* … */] });
```

The model routes by the descriptions embedded in the `spawn_agent` tool
description. A subagent sees **only the task text** (no parent history) and
returns its final report as the tool result, footed with its token usage —
the parent conversation never absorbs the child's tool-call noise. Subagent
conversations are ephemeral (in-memory, fresh id per run): they never touch
the host's memory store. Stopping the parent run aborts the subagent with it.

### Run resume (crash recovery)

Sessions are recoverable; **runs are not auto-resumed** — core never
continues a run on its own. A page reload, a killed process, or a dropped
connection leaves the last run unfinished *without the user asking to stop*;
that is the case `resume()` targets. An `abort()` is the other axis: the user
asked to stop, the partial reply is kept, and continuing is their call — the
host that called `abort()` is the one that knows, so it decides.

```ts
const store = new IDBStore();
const agent = createAgent({ /* … */ memory: store, persistRuns: true });

// Host decides WHEN — reload recovery, a "Continue the interrupted reply?"
// button, or never. inspectRunTail() is pure, so you can ask first (feed it
// the view the loop would send, not the raw store):
const tail = inspectRunTail(materializeCompactedView(await store.load(conversationId)));
const offerResume = tail.kind !== "at-rest"; // show the button only if it means something

// Same events / abort / done shape as send(), and the same conversation queue:
await agent.conversation(conversationId).resume().done;
```

It repairs as it goes, driven purely by the shape of the persisted tail:

| tail | what resume does |
| --- | --- |
| `at-rest` | nothing to do — emits `error{code:"nothing_to_resume", recoverable:true}` then a normal `done` |
| `continue` (user message) | drives the next turn |
| `answer-tools` (assistant turn whose tool results were lost) | answers every dangling call with an honest `isError` tool_result — *"may or may not have run; verify before re-calling"* — persisted before re-driving. Never blind re-execution |
| `continue-partial` (aborted / `max_tokens` / `pause_turn` reply) | re-sends the request ending on that partial so the model continues from it |

The classifier reads shape only, so a partial you *aborted yourself* looks the
same as one a crash left behind — both mean "there is an unfinished reply
here". Whether to offer it is yours: gate the UI on your own abort
(`tail.kind !== "at-rest" && !userJustStopped`), or filter precisely on the
partial's `metadata.stopReason === "aborted"`.

The synthetic carrier is also what keeps the history protocol-complete — a
dangling `tool_use` followed by a new request is a hard 400 on both provider
families.

`persistRuns: true` is the crash-safety half: by default persistence is one
batch append at run end, so a killed process stores nothing from that run;
with it, each message (input, every assistant turn, tool-result carriers)
becomes durable as it is produced, so resume starts from the true cut-off
point rather than the previous run's tail. Without it resume still works,
just coarser.

## API

- `createAgent(config)` — `config: { provider, model? | models? ({ fast?, main,
  max? } — exactly one of `model` / `models.main`, or equal both), modelFor?,
  system?, tools?, maxTurns?, maxTokens?, effort?, thinking?, temperature?,
  topP?, stopSequences?, retry?, context?, contextTokenBudget?, memory?,
  persistRuns?, hooks?, permissionGate?, toolTimeoutMs?, providerOptions?,
  allowedToolTags?, logger? }`.
- `Agent` — `.stream(input, { conversationId, signal?, model? })` /
  `.run(input, opts)`; streaming runs expose `.events`, `.abort()`, `.done`.
  `model` overrides the default for that run only and suppresses `modelFor`.
  Concurrent sends on the SAME conversation are serialized (queued): the next
  run waits for the previous one — including its persistence flush — to settle,
  so its loaded base always contains everything the previous run produced
  (aborted partials included). Sends on different conversations run in
  parallel.
  `.respond(input, { conversationId, schema })` returns a schema-validated
  JSON answer (generic: `respond<T>(...)`). Tools are not available during a
  respond call — compose `run()` first when the model needs to research.
  `.compact(conversationId)` manually folds early history into a summary note
  (the /compact escape hatch; originals stay in the store).
  `.resume({ conversationId })` / `conversation(id).resume()` re-drives a run
  that was cut off, taking no new input (see Run resume); it rides the same
  conversation queue, so a `send` that is still settling always wins.
- `inspectRunTail(messages)` — pure tail classification
  (`at-rest` / `continue` / `answer-tools` / `continue-partial`); call it on
  `materializeCompactedView(await store.load(id))` to decide whether to offer
  resume. `interruptedToolCarrier(assistant, calls, now)` builds the honest
  synthetic tool_result carrier for a dangling round (exported for hosts that
  persist history themselves).
- `createPermissionRules(opts)` — the standard permission gate (see Features);
  `remember()`/`snapshot()`/`forgetAll()` manage standing decisions, and the
  gate's `request` receives the tool's `permissions.tags` for tag-based
  rules.
- `defineTool({ name, description, inputSchema, execute })` — JSON Schema or
  zod input; `execute(input, ctx)` with an abort `signal`.
- `createSpawnTool(defs, opts)` — defs: `{ name, description, system, tools,
  model?, maxTurns? }[]`; opts: `{ provider, model? | models?, maxDepth? (1),
  maxConcurrent? (3), timeoutMs? (600s), onEvent?, hooks? }`. Returns the
  `spawn_agent` tool. Parallel spawn calls in one turn run concurrently through
  the shared semaphore; `maxDepth` > 1 injects a depth-capped spawn tool into
  subagents themselves.
  `hooks?: Pick<Hooks, "beforeRequest">` guards **each child run** and is
  deliberately typed to that one hook: subagents have their own tool allowlist,
  so inheriting a parent's `beforeToolCall` veto rules would misfire, and
  `afterTurn`/`afterToolCall` observations already arrive through `onEvent`.
  **Nothing is inherited** — a guard configured only on `AgentConfig.hooks` does
  not reach subagents; declare it here as well. This matters because subagents
  run headless with no permission gate, so the tool allowlist plus these hooks
  are the whole guard rail.
- `HookError` / `HookAbortError` — `HookError.hook` names the hook that threw
  and `.cause` keeps the original error, so a broken guardrail (run-scope
  `error{code:"hook_error"}`) is distinguishable from a provider outage.
- `createRecallStore({ store, scope?, topK?, minScoreRatio?, maxPerConversation?,
  maxDocChars?, snippetChars? })` — decorates a `MemoryStore` with lexical
  recall, so `ragInjectHook` works against any backend (InMemoryStore, IDBStore,
  your Redis/wx bridge). Reads and writes both go through the wrapper — pass the
  wrapper as `memory`, not the raw store. `scope()` is the visibility boundary
  (defaults to everything `list()` reports; multi-tenant hosts must set it).
  Indexing is lazy, incremental on `append`, and reconciled against `list()` on
  every recall (deleted conversations drop out); the index is in-process and not
  persisted. On a store without `list()` it degrades to indexing what it has
  seen appended. Returned snippets carry `source` (conversation id) and
  `messageId`, and honour `opts.exclude` / `opts.signal`.
- `ragInjectHook({ store, topK?, queryFrom?, render?, excludeCurrentConversation? })`
  — the `beforeRequest` hook that turns recall into context. Fires once per user
  turn (not on every turn of a tool loop — injection is persisted and hooks
  cannot remove messages), excludes the current conversation by default, frames
  the block as quoted reference material, and tags it `metadata.recallInjected`
  (exported as `isRecallInjected`; `markRecallInjected` for custom `render`s).
  A failing or aborted recall degrades to no injection rather than killing the run.
- Providers implement `LLMProvider` (`stream`, `complete`, `countTokens`);
  see [`@lingjing-agent/provider-openai`](../provider-openai) for a reference adapter
  that speaks the OpenAI Chat Completions protocol (works with DeepSeek, 豆包,
  通义, Kimi, 智谱, Ollama, vLLM, gateways, …).
- `createTitleGenerator({ provider, model, … })` — optional utility: one-shot
  fast-tier title call with built-in normalization (first line, quote
  stripping, length cap, language follows the user's). Never throws — resolves
  `null` on failure so hosts can fire-and-forget with a fallback title.
- `fetchTransport(fetch?)` — default HTTP transport; inject a custom
  `HttpTransport` where no global `fetch` exists.

## Design

See [DESIGN.md](../../DESIGN.md) for the architecture: neutral message/content
types, one event stream, providers as pure protocol adapters, loop-owned
retry/overflow handling.
