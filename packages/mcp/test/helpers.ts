// Shared test helpers: a minimal ToolCallContext for direct tool.execute()
// calls, a byte-level body chunker, and an in-memory McpTransport fake.

import type { ToolCallContext } from "@lingjing-agent/core";
import type { McpTransport } from "../src/mcp-transport.js";
import type { JsonRpcMessage } from "../src/json-rpc.js";

export function testCtx(signal?: AbortSignal): ToolCallContext {
  return {
    signal: signal ?? new AbortController().signal,
    toolCallId: "tc-test",
    conversationId: "c-test",
    runtime: "node",
    log: () => {},
  };
}

/**
 * Wrap text as an AsyncIterable<Uint8Array> in fixed-size chunks. Chunks are
 * cut at the BYTE level (not character level) so multi-byte characters are
 * split across chunks — exercising the reassembly paths.
 */
export function bodyOf(text: string, chunkSize = 7): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  async function* gen(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < bytes.length; i += chunkSize) {
      yield bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    }
  }
  return gen();
}

export interface FakeMcpTransport extends McpTransport {
  /** Every message handed to send(), in order. */
  readonly sent: JsonRpcMessage[];
  /** Program per-send behavior (e.g. throw McpSessionExpiredError). Default: resolve. */
  onSend?: ((msg: JsonRpcMessage) => void | Promise<void>) | undefined;
  /** Inject a server→client message through the registered listener. */
  emit(msg: JsonRpcMessage): void;
  /** Simulate fatal transport loss. */
  fail(err?: Error): void;
  /** Whether close() has been called. */
  readonly closed: boolean;
  /** Number of reopen() calls. Present only when reopenable (see opts). */
  readonly reopenCalls: number;
  /** Calls recorded for the HTTP-only optional hooks (absent on real stdio). */
  readonly protocolVersionCalls: string[];
  readonly resetSessionCalls: number;
}

/** Reopenable transports (mkdir the stdio/http shape) mark transport loss as
 *  reconnectable (dead) rather than terminal. */
export function fakeMcpTransport(label = "fake", reopenable = false): FakeMcpTransport {
  const sent: JsonRpcMessage[] = [];
  const protocolVersionCalls: string[] = [];
  let resetSessionCalls = 0;
  let reopenCalls = 0;
  let msgListener: ((msg: JsonRpcMessage) => void) | undefined;
  let closeListener: ((err?: Error) => void) | undefined;
  let closed = false;
  const t: FakeMcpTransport = {
    label,
    sent,
    protocolVersionCalls,
    get resetSessionCalls() {
      return resetSessionCalls;
    },
    get reopenCalls() {
      return reopenCalls;
    },
    get closed() {
      return closed;
    },
    send(msg) {
      sent.push(msg);
      return t.onSend ? Promise.resolve(t.onSend(msg)).then(() => undefined) : Promise.resolve();
    },
    onMessage(l) {
      msgListener = l;
    },
    onClose(l) {
      closeListener = l;
    },
    close() {
      closed = true;
      return Promise.resolve();
    },
    setProtocolVersion(v) {
      protocolVersionCalls.push(v);
    },
    resetSession() {
      resetSessionCalls += 1;
    },
    ...(reopenable
      ? {
          reopen() {
            reopenCalls += 1;
            closed = false;
            return Promise.resolve();
          },
        }
      : {}),
    emit(msg) {
      msgListener?.(msg);
    },
    fail(err) {
      closed = true;
      closeListener?.(err);
    },
  };
  return t;
}
