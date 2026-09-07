// RAG-inject demo: wires `ragInjectHook` so that, before each provider request,
// the agent retrieves relevant snippets from a long-term memory store and injects
// them as a labelled `[Retrieved context]` user message.
//
// No network / no API key — it uses a FakeProvider that records the request and a
// toy substring-overlap recall. Run it after building:
//
//   pnpm -r build
//   node --experimental-strip-types examples/rag-inject-demo.ts
//
// Swap the FakeProvider for a real provider (Anthropic/OpenAI) and the
// SubstringMemory for a vector store, and this same wiring gives you real RAG.

import {
  createAgent,
  extractText,
  ragInjectHook,
  InMemoryStore,
  type LLMProvider,
  type Message,
  type MemorySnippet,
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

/**
 * A toy "long-term memory" with keyword-overlap recall (substring stand-in for a
 * vector store). recall() scores stored facts by how many query tokens they
 * contain and returns the top hits.
 */
class SubstringMemory extends InMemoryStore {
  private facts: MemorySnippet[] = [
    { content: "The user's favorite color is teal.", source: "profile" },
    { content: "The deploy command for this project is `pnpm ship`.", source: "runbook" },
    { content: "Meetings are on Thursdays at 10:00.", source: "calendar" },
  ];

  override async recall(query?: string, opts?: { topK?: number }): Promise<MemorySnippet[]> {
    if (!query) return this.facts.slice(0, opts?.topK ?? 4);
    const stop = new Set([
      "the", "a", "an", "is", "are", "was", "what", "whats", "my", "i", "it", "its",
      "of", "to", "and", "for", "in", "on", "at", "hint", "shade", "this", "that",
    ]);
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !stop.has(w));

    return this.facts
      .map((fact) => {
        const body = fact.content.toLowerCase();
        const score = tokens.reduce((n, t) => n + (body.includes(t) ? 1 : 0), 0);
        return { fact, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts?.topK ?? 4)
      .map((x) => ({ ...x.fact, score: x.score }));
  }
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

  const memory = new SubstringMemory();
  const agent = createAgent({
    provider,
    model: "demo",
    maxTurns: 3,
    hooks: { beforeRequest: ragInjectHook({ store: memory }) },
  });

  const prompt = "What's my favorite color? It's a shade of teal.";
  console.log(`user prompt: ${prompt}\n`);

  const { events, done } = agent.stream(prompt, { conversationId: "demo" });
  for await (const _e of events) void _e;
  await done;

  const firstRequest = seen[0];
  if (!firstRequest) {
    console.error("✗ provider was never called");
    process.exit(1);
  }

  console.log("--- messages sent to the provider (first turn) ---");
  for (const m of firstRequest) console.log(render(m));

  const injected = firstRequest.some(
    (m) => typeof m.content === "string" && m.content.includes("[Retrieved context]"),
  );
  const carried = firstRequest.some(
    (m) => typeof m.content === "string" && m.content.includes("teal"),
  );

  console.log(
    `\n${injected && carried ? "✓" : "✗"} RAG injection ${injected && carried ? "worked" : "failed"}: ` +
      `[Retrieved context] present=${injected}, carried fact present=${carried}`,
  );
  process.exit(injected && carried ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
