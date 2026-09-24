// Vector (semantic) long-term memory: an embedding-based `recall` backend for
// any MemoryStore — the mirror of recall.ts (lexical BM25). Same decorator
// shape, same lifecycle (lazy build + append-incremental + reconcile via
// list()), different scoring: cosine similarity over in-memory doc vectors.
//
// The embedder is host-supplied: core never touches the network. Sync and
// async embedders are both accepted (a local deterministic embedder need not
// wrap in a promise). An embed
// failure propagates (the failing message is not marked indexed → the next
// recall retries it); a dimension mismatch scores that pair 0 instead of
// crashing, so a mid-corpus model switch degrades honestly.

import { extractText } from "./types.js";
import type { Message } from "./types.js";
import { isRecallInjected } from "./memory.js";
import type { MemorySnippet, MemoryStore, RecallOptions } from "./memory.js";

export type EmbedFn = (
  text: string,
  opts?: { signal?: AbortSignal },
) => number[] | Promise<number[]>;

/** Serialized index state for reboot: every indexed doc with its vector and
 *  the exact text it was embedded from. Text travels with the doc so a stale
 *  entry (same id, rewritten message) is detected by comparison, not trusted. */
export interface SavedVectorIndex {
  docs: Array<{
    conversationId: string;
    messageId: string;
    text: string;
    vector: number[];
  }>;
}

export interface VectorIndexPersist {
  load(): Promise<SavedVectorIndex | undefined>;
  save(index: SavedVectorIndex): void | Promise<void>;
}

export interface VectorRecallStoreOptions {
  /** The store to wrap. Reads and writes go through the wrapper — pass the
   *  wrapper itself as `AgentConfig.memory`, or nothing gets indexed. */
  store: MemoryStore;
  embed: EmbedFn;
  /**
   * Conversation ids this wrapper may see, resolved on every recall. Same
   * shape as the lexical backend's — swapping backends is a one-line change.
   *
   * Multi-tenant hosts MUST pass this — core has no way to know which
   * conversations belong to whom. Out-of-scope conversations are never
   * `load`ed, so their text never enters the index (and never reaches the
   * embedder, which may be a remote API).
   *
   * Has no effect on a store without `list()` (nothing to filter) — such a
   * store must enforce its own visibility.
   */
  scope?: () => Promise<string[]>;
  /** Docs below this fraction of the top score are dropped. */
  minScoreRatio?: number;
  maxPerConversation?: number;
  maxDocChars?: number;
  snippetChars?: number;
  topK?: number;
  /** Optional serialized index — reboot reuses saved vectors instead of
   *  re-embedding the corpus. load() runs lazily at the first recall; save()
   *  is fire-and-forget after every index change. */
  persistIndex?: VectorIndexPersist;
}

export interface VectorRecallStore extends MemoryStore {
  recall(query: string, opts?: RecallOptions): Promise<MemorySnippet[]>;
  /** Drop every vector (the underlying conversation memory is untouched). */
  reset(): void;
}

const DEFAULT_TOP_K = 4;
const DEFAULT_MAX_DOC_CHARS = 2000;
const DEFAULT_SNIPPET_CHARS = 240;
const DEFAULT_MAX_PER_CONVERSATION = 2;
const DEFAULT_MIN_SCORE_RATIO = 0.25;

/** Separates conversation id from message id in a doc key. Not a legal
 *  character in either an id we generate or a realistic host id. */
const KEY_SEP = "\x00";

interface Doc {
  conversationId: string;
  messageId: string;
  text: string;
  vector: number[];
}

