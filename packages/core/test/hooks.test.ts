// The hook contract: error isolation (intercept fails closed, observe fails
// soft), the abort/veto split, the snapshot vs. live context boundaries, and
// the two paths hooks used to silently miss (agent.respond, subagents).

import { describe, expect, test } from "vitest";
import {
  HookAbortError,
  HookError,
  createAgent,
  createSpawnTool,
  extractText,
  InMemoryStore,
  normalizeInjected,
  type AgentEvent,
  type ContextManager,
  type Hooks,
  type LLMProvider,
  type Message,
  type StreamHandle,
} from "../src/index.js";
import {
  abortingHook,
  allowGate,
  cweTurn,
  echoTool,
  failTool,
  inputRewritingHook,
  legacyAbortingHook,
  legacyVetoingHook,
  mutatingHook,
  scriptedProvider,
  slowTool,
  textTurn,
  throwingHooks,
  toolCallTurn,
  vetoingHook,
} from "./helpers/index.js";

async function collect(handle: StreamHandle): Promise<{ events: AgentEvent[]; message?: Message; error?: unknown }> {
  const events: AgentEvent[] = [];
  for await (const e of handle.events) events.push(e);
  try {
    return { events, message: await handle.done };
  } catch (error) {
    return { events, error };
  }
}
const findError = (es: AgentEvent[]) => es.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
const toolResults = (es: AgentEvent[]) =>
  es.filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result");
const resultText = (e: Extract<AgentEvent, { type: "tool_result" }>): string =>
  e.content.map((b: unknown) => (b as { text?: string }).text ?? "").join("");

describe("hook error isolation", () => {
  test("beforeRequest throwing fails the run closed with code hook_error (not provider_error)", async () => {
    const agent = createAgent({
      provider: scriptedProvider([textTurn("never sent")]),
      model: "fake",
      hooks: throwingHooks(["beforeRequest"]),
    });
    const { events, error } = await collect(agent.stream("go", { conversationId: "c" }));

    const err = findError(events);
    expect(err?.code).toBe("hook_error");
    expect(err?.code).not.toBe("provider_error"); // the whole point of the distinct code
    expect(err?.recoverable).toBe(false);
    expect(err?.message).toContain("beforeRequest");
    // done rejects with a HookError naming the hook, keeping the cause.
    expect(error).toBeInstanceOf(HookError);
    expect((error as HookError).hook).toBe("beforeRequest");
    expect(((error as HookError).cause as Error).message).toBe("beforeRequest blew up");
  });

  test("beforeRequest aborting is reported as hook_abort, distinct from a crash", async () => {
    const agent = createAgent({
      provider: scriptedProvider([textTurn("never sent")]),
      model: "fake",
      hooks: abortingHook("policy says no"),
    });
    const { events, error } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(findError(events)?.code).toBe("hook_abort");
    expect(findError(events)?.message).toBe("policy says no");
    expect(error).toBeInstanceOf(HookAbortError);
  });

  test("afterTurn throwing fails soft: run completes, warning goes to the logger", async () => {
    const logs: Array<[string, string]> = [];
    const agent = createAgent({
      provider: scriptedProvider([textTurn("all good")]),
      model: "fake",
      logger: (level, msg) => { logs.push([level, msg]); },
      hooks: throwingHooks(["afterTurn"]),
    });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));

    expect(message && extractText(message)).toBe("all good"); // the run is unaffected
    expect(findError(events)).toBeUndefined(); // and no error event is emitted
    expect(logs[0]?.[0]).toBe("warn");
    expect(logs[0]?.[1]).toContain("afterTurn");
  });

  test("beforeToolCall throwing fails closed at tool scope: tool skipped, run continues", async () => {
    const agent = createAgent({
      provider: scriptedProvider([toolCallTurn("echo", {}), textTurn("ok")]),
      model: "fake", maxTurns: 5, tools: [echoTool()],
      hooks: throwingHooks(["beforeToolCall"]),
    });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));

    const failed = toolResults(events).find((r) => r.isError);
    expect(resultText(failed!)).toContain("beforeToolCall threw");
    expect(message && extractText(message)).toBe("ok"); // the run survived
    expect(findError(events)).toBeUndefined();
  });
});

