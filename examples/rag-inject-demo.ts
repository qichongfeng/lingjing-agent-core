// RAG-inject demo: wires `ragInjectHook` so that, before each provider request,
// the agent retrieves relevant snippets from long-term memory and injects them
// as a framed `[Retrieved context]` user message.
//
// The retrieval here is real: `createRecallStore` indexes every conversation in
// an InMemoryStore (BM25 over latin + CJK tokens) and answers `recall` from it.
// Swap the FakeProvider for a real provider and the InMemoryStore for IDBStore
// (browser) or your own storage, and this same wiring is production RAG. The
// store stays yours — core only asks it for messages and gives back snippets.
//
// No network / no API key. Run it after building:
//
//   pnpm -r build
//   node --experimental-transform-types examples/rag-inject-demo.ts

import {
  createAgent,
  createRecallStore,
  extractText,
  ragInjectHook,
  InMemoryStore,
  type LLMProvider,
  type Message,
  type ProviderChunk,
  type ProviderRequest,
  type StopReason,
} from "@lingjing-agent/core";

// Minimal no-network provider for this self-verifying demo. core's testing
// helpers (FakeProvider / textTurn) live in core/test/helpers and are NOT a
// public export, so this demo inlines the small slice it needs.
function textTurn(text: string): ProviderChunk[] {
  return [
    { type: "message_start", messageId: "demo", model: "demo" },
    { type: "text_delta", text },
    { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
  ];
}

class FakeProvider implements LLMProvider {
  readonly id = "fake";
  readonly capabilities = {
    stopReasons: ["end_turn"] as readonly StopReason[],
    streaming: true,
  };
  constructor(private script: (req: ProviderRequest) => ProviderChunk[]) {}
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    return this.iter(req);
  }
  private async *iter(req: ProviderRequest): AsyncIterable<ProviderChunk> {
    for (const c of this.script(req)) yield c;
  }
}

function msg(role: Message["role"], text: string, id: string): Message {
  return { id, role, content: text, createdAt: 0 };
}

/** Stand-in for "everything the user told us, months ago": one conversation per
 *  topic, all of it already persisted. The agent's own conversation is separate. */
async function seedHistory(store: InMemoryStore): Promise<void> {
  const topics: [string, string][] = [
    ["profile", "Just so you know, my favorite color is teal."],
    ["runbook", "The deploy command for this project is `pnpm ship`."],
    ["calendar", "Meetings are on Thursdays at 10:00."],
    ["travel", "The flight to Lisbon is booked for the 14th."],
    ["shopping", "The new keyboard is on the list for this month."],
    ["notes", "The meeting notes are in the shared folder."],
    ["homelab", "The wifi password is printed on the router."],
    ["health", "My guess is the knee is fine by the weekend."],
  ];
  for (const [id, text] of topics) {
    await store.append(id, [msg("assistant", text, `${id}-1`)]);
  }
  await seedFiller(store);
}

/** The rest of the history: mundane conversations that exist so the corpus has
 *  the shape of a real one. This is load-bearing, not padding.
 *
 *  BM25 decides what is informative from document frequency, so in a tiny
 *  corpus a function word ("the", "to", "what") that happens to appear in only
 *  one conversation gets maximal IDF — as much as "favorite" — and a question
 *  about paint colors drags the flight booking into the prompt. No weighting
 *  scheme can fix that: on eight documents there is genuinely no evidence that
 *  "to" is common. Real histories are big enough for IDF to mean something, so
 *  the demo's has to be too. Generated (not random) so the self-check is
 *  reproducible. */
async function seedFiller(store: InMemoryStore): Promise<void> {
  const lines = [
    "The notes for this week are in the shared folder.",
    "What is the best way to do this?",
    "It is on the list for next month.",
    "My guess is that the answer is in the doc.",
    "You can find the rest of it in the archive.",
    "This is what I meant by the second option.",
    "For now the plan is to wait and see.",
    "The build is green and the tests are passing.",
    "I think it is better to ask before doing that.",
    "Can you check the logs for this run?",
    "The meeting is on Thursday and it is short.",
    "The password for the router is on a note.",
  ];
  const count = 40;
  const writes: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    const text = `${lines[i % lines.length]} ${lines[(i * 7 + 3) % lines.length]}`;
    writes.push(store.append(`filler-${i}`, [msg("assistant", text, `filler-${i}-1`)]));
  }
  await Promise.all(writes);
}

function render(m: Message): string {
  const text = typeof m.content === "string" ? m.content : extractText(m);
  return `[${m.role}] ${text}`;
}

async function main(): Promise<void> {
  const seen: Message[][] = [];
  const provider = new FakeProvider((req) => {
    seen.push(req.messages);
    return textTurn("Got it.");
  });

  const store = new InMemoryStore();
  await seedHistory(store);
  // One line is the whole integration. Pass the WRAPPER as `memory` — anything
  // written through the raw store would be invisible to the index.
  const memory = createRecallStore({ store });

  const agent = createAgent({
    provider,
    model: "demo",
    maxTurns: 3,
    hooks: { beforeRequest: ragInjectHook({ store: memory }) },
  });

  const prompt = "What's my favorite color? I want to repaint the kitchen.";
  console.log(`user prompt: ${prompt}\n`);

  const { events, done } = agent.stream(prompt, { conversationId: "today" });
  for await (const _e of events) void _e;
  await done;

  const firstRequest = seen[0];
  if (!firstRequest) {
    console.error("✗ provider was never called");
    process.exit(1);
  }

  console.log("--- messages sent to the provider (first turn) ---");
  for (const m of firstRequest) console.log(render(m));

  const injectedText = firstRequest
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .find((t) => t.includes("[Retrieved context]"));
  const injected = injectedText !== undefined;
  const carried = injectedText?.includes("teal") === true;
  // Ranking, not just matching: none of the other stored facts may ride along.
  // Matching is trivial (every fact shares "the" with the question); keeping
  // the other seven out is what BM25 + the score cutoff actually buy.
  const otherFacts = ["pnpm ship", "Thursdays", "Lisbon", "keyboard", "shared folder", "router", "knee"];
  const quiet = injectedText !== undefined && !otherFacts.some((f) => injectedText.includes(f));

  const ok = injected && carried && quiet;
  console.log(
    `\n${ok ? "✓" : "✗"} lexical recall ${ok ? "worked" : "failed"}: ` +
      `[Retrieved context] present=${injected}, relevant fact carried=${carried}, irrelevant facts excluded=${quiet}`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
