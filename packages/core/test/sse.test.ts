// splitLines / decodeUtf8 / sseDataEvents: byte-level framing, multi-byte
// reassembly across chunks, CRLF, event assembly rules, caps.

import { describe, expect, it } from "vitest";
import { decodeUtf8, splitLines, sseDataEvents } from "../src/index.js";

/** Wrap text as an AsyncIterable<Uint8Array> in fixed-size byte chunks. */
function bodyOf(text: string, chunkSize = 7): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  async function* gen(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      yield bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    }
  }
  return gen();
}

async function lines(text: string, chunkSize?: number): Promise<string[]> {
  const out: string[] = [];
  for await (const line of splitLines(bodyOf(text, chunkSize), "test")) out.push(decodeUtf8(line));
  return out;
}

async function events(text: string, chunkSize?: number): Promise<string[]> {
  const out: string[] = [];
  for await (const ev of sseDataEvents(bodyOf(text, chunkSize), "test")) out.push(ev);
  return out;
}

describe("splitLines + decodeUtf8", () => {
  it("splits simple lines and drops the terminator", async () => {
    expect(await lines("a\nb\nc\n")).toEqual(["a", "b", "c"]);
  });

  it("flushes a trailing line without terminator", async () => {
    expect(await lines("a\nb")).toEqual(["a", "b"]);
  });

  it("returns no lines for an empty stream", async () => {
    expect(await lines("")).toEqual([]);
  });

  it("strips a single trailing CR (CRLF) but keeps interior CRs", async () => {
    expect(await lines("a\r\nb\r\nc\n")).toEqual(["a", "b", "c"]);
    expect(await lines("a\rb\n")).toEqual(["a\rb"]);
  });

  it("reassembles multi-byte characters split across 1-byte chunks", async () => {
    expect(await lines("灵境 agent 🎉\n中文", 1)).toEqual(["灵境 agent 🎉", "中文"]);
  });

  it("reassembles a single line split across many chunks", async () => {
    const long = "x".repeat(5000) + "尾巴";
    expect(await lines(`${long}\nnext`, 13)).toEqual([long, "next"]);
  });

  it("decodeUtf8 replaces invalid bytes with U+FFFD", () => {
    expect(decodeUtf8(new Uint8Array([0xff, 0xfe]))).toBe("��");
  });

  it("throws when a single line exceeds 4 MiB", async () => {
    const huge = "a".repeat(4 * 1024 * 1024 + 10) + "\n";
    await expect(async () => {
      for await (const _ of splitLines(bodyOf(huge, 65536), "test")) {
        /* drain */
      }
    }).rejects.toThrow(/line exceeds/);
  });
});

describe("sseDataEvents", () => {
  it("yields one payload per blank-line-terminated event", async () => {
    expect(await events('data: {"a":1}\n\ndata: {"b":2}\n\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("strips exactly one leading space after data:", async () => {
    expect(await events("data:no-space\ndata: one-space\n\n")).toEqual(["no-space\none-space"]);
  });

  it("joins multiple data: lines of one event with \\n", async () => {
    expect(await events("data: line1\ndata: line2\n\n")).toEqual(["line1\nline2"]);
  });

  it("ignores comments, event:, id:, retry: fields", async () => {
    const text = ": keep-alive\nevent: message\nid: 7\nretry: 100\ndata: payload\n\n";
    expect(await events(text)).toEqual(["payload"]);
  });

  it("flushes a trailing event without a blank line", async () => {
    expect(await events("data: tail")).toEqual(["tail"]);
  });

  it("reassembles payloads with multi-byte chars split at 1-byte granularity", async () => {
    const payload = JSON.stringify({ text: "灵境✨跨界" });
    expect(await events(`data: ${payload}\n\n`, 1)).toEqual([payload]);
  });

  it("handles CRLF delimiters end to end", async () => {
    expect(await events("data: a\r\n\r\ndata: b\r\n\r\n")).toEqual(["a", "b"]);
  });

  it("produces nothing for an empty stream", async () => {
    expect(await events("")).toEqual([]);
  });
});
