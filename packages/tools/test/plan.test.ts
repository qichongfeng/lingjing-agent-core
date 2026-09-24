// update_plan — full-replacement contract, input sanitization, onUpdate
// fire-and-forget semantics, and the no-throw guarantee on bad input.

import { describe, expect, it } from "vitest";
import { createPlanTool, type PlanUpdateInfo } from "../src/index.js";
import { testCtx } from "./helpers.js";

const okPlan = [
  { step: "调研 loop 结构", status: "completed" },
  { step: "实现工具", status: "in_progress" },
  { step: "写测试" }, // status defaults to pending
];

describe("createPlanTool", () => {
  it("registers a full plan and returns a progress-rendered confirmation", async () => {
    const tool = createPlanTool();
    const r = await tool.execute({ plan: okPlan }, testCtx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Plan updated (1/3 done)");
    expect(r.content).toContain("1. [completed] 调研 loop 结构");
    expect(r.content).toContain("2. [in_progress] 实现工具");
    expect(r.content).toContain("3. [pending] 写测试");
  });

  it("fires onUpdate with the sanitized plan and ctx identity (sync, before the result resolves)", async () => {
    const seen: PlanUpdateInfo[] = [];
    const tool = createPlanTool({ onUpdate: (info) => seen.push(info) });
    const ctx = testCtx();
    const r = await tool.execute({ plan: [{ step: "  去空格  ", status: "bogus" }] }, ctx).catch((e) => e);
    // bogus status is a Refused: error → no update fired
    expect(r).toMatchObject({ isError: true });
    expect(seen).toHaveLength(0);

    await tool.execute({ plan: [{ step: "  去空格  " }] }, ctx);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.plan).toEqual([{ step: "去空格", status: "pending" }]);
    expect(seen[0]!.conversationId).toBe("c-test");
    expect(seen[0]!.toolCallId).toBe("tc-test");
  });

  it("swallows a throwing onUpdate — the plan is still registered", async () => {
    const tool = createPlanTool({
      onUpdate: () => {
        throw new Error("card renderer crashed");
      },
    });
    const r = await tool.execute({ plan: okPlan }, testCtx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("Plan updated");
  });

  it("refuses a missing / non-array / empty plan", async () => {
    const tool = createPlanTool();
    for (const bad of [undefined, "steps", [], 42]) {
      const r = await tool.execute({ plan: bad }, testCtx());
      expect(r.isError).toBe(true);
      expect(r.content).toContain("Refused: input.plan");
    }
  });

  it("refuses an over-long plan with the limit in the message", async () => {
    const tool = createPlanTool();
    const r = await tool.execute({ plan: Array.from({ length: 25 }, (_, i) => ({ step: `s${i}` })) }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("max 20");
  });

  it("refuses bad entries with the offending index and the valid statuses", async () => {
    const tool = createPlanTool();
    const noText = await tool.execute({ plan: [{ step: "ok" }, { step: "   " }] }, testCtx());
    expect(noText.content).toContain("Refused: input.plan[1].step");

    const badStatus = await tool.execute({ plan: [{ step: "ok", status: "done" }] }, testCtx());
    expect(badStatus.content).toContain("Refused: input.plan[0].status");
    expect(badStatus.content).toContain("pending | in_progress | completed");
    expect(badStatus.content).toContain('"done"');
  });

  it("clamps step text to 500 chars (silently — labels, not prose)", async () => {
    let seen: PlanUpdateInfo | undefined;
    const tool = createPlanTool({ onUpdate: (info) => (seen = info) });
    const r = await tool.execute({ plan: [{ step: "x".repeat(600) }] }, testCtx());
    expect(r.isError).toBeUndefined();
    expect(seen?.plan[0]!.step.length).toBe(500);
  });

  it("returns (aborted) without registering anything when the signal is already aborted", async () => {
    let called = false;
    const tool = createPlanTool({
      onUpdate: () => {
        called = true;
      },
    });
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute({ plan: okPlan }, testCtx(ac.signal));
    expect(called).toBe(false);
    expect(r).toEqual({ content: "(aborted)", isError: true });
  });

  it("carries the status enum in the schema so the model sees valid values upfront", () => {
    const schema = createPlanTool().inputSchema.jsonSchema as {
      properties: { plan: { items: { properties: { status: { enum?: string[] } } } } };
    };
    expect(schema.properties.plan.items.properties.status.enum).toEqual(["pending", "in_progress", "completed"]);
  });
});
