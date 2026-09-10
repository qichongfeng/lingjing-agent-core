// Minimal Server-Sent Events parser for OpenAI streaming responses.
//
// OpenAI streams `text/event-stream` where each event is one or more `data:`
// lines terminated by a blank line, and the stream ends with `data: [DONE]`.
// Event assembly (byte-level line splitting, multi-byte reassembly across
// chunks, CRLF tolerance, trailing-event flush) lives in core's
// sseDataEvents — shared with the MCP bridge and mini-program safe. This
// wrapper JSON-parses each payload into a ChatCompletionChunk and honors
// OpenAI's [DONE] sentinel.

import { sseDataEvents } from "@lingjing-agent/core";
import type { ChatCompletionChunk } from "./types.js";

/**
 * Parse an SSE byte stream into ChatCompletionChunk objects. Accepts any
 * `AsyncIterable<Uint8Array>` (e.g. an `HttpTransport` body), freeing the
 * caller from the Web `Response`/`ReadableStream` shape. Malformed JSON
 * payloads are skipped (never thrown) — a single bad event should not kill an
 * otherwise healthy stream. Abort/error of the underlying iterable propagates
 * to the caller (mapStream classifies it via enrichError).
 */
export async function* parseSSE(body: AsyncIterable<Uint8Array>): AsyncIterable<ChatCompletionChunk> {
  for await (const data of sseDataEvents(body)) {
    if (data === "[DONE]") return;
    try {
      yield JSON.parse(data) as ChatCompletionChunk;
    } catch {
      /* skip malformed event payload */
    }
  }
}
