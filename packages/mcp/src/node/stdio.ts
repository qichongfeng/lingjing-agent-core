// stdio transport — spawn an MCP server as a child process and speak
// newline-delimited JSON-RPC over its stdin/stdout (the stdio binding).
//
// Node/Electron/Tauri-main ONLY (imports node:child_process) — this file is
// reachable solely through the "./node" subpath entry; the package's main
// entry stays free of node:* imports for browser/Edge/mini-program bundles.
//
// Discipline (mirrors tools-node's shell hardening): argv-direct spawn
// (shell: false), windowsHide, a serialized stdin write queue (parallel tool
// calls in one agent turn multiplex one child — frames must not interleave),
// 4 MiB frame guard, stderr for server logs, and SIGTERM → SIGKILL close.
//
// Reconnect: an unexpected child exit signals McpClient via onClose but does
// NOT permanently close the transport; `reopen()` respawns the child so the
// client can re-handshake (exponential backoff lives in McpClient).

import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { decodeUtf8, splitLines } from "@lingjing-agent/core";
import { parseJsonRpcMessage, type JsonRpcMessage } from "../json-rpc.js";
import type { McpTransport, McpTransportSendOptions } from "../mcp-transport.js";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_CLOSE_GRACE_MS = 3_000;
const CLOSE_GUARD_MS = 5_000;

export interface StdioMcpTransportOptions {
  /** Executable to spawn — argv-direct, never through a shell. */
  command: string;
  args?: string[];
  /** Merged OVER process.env ({ ...process.env, ...env }). */
  env?: Record<string, string>;
  cwd?: string;
  /** Server log handling: "ignore" (default), "inherit", or a per-line callback. */
  stderr?: "ignore" | "inherit" | ((line: string) => void);
  /** SIGTERM → SIGKILL grace on close(). Default 3_000. */
  closeGraceMs?: number;
}

export function createStdioMcpTransport(opts: StdioMcpTransportOptions): McpTransport {
  const stderrMode = opts.stderr ?? "ignore";
  const label = `stdio ${opts.command}${(opts.args ?? []).map((a) => ` ${a}`).join("")}`;

  let msgListener: ((msg: JsonRpcMessage) => void) | undefined;
  let closeListener: ((err?: Error) => void) | undefined;
  let closeErr: Error | undefined;
  /** Deliberate close() (terminal) — distinct from a child that just exited. */
  let closed = false;
  let child: ChildProcess | undefined;
  /** Serialized writes promise chain — per child (reset on respawn). */
  let writeChain: Promise<void> = Promise.resolve();
  let closeDone: (() => void) | undefined;

  const spawnChild = (): ChildProcess => {
    const stdio: StdioOptions = [
      "pipe",
      "pipe",
      stderrMode === "ignore" || stderrMode === "inherit" ? stderrMode : "pipe",
    ];
    const c = spawn(opts.command, opts.args ?? [], {
      stdio,
      windowsHide: true,
      ...(opts.cwd !== undefined && { cwd: opts.cwd }),
      ...(opts.env !== undefined && { env: { ...process.env, ...opts.env } }),
    });

    // stdout: NDJSON frames → JsonRpcMessage. Noise (blank/garbage lines) is skipped.
    c.stdout !== null &&
      void (async () => {
        try {
          for await (const lineBytes of splitLines(c.stdout!, label)) {
            const msg = parseJsonRpcMessage(decodeUtf8(lineBytes));
            if (msg !== undefined) msgListener?.(msg);
          }
        } catch {
          // Stream errors surface through the child's close/error events.
        }
      })();

    c.stderr !== null &&
      typeof stderrMode === "function" &&
      void (async () => {
        try {
          for await (const lineBytes of splitLines(c.stderr!, `${label} stderr`)) {
            stderrMode(decodeUtf8(lineBytes));
          }
        } catch {
          /* stderr is best-effort */
        }
      })();

    c.on("error", (err) => onChildExit(err instanceof Error ? err : new Error(String(err))));
    c.on("close", (code, signal) => {
      const err = new Error(`${label}: server exited (code ${code ?? "?"}, signal ${signal ?? "-"})`);
      onChildExit(err);
      closeDone?.();
    });
    return c;
  };

  const onChildExit = (err: Error): void => {
    if (closed) return; // deliberate close — already cleaned up
    closeErr = err;
    // Signal the client (unless this is the child we closed on purpose).
    closeListener?.(err);
  };

  child = spawnChild();

  // Serialized writes: a promise chain so JSON frames never interleave even
  // when the agent loop runs tool calls in parallel over one session.
  const writeOne = (frame: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const stdin = child?.stdin;
      if (stdin === null || stdin === undefined || stdin.destroyed) {
        reject(closeErr ?? new Error(`${label}: stdin closed`));
        return;
      }
      stdin.write(frame, "utf8", (err) => (err ? reject(err) : resolve()));
    });

  const transport: McpTransport = {
    label,
    // opts ignored by design: stdio cancellation is `notifications/cancelled`
    // (driven by McpClient); the child itself is not killed per-call.
    send(msg: JsonRpcMessage, _opts?: McpTransportSendOptions): Promise<void> {
      if (closed) return Promise.reject(closeErr ?? new Error(`${label}: transport closed`));
      const frame = `${JSON.stringify(msg)}\n`;
      if (frame.length > MAX_FRAME_BYTES) {
        return Promise.reject(new Error(`${label}: frame exceeds ${MAX_FRAME_BYTES} bytes`));
      }
      writeChain = writeChain.then(() => writeOne(frame));
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
      child?.stdin?.end();
      child?.kill("SIGTERM");
      const graceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
      const killTimer = setTimeout(() => child?.kill("SIGKILL"), graceMs);
      // The guard bounds how long close() WAITS — it never disarms the SIGKILL
      // (a SIGTERM-ignoring child must still die), so wait at least the grace
      // period; the child actually exiting resolves earliest via closeDone.
      return new Promise<void>((resolve) => {
        const guard = setTimeout(() => {
          clearTimeout(killTimer); // no-op unless the clock misbehaved: kill fired first
          resolve();
        }, Math.max(CLOSE_GUARD_MS, graceMs));
        closeDone = () => {
          clearTimeout(killTimer);
          clearTimeout(guard);
          resolve();
        };
      });
    },
    async reopen(): Promise<void> {
      if (closed) return; // deliberate close is terminal — nothing to respawn
      // A reopen while the previous child still lives (duplicate/delayed
      // reopen callers) must not leak it: detach its listeners, end stdin,
      // and kill it so two children never feed the same message listener.
      if (child !== undefined && child.exitCode === null) {
        child.removeAllListeners();
        child.stdin?.end();
        child.kill("SIGTERM");
      }
      closeErr = undefined;
      writeChain = Promise.resolve();
      child = spawnChild();
    },
  };
  return transport;
}