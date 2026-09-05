// Memory + context management. Phase 1 ships TrimContextManager and an
// in-memory store; CompactContextManager (provider-backed summarization) and
// vector recall are Phase 2+/roadmap.

import { extractText, randomId } from "./types.js";
import type { Message } from "./types.js";
import type { Hooks } from "./hooks.js";

export interface MemorySnippet {
  content: string;
  score?: number;
  source?: string;
}

export interface MemoryStore {
  load(conversationId: string): Promise<Message[]>;
  append(conversationId: string, messages: Message[]): Promise<void>;
  /** Optional: long-term semantic recall (roadmap; Phase 1 stubs return []). */
  recall?(query: string, opts?: { topK?: number }): Promise<MemorySnippet[]>;
}

/** In-process memory store keyed by conversation id. Node/testing default. */
export class InMemoryStore implements MemoryStore {
  private map = new Map<string, Message[]>();
  async load(conversationId: string): Promise<Message[]> {
    return this.map.get(conversationId) ?? [];
  }
  async append(conversationId: string, messages: Message[]): Promise<void> {
    const existing = this.map.get(conversationId) ?? [];
    existing.push(...messages);
    this.map.set(conversationId, existing);
  }
  async recall(): Promise<MemorySnippet[]> {
    return [];
  }
}

// ---------------------------------------------------------------------------
// ragInjectHook — wire `MemoryStore.recall()` into the loop via beforeRequest.
// ---------------------------------------------------------------------------

const RETRIEVED_LABEL = "[Retrieved context]";
const DEFAULT_TOP_K = 4;

export interface RagInjectOptions {
  store: MemoryStore;
  /** Number of snippets to retrieve. Default 4. */
  topK?: number;
  /** Build the retrieval query from current messages. Default: text of the
   * most recent user message. Returns "" to skip retrieval for this turn. */
  queryFrom?: (messages: Message[]) => string;
  /** Render retrieved snippets to the injected payload (string or message(s)).
   * Default: a single labelled `[Retrieved context]` user message. */
  render?: (snippets: MemorySnippet[]) => string | Message[];
}

/** Build a `beforeRequest` hook that injects semantically recalled memory.
 * No-op when the store has no `recall`, returns no snippets, or the query is
 * empty. Does not mutate history itself — returns `{ inject }` and the loop
 * appends it. Keeps core minimal: hosts opt in via `hooks.beforeRequest`. */
export function ragInjectHook(opts: RagInjectOptions): NonNullable<Hooks["beforeRequest"]> {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  return async (ctx) => {
    if (!opts.store.recall) return;
    const query = opts.queryFrom ? opts.queryFrom(ctx.messages) : defaultQuery(ctx.messages);
    if (!query) return;
    const snippets = await opts.store.recall(query, { topK });
    if (!snippets || snippets.length === 0) return;
    const payload = opts.render ? opts.render(snippets) : defaultRender(snippets);
    return { inject: payload };
  };
}

function defaultQuery(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return extractText(m);
  }
  return "";
}

function defaultRender(snippets: MemorySnippet[]): Message[] {
  const lines = snippets.map((s, i) => {
    const src = s.source ? ` (${s.source})` : "";
    return `[${i + 1}]${src} ${s.content}`;
  });
  return [
    {
      id: randomId(),
      role: "user",
      content: `${RETRIEVED_LABEL}\n${lines.join("\n")}`,
      createdAt: Date.now(),
    },
  ];
}
