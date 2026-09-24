// createPermissionRules — the rule-based gate: deny-wins static rules
// (order-independent), remembered decisions with fingerprints, ask fallback,
// snapshot round-trip, and loop integration (tags reach the gate).

import { describe, expect, test } from "vitest";
import {
  createAgent,
  createPermissionRules,
  extractText,
  type AgentEvent,
  type Message,
  type PermissionCall,
  type StreamHandle,
  type Tool,
} from "../src/index.js";
import { scriptedProvider, textTurn, toolCallTurn } from "./helpers/index.js";

const idle = (): AbortSignal => new AbortController().signal;

function call(partial: Partial<PermissionCall> & { name: string }): PermissionCall {
  return { toolCallId: "t1", input: {}, destructive: false, ...partial };
}

describe("createPermissionRules — static rules", () => {
  test("allow by tool name; deny by tag", async () => {
    const gate = createPermissionRules({
      rules: [
        { tool: "read_file", effect: "allow" },
        { tag: "fs:write", effect: "deny" },
      ],
    });
    await expect(gate.request(call({ name: "read_file" }), idle())).resolves.toEqual({ allow: true });
    const denied = await gate.request(call({ name: "write_file", tags: ["artifact:edit", "fs:write"] }), idle());
    expect(denied).toMatchObject({ allow: false });
    if (!denied.allow) expect(denied.reason).toContain("tag=fs:write");
  });

  test("deny beats allow regardless of order — a hard deny is unbypassable", async () => {
    const gate = createPermissionRules({
      rules: [
        { tool: "shell", effect: "allow" }, // listed first on purpose
        { tool: "shell", when: () => true, effect: "deny" },
      ],
    });
    await expect(gate.request(call({ name: "shell" }), idle())).resolves.toMatchObject({ allow: false });
  });

  test("`when` refines: allow npm-* commands only; others fall through", async () => {
    const gate = createPermissionRules({
      rules: [{ tool: "shell", when: (i) => typeof (i as { cmd?: string }).cmd === "string" && (i as { cmd: string }).cmd.startsWith("npm "), effect: "allow" }],
    });
    await expect(gate.request(call({ name: "shell", input: { cmd: "npm test" } }), idle())).resolves.toEqual({ allow: true });
    const other = await gate.request(call({ name: "shell", input: { cmd: "rm -rf /" } }), idle());
    expect(other).toMatchObject({ allow: false }); // fell through: no ask → deny
  });

  test("unmatched + no onAsk → deny-by-default with a diagnosable reason", async () => {
    const gate = createPermissionRules({ rules: [{ tool: "other", effect: "allow" }] });
    const r = await gate.request(call({ name: "mystery" }), idle());
    expect(r).toMatchObject({ allow: false });
    if (!r.allow) expect(r.reason).toContain("No permission rule matched");
  });
});

describe("createPermissionRules — ask + remember", () => {
  test("unmatched goes to onAsk; remember:true skips the ask next time (same fingerprint)", async () => {
    let asks = 0;
    const gate = createPermissionRules({
      onAsk: async (c) => {
        asks++;
        return { allow: true, reason: "ok", remember: true, ...(c.name === "never" ? {} : {}) };
      },
    });
    await expect(gate.request(call({ name: "shell" }), idle())).resolves.toEqual({ allow: true });
    await expect(gate.request(call({ name: "shell" }), idle())).resolves.toEqual({ allow: true });
    expect(asks).toBe(1); // second call answered from memory
    // A different tool has a different default fingerprint → asks again.
    await expect(gate.request(call({ name: "other" }), idle())).resolves.toEqual({ allow: true });
    expect(asks).toBe(2);
  });

  test("fingerprintOf: remembered per-target (per path), not per tool", async () => {
    let asks = 0;
    const gate = createPermissionRules({
      fingerprintOf: (c) => String((c.input as { path?: string }).path ?? ""),
      onAsk: async () => {
        asks++;
        return { allow: true, remember: true };
      },
    });
    await gate.request(call({ name: "edit_file", input: { path: "a.html" } }), idle());
    await gate.request(call({ name: "edit_file", input: { path: "a.html" } }), idle());
    expect(asks).toBe(1);
    await gate.request(call({ name: "edit_file", input: { path: "b.html" } }), idle());
    expect(asks).toBe(2);
  });

  test("ask can deny (and remember the deny); forgetAll resets", async () => {
    const gate = createPermissionRules({
      onAsk: async () => ({ allow: false, reason: "nope", remember: true }),
    });
    const r = await gate.request(call({ name: "shell" }), idle());
    expect(r).toMatchObject({ allow: false, reason: "nope" });
    // Remembered deny answers without asking again.
    const r2 = await gate.request(call({ name: "shell" }), idle());
    expect(r2).toMatchObject({ allow: false });
    if (!r2.allow) expect(r2.reason).toContain("remembered");
    gate.forgetAll();
    const r3 = await gate.request(call({ name: "shell" }), idle());
    expect(r3).toMatchObject({ allow: false, reason: "nope" }); // asked again
  });

  test("onAsk modifiedInput passes through as a decision rewrite", async () => {
    const gate = createPermissionRules({
      onAsk: async () => ({ allow: true, modifiedInput: { sanitized: true } }),
    });
    await expect(gate.request(call({ name: "shell", input: { cmd: "rm -rf /" } }), idle())).resolves.toEqual({
      allow: true,
      modifiedInput: { sanitized: true },
    });
  });

  test("a remembered allow never bypasses a static deny (hard policy wins)", async () => {
    const gate = createPermissionRules({
      rules: [{ tag: "destructive", effect: "deny" }],
    });
    gate.remember("allow", "nuke", "");
    await expect(gate.request(call({ name: "nuke", tags: ["destructive"] }), idle())).resolves.toMatchObject({ allow: false });
  });

  test("snapshot round-trip seeds a fresh gate (with the same fingerprintOf)", async () => {
    const byPath = (c: PermissionCall) => String((c.input as { path?: string }).path ?? "");
    const g1 = createPermissionRules({ fingerprintOf: byPath, onAsk: async () => ({ allow: true, remember: true }) });
    await g1.request(call({ name: "edit_file", input: { path: "x.html" } }), idle());
    const snap = g1.snapshot();
    expect(snap).toEqual([{ tool: "edit_file", fingerprint: "x.html", effect: "allow" }]);

    let asks = 0;
    const g2 = createPermissionRules({ remembered: snap, fingerprintOf: byPath, onAsk: async () => { asks++; return { allow: false }; } });
    await expect(g2.request(call({ name: "edit_file", input: { path: "x.html" } }), idle())).resolves.toEqual({ allow: true });
    expect(asks).toBe(0);
  });
});

