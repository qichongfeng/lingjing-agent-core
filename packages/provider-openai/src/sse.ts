// Minimal Server-Sent Events parser for OpenAI streaming responses.
//
// OpenAI streams `text/event-stream` where each event is one or more `data:`
// lines terminated by a blank line, and the stream ends with `data: [DONE]`.
// We split the byte stream into lines, accumulate `data:` payloads per event,
// and yield each as a parsed ChatCompletionChunk. Consumes any
// `AsyncIterable<Uint8Array>` (typically an HttpTransport body), so it runs in
// any runtime that can produce one — Node, browsers, Edge, AND mini-programs
// (whose wx.request transport yields chunked bytes without a Web ReadableStream).

import type { ChatCompletionChunk } from "./types.js";

/**
 * Parse an SSE byte stream into ChatCompletionChunk objects. Accepts any
 * `AsyncIterable<Uint8Array>` (e.g. `HttpTransportResponse.body`), freeing the
 * caller from the Web `Response`/`ReadableStream` shape. Malformed JSON payloads
 * are skipped (never thrown) — a single bad event should not kill an otherwise
 * healthy stream. Abort/error of the underlying iterable propagates to the
 * caller (mapStream classifies it via enrichError).
 */
export async function* parseSSE(body: AsyncIterable<Uint8Array>): AsyncIterable<ChatCompletionChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: string[] = [];

  const flush = function* (): Generator<ChatCompletionChunk> {
    for (const data of pending) {
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data) as ChatCompletionChunk;
      } catch {
        /* skip malformed event payload */
      }
    }
    pending.length = 0;
  };

  for await (const value of body) {
    buffer += decoder.decode(value, { stream: true });
    // Split on newline; the final element is the incomplete trailing line.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line === "") {
        // Blank line = event boundary → emit accumulated data parts.
        for (const chunk of flush()) yield chunk;
      } else if (line.startsWith("data:")) {
        pending.push(line.slice(5).replace(/^ /, ""));
      }
      // Other SSE fields (event:, id:, retry:, comments) are ignored.
    }
  }
  // Flush any trailing partial event at stream close.
  buffer += decoder.decode();
  if (buffer.trim() !== "") {
    const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
    if (line.startsWith("data:")) pending.push(line.slice(5).replace(/^ /, ""));
  }
  for (const chunk of flush()) yield chunk;
}
