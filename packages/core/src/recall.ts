// Lexical long-term memory: a BM25 `recall` backend for any MemoryStore.
//
// Why this exists: `MemoryStore.recall` is what `ragInjectHook` calls, and
// `ragInjectHook` is a complete, working `beforeRequest` hook — the only thing
// missing was an implementation, so the whole passive-memory path was dead
// code (the built-in store stubs `recall` to []). This module is that
// implementation: wrap a store, get retrieval.
//
// Shape: a DECORATOR, not a store implementation and not a model-facing tool.
// `createRecallStore({ store })` proxies load/append (indexing incrementally on
// append) and answers `recall` from its own index. Any store — InMemoryStore,
// IDBStore, a host's Redis/wx bridge — gains retrieval with no change to itself,
// which is what lets the mechanism live in core while the data stays the host's.
//
// Local by design: a wrapper per scope. The VISIBILITY BOUNDARY IS THE HOST'S:
// pass `scope` and only those conversations are ever loaded into the index.
// MemoryStore itself carries no ACL — core cannot know which conversations
// belong to whom, so it asks rather than guesses.
//
// Not indexed-resident: the index is in-process and rebuilt lazily. Persisting
// it is the vector-backend's problem (roadmap), not this one's.
//
// `extractText` does the field selection for free: it keeps only `type:"text"`
// blocks, so thinking / tool-call arguments / tool results (bulky, noisy) and
// images drop out without a filter predicate, and tool-result carriers —
// which are nothing but tool_result blocks — yield "" and are skipped.
//
// The indexer also skips messages the RAG hook itself injected. Without that,
// retrieval eats its own tail: conversation A's injected copy of B's text
// becomes A's own user text, which is recalled into C, and so on — a
// transitive laundering of text the model never said.

import { extractText } from "./types.js";
import type { Message } from "./types.js";
import { isRecallInjected } from "./memory.js";
import type { MemorySnippet, MemoryStore, RecallOptions } from "./memory.js";

// Standard BM25 saturation / length-normalization constants.
const K1 = 1.2;
const B = 0.75;

const DEFAULT_TOP_K = 4;
const DEFAULT_MAX_DOC_CHARS = 2000;
const DEFAULT_SNIPPET_CHARS = 240;
const DEFAULT_MAX_PER_CONVERSATION = 2;
const DEFAULT_MIN_SCORE_RATIO = 0.25;

/** Separates conversation id from message id in a doc key. Not a legal
 *  character in either an id we generate or a realistic host id. */
const KEY_SEP = "\x00";

/** Scripts written without spaces, where a run of these is one word to be cut
 *  into n-grams. Deliberately NARROWER than tokens.ts's estimation predicate:
 *  that one counts punctuation and fullwidth forms as CJK because they cost a
 *  token, but punctuation is not part of a word — letting it through would
 *  fuse "好。今天" into one run and emit junk bigrams like 「好。」 and 「。今」. */
const CJK_WORD_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3100, 0x312f], // Bopomofo
  [0x3130, 0x318f], // Hangul compatibility jamo
  [0x31f0, 0x31ff], // Katakana phonetic extensions
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa960, 0xa97f], // Hangul jamo extension A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0x20000, 0x2fa1f], // astral extensions (Ext B+ and compatibility supplement)
];