describe("loop integration", () => {
  test("the gate sees the tool's tags; an allow-by-tag rule lets the call run", async () => {
    const seenTags: Array<string[] | undefined> = [];
    const gate = createPermissionRules({
      onAsk: async (c) => {
        seenTags.push(c.tags);
        return { allow: false, reason: "asked" };
      },
    });
    const taggedTool: Tool = {
      name: "guarded",
      description: "x",
      inputSchema: { jsonSchema: { type: "object" } },
      requiresConfirmation: true,
      permissions: { tags: ["artifact:edit"] },
      async execute() {
        return { content: "ran" };
      },
    };
    const provider = scriptedProvider([toolCallTurn("guarded", {}, 0), textTurn("ok")]);
    const agent = createAgent({ provider, model: "fake", maxTurns: 5, tools: [taggedTool], permissionGate: gate });
    const { events, message } = await collect(agent.stream("go", { conversationId: "perm-1" }));
    expect(seenTags).toEqual([["artifact:edit"]]); // tags reached the gate
    const denied = events.find((e) => e.type === "tool_result" && e.isError);
    expect(denied).toBeDefined();
    expect(message && extractText(message)).toBe("ok");

    // Same agent shape, but allow by tag → executes.
    const allowGate = createPermissionRules({ rules: [{ tag: "artifact:edit", effect: "allow" }] });
    const provider2 = scriptedProvider([toolCallTurn("guarded", {}, 1), textTurn("ok")]);
    const agent2 = createAgent({ provider: provider2, model: "fake", maxTurns: 5, tools: [taggedTool], permissionGate: allowGate });
    const r2 = await collect(agent2.stream("go", { conversationId: "perm-2" }));
    expect(r2.events.some((e) => e.type === "tool_result" && !e.isError)).toBe(true);
  });
});

async function collect(handle: StreamHandle): Promise<{ events: AgentEvent[]; message?: Message }> {
  const events: AgentEvent[] = [];
  for await (const e of handle.events) events.push(e);
  try {
    return { events, message: await handle.done };
  } catch {
    return { events };
  }
}

describe("createPermissionRules — cross-session persistence (persist)", () => {
  test("load() seeds decisions; the first request awaits it", async () => {
    let asks = 0;
    const gate = createPermissionRules({
      persist: { load: async () => [{ tool: "shell", fingerprint: "", effect: "allow" }], save: () => {} },
      onAsk: async () => { asks++; return { allow: false }; },
    });
    // No artificial waiting: request() itself must await the async load.
    await expect(gate.request(call({ name: "shell" }), idle())).resolves.toEqual({ allow: true });
    expect(asks).toBe(0);
  });

  test("ask-remember and remember() trigger save() with the full snapshot", async () => {
    const saved: Array<{ tool: string; fingerprint: string; effect: string }[]> = [];
    const gate = createPermissionRules({
      fingerprintOf: (c) => String((c.input as { path?: string }).path ?? ""),
      onAsk: async () => ({ allow: true, remember: true }),
      persist: { load: async () => [], save: (snap) => { saved.push(snap); } },
    });
    await gate.request(call({ name: "edit_file", input: { path: "a.html" } }), idle());
    expect(saved).toEqual([[{ tool: "edit_file", fingerprint: "a.html", effect: "allow" }]]);
    gate.remember("deny", "shell", "rm ");
    expect(saved[1]).toEqual([
      { tool: "edit_file", fingerprint: "a.html", effect: "allow" },
      { tool: "shell", fingerprint: "rm ", effect: "deny" },
    ]);
    gate.forgetAll();
    expect(saved[2]).toEqual([]);
  });

  test("round trip through a hostile storage: failing load starts blank; failing save never breaks the flow", async () => {
    const gate1 = createPermissionRules({
      onAsk: async () => ({ allow: true, remember: true }),
      persist: { load: async () => [], save: () => {} },
    });
    await gate1.request(call({ name: "shell" }), idle());
    const snap = gate1.snapshot();

    const brokenLoad = createPermissionRules({
      remembered: snap,
      persist: { load: async () => Promise.reject(new Error("idb gone")), save: () => { throw new Error("disk full"); } },
      onAsk: async () => ({ allow: false, reason: "asked" }),
    });
    // Seeded memory still applies (load failure is ignored, not merged).
    await expect(brokenLoad.request(call({ name: "shell" }), idle())).resolves.toEqual({ allow: true });
    brokenLoad.remember("deny", "other");
    await expect(brokenLoad.request(call({ name: "third" }), idle())).resolves.toMatchObject({ allow: false });
  });
});
