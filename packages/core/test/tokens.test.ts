import { describe, expect, test } from "vitest";
import {
  estimateContextTokens,
  estimateMessagesTokens,
  estimateTextTokens,
  usageAnchor,
} from "../src/index.js";
import type { Message } from "../src/index.js";

describe("estimateTextTokens (CJK-aware)", () => {
  test("ASCII text stays ~4 chars/token", () => {
    expect(estimateTextTokens("12345678")).toBe(2);
    expect(estimateTextTokens("")).toBe(0);
  });

  test("CJK counts ~1 token per character — the old char/4 undercounted 4×", () => {
    expect(estimateTextTokens("你好世界")).toBe(4);
  });

  test("mixed text splits per character, not per string", () => {
    // 2 CJK (2) + 8 ASCII (2) = 4 — a whole-string char/4 would say 2.5→3
    expect(estimateTextTokens("你好12345678")).toBe(4);
  });

  test("CJK punctuation and fullwidth forms count as CJK", () => {
    expect(estimateTextTokens("。《》!,")).toBe(4);
  });

  test("kana and hangul count as CJK", () => {
    expect(estimateTextTokens("あいうお")).toBe(4);
    expect(estimateTextTokens("한국어")).toBe(3);
  });

  test("astral-plane chars (surrogate pairs) count ≥1 token per unit", () => {
    expect(estimateTextTokens("𠀀𠀁")).toBe(4); // 2 surrogate units each ≈ 2 tokens/char
  });
});

describe("estimateMessagesTokens", () => {
  const msg = (content: Message["content"], role: Message["role"] = "user"): Message => ({
    id: "x", role, content, createdAt: 0,
  });

  test("counts string content, text blocks, tool_result text", () => {
    const msgs = [
      msg("12345678"),
      msg([{ type: "text", text: "12345678" }]),
      msg([{ type: "tool_result", toolCallId: "t", content: "12345678" }]),
    ];
    expect(estimateMessagesTokens(msgs)).toBe(6);
  });

  test("tool_result with block-array content counts its text blocks", () => {
    const msgs = [msg([{ type: "tool_result", toolCallId: "t", content: [{ type: "text", text: "12345678" }] }])];
    expect(estimateMessagesTokens(msgs)).toBe(2);
  });

  test("tool_call input JSON counts (write-file style calls are context too)", () => {
    const msgs = [msg([{ type: "tool_call", id: "c", name: "n", inputJson: "12345678" }], "assistant")];
    expect(estimateMessagesTokens(msgs)).toBe(2);
  });

  test("images are skipped (per-model cost); thinking text is counted (providers replay it)", () => {
    const msgs = [
      msg([
        { type: "image", mediaType: "image/png", data: "AAAA" },
        { type: "thinking", text: "12345678" },
        { type: "text", text: "1234" },
      ]),
    ];
    // thinking (2) + text (1); image contributes 0.
    expect(estimateMessagesTokens(msgs)).toBe(3);
  });
});

describe("usageAnchor / estimateContextTokens", () => {
  const assistantWithUsage = (inputTokens: number, i: number): Message => ({
    id: `a${i}`, role: "assistant", content: "回复", createdAt: i,
    metadata: { usage: { inputTokens, outputTokens: 1 } },
  });
  const plain = (text: string, i: number): Message => ({
    id: `m${i}`, role: "user", content: text, createdAt: i,
  });

  test("no stamped usage → pure heuristic fallback", () => {
    const msgs = [plain("12345678", 0), plain("12345678", 1)];
    expect(estimateContextTokens(msgs)).toBe(estimateMessagesTokens(msgs));
    expect(usageAnchor(msgs)).toBeUndefined();
  });

  test("anchors on the NEWEST usage-bearing assistant; covers everything before it", () => {
    const msgs = [
      plain("旧消息旧消息旧消息旧消息", 0), // 10 CJK = 10 est
      assistantWithUsage(9000, 1), // request covered [0] → real 9000
      plain("新消息新消息", 2), // 5 est
    ];
    const a = usageAnchor(msgs);
    expect(a).toEqual({ inputTokens: 9000, msgCount: 1 });
    expect(estimateContextTokens(msgs)).toBe(9000 + 2 + 6); // real + assistant("回复") + increment("新消息新消息")
  });

  test("zero/invalid usage entries are skipped, later anchors win", () => {
    const msgs = [
      plain("q", 0),
      assistantWithUsage(0, 1), // ignored — nothing real reported
      plain("q2", 2),
      assistantWithUsage(400, 3),
      plain("q3", 4),
    ];
    expect(usageAnchor(msgs)).toEqual({ inputTokens: 400, msgCount: 3 });
  });

  test("non-assistant metadata.usage is not an anchor", () => {
    const msgs = [
      { id: "m0", role: "user", content: "q", createdAt: 0, metadata: { usage: { inputTokens: 100, outputTokens: 1 } } },
      plain("q2", 1),
    ] as Message[];
    expect(usageAnchor(msgs)).toBeUndefined();
  });
});