/** Word characters in spaced scripts (latin, cyrillic, digits, …). CJK is
 *  checked first — ideographs are `\p{L}` too, and they need the other path. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

function isCjkWord(codePoint: number): boolean {
  for (const [lo, hi] of CJK_WORD_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return true;
  }
  return false;
}

/**
 * Tokenize for lexical retrieval: latin/digit runs (single-char dropped) plus
 * CJK unigrams AND bigrams.
 *
 * Both CJK granularities matter. Bigrams carry the precision ("北京" matches
 * 北京, not 東京), but bigrams alone are a dead end for single-character
 * queries — "京" would tokenize to nothing and never match anything, and
 * single-character queries are ordinary Chinese. Unigrams restore recall, and
 * the noise they bring (的/了 matching everywhere) is exactly what BM25's IDF
 * exists to suppress: a character present in every document scores near zero.
 *
 * NFKC first, so fullwidth and compatibility forms converge with what a user
 * types on a normal keyboard — without it 「ＡＢＣ」 indexes as CJK bigrams and
 * can never match a query of "abc". Iterating code points (not UTF-16 units)
 * keeps astral CJK whole instead of splitting it into surrogate halves.
 *
 * Tokens from an NFKC-clean input are literal substrings of it, which is what
 * lets the snippet builder locate a match with a plain indexOf.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const normalized = text.normalize("NFKC").toLowerCase();
  let word = "";
  let cjk: string[] = [];

  const flushWord = (): void => {
    if (word.length >= 2) out.push(word); // single latin chars carry no signal
    word = "";
  };
  const flushCjk = (): void => {
    if (cjk.length === 1) {
      out.push(cjk[0]!);
    } else {
      for (let i = 0; i < cjk.length; i++) {
        out.push(cjk[i]!);
        if (i + 1 < cjk.length) out.push(cjk[i]! + cjk[i + 1]!);
      }
    }
    cjk = [];
  };

  for (const ch of normalized) {
    const codePoint = ch.codePointAt(0);
    if (codePoint !== undefined && isCjkWord(codePoint)) {
      flushWord();
      cjk.push(ch);
    } else if (WORD_CHAR.test(ch)) {
      flushCjk();
      word += ch;
    } else {
      flushWord();
      flushCjk();
    }
  }
  flushWord();
  flushCjk();
  return out;
}

interface Doc {
  conversationId: string;
  messageId: string;
  /** Indexed text, capped at maxDocChars. Snippets are cut from this. */
  text: string;
  /** term → term frequency in this document. */
  terms: Map<string, number>;
  /** Token count (unigrams + bigrams), for BM25 length normalization. */
  length: number;
}

export interface RecallStoreOptions {
  /** The store to wrap. Reads and writes go through the wrapper — pass the
   *  wrapper itself as `AgentConfig.memory`, or nothing gets indexed. */
  store: MemoryStore;
  /**
   * Conversation ids this wrapper may see, resolved on every recall. Default:
   * everything `store.list()` reports (right for a single-user local store).
   *
   * Multi-tenant hosts MUST pass this — core has no way to know which
   * conversations belong to whom. Out-of-scope conversations are never
   * `load`ed, so their text never enters the index at all.
   *
   * Has no effect on a store without `list()` (nothing to filter) — such a
   * store must enforce its own visibility.
   */
  scope?: () => Promise<string[]>;
  /** Drop hits scoring below this fraction of the top hit (default 0.25).
   *  BM25 scores have no absolute scale, so a relative cutoff is what keeps a
   *  barely-relevant query from padding the context with 4 near-noise hits. */
  minScoreRatio?: number;
  /** At most this many snippets per conversation (default 2) — otherwise
   *  adjacent messages from one stretch of history take every slot and the
   *  injected context reads as the same thing four times. */
  maxPerConversation?: number;
  /** Indexed-text cap per message (default 2000 chars). */
  maxDocChars?: number;
  /** Snippet window length (default 240 chars). */
  snippetChars?: number;
  /** Default result count when `recall(query)` omits topK. Default 4. */
  topK?: number;
}

export interface RecallStore extends MemoryStore {
  recall(query: string, opts?: RecallOptions): Promise<MemorySnippet[]>;
  /** Drop the index; the next recall rebuilds it. */
  reset(): void;
}

/**
 * Wrap a MemoryStore so it can answer `recall`. See the module comment for the
 * design; the short version is that you pass the wrapper, not the inner store,
 * wherever a MemoryStore is expected.
 */
