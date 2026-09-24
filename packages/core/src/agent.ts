// Public Agent API: createAgent(), stream/run, tool registry, conversations.

import type { ContextManager } from "./context.js";
import { CompactContextManager, materializeCompactedView } from "./context.js";
import type { Hooks } from "./hooks.js";
import { runLoop } from "./loop.js";
import type { ModelForHook, ModelTiers } from "./models.js";
import { contextWindowFor } from "./models.js";
import { InMemoryStore, type MemoryStore } from "./memory.js";
import type { AgentConfirmMode, PermissionGate } from "./permission.js";
import type {
  LLMProvider,
  ProviderConfig,
  StopReason,
} from "./provider.js";
import { runStructured } from "./structured.js";
import { inspectRunTail, interruptedToolCarrier } from "./resume.js";
import type { Tool, ToolCallContext } from "./tool.js";
import type { Message, TextContent } from "./types.js";
import { extractText, randomId, userMessage, withRunId, withTurnMeta } from "./types.js";
import { AbortError, anySignal } from "./abort.js";
import type { AgentEvent } from "./events.js";
import { DEFAULT_CONTEXT_TOKEN_BUDGET, estimateMessagesTokens } from "./tokens.js";

// Re-exported for hosts (the constant lives with the estimator in tokens.ts).
export { DEFAULT_CONTEXT_TOKEN_BUDGET };

export interface AgentConfig {
  provider: LLMProvider;
  /** Default model. Exactly one of `model` / `models.main` is required; setting
   *  both is only valid when equal (`model` is then an alias of `models.main`). */
  model?: string;
  /** Three-tier model config (fast/main/max). Setting it enables per-turn tier
   *  fallback (max→main→fast on 529/overloaded/model_not_found/5xx, never on
   *  429) and — when no `context` manager is passed — auto-wires a
   *  CompactContextManager that summarizes on `models.fast ?? models.main`.
   *  `models.contextWindow` (per tier) resolves the token budget when
   *  `contextTokenBudget` is unset. */
  models?: ModelTiers;
  /** Host policy hook: pick the model per turn (defaults to the configured
   *  main). Suppressed for runs that pass a per-send `model` override. */
  modelFor?: ModelForHook;
  system?: string | TextContent[];
  tools?: Tool[];
  maxTokens?: number; // default 16000
  maxTurns?: number; // default 25 — hard cap guarantees termination
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  thinking?: { type: "adaptive" | "disabled"; display?: "summarized" | "omitted" };
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  toolTimeoutMs?: number; // default 30000
  toolChoice?: ProviderConfig["toolChoice"];
  context?: ContextManager;
  /** Token budget passed to context.fit/compact (total context tokens: the
   *  loop anchors on provider-reported real usage and estimates only the
   *  increment, CJK-aware). Unset → per-turn `models.contextWindow` for the
   *  turn's model → DEFAULT_CONTEXT_TOKEN_BUDGET (1M). */
  contextTokenBudget?: number;
  /** Max pause_turn continuations before terminating. Default 5. */
  maxContinuations?: number;
  /** Max consecutive max_tokens turns (no progress) before terminating. Default 3. */
  maxStalledTurns?: number;
  memory?: MemoryStore;
  hooks?: Hooks;
  permissionGate?: PermissionGate;
  /** Agent-level confirmation override of the tools' own declarations
   *  (AgentConfirmMode). "tool" (default) — each tool's requiresConfirmation
   *  decides and the gate is only consulted for declaring tools; "never" —
   *  every tool skips the gate, declared or not (the host takes full
   *  responsibility; the deny-by-default is intentionally overridden);
   *  "always" — every tool passes the gate, read-class included. A call that
   *  needs confirmation with no permissionGate configured is refused in
   *  every mode. */
  confirm?: AgentConfirmMode;
  retry?: { maxRetries: number; baseDelayMs: number; maxDelayMs: number };
  providerOptions?: Record<string, unknown>;
  /** Tool tag allowlist; tools whose permissions.tags aren't included are refused at registration. */
  allowedToolTags?: string[];
  /** Diagnostic sink handed to every tool as ctx.log (hook warnings, tool-side
   *  breadcrumbs). Default: silent. */
  logger?: ToolCallContext["log"];
  /** Crash-safe incremental persistence: every message the run appends
   *  (assistant turns, tool-result carriers, hook injects, compaction notes)
   *  is durably stored BEFORE the run proceeds, instead of the default
   *  run-end batch append. Turn on when hosts want agent.resume() to
   *  re-drive a killed run from fine-grained state. Costs more, smaller
   *  store writes during the run. Default false (batch semantics). */
  persistRuns?: boolean;
}

