// stdio server channel — BE an MCP server over this process's stdin/stdout:
// read newline-delimited JSON-RPC requests from stdin, write responses to
// stdout. The counterpart of ./stdio (which spawns a server child); this one
// serves when the host process IS the MCP server (e.g. a daemon exposing
// core tools).
//
// Node/Electron/Tauri-main ONLY (imports node:process) — reachable solely
// through the "./node" subpath entry; the package's main entry stays free of
// node:* imports.
//
// Discipline (mirrors ./stdio): a serialized stdout write queue (parallel
// tool calls must not interleave frames), the 4 MiB frame guard, and
// newline-delimited frames parsed by parseJsonRpcMessage (banner text /
// garbage on stdin is skipped — never kills the pump). Server-side logging
// goes to stderr; stdout is the protocol channel and must never carry logs.

import { decodeUtf8, splitLines } from "@lingjing-agent/core";
import { parseJsonRpcMessage, type JsonRpcMessage } from "../json-rpc.js";
import type { McpServerChannel } from "../server.js";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export interface StdioMcpServerChannelOptions {
  /** Server log handling: "ignore" (default), "inherit", or a per-line callback. */
  stderr?: "ignore" | "inherit" | ((line: string) => void);
}

export function createStdioMcpServerChannel(opts: StdioMcpServerChannelOptions = {}): McpServerChannel {
  const stderrMode = opts.stderr ?? "ignore";
  const label = "stdio";

  let msgListener: ((msg: JsonRpcMessage) => void) | undefined;
  let closeListener: ((err?: Error) => void) | undefined;
  let closed = false;

  // stdin: NDJSON frames → JsonRpcMessage. Noise (blank/garbage lines) is skipped.
  void (async () => {
    try {
      for await (const lineBytes of splitLines(process.stdin, label)) {
        const msg = parseJsonRpcMessage(decodeUtf8(lineBytes));
        if (msg !== undefined) msgListener?.(msg);
      }
    } catch {
      // Stream errors surface through the close path below.
    }
    if (!closed) {
      closed = true;
      closeListener?.(new Error(`${label}: stdin closed`));
    }
  })();

  // Serialized writes: a promise chain so response frames never interleave
  // even when several tools/call settle at once.
  let writeChain: Promise<void> = Promise.resolve();

  const channel: McpServerChannel = {
    label,
    send(msg: JsonRpcMessage): Promise<void> {
      if (closed) return Promise.reject(new Error(`${label}: channel closed`));
      const frame = `${JSON.stringify(msg)}\n`;
      if (frame.length > MAX_FRAME_BYTES) {
        return Promise.reject(new Error(`${label}: frame exceeds ${MAX_FRAME_BYTES} bytes`));
      }
      writeChain = writeChain.then(
        () =>
          new Promise<void>((resolve, reject) => {
            if (process.stdout.destroyed) {
              reject(new Error(`${label}: stdout closed`));
              return;
            }
            process.stdout.write(frame, "utf8", (err) => (err ? reject(err) : resolve()));
          }),
      );
      return writeChain;
    },
    onMessage(l) {
      msgListener = l;
    },
    onClose(l) {
      closeListener = l;
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve();
      closed = true;
      process.stdin.destroy();
      return Promise.resolve();
    },
  };

  if (stderrMode !== "ignore" && typeof stderrMode === "function") {
    // Nothing to read from our own stderr here — the callback form is accepted
    // for option parity with ./stdio; process stderr is the process's own.
  }
  return channel;
}