export function createVectorRecallStore(opts: VectorRecallStoreOptions): VectorRecallStore {
  const store = opts.store;
  const embed = opts.embed;
  const scope = opts.scope;
  const maxDocChars = opts.maxDocChars ?? DEFAULT_MAX_DOC_CHARS;
  const snippetChars = opts.snippetChars ?? DEFAULT_SNIPPET_CHARS;
  const maxPerConversation = opts.maxPerConversation ?? DEFAULT_MAX_PER_CONVERSATION;
  const minScoreRatio = opts.minScoreRatio ?? DEFAULT_MIN_SCORE_RATIO;
  const defaultTopK = opts.topK ?? DEFAULT_TOP_K;
  const persisted = opts.persistIndex;

  const docsByConversation = new Map<string, Doc[]>();
  const indexedKeys = new Set<string>();
  const known = new Set<string>();
  let docCount = 0;

  // Saved-index reuse: (conversationId, messageId) → the embedded text +
  // vector. Drained into the live docs as indexing dispatches it (a live doc
  // replaces the entry), so a reboot converges instead of re-embedding.
  const saved = new Map<string, { text: string; vector: number[] }>();

  // All index mutations (reconcile incl. per-message embeds, append's
  // incremental index, reset) go through this chain — they interleave across
  // awaits otherwise.
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const run = chain.then(work);
    chain = run.catch(() => {});
    return run;
  }

  // First recall only — a bad storage starts blank and re-embeds everything.
  async function loadSaved(): Promise<void> {
    if (saved.size > 0 || !persisted) return;
    try {
      const idx = await persisted.load();
      for (const d of idx?.docs ?? []) {
        saved.set(d.conversationId + KEY_SEP + d.messageId, { text: d.text, vector: d.vector });
      }
    } catch {
      /* storage error → start blank */
    }
  }

  /** Index one conversation's messages: text selection per extractText (text
   *  blocks only — thinking, tool args and tool results never become docs),
   *  recall-injected blocks skipped, saved vectors reused when the text still
   *  matches, otherwise embedded. A cancelled build stops before paying for
   *  another embed; an embed failure propagates. */
  async function indexMessages(
    conversationId: string,
    messages: readonly Message[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const m of messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (isRecallInjected(m)) continue;
      const text = extractText(m).trim();
      if (text === "") continue;
      const key = conversationId + KEY_SEP + m.id;
      if (indexedKeys.has(key)) continue;
      const capped = text.length > maxDocChars ? text.slice(0, maxDocChars) : text;
      let vector: number[];
      const hit = saved.get(key);
      if (hit && hit.text === capped) {
        vector = hit.vector;
      } else {
        if (signal?.aborted) return;
        vector = await embed(capped, signal ? { signal } : undefined);
      }
      saved.set(key, { text: capped, vector });
      indexedKeys.add(key);
      docCount++;
      let docs = docsByConversation.get(conversationId);
      if (!docs) {
        docs = [];
        docsByConversation.set(conversationId, docs);
      }
      docs.push({ conversationId, messageId: m.id, text: capped, vector });
    }
  }

  function dropConversation(conversationId: string): void {
    known.delete(conversationId);
    const docs = docsByConversation.get(conversationId);
    if (!docs) return;
    for (const doc of docs) {
      const key = conversationId + KEY_SEP + doc.messageId;
      indexedKeys.delete(key);
      saved.delete(key);
    }
    docCount -= docs.length;
    docsByConversation.delete(conversationId);
  }

  function clearIndex(): void {
    docsByConversation.clear();
    indexedKeys.clear();
    known.clear();
    saved.clear();
    docCount = 0;
  }

  function persistSave(): void {
    if (!persisted) return;
    const index: SavedVectorIndex = {
      docs: [...docsByConversation.values()]
        .flat()
        .map((d) => ({ conversationId: d.conversationId, messageId: d.messageId, text: d.text, vector: d.vector })),
    };
    try {
      Promise.resolve(persisted.save(index)).catch(() => {});
    } catch {
      /* sync throw — best-effort by contract */
    }
  }

  // Deleted conversations release their index only when enumeration is
  // possible; append-only stores keep everything (same as the lexical backend).
  async function listVisible(): Promise<string[] | undefined> {
    const inner = store.list;
    if (!inner) return undefined;
    const all = await inner.call(store);
    if (!scope) return all;
    const allowed = new Set(await scope());
    return all.filter((id) => allowed.has(id));
  }

  async function reconcile(signal?: AbortSignal): Promise<void> {
    const visible = await listVisible();
    if (visible === undefined) return;
    const live = new Set(visible);
    for (const id of [...known]) {
      if (!live.has(id)) dropConversation(id);
    }
    for (const id of visible) {
      if (known.has(id)) continue;
      const messages = await store.load(id);
      await indexMessages(id, messages, signal);
      // Mark known only after a fully-built index. An embed failure THROWS
      // (stays retryable), but a signal abort RETURNS early mid-build —
      // marking known then would permanently skip the un-indexed remainder
      // for this process lifetime. Abort cancels the whole recall anyway.
      if (signal?.aborted) return;
      known.add(id);
    }
  }

  function dot(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0; // mixed dimensions → no signal for this pair
    let sum = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      sum += a[i]! * b[i]!;
      na += a[i]! * a[i]!;
      nb += b[i]! * b[i]!;
    }
    if (na === 0 || nb === 0) return 0;
    return sum / Math.sqrt(na * nb);
  }

  /** A window from the head — vector matches carry no token position to anchor
   *  on (the lexical backend's first-match window has no equivalent here). */
  function snippet(doc: Doc): string {
    if (doc.text.length <= snippetChars) return doc.text;
    return `${doc.text.slice(0, snippetChars)}…`;
  }

  const recall = async (query: string, recallOpts?: RecallOptions): Promise<MemorySnippet[]> => {
    const signal = recallOpts?.signal;
    if (signal?.aborted) return [];
    await enqueue(async () => {
      await loadSaved();
      await reconcile(signal);
      persistSave();
    });
    // The build is the expensive step (an embed per message), so a cancelled
    // run must short-circuit after it rather than pay for scoring.
    if (signal?.aborted) return [];
    if (query === "" || docCount === 0) return [];
    const exclude = new Set(recallOpts?.exclude ?? []);
    const topK = recallOpts?.topK ?? defaultTopK;
    // One query embed. The docs may carry a different dimension than the query
    // (host changed models) → those pairs score 0.
    const q = await embed(query, signal ? { signal } : undefined);
    if (q.length === 0) return [];
    const ranked: Array<{ doc: Doc; value: number }> = [];
    for (const docs of docsByConversation.values()) {
      for (const doc of docs) {
        if (exclude.has(doc.conversationId)) continue;
        ranked.push({ doc, value: dot(q, doc.vector) });
      }
    }
    ranked.sort((a, b) => b.value - a.value);
    const best = ranked[0];
    if (!best) return [];
    const cutoff = best.value * (recallOpts?.minScoreRatio ?? minScoreRatio);
    const used = new Map<string, number>();
    const out: MemorySnippet[] = [];
    for (const { doc, value } of ranked) {
      if (out.length >= topK) break;
      if (value < cutoff) break;
      const taken = used.get(doc.conversationId) ?? 0;
      if (taken >= maxPerConversation) continue;
      used.set(doc.conversationId, taken + 1);
      out.push({ content: snippet(doc), score: value, source: doc.conversationId, messageId: doc.messageId });
    }
    return out;
  };

  const wrapper: VectorRecallStore = {
    load: (conversationId) => store.load(conversationId),
    append: async (conversationId, messages) => {
      await store.append(conversationId, messages);
      await enqueue(() => indexMessages(conversationId, messages));
    },
    recall,
    reset: () => {
      void enqueue(async () => {
        clearIndex();
        persistSave(); // a reboot must not resurrect a deliberately reset index
      });
    },
  };
  if (store.list) {
    wrapper.list = () => store.list!.call(store);
  }
  return wrapper;
}