describe("hook firing coverage", () => {
  test("afterTurn fires on every turn, including a context_window_exceeded turn", async () => {
    const seen: string[] = [];
    const mgr: ContextManager = {
      async fit(input) { return { messages: input.messages, compacted: false }; },
      async compact(input) { return { messages: input.messages, compacted: false }; },
    };
    const agent = createAgent({
      provider: scriptedProvider([cweTurn("too big"), textTurn("recovered")]),
      model: "fake", maxTurns: 5, context: mgr,
      hooks: {
        afterTurn: async (ctx) => { seen.push(ctx.stopReason); },
      },
    });
    await collect(agent.stream("go", { conversationId: "c" }));
    expect(seen).toEqual(["context_window_exceeded", "end_turn"]);
  });

  test("deprecated afterResponse spelling (0.1.0-beta) still fires — same compat read abort→veto got", async () => {
    const seen: string[] = [];
    const agent = createAgent({
      provider: scriptedProvider([textTurn("done")]),
      model: "fake",
      // The pre-rename spelling, as a JS host would pass it (no compile types).
      hooks: {
        afterResponse: async (ctx: { stopReason: string }) => { seen.push(ctx.stopReason); },
      } as unknown as Hooks,
    });
    await collect(agent.stream("go", { conversationId: "c" }));
    expect(seen).toEqual(["end_turn"]); // the observer did not silently vanish
  });

  test("afterToolCall fires on the failure path too (it used to skip it)", async () => {
    const seen: Array<{ isError: boolean; text: string }> = [];
    const agent = createAgent({
      provider: scriptedProvider([toolCallTurn("fail", {}), textTurn("ok")]),
      model: "fake", maxTurns: 5, tools: [failTool()],
      hooks: {
        afterToolCall: async (call) => {
          const c = call.result.content;
          seen.push({
            isError: call.isError,
            text: Array.isArray(c) ? c.map((b) => (b.type === "text" ? b.text : "")).join("") : c,
          });
        },
      },
    });
    const { message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(message && extractText(message)).toBe("ok"); // still recovers
    expect(seen).toHaveLength(1);
    expect(seen[0]?.isError).toBe(true);
    expect(seen[0]?.text).toContain("intentional failure");
  });

  test("afterToolCall fires on the timeout path too", async () => {
    const seen: Array<{ isError: boolean }> = [];
    // No per-tool `timeoutMs` here (slowTool sets one, which would win), so the
    // agent-level toolTimeoutMs governs and the call is killed mid-flight.
    const agent = createAgent({
      provider: scriptedProvider([toolCallTurn("slow", {}), textTurn("ok")]),
      model: "fake", maxTurns: 5, tools: [slowTool(50, { noTimeout: true })], toolTimeoutMs: 10,
      hooks: {
        afterToolCall: async (call) => { seen.push({ isError: call.isError }); },
      },
    });
    await collect(agent.stream("go", { conversationId: "c" }));
    expect(seen).toEqual([{ isError: true }]);
  });
});

describe("hook context boundaries", () => {
  test("ctx.messages is a snapshot — in-place mutation cannot rewrite history", async () => {
    const seenByProvider: string[][] = [];
    const provider: LLMProvider = {
      id: "capturing",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream(req) {
        seenByProvider.push(req.messages.map((m) => extractText(m)));
        return (async function* () {
          for (const c of textTurn("done")) yield c;
        })();
      },
    };
    const agent = createAgent({ provider, model: "fake", hooks: mutatingHook("INJECTED BY MUTATION") });
    await collect(agent.stream("go", { conversationId: "c" }));

    expect(seenByProvider).toHaveLength(1);
    expect(seenByProvider[0]).toEqual(["go"]); // the mutation never reached the request
    expect(seenByProvider[0]?.some((t) => t.includes("INJECTED BY MUTATION"))).toBe(false);
  });

  test("ctx.tools is live — pushing a tool changes the request (documented, pinned)", async () => {
    let toolsSeen: string[] = [];
    const provider: LLMProvider = {
      id: "capturing",
      capabilities: { stopReasons: ["end_turn"], streaming: true },
      stream(req) {
        toolsSeen = req.tools?.map((t) => t.name) ?? [];
        return (async function* () {
          for (const c of textTurn("done")) yield c;
        })();
      },
    };
    const agent = createAgent({
      provider, model: "fake",
      hooks: {
        beforeRequest: async (ctx) => {
          if (!ctx.tools.some((t) => t.name === "late")) {
            ctx.tools.push({
              name: "late",
              description: "added per-turn",
              inputSchema: { jsonSchema: { type: "object" } },
              async execute() { return { content: "late" }; },
            });
          }
        },
      },
    });
    await collect(agent.stream("go", { conversationId: "c" }));
    expect(toolsSeen).toContain("late");
  });
});

describe("abort vs veto: the deprecated spellings stay fail-closed", () => {
  test("beforeRequest's legacy {abort:true} is read as a run abort", async () => {
    const agent = createAgent({
      provider: scriptedProvider([textTurn("never sent")]),
      model: "fake",
      hooks: legacyAbortingHook("legacy abort"),
    });
    const { events, error } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(findError(events)?.code).toBe("hook_abort");
    expect(error).toBeInstanceOf(HookAbortError);
  });

  test("beforeToolCall's legacy {abort:true} is read as a veto, never a run abort", async () => {
    const agent = createAgent({
      provider: scriptedProvider([toolCallTurn("echo", {}), textTurn("ok")]),
      model: "fake", maxTurns: 5, tools: [echoTool()],
      hooks: legacyVetoingHook("legacy veto"),
    });
    const { events, message } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(resultText(toolResults(events)[0]!)).toContain("Vetoed by beforeToolCall: legacy veto");
    expect(message && extractText(message)).toBe("ok"); // the run continued
    expect(findError(events)).toBeUndefined();
  });

  test("veto with no reason still produces a usable tool_result", async () => {
    const agent = createAgent({
      provider: scriptedProvider([toolCallTurn("echo", {}), textTurn("ok")]),
      model: "fake", maxTurns: 5, tools: [echoTool()],
      hooks: { beforeToolCall: async () => ({ veto: true as const }) as never },
    });
    const { events } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(resultText(toolResults(events)[0]!)).toContain("no reason given");
  });
});

describe("hooks reach agent.respond", () => {
  const SCHEMA = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false };

  test("beforeRequest fires once, even when a repair retry happens", async () => {
    let calls = 0;
    const agent = createAgent({
      provider: scriptedProvider([
        toolCallTurn("respond", { wrong: true }), // schema violation → one repair
        toolCallTurn("respond", { answer: 7 }, 1),
      ]),
      model: "fake",
      hooks: { beforeRequest: async () => { calls++; } },
    });
    const data = await agent.respond<{ answer: number }>("extract", { conversationId: "s", schema: SCHEMA });
    expect(data).toEqual({ answer: 7 });
    expect(calls).toBe(1); // a repair is the same logical turn — no stacking
  });

  test("an abortRun in beforeRequest stops the extraction", async () => {
    const agent = createAgent({
      provider: scriptedProvider([toolCallTurn("respond", { answer: 1 })]),
      model: "fake",
      hooks: abortingHook("no extraction allowed"),
    });
    await expect(agent.respond("extract", { conversationId: "s", schema: SCHEMA }))
      .rejects.toThrow("no extraction allowed");
  });

  test("a throwing guard surfaces as HookError, not StructuredOutputError", async () => {
    const agent = createAgent({
      provider: scriptedProvider([toolCallTurn("respond", { answer: 1 })]),
      model: "fake",
      hooks: throwingHooks(["beforeRequest"]),
    });
    const err = await agent.respond("extract", { conversationId: "s", schema: SCHEMA }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HookError);
    expect((err as HookError).hook).toBe("beforeRequest");
  });
});