export function createRecallStore(opts: RecallStoreOptions): RecallStore {
  const store = opts.store;
  const scope = opts.scope;
  const maxDocChars = opts.maxDocChars ?? DEFAULT_MAX_DOC_CHARS;
  const snippetChars = opts.snippetChars ?? DEFAULT_SNIPPET_CHARS;
  const maxPerConversation = opts.maxPerConversation ?? DEFAULT_MAX_PER_CONVERSATION;
  const minScoreRatio = opts.minScoreRatio ?? DEFAULT_MIN_SCORE_RATIO;
  const defaultTopK = opts.topK ?? DEFAULT_TOP_K;

  const docsByConversation = new Map<string, Doc[]>();
  /** Doc keys already indexed — the guard against re-indexing a message that
   *  a concurrent reconcile also picked up. */
  const indexedKeys = new Set<string>();
  /** term → (doc → tf). */
  const postings = new Map<string, Map<Doc, number>>();
  /** term → number of documents containing it. */
  const docFreq = new Map<string, number>();
  /** Conversations we have loaded (or confirmed absent). Separate from
   *  docsByConversation so an empty conversation isn't re-loaded every recall. */
  const known = new Set<string>();
  let totalLength = 0;
  let docCount = 0;

  // Every index mutation goes through this chain: reconcile, append's
  // incremental index, and reset can otherwise interleave across awaits and
  // double-count or corrupt the postings.
  let chain: Promise<unknown> = Promise.resolve();
  function enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const run = chain.then(work, work);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  function indexMessages(conversationId: string, messages: readonly Message[]): void {
    for (const m of messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      if (isRecallInjected(m)) continue; // see the module comment: no self-feed
      const text = extractText(m).trim();
      if (text === "") continue;
      const key = conversationId + KEY_SEP + m.id;
      if (indexedKeys.has(key)) continue;
      const capped = text.length > maxDocChars ? text.slice(0, maxDocChars) : text;
      const terms = termFrequencies(capped);
      if (terms.size === 0) continue;

      let length = 0;
      for (const tf of terms.values()) length += tf;

      const doc: Doc = { conversationId, messageId: m.id, text: capped, terms, length };
      indexedKeys.add(key);
      let docs = docsByConversation.get(conversationId);
      if (!docs) {
        docs = [];
        docsByConversation.set(conversationId, docs);
      }
      docs.push(doc);
      for (const [term, tf] of terms) {
        let posting = postings.get(term);
        if (!posting) {
          posting = new Map();
          postings.set(term, posting);
        }
        posting.set(doc, tf);
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
      }
      totalLength += length;
      docCount++;
    }
  }

  function dropConversation(conversationId: string): void {
    known.delete(conversationId);
    const docs = docsByConversation.get(conversationId);
    if (!docs) return;
    for (const doc of docs) {
      indexedKeys.delete(conversationId + KEY_SEP + doc.messageId);
      for (const [term, tf] of doc.terms) {
        const posting = postings.get(term);
        if (posting) {
          posting.delete(doc);
          if (posting.size === 0) postings.delete(term);
        }
        const df = (docFreq.get(term) ?? tf) - 1;
        if (df <= 0) docFreq.delete(term);
        else docFreq.set(term, df);
      }
      totalLength -= doc.length;
      docCount--;
    }
    docsByConversation.delete(conversationId);
  }

  function clearIndex(): void {
    docsByConversation.clear();
    indexedKeys.clear();
    postings.clear();
    docFreq.clear();
    known.clear();
    totalLength = 0;
    docCount = 0;
  }

  /** Conversation ids currently visible, or undefined when the store cannot
   *  be enumerated (append-only fallback). */
  async function listVisible(): Promise<string[] | undefined> {
    const inner = store.list;
    if (!inner) return undefined;
    const all = await inner.call(store);
    if (!scope) return all;
    const allowed = new Set(await scope());
    return all.filter((id) => allowed.has(id));
  }

  /** Bring the index in line with what the store currently holds: load newly
   *  visible conversations, forget ones that vanished. Runs before every
   *  recall — one `list()` (cheap: Map keys / IDB getAllKeys) is what keeps a
   *  deleted conversation from lingering in memory and being retrieved. */
  async function reconcile(): Promise<void> {
    const visible = await listVisible();
    if (visible === undefined) return; // no enumeration — append-only mode
    const live = new Set(visible);
    for (const id of [...known]) {
      if (!live.has(id)) dropConversation(id);
    }
    for (const id of visible) {
      if (known.has(id)) continue;
      const messages = await store.load(id);
      known.add(id); // after the load: a failure must stay retryable
      indexMessages(id, messages);
    }
  }

  function score(tokens: readonly string[], exclude: ReadonlySet<string>): Map<Doc, number> {
    const scores = new Map<Doc, number>();
    const avgLength = docCount > 0 ? totalLength / docCount : 0;
    const counted = new Set<string>();
    for (const term of tokens) {
      if (counted.has(term)) continue; // a repeated query term must not double-count
      counted.add(term);
      const posting = postings.get(term);
      if (!posting) continue;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (docCount - df + 0.5) / (df + 0.5));
      for (const [doc, tf] of posting) {
        if (exclude.has(doc.conversationId)) continue;
        const norm = avgLength > 0 ? doc.length / avgLength : 1;
        scores.set(doc, (scores.get(doc) ?? 0) + (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + B * norm)));
      }
    }
    return scores;
  }

  /** Cut a window around the first matching token rather than the head of the
   *  message — a long turn's opening line is rarely why it matched.
   *
   *  Matching runs against the raw text, so a document that is written
   *  entirely in fullwidth forms finds no position and falls back to its head.
   *  A misplaced window is a cosmetic miss; showing the un-normalized original
   *  is the point, so this is not worth storing a second copy of every doc. */
  function snippet(doc: Doc, tokens: readonly string[]): string {
    const haystack = doc.text.toLowerCase();
    let pos = -1;
    for (const term of tokens) {
      const at = haystack.indexOf(term);
      if (at >= 0 && (pos < 0 || at < pos)) pos = at;
    }
    if (pos < 0) pos = 0;
    let start = Math.max(0, pos - Math.floor(snippetChars / 4));
    let end = Math.min(doc.text.length, start + snippetChars);
    if (end - start < snippetChars) start = Math.max(0, end - snippetChars);
    const body = doc.text.slice(start, end);
    return `${start > 0 ? "…" : ""}${body}${end < doc.text.length ? "…" : ""}`;
  }

  const recall = async (query: string, recallOpts?: RecallOptions): Promise<MemorySnippet[]> => {
    const signal = recallOpts?.signal;
    if (signal?.aborted) return [];
    await enqueue(reconcile);
    // The build is the expensive step (a load per conversation), so the run
    // being cancelled must short-circuit after it rather than pay for scoring.
    if (signal?.aborted) return [];
    const tokens = tokenize(query);
    if (tokens.length === 0 || docCount === 0) return [];
    const exclude = new Set(recallOpts?.exclude ?? []);
    const topK = recallOpts?.topK ?? defaultTopK;

    const ranked = [...score(tokens, exclude).entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    if (!top) return [];
    const cutoff = top[1] * (recallOpts?.minScoreRatio ?? minScoreRatio);

    const perConversation = new Map<string, number>();
    const out: MemorySnippet[] = [];
    for (const [doc, value] of ranked) {
      if (out.length >= topK) break;
      if (value < cutoff) break; // sorted desc: everything after is weaker too
      const used = perConversation.get(doc.conversationId) ?? 0;
      if (used >= maxPerConversation) continue;
      perConversation.set(doc.conversationId, used + 1);
      out.push({
        content: snippet(doc, tokens),
        score: value,
        source: doc.conversationId,
        messageId: doc.messageId,
      });
    }
    return out;
  };

  const wrapper: RecallStore = {
    load: (conversationId) => store.load(conversationId),
    append: async (conversationId, messages) => {
      await store.append(conversationId, messages);
      await enqueue(() => indexMessages(conversationId, messages));
    },
    recall,
    reset: () => {
      void enqueue(clearIndex);
    },
  };
  if (store.list) {
    wrapper.list = () => store.list!.call(store);
  }
  return wrapper;
}

/** term → frequency, for one document's text. */
function termFrequencies(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of tokenize(text)) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}
