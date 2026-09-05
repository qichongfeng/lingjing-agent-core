import { describe, expect, test } from "vitest";
import { redact, redactEvents, SECRET_PATTERNS, type AgentEvent, type Message } from "../src/index.js";

const ev = (e: AgentEvent): AgentEvent => e;

describe("redact", () => {
  test("masks secrets in text_delta text", () => {
    const e = redact(ev({
      type: "text_delta", conversationId: "c", turn: 1, ts: 0,
      text: "leaked key sk-ant-abc123XYZ and a Bearer abc.def.ghi token",
    })) as Extract<AgentEvent, { type: "text_delta" }>;
    expect(e.text).toContain("sk-ant-***");
    expect(e.text).toContain("Bearer ***");
    expect(e.text).not.toContain("sk-ant-abc123XYZ");
  });

  test("masks secrets in tool_result content strings", () => {
    const e = redact(ev({
      type: "tool_result", conversationId: "c", turn: 1, ts: 0,
      toolCallId: "tc", isError: false, ms: 1,
      content: [{ type: "text", text: "AKIAIOSFODNN7EXAMPLE found" }],
    })) as Extract<AgentEvent, { type: "tool_result" }>;
    const text = e.content.map((b) => (b as { text?: string }).text ?? "").join("");
    expect(text).toContain("AKIA***");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  test("masks secrets in the error.message field", () => {
    const e = redact(ev({
      type: "error", conversationId: "c", turn: 1, ts: 0,
      message: "failed token=abcdef0123456789 here", code: "x", recoverable: false,
    })) as Extract<AgentEvent, { type: "error" }>;
    expect(e.message).toContain("<redacted>");
    expect(e.message).not.toContain("abcdef0123456789");
  });

  test("drops secret-named Message.metadata keys, keeps the rest", () => {
    const m: Message = {
      id: "m1", role: "user", content: "hi", createdAt: 0,
      metadata: { apiKey: "sk-ant-x", userId: "u1", token: "t" },
    };
    const r = redact(m) as Message;
    expect(r.metadata).toBeDefined();
    expect(Object.keys(r.metadata ?? {})).not.toContain("apiKey");
    expect(Object.keys(r.metadata ?? {})).not.toContain("token");
    expect((r.metadata as Record<string, unknown>).userId).toBe("u1");
  });

  test("does not mutate the input", () => {
    const orig: Message = { id: "m", role: "user", content: "sk-ant-secret", createdAt: 0 };
    redact(orig);
    expect(orig.content).toBe("sk-ant-secret");
  });

  test("non-secret events pass through with text intact", () => {
    const e = redact(ev({
      type: "text_delta", conversationId: "c", turn: 1, ts: 0, text: "just normal words",
    })) as Extract<AgentEvent, { type: "text_delta" }>;
    expect(e.text).toBe("just normal words");
  });

  test("redactEvents maps over an array", () => {
    const out = redactEvents([
      ev({ type: "text_delta", conversationId: "c", turn: 1, ts: 0, text: "sk-ant-z" }),
      ev({ type: "text_delta", conversationId: "c", turn: 1, ts: 0, text: "ok" }),
    ]);
    expect(out.length).toBe(2);
    expect((out[0] as Extract<AgentEvent, { type: "text_delta" }>).text).toBe("sk-ant-***");
    expect((out[1] as Extract<AgentEvent, { type: "text_delta" }>).text).toBe("ok");
  });

  test("SECRET_PATTERNS is exported", () => {
    expect(Array.isArray(SECRET_PATTERNS)).toBe(true);
    expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
  });
});