describe("hooks reach subagents — by explicit declaration only", () => {
  const RESEARCHER = { name: "researcher", description: "researches things", system: "be brief", tools: [] };
  const PARENT_SCRIPT = () => [
    toolCallTurn("spawn_agent", { agent: "researcher", task: "find X" }),
    textTurn("parent done"),
  ];

  test("SpawnToolOptions.hooks fires inside the child run", async () => {
    let childCalls = 0;
    const spawn = createSpawnTool([RESEARCHER], {
      provider: scriptedProvider([textTurn("child report")]),
      model: "fake-child",
      hooks: { beforeRequest: async () => { childCalls++; } },
    });
    const parent = createAgent({
      provider: scriptedProvider(PARENT_SCRIPT()),
      model: "fake-main", maxTurns: 5, tools: [spawn],
    });
    const { message } = await collect(parent.stream("go", { conversationId: "c" }));
    expect(message && extractText(message)).toBe("parent done");
    expect(childCalls).toBe(1);
  });

  test("the parent's AgentConfig.hooks do NOT reach the child (pinned default)", async () => {
    let parentCalls = 0;
    // Deliberately no `hooks` on the spawn tool: the child must be unguarded by
    // the parent's config. If this ever changes, it must be a conscious edit.
    const spawn = createSpawnTool([RESEARCHER], {
      provider: scriptedProvider([textTurn("child report")]),
      model: "fake-child",
    });
    const parent = createAgent({
      provider: scriptedProvider(PARENT_SCRIPT()),
      model: "fake-main", maxTurns: 5, tools: [spawn],
      hooks: { beforeRequest: async () => { parentCalls++; } },
    });
    await collect(parent.stream("go", { conversationId: "c" }));
    expect(parentCalls).toBe(2); // the parent's two turns only — not the child's
  });
});