export interface StreamHandle {
  events: AsyncIterable<AgentEvent>;
  abort: () => void;
  done: Promise<Message>;
}

export interface RespondOptions {
  /** JSON Schema (draft-07 subset, same as tool inputs). Root must be
   *  `{ type: "object", ... }` — a structured answer is one JSON object. */
  schema: object;
  /** Abort the extraction call. */
  signal?: AbortSignal;
  /** Model override for THIS call only (same semantics as send's). */
  model?: string;
}

export interface ConversationHandle {
  readonly id: string;
  /** `model` overrides the configured default for THIS run only (the UI model
   *  picker); it also suppresses the `modelFor` hook for the run. Tier
   *  fallback still applies if the override sits in the tier table. */
  send(input: string | Message[], opts?: { signal?: AbortSignal; model?: string }): StreamHandle;
  /** One-shot structured answer over the conversation so far (see
   *  Agent.respond) — same persistence and queueing semantics as send. */
  respond<T = unknown>(input: string | Message[], opts: RespondOptions): Promise<T>;
  /** Run-level resume of this conversation (see Agent.resume). */
  resume(opts?: { signal?: AbortSignal; model?: string }): StreamHandle;
  /** Manually compact this conversation's stored history (see Agent.compact). */
  compact(opts?: { signal?: AbortSignal }): Promise<{ tokensSaved?: number } | null>;
}

export interface Agent {
  stream(input: string | Message[], opts: { conversationId: string; signal?: AbortSignal; model?: string }): StreamHandle;
  run(input: string | Message[], opts: { conversationId: string; signal?: AbortSignal; model?: string }): Promise<Message>;
  /** Structured output: one forced-tool extraction turn that must answer with
   *  a JSON object validated against `opts.schema`. Appends the input, the
   *  assistant turn, and a synthetic tool_result carrier to the conversation
   *  (protocol-complete history; usage stamped like any turn). Tools are NOT
   *  available during the call — compose run()/send() first when the model
   *  needs to research; respond sees the full persisted history. One
   *  corrective retry on schema violations; past that it rejects with
   *  StructuredOutputError (the failed attempt is never persisted).
   *  Serialized on the conversation queue like send. */
  respond<T = unknown>(input: string | Message[], opts: RespondOptions & { conversationId: string }): Promise<T>;
  /** Run-level resume: re-drive the conversation's last run that was cut off
   *  (process death / reload / disconnect) WITHOUT new user input. What
   *  happens depends on the persisted tail (see inspectRunTail): a dangling
   *  tool round gets honest synthetic "may or may not have run" results
   *  (protocol repair, never blind re-execution), a partial reply is re-sent
   *  as prefill and continued, an unanswered input simply drives the next
   *  turn. A cleanly finished conversation errors with code
   *  `nothing_to_resume` (recoverable) and the stream terminates normally.
   *  HOST-CONTROLLED by contract — core never auto-resumes; hosts inspect
   *  (inspectRunTail) and decide when. Serialized on the conversation queue
   *  like send. Works best with AgentConfig.persistRuns (per-message durable
   *  appends); without it, resume starts from whatever last persisted. */
  resume(opts: { conversationId: string; signal?: AbortSignal; model?: string }): StreamHandle;
  /** Manually compact a conversation's stored history (the /compact escape
   *  hatch): run the configured ContextManager's compact() over the loaded
   *  history and persist any new messages it created (the summary note) —
   *  append-only, originals stay. The next run's fit picks the note up
   *  incrementally, so this effectively pre-seeds compaction before the soft
   *  trigger. Returns null when no context manager is configured, the store
   *  is empty, or compaction produced nothing; `{ tokensSaved? }` otherwise. */
  compact(conversationId: string, opts?: { signal?: AbortSignal }): Promise<{ tokensSaved?: number } | null>;
  registerTool(tool: Tool): void;
  unregisterTool(name: string): void;
  listTools(): readonly Tool[];
  conversation(id: string): ConversationHandle;
}

