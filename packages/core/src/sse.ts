// Cross-runtime byte-stream framing shared by the provider/MCP/tool packages.
//
// splitLines splits a byte stream (HttpTransport response body, stdio stdout)
// into lines at the BYTE level, then decodeUtf8 decodes each complete line.
// Splitting before decoding is what makes multi-byte UTF-8 reassembly across
// chunk boundaries trivial: 0x0A can never appear inside a multi-byte
// sequence, so every yielded line is a complete sequence — characters split
// across transport chunks reassemble in the pending buffer. A trailing \r is
// stripped after the split (CRLF tolerance), never before.
//
// sseDataEvents assembles SSE events on top: `data:` payload lines (one
// leading space stripped, multiple data lines joined with "\n" per the SSE
// spec), blank line = event boundary, `:`-comments and event:/id:/retry:
// ignored, trailing event without a blank line flushed at stream end.

const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** Concatenate byte chunks into one buffer. */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.byteLength;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Yield complete lines (newline-stripped, single trailing \r removed) from a
 * byte stream. The final unterminated line is flushed at stream end. Throws
 * if a single line exceeds 4 MiB — a runaway server must not OOM the host.
 */
export async function* splitLines(
  body: AsyncIterable<Uint8Array>,
  label = "stream",
): AsyncGenerator<Uint8Array> {
  let pending: Uint8Array[] = [];
  let pendingLen = 0;

  /** Extract the first complete line from `pending`, or null if none. Mutates `pending`. */
  const takeLine = (): Uint8Array | null => {
    let scanned = 0;
    for (let i = 0; i < pending.length; i++) {
      const chunk = pending[i]!;
      const nl = chunk.indexOf(0x0a);
      if (nl === -1) {
        scanned += chunk.byteLength;
        continue;
      }
      let line: Uint8Array;
      if (i === 0) {
        line = chunk.subarray(0, nl);
      } else {
        // Line spans chunks 0..i-1 plus the head of chunk i.
        line = new Uint8Array(scanned + nl);
        line.set(concatBytes(pending.slice(0, i)), 0);
        line.set(chunk.subarray(0, nl), scanned);
      }
      const rest = chunk.subarray(nl + 1);
      pending = rest.byteLength > 0 ? [rest] : [];
      pendingLen = rest.byteLength;
      return line.byteLength > 0 && line[line.byteLength - 1] === 0x0d
        ? line.subarray(0, line.byteLength - 1)
        : line;
    }
    return null;
  };

  for await (const chunk of body) {
    pending.push(chunk);
    pendingLen += chunk.byteLength;
    if (pendingLen > MAX_LINE_BYTES) {
      throw new Error(`${label}: line exceeds ${MAX_LINE_BYTES} bytes`);
    }
    let line: Uint8Array | null;
    while ((line = takeLine()) !== null) yield line;
  }
  if (pendingLen > 0) {
    const tail = concatBytes(pending);
    yield tail.byteLength > 0 && tail[tail.byteLength - 1] === 0x0d
      ? tail.subarray(0, tail.byteLength - 1)
      : tail;
  }
}

/**
 * Decode complete UTF-8 bytes to a string. TextDecoder when the runtime has
 * it; a manual decoder otherwise (WeChat mini-program engines lack
 * TextDecoder). Stateless — safe only over complete byte sequences (e.g. the
 * lines splitLines yields, or a fully-buffered body).
 */
export function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder === "function") return new TextDecoder("utf-8").decode(bytes);
  let out = "";
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i++]!;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if (b0 >= 0xc2 && b0 < 0xe0 && i < n) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i++]! & 0x3f));
    } else if (b0 >= 0xe0 && b0 < 0xf0 && i + 1 < n) {
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f));
    } else if (b0 >= 0xf0 && b0 < 0xf8 && i + 2 < n) {
      const cp =
        ((b0 & 0x07) << 18) | ((bytes[i++]! & 0x3f) << 12) | ((bytes[i++]! & 0x3f) << 6) | (bytes[i++]! & 0x3f);
      out += String.fromCodePoint(cp);
    } else {
      out += "�"; // continuation byte lead, truncated sequence, or 5+ byte form
    }
  }
  return out;
}

/** Strip exactly one leading space after the field name (SSE spec). */
function stripOneSpace(s: string): string {
  return s.startsWith(" ") ? s.slice(1) : s;
}

/**
 * Parse an SSE byte stream into `data:` event payloads (raw strings — the
 * caller JSON-parses each as one event payload, e.g. a JSON-RPC message or a
 * ChatCompletionChunk). See module comment for the exact event-assembly rules.
 */
export async function* sseDataEvents(
  body: AsyncIterable<Uint8Array>,
  label = "stream",
): AsyncGenerator<string> {
  let data: string[] = [];
  for await (const lineBytes of splitLines(body, label)) {
    const line = decodeUtf8(lineBytes);
    if (line === "") {
      if (data.length > 0) {
        yield data.join("\n");
        data = [];
      }
    } else if (line.startsWith("data:")) {
      data.push(stripOneSpace(line.slice(5)));
    }
    // `:`-comments, event:, id:, retry: — ignored.
  }
  // Flush a trailing event that was not terminated by a blank line.
  if (data.length > 0) yield data.join("\n");
}
