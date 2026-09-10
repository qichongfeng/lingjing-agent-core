// Minimal SSE parser for Anthropic streaming responses.
//
// Anthropic streams `text/event-stream` where each event is one or more `data:`
// lines (a JSON payload) terminated by a blank line. Each payload's `type` field
// discriminates message_start / content_block_start / content_block_delta /
// content_block_stop / message_delta / message_stop / ping / error. There
// is no `[DONE]` sentinel (unlike OpenAI) — the stream ends with a
// `message_stop` event. Event assembly lives in core's sseDataEvents (byte-
// level line splitting, mini-program safe); this wrapper JSON-parses each
// payload as an AnthropicStreamEvent.

import { sseDataEvents } from "@lingjing-agent/core";
import type { AnthropicStreamEvent } from "./types.js";

/**
 * Parse an SSE byte stream into AnthropicStreamEvent objects. Accepts any
 * `AsyncIterable<Uint8Array>` (e.g. `HttpTransportResponse.body`). Malformed
 * JSON payloads are skipped (never thrown). Abort/error of the underlying
 * iterable propagates to the caller (mapStream classifies it via enrichError).
 */
export async function* parseSSE(body: AsyncIterable<Uint8Array>): AsyncIterable<AnthropicStreamEvent> {
  for await (const data of sseDataEvents(body)) {
    try {
      yield JSON.parse(data) as AnthropicStreamEvent;
    } catch {
      /* skip malformed event payload */
    }
  }
}