export function createAgent(config: AgentConfig): Agent {
  if (!config.provider) throw new Error("AgentConfig.provider is required");

  // Model config: exactly one of `model` / `models.main` must name the default;
  // setting both is only valid when they're equal (alias, e.g. migrating hosts).
  const models = config.models;
  if (models !== undefined && (typeof models.main !== "string" || models.main === "")) {
    throw new Error("AgentConfig.models.main is required when `models` is set");
  }
  const hasModel = typeof config.model === "string" && config.model !== "";
  if (!hasModel && models === undefined) {
    throw new Error("AgentConfig requires a model: set `model` or `models.main`");
  }
  if (hasModel && models !== undefined && models.main !== config.model) {
    throw new Error(
      `AgentConfig.model ("${config.model}") and AgentConfig.models.main ("${models.main}") conflict — set one, or make them equal`,
    );
  }
  const defaultModel = models !== undefined ? models.main : config.model!;

  const maxTurns = config.maxTurns ?? 25;
  if (maxTurns < 1) throw new Error(`AgentConfig.maxTurns must be >= 1 (got ${maxTurns})`);
  const maxTokens = config.maxTokens ?? 16000;
  const toolTimeoutMs = config.toolTimeoutMs ?? 30000;
  // Undefined unless the host pinned it — the loop then resolves per turn:
  // models.contextWindow for the turn's model, else the global default.
  const contextTokenBudget = config.contextTokenBudget;
  const maxContinuations = config.maxContinuations ?? 5;
  const maxStalledTurns = config.maxStalledTurns ?? 3;
  const retry = config.retry ?? { maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 30000 };

  // Role routing: with tiers configured and no explicit context manager, wire
  // auto-compact summarization onto the fast tier (falling back to main when
  // no fast tier is set). Hosts passing their own `context` keep full control;
  // hosts on plain `model` keep today's no-context-management behavior.
  const context: ContextManager | undefined =
    config.context !== undefined
      ? config.context
      : models !== undefined
        ? new CompactContextManager({ provider: config.provider, model: models.fast ?? models.main })
        : undefined;
  const now = () => Date.now();

  const tools: Tool[] = [];
  const allowedTags = config.allowedToolTags ? new Set(config.allowedToolTags) : undefined;
  for (const t of config.tools ?? []) register(t);

  function register(tool: Tool): void {
    if (tools.some((t) => t.name === tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    if (allowedTags && tool.permissions?.tags) {
      for (const tag of tool.permissions.tags) {
        if (!allowedTags.has(tag)) {
          throw new Error(`Tool '${tool.name}' tag '${tag}' not in allowedToolTags`);
        }
      }
    }
    tools.push(tool);
  }

  function buildProviderConfig(): ProviderConfig {
    const cfg: ProviderConfig = { maxTokens };
    if (config.temperature !== undefined) cfg.temperature = config.temperature;
    if (config.topP !== undefined) cfg.topP = config.topP;
    if (config.stopSequences !== undefined) cfg.stopSequences = config.stopSequences;
    if (config.thinking !== undefined) cfg.thinking = config.thinking;
    if (config.effort !== undefined) cfg.effort = config.effort;
    if (config.toolChoice !== undefined) cfg.toolChoice = config.toolChoice;
    if (config.providerOptions !== undefined) cfg.providerOptions = config.providerOptions;
    return cfg;
  }

  // Memory store: defaults to an in-process InMemoryStore; pass your own
  // (redis / postgres / wx storage) for cross-process persistence. core always
  // goes through load/append — no special-casing for "no memory configured".
  const memory: MemoryStore = config.memory ?? new InMemoryStore();

  // Per-conversation run serialization (queue). A second send on the SAME
  // conversation waits for the previous run — including its persistence
  // flush — to settle before loading history. Without this, two concurrent
  // runs load the same base (each blind to the other) and the store ends up
  // with two parallel branches flattened into one list; the tightest window
  // is abort → immediate resend, where the resend's load can beat the aborted
  // run's flush and miss its salvaged partial. Sends on DIFFERENT
  // conversations stay fully parallel. The queue lives per agent instance:
  // hosts sharing one memory store across agent instances must serialize
  // those themselves.
  const convoTails = new Map<string, Promise<unknown>>();
  function enqueueConversation<T>(conversationId: string, body: () => Promise<T>): Promise<T> {
    const prev = convoTails.get(conversationId) ?? Promise.resolve();
    // Previous outcome is irrelevant — the next run starts either way.
    const run = prev.then(body, body);
    // Never-rejecting tail for the NEXT send to chain on; self-removes once
    // idle so a long-lived agent doesn't accumulate map entries. Identity
    // check: a newer send may have enqueued while this one was settling.
    const tail = run.then(
      () => { if (convoTails.get(conversationId) === tail) convoTails.delete(conversationId); },
      () => { if (convoTails.get(conversationId) === tail) convoTails.delete(conversationId); },
    );
    convoTails.set(conversationId, tail);
    return run;
  }

  /** Manual compaction (Agent.compact): run the resolved context manager's
   *  compact() over the stored history and persist new messages (the note).
   *  Uses the same token estimate and budget as the loop's fit, so a manual
   *  note lines up with what the next automatic fit expects. Serialized on
   *  the conversation's queue: a /compact issued mid-run waits for the run
   *  to finish, then compacts everything it produced. */
  async function compactStored(
    conversationId: string,
    opts: { signal?: AbortSignal } | undefined,
  ): Promise<{ tokensSaved?: number } | null> {
    if (!context) return null;
    return enqueueConversation(conversationId, async () => {
      if (opts?.signal?.aborted) return null; // queued past the caller's patience
      const history = [...(await memory.load(conversationId))];
      if (history.length === 0) return null;
      const r = await context.compact({
        messages: history,
        tools: [...tools],
        system: config.system, // required-but-undefined-able: direct assign, no conditional spread
        tokenBudget:
          contextTokenBudget ?? contextWindowFor(defaultModel, models) ?? DEFAULT_CONTEXT_TOKEN_BUDGET,
        countTokens: (msgs) =>
          config.provider.countTokens?.(msgs, defaultModel) ?? Promise.resolve(estimateMessagesTokens(msgs)),
        signal: opts?.signal ?? new AbortController().signal,
      });
      if (!r.compacted) return null;
      const known = new Set(history.map((m) => m.id));
      const fresh = r.messages.filter((m) => !known.has(m.id));
      if (fresh.length > 0) await memory.append(conversationId, fresh);
      return { ...(r.tokensSaved !== undefined ? { tokensSaved: r.tokensSaved } : {}) };
    });
  }

  /** Structured respond (Agent.respond / ConversationHandle.respond): one
   *  forced-tool extraction turn, serialized on the conversation queue. On
   *  success persists [input, assistant(respond), carrier(tool_result)] —
   *  protocol-complete. On failure only the input persists: a dangling
   *  respond tool_use without its tool_result must never enter history (it
   *  would 400 the next request on strict APIs). */
  function respondInto<T>(
    conversationId: string,
    input: string | Message[],
    opts: RespondOptions,
  ): Promise<T> {
    return enqueueConversation(conversationId, async () => {
      const runId = randomId();
      const loaded: Message[] = [...(await memory.load(conversationId))];
      const loadedIds = new Set(loaded.map((m) => m.id));
      const history = materializeCompactedView(loaded);
      // Crash-safe parity with send() (persistRuns): the input becomes durable
      // BEFORE the extraction request — a kill mid-respond loses nothing that
      // an identical kill during send() would not. Same dual filter as
      // streamInto's fresh() keeps the run-end appends from double-writing.
      const persistedIds = new Set<string>();
      const persist =
        config.persistRuns === true
          ? async (msgs: Message[]): Promise<void> => {
              await memory.append(conversationId, msgs);
              for (const m of msgs) persistedIds.add(m.id);
            }
          : undefined;
      if (typeof input === "string") {
        history.push(withRunId(userMessage(input, now), runId));
      } else {
        history.push(...input.map((m) => withRunId(m, runId)));
      }
      try {
        if (persist) await persist(history.filter((m) => !loadedIds.has(m.id)));
        const r = await runStructured({
          provider: config.provider,
          model: opts.model ?? defaultModel,
          ...(models !== undefined ? { models } : {}),
          messages: history,
          schema: opts.schema,
          config: buildProviderConfig(),
          retry,
          signal: opts.signal ?? new AbortController().signal,
          conversationId,
          now,
          // Same guard the run loop gets: respond() sees the same history, so
          // a host's beforeRequest must apply here too (see structured.ts).
          ...(config.hooks ? { hooks: config.hooks } : {}),
          runId,
        });
        const assistant = withRunId(withTurnMeta(r.message, r.usage, "tool_use"), runId);
        const carrier = withRunId(r.carrier, runId);
        history.push(assistant, carrier);
        await memory.append(conversationId, history.filter((m) => !loadedIds.has(m.id) && !persistedIds.has(m.id)));
        return r.data as T;
      } catch (err) {
        // Keep what the user really said (Claude parity with send's abort
        // path); the failed extraction attempt itself is never persisted.
        try {
          const newMsgs = history.filter((m) => !loadedIds.has(m.id) && !persistedIds.has(m.id));
          if (newMsgs.length > 0) await memory.append(conversationId, newMsgs);
        } catch {
          /* keep the original failure */
        }
        throw err instanceof Error ? err : new Error(String(err));
      }
    });
  }

  function streamInto(conversationId: string, input: string | Message[], opts: { signal?: AbortSignal; model?: string } | undefined): StreamHandle {
    const queue = new AsyncQueue<AgentEvent>();
    const controller = new AbortController();
    if (opts?.signal) {
      const external = opts.signal;
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", () => controller.abort(), { once: true });
    }

    // Serialized on the conversation's queue (see enqueueConversation): the
    // load below runs only after any previous run — including its persistence
    // flush — has settled, so this run's base always contains everything the
    // previous run produced. Events stay empty and done pending while queued;
    // an abort while waiting behaves exactly like an abort before start (the
    // run persists its input, emits error, rejects done).
    const done: Promise<Message> = enqueueConversation(conversationId, async () => {
      // A failure BEFORE runLoop starts (store load, the durable persist of
      // the input) must still terminate the events stream — runLoop owns
      // error events once it runs; without this, an events-only consumer
      // hangs forever on a queue that never closes.
      const failBeforeLoop = (err: unknown): never => {
        queue.push({
          type: "error", conversationId, turn: 0, ts: now(),
          message: `Failed before the run started: ${err instanceof Error ? err.message : String(err)}`,
          code: "memory_error", recoverable: true,
        });
        queue.close();
        throw err instanceof Error ? err : new Error(String(err));
      };
      // Run id: groups everything this stream appends (input, assistant turns,
      // tool-result carriers, hook injects) into one exchange for groupExchanges().
      const runId = randomId();
      // Load history from the memory store (default InMemoryStore = in-process).
      // Copy so runLoop's in-place mutations don't leak into the store until append().
      let loaded: Message[];
      try {
        loaded = [...(await memory.load(conversationId))];
      } catch (err) {
        failBeforeLoop(err);
        throw err; // unreachable (failBeforeLoop throws) — closes definite-assignment analysis
      }
      // Track loaded message ids so append persists only what THIS stream added
      // (input + assistant turns + tool results) — robust against context.fit/compact
      // shortening history in place (a baseline array index would go stale after compaction).
      const loadedIds = new Set(loaded.map((m) => m.id));
      // MATERIALIZE persisted compaction before the first request: when the
      // newest summary note's coveredUntil resolves, drop the originals it
      // covers and lead with the note. Without this the run would re-send the
      // full un-compacted history once (the seeded anchor reflects the
      // compacted view, so fit under-triggers) before re-anchoring.
      const history: Message[] = materializeCompactedView(loaded);
      // Crash-safe incremental persistence (persistRuns): each message becomes
      // durable as the run appends it. persistedIds keeps the run-end batch
      // append from double-writing; a failed incremental append leaves the id
      // unrecorded so the batch append still covers it.
      const persistedIds = new Set<string>();
      const persist =
        config.persistRuns === true
          ? async (msgs: Message[]): Promise<void> => {
              await memory.append(conversationId, msgs);
              for (const m of msgs) persistedIds.add(m.id);
            }
          : undefined;
      const fresh = (): Message[] =>
        history.filter((m) => !loadedIds.has(m.id) && !persistedIds.has(m.id));
      if (typeof input === "string") {
        const m = withRunId(userMessage(input, now), runId);
        history.push(m);
        if (persist) {
          try {
            await persist([m]);
          } catch (err) {
            failBeforeLoop(err);
          }
        }
      } else {
        // Copy-on-write stamp: caller-owned Message objects are never mutated.
        const stamped = input.map((m) => withRunId(m, runId));
        history.push(...stamped);
        if (persist) {
          try {
            await persist(stamped);
          } catch (err) {
            failBeforeLoop(err);
          }
        }
      }

      try {
        const finalMsg = await runLoop({
          provider: config.provider,
          model: opts?.model ?? defaultModel,
          ...(models !== undefined ? { models } : {}),
          // A per-send override is a deliberate one-off and wins predictably:
          // the host-wide modelFor policy hook is not consulted for that run.
          ...(opts?.model === undefined && config.modelFor ? { modelFor: config.modelFor } : {}),
          tools: [...tools],
          messages: history,
          runId,
          config: buildProviderConfig(),
          maxTurns,
          toolTimeoutMs,
          ...(contextTokenBudget !== undefined ? { tokenBudget: contextTokenBudget } : {}),
          maxContinuations,
          maxStalledTurns,
          retry,
          signal: controller.signal,
          conversationId,
          now,
          emit: (e) => queue.push(e),
          // Persist what an in-run compaction drops or rewrites in place
          // (loadedIds at run start, persistedIds for anything the incremental
          // persistRuns path already made durable — same filter as fresh(), or
          // those messages are appended TWICE) — the append-only contract: the
          // store always keeps the verbatim originals, the note rides later.
          // Recording the id ONLY after a durable append matters for same-id
          // rewrites (microcompact stubs): fresh() then skips the stubbed
          // copy, so the store keeps the verbatim original; a failed append
          // leaves it unrecorded and the run-end batch still covers the id
          // (degraded: the stub, which is today's behavior).
          persistDropped: async (dropped) => {
            const notInStore = dropped.filter((m) => !loadedIds.has(m.id) && !persistedIds.has(m.id));
            if (notInStore.length === 0) return;
            await memory.append(conversationId, notInStore);
            for (const m of notInStore) persistedIds.add(m.id);
          },
          ...(persist ? { persist } : {}),
          ...(config.logger ? { logger: config.logger } : {}),
          ...(config.system !== undefined ? { system: config.system } : {}),
          ...(config.permissionGate ? { permissionGate: config.permissionGate } : {}),
          ...(config.confirm !== undefined ? { confirm: config.confirm } : {}),
          ...(config.hooks ? { hooks: config.hooks } : {}),
          ...(context ? { context } : {}),
        });
        const newMsgs = fresh();
        await memory.append(conversationId, newMsgs);
        queue.close();
        return finalMsg;
      } catch (err) {
        // Claude parity on interruption: a run that produced REAL content — the
        // input, completed turns (incl. tool results), and the loop's salvaged
        // partial reply — keeps it. Persist what this stream added before
        // rethrowing; best-effort, because a persistence failure here must not
        // mask the original error. (With persistRuns most of it is already
        // durable; this covers the tail and any failed incremental append.)
        try {
          const newMsgs = fresh();
          if (newMsgs.length > 0) await memory.append(conversationId, newMsgs);
        } catch {
          /* keep the original failure */
        }
        // runLoop already emitted an `error` event on the hard-failure path.
        queue.close();
        throw err instanceof Error ? err : new Error(String(err));
      }
    });

    return {
      events: queue,
      abort: () => controller.abort(),
      done,
    };
  }

  /** Run-level resume (Agent.resume): re-drive the last cut-off run — see
   *  resume.ts for the tail classification and repair semantics. Same queue,
   *  events, and persistence contracts as streamInto; no new user input. */
  function resumeInto(conversationId: string, opts: { signal?: AbortSignal; model?: string } | undefined): StreamHandle {
    const queue = new AsyncQueue<AgentEvent>();
    const controller = new AbortController();
    if (opts?.signal) {
      const external = opts.signal;
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const done: Promise<Message> = enqueueConversation(conversationId, async () => {
      const runId = randomId();
      // Same fail-before-loop contract as streamInto: a store failure here
      // must still close the events stream (see streamInto's comment).
      const failBeforeLoop = (err: unknown): never => {
        queue.push({
          type: "error", conversationId, turn: 0, ts: now(),
          message: `Failed before the run started: ${err instanceof Error ? err.message : String(err)}`,
          code: "memory_error", recoverable: true,
        });
        queue.close();
        throw err instanceof Error ? err : new Error(String(err));
      };
      let loaded: Message[];
      try {
        loaded = [...(await memory.load(conversationId))];
      } catch (err) {
        failBeforeLoop(err);
        throw err; // unreachable (failBeforeLoop throws) — closes definite-assignment analysis
      }
      const loadedIds = new Set(loaded.map((m) => m.id));
      const history: Message[] = materializeCompactedView(loaded);
      const tail = inspectRunTail(history);

      if (tail.kind === "at-rest") {
        // Nothing to continue — recoverable error + a normal done so the
        // host's stream UI terminates exactly like any other finished run.
        const last = history[history.length - 1];
        queue.push({
          type: "error", conversationId, turn: 0, ts: now(),
          message: "Nothing to resume: the last run finished cleanly",
          code: "nothing_to_resume", recoverable: true,
        });
        queue.push({
          type: "done", conversationId, turn: 0, ts: now(),
          finalText: last ? extractText(last) : "",
          totalUsage: { inputTokens: 0, outputTokens: 0 },
          turns: 0,
        });
        queue.close();
        return last ?? { id: randomId(), role: "assistant", content: "", createdAt: now() };
      }

      const persistedIds = new Set<string>();
      const persist =
        config.persistRuns === true
          ? async (msgs: Message[]): Promise<void> => {
              await memory.append(conversationId, msgs);
              for (const m of msgs) persistedIds.add(m.id);
            }
          : undefined;
      const fresh = (): Message[] =>
        history.filter((m) => !loadedIds.has(m.id) && !persistedIds.has(m.id));

      if (tail.kind === "answer-tools") {
        // Protocol repair BEFORE re-driving: answer the dangling tool_use
        // round with honest synthetic results ("may or may not have run —
        // verify before re-calling"), durably. Never blind re-execution.
        const carrier = interruptedToolCarrier(tail.message, tail.calls, now);
        history.push(carrier);
        try {
          await memory.append(conversationId, [carrier]);
        } catch (err) {
          failBeforeLoop(err);
        }
        persistedIds.add(carrier.id);
      }
      // "continue": tail is a user message — drive the next turn.
      // "continue-partial": tail is a non-terminal assistant — the request
      // ends with it and both provider families prefill-continue from there.

      try {
        const finalMsg = await runLoop({
          provider: config.provider,
          model: opts?.model ?? defaultModel,
          ...(models !== undefined ? { models } : {}),
          ...(opts?.model === undefined && config.modelFor ? { modelFor: config.modelFor } : {}),
          tools: [...tools],
          messages: history,
          runId,
          config: buildProviderConfig(),
          maxTurns,
          toolTimeoutMs,
          ...(contextTokenBudget !== undefined ? { tokenBudget: contextTokenBudget } : {}),
          maxContinuations,
          maxStalledTurns,
          retry,
          signal: controller.signal,
          conversationId,
          now,
          emit: (e) => queue.push(e),
          persistDropped: async (dropped) => {
            // Same contract as streamInto's — see its comment there.
            const notInStore = dropped.filter((m) => !loadedIds.has(m.id) && !persistedIds.has(m.id));
            if (notInStore.length === 0) return;
            await memory.append(conversationId, notInStore);
            for (const m of notInStore) persistedIds.add(m.id);
          },
          ...(persist ? { persist } : {}),
          ...(config.logger ? { logger: config.logger } : {}),
          ...(config.system !== undefined ? { system: config.system } : {}),
          ...(config.permissionGate ? { permissionGate: config.permissionGate } : {}),
          ...(config.confirm !== undefined ? { confirm: config.confirm } : {}),
          ...(config.hooks ? { hooks: config.hooks } : {}),
          ...(context ? { context } : {}),
        });
        const newMsgs = fresh();
        await memory.append(conversationId, newMsgs);
        queue.close();
        return finalMsg;
      } catch (err) {
        try {
          const newMsgs = fresh();
          if (newMsgs.length > 0) await memory.append(conversationId, newMsgs);
        } catch {
          /* keep the original failure */
        }
        queue.close();
        throw err instanceof Error ? err : new Error(String(err));
      }
    });

    return {
      events: queue,
      abort: () => controller.abort(),
      done,
    };
  }

  const agent: Agent = {
    stream(input, opts) {
      if (!opts?.conversationId) {
        throw new Error("agent.stream requires opts.conversationId — pass one (or use agent.conversation(id).send).");
      }
      return streamInto(opts.conversationId, input, opts);
    },

    async run(input, opts) {
      const handle = agent.stream(input, opts);
      for await (const _event of handle.events) {
        void _event;
      }
      return await handle.done;
    },

    async respond<T>(input: string | Message[], opts: RespondOptions & { conversationId: string }) {
      if (!opts?.conversationId) {
        throw new Error("agent.respond requires opts.conversationId — pass one (or use agent.conversation(id).respond).");
      }
      const { conversationId, ...rest } = opts;
      return await respondInto<T>(conversationId, input, rest);
    },

    resume(opts) {
      if (!opts?.conversationId) {
        throw new Error("agent.resume requires opts.conversationId — pass one (or use agent.conversation(id).resume).");
      }
      return resumeInto(opts.conversationId, opts);
    },

    compact: compactStored,

    registerTool(tool) {
      register(tool);
    },

    unregisterTool(name) {
      const idx = tools.findIndex((t) => t.name === name);
      if (idx >= 0) tools.splice(idx, 1);
    },

    listTools() {
      return [...tools];
    },

    conversation(id) {
      // A named-conversation handle: send() without re-passing the id each time.
      // History lives in the memory store — read it via memory.load(id) if needed.
      return {
        id,
        send: (input, opts) => streamInto(id, input, opts),
        respond: <T>(input: string | Message[], ropts: RespondOptions) => respondInto<T>(id, input, ropts),
        resume: (opts) => resumeInto(id, opts),
        compact: (opts) => compactStored(id, opts),
      };
    },
  };

  return agent;
}

/** Simple async queue: bridges the synchronous `emit` callback to an AsyncIterable. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private buf: T[] = [];
  private resolveNext: ((v: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: item, done: false });
    } else {
      this.buf.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.resolveNext) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buf.length > 0) {
          const value = this.buf.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        if (this.resolveNext) {
          // Single-consumer contract: the events stream is meant for ONE for-await.
          // A second consumer would steal messages / hang the first. Tee it yourself.
          throw new Error("AsyncQueue is single-consumer: another consumer is already awaiting — tee the stream to broadcast.");
        }
        return new Promise((resolve) => {
          this.resolveNext = resolve;
        });
      },
    };
  }
}

// Re-export for consumers; AbortError is the canonical abort signal type.
export { AbortError, anySignal };
export type { StopReason };
