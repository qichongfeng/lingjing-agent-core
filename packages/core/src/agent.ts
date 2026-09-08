// Public Agent API: createAgent(), stream/run, tool registry, conversations.

import type { ContextManager } from "./context.js";
import type { Hooks } from "./hooks.js";
import { runLoop } from "./loop.js";
import { InMemoryStore, type MemoryStore } from "./memory.js";
import type { PermissionGate } from "./permission.js";
import type {
  LLMProvider,
  ProviderConfig,
  StopReason,
} from "./provider.js";
import type { Tool } from "./tool.js";
import type { Message, TextContent } from "./types.js";
import { randomId, userMessage, withRunId } from "./types.js";
import { AbortError, anySignal } from "./abort.js";
import type { AgentEvent } from "./events.js";

export interface AgentConfig {
  provider: LLMProvider;
  model: string;
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
  /** Token budget passed to context.fit/compact. Default 100_000. */
  contextTokenBudget?: number;
  /** Max pause_turn continuations before terminating. Default 5. */
  maxContinuations?: number;
  /** Max consecutive max_tokens turns (no progress) before terminating. Default 3. */
  maxStalledTurns?: number;
  memory?: MemoryStore;
  hooks?: Hooks;
  permissionGate?: PermissionGate;
  retry?: { maxRetries: number; baseDelayMs: number; maxDelayMs: number };
  providerOptions?: Record<string, unknown>;
  /** Tool tag allowlist; tools whose permissions.tags aren't included are refused at registration. */
  allowedToolTags?: string[];
}

export interface StreamHandle {
  events: AsyncIterable<AgentEvent>;
  abort: () => void;
  done: Promise<Message>;
}

export interface ConversationHandle {
  readonly id: string;
  send(input: string | Message[], opts?: { signal?: AbortSignal }): StreamHandle;
}

export interface Agent {
  stream(input: string | Message[], opts: { conversationId: string; signal?: AbortSignal }): StreamHandle;
  run(input: string | Message[], opts: { conversationId: string; signal?: AbortSignal }): Promise<Message>;
  registerTool(tool: Tool): void;
  unregisterTool(name: string): void;
  listTools(): readonly Tool[];
  conversation(id: string): ConversationHandle;
}

export function createAgent(config: AgentConfig): Agent {
  if (!config.provider) throw new Error("AgentConfig.provider is required");
  if (!config.model) throw new Error("AgentConfig.model is required");

  const maxTurns = config.maxTurns ?? 25;
  if (maxTurns < 1) throw new Error(`AgentConfig.maxTurns must be >= 1 (got ${maxTurns})`);
  const maxTokens = config.maxTokens ?? 16000;
  const toolTimeoutMs = config.toolTimeoutMs ?? 30000;
  const contextTokenBudget = config.contextTokenBudget ?? 100_000;
  const maxContinuations = config.maxContinuations ?? 5;
  const maxStalledTurns = config.maxStalledTurns ?? 3;
  const retry = config.retry ?? { maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 30000 };
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

  function streamInto(conversationId: string, input: string | Message[], opts: { signal?: AbortSignal } | undefined): StreamHandle {
    const queue = new AsyncQueue<AgentEvent>();
    const controller = new AbortController();
    if (opts?.signal) {
      const external = opts.signal;
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const done: Promise<Message> = (async () => {
      // Run id: groups everything this stream appends (input, assistant turns,
      // tool-result carriers, hook injects) into one exchange for groupExchanges().
      const runId = randomId();
      // Load history from the memory store (default InMemoryStore = in-process).
      // Copy so runLoop's in-place mutations don't leak into the store until append().
      const history: Message[] = [...(await memory.load(conversationId))];
      // Track loaded message ids so append persists only what THIS stream added
      // (input + assistant turns + tool results) — robust against context.fit/compact
      // shortening history in place (a baseline array index would go stale after compaction).
      const loadedIds = new Set(history.map((m) => m.id));
      if (typeof input === "string") {
        history.push(withRunId(userMessage(input, now), runId));
      } else {
        // Copy-on-write stamp: caller-owned Message objects are never mutated.
        history.push(...input.map((m) => withRunId(m, runId)));
      }

      try {
        const finalMsg = await runLoop({
          provider: config.provider,
          model: config.model,
          tools: [...tools],
          messages: history,
          runId,
          config: buildProviderConfig(),
          maxTurns,
          toolTimeoutMs,
          tokenBudget: contextTokenBudget,
          maxContinuations,
          maxStalledTurns,
          retry,
          signal: controller.signal,
          conversationId,
          now,
          emit: (e) => queue.push(e),
          ...(config.system !== undefined ? { system: config.system } : {}),
          ...(config.permissionGate ? { permissionGate: config.permissionGate } : {}),
          ...(config.hooks ? { hooks: config.hooks } : {}),
          ...(config.context ? { context: config.context } : {}),
        });
        const newMsgs = history.filter((m) => !loadedIds.has(m.id));
        await memory.append(conversationId, newMsgs);
        queue.close();
        return finalMsg;
      } catch (err) {
        // runLoop already emitted an `error` event on the hard-failure path.
        queue.close();
        throw err instanceof Error ? err : new Error(String(err));
      }
    })();

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
