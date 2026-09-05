// Minimal SSE parser for Anthropic streaming responses.
//
// Anthropic streams `text/event-stream` where each event is one or more `data:`
// lines (a JSON payload) terminated by a blank line. Each payload's `type` field
// discriminates message_start / content_block_start / content_block_delta /
// content_block_stop / message_delta / message_stop / ping / error. There is no
// `[DONE]` sentinel (unlike OpenAI) — the stream ends with a `message_stop` event.

import type { AnthropicStreamEvent } from "./types.js";

/**
 * Parse an SSE byte stream into AnthropicStreamEvent objects. Accepts any
 * `AsyncIterable<Uint8Array>` (e.g. `HttpTransportResponse.body`). Malformed
 * JSON payloads are skipped (never thrown). Abort/error of the underlying
 * iterable propagates to the caller (mapStream classifies it via enrichError).
 */
export async function* parseSSE(body: AsyncIterable<Uint8Array>): AsyncIterable<AnthropicStreamEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: string[] = [];

  const flush = function* (): Generator<AnthropicStreamEvent> {
    for (const data of pending) {
      try {
        yield JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        /* skip malformed event payload */
      }
    }
    pending.length = 0;
  };

  for await (const value of body) {
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line === "") {
        for (const ev of flush()) yield ev;
      } else if (line.startsWith("data:")) {
        pending.push(line.slice(5).replace(/^ /, ""));
      }
      // Other SSE fields (event:, id:, retry:, comments) are ignored — `type`
      // is already in the data JSON.
    }
  }
  buffer += decoder.decode();
  if (buffer.trim() !== "") {
    const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    if (line.startsWith("data:")) pending.push(line.slice(5).replace(/^ /, ""));
  }
  for (const ev of flush()) yield ev;
}