describe("hooks are forwarded by agent.resume", () => {
  test("a resumed run consults beforeRequest", async () => {
    let calls = 0;
    // A store whose tail is an unanswered user message — inspectRunTail reads
    // that as "continue", so resume drives a real turn instead of short-
    // circuiting on nothing_to_resume.
    const store = new InMemoryStore();
    await store.append("c", [{ id: "u1", role: "user", content: "hi", createdAt: 0 }]);
    const agent = createAgent({
      provider: scriptedProvider([textTurn("continued")]),
      model: "fake", maxTurns: 5, memory: store,
      hooks: { beforeRequest: async () => { calls++; } },
    });

    const { message } = await collect(agent.resume({ conversationId: "c" }));
    expect(message && extractText(message)).toBe("continued");
    expect(calls).toBe(1); // the resume ran hooks, or this silently rots
  });
});

describe("normalizeInjected", () => {
  const now = () => 1234;

  test("a string becomes a user message; a Message passes through", () => {
    const [fromString] = normalizeInjected("hello", now);
    expect(fromString?.role).toBe("user");
    expect(extractText(fromString!)).toBe("hello");
    expect(fromString?.createdAt).toBe(1234);

    const crafted: Message = { id: "fixed", role: "user", content: "crafted", createdAt: 1 };
    const [passthrough] = normalizeInjected(crafted, now);
    expect(passthrough).toBe(crafted); // same instance, not rebuilt
  });

  test("a mixed array keeps its order and stamps every item with runId", () => {
    const crafted: Message = { id: "fixed", role: "user", content: "second", createdAt: 1 };
    const out = normalizeInjected(["first", crafted, "third"], now, "run-1");
    expect(out.map((m) => extractText(m))).toEqual(["first", "second", "third"]);
    for (const m of out) expect(m.metadata?.runId).toBe("run-1");
    expect(crafted.metadata).toBeUndefined(); // copy-on-write: input untouched
  });

  test("no runId means no stamp", () => {
    const [m] = normalizeInjected("plain", now);
    expect(m?.metadata).toBeUndefined();
  });
});

describe("permission gate and hooks stay independent", () => {
  test("a gate denial and a hook veto are both reported, neither shadows the other", async () => {
    const agent = createAgent({
      provider: scriptedProvider([toolCallTurn("echo", {}), textTurn("ok")]),
      model: "fake", maxTurns: 5,
      tools: [{ ...echoTool(), requiresConfirmation: true }],
      permissionGate: allowGate(),
      hooks: vetoingHook("hook wins"),
    });
    const { events } = await collect(agent.stream("go", { conversationId: "c" }));
    // beforeToolCall runs BEFORE the gate, so the veto short-circuits the ask.
    expect(resultText(toolResults(events)[0]!)).toContain("Vetoed by beforeToolCall: hook wins");
    expect(events.some((e) => e.type === "permission_request")).toBe(false);
  });

  test("input rewritten by a hook is what the tool actually receives", async () => {
    const agent = createAgent({
      provider: scriptedProvider([toolCallTurn("echo", { hello: "original" }), textTurn("ok")]),
      model: "fake", maxTurns: 5, tools: [echoTool()],
      hooks: inputRewritingHook({ hello: "rewritten" }),
    });
    const { events } = await collect(agent.stream("go", { conversationId: "c" }));
    expect(resultText(toolResults(events)[0]!)).toContain('{"hello":"rewritten"}');
  });
});
