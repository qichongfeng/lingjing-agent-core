// MCP server side: expose core `Tool`s to external MCP clients over a
// message channel — the mirror of the client bridge (tools.ts).
//
// Shape: a `McpServerChannel` is the server-direction seam (stdio from
// "./node", a test fake, a custom bridge) — the same JsonRpcMessage union is
// the wire, `parseJsonRpcMessage` the only parser, noise skipped.
//
// Discipline (mirrors client.ts): nothing throws across the message
// boundary — protocol errors are JSON-RPC error OBJECTS (-32601/-32602), tool
// failures are MCP results with isError (per the spec a tool error is a
// successful call whose result carries isError), notifications get no
// response. A hostile client therefore cannot take down the message pump.
//
// Only the tools surface is implemented (initialize / ping / tools/list /
// tools/call + notifications/cancelled) — resources, prompts and sampling
// are out of scope; unknown methods answer -32601.
//
// Arguments pass through verbatim — schema enforcement is the caller's job
// (the client bridge validates the model's args against the descriptor before
// calling; a hand-rolled client must do the same or trust the server tool).

import {
  TimeoutError,
  detectRuntime,
  type Content,
  type Tool,
  type ToolCallContext,
} from "@lingjing-agent/core";
import {
  isNotification,
  isRequest,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
} from "./json-rpc.js";
import { KNOWN_PROTOCOL_VERSIONS } from "./client.js";

/** The latest version this server answers an unsupported ask with — the client
 *  refuses anything it cannot speak, so echoing the ask's era is correct. */
const LATEST_PROTOCOL_VERSION = KNOWN_PROTOCOL_VERSIONS[KNOWN_PROTOCOL_VERSIONS.length - 1]!;

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESULT_CHARS = 1_000_000;

/** Server-direction message channel: reads client requests and writes
 *  responses. The stdio implementation reads process.stdin / writes
 *  process.stdout; test fakes pump arrays. */
export interface McpServerChannel {
  /** Human label for error messages ("stdio", "test channel"). */
  readonly label: string;
  /** All client→server messages. Registered exactly once. */
  onMessage(listener: (msg: JsonRpcMessage) => void): void;
  /** Fatal channel loss (stdin closed, socket dropped) — notifies close(). */
  onClose(listener: (err?: Error) => void): void;
  /** Write one response/notification to the client. Resolves once accepted. */
  send(msg: JsonRpcMessage): Promise<void>;
  /** Best-effort terminate. Idempotent. */
  close(): Promise<void>;
}

export interface McpServerOptions {
  channel: McpServerChannel;
  /** serverInfo.name in the initialize result. Required. */
  name: string;
  /** serverInfo.version. Default "0.0.0". */
  version?: string;
  /** serverInfo.title. */
  title?: string;
  /** Server-provided usage instructions (clients may append to the system prompt). */
  instructions?: string;
  /** The core Tools to expose. Mutate later via the handle's registerTool/unregisterTool. */
  tools?: Tool[];
  /** Budget for one tool execution. Default 120_000. */
  toolTimeoutMs?: number;
  /** Cap a tool result's text (the stdio frame guard is 4 MiB). Default 1_000_000 chars. */
  maxResultChars?: number;
  /** Sink for ToolCallContext.log (tool-internal logging). Default: drop. */
  log?: (level: "debug" | "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

export interface McpServerHandle {
  readonly name: string;
  readonly version: string;
  /** Negotiated protocol version in force (the initialize ask's era, or the latest). */
  readonly protocolVersion: string;
  /** Add a tool (or replace one of the same name) — the next tools/list reflects it. */
  registerTool(tool: Tool): void;
  unregisterTool(name: string): void;
  /** Terminate via the channel. Idempotent. */
  close(): Promise<void>;
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function resultResponse(id: JsonRpcId, result: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** core Tool → MCP descriptor: name/description pass through, the wrapped
 *  JSON Schema unwraps to the raw draft-07 object, destructive tools announce
 *  `destructiveHint: true` (read-only hints are NOT guessed — a core tool
 *  without `permissions.destructive` might still mutate; absence says nothing). */
function toDescriptor(tool: Tool): Record<string, unknown> {
  const destructive = tool.permissions?.destructive === true;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema.jsonSchema,
    ...(destructive && { annotations: { destructiveHint: true } }),
  };
}

/** ToolResultValue → MCP content blocks: text and image map; tool_call /
 *  thinking / tool_result blocks are result metadata a client would not
 *  consume — skipped rather than serialized. */
function toMcpContent(content: string | Content[]): Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  const blocks: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
  for (const b of content) {
    if (b.type === "text") blocks.push({ type: "text", text: b.text });
    else if (b.type === "image") blocks.push({ type: "image", data: b.data, mimeType: b.mediaType });
  }
  return blocks;
}

/** Cap the result's text so a huge result cannot break the transport's frame
 *  guard. First-come blocks keep their place; the overflow becomes one
 *  truncated text block (bounded output beats a hung client). */
function capContent(
  blocks: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
  maxChars: number,
): Array<{ type: string; text?: string; data?: string; mimeType?: string }> {
  let used = 0;
  for (let i = 0; i < blocks.length; i++) {
    const len = blocks[i]!.text?.length ?? 0;
    if (used + len <= maxChars) {
      used += len;
      continue;
    }
    const room = Math.max(0, maxChars - used);
    const kept = blocks.slice(0, i);
    kept.push({ type: "text", text: `${blocks[i]!.text?.slice(0, room) ?? ""}\n[truncated at ${maxChars} chars]` });
    return kept;
  }
  return blocks;
}

export function createMcpServer(opts: McpServerOptions): McpServerHandle {
  const channel = opts.channel;
  const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const maxResultChars = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
  const log = opts.log;
  const runtime = detectRuntime();

  const tools = new Map<string, Tool>();
  for (const t of opts.tools ?? []) tools.set(t.name, t);

  /** In-flight tools/call by request id — notifications/cancelled aborts them. */
  const pending = new Map<JsonRpcId, AbortController>();
  // The negotiated version is echoed back verbatim — a plain string is the
  // honest type; the union buys nothing here (the guard already proved membership).
  let protocolVersion: string = LATEST_PROTOCOL_VERSION;

  async function dispatch(req: JsonRpcRequest): Promise<void> {
    switch (req.method) {
      case "initialize": {
        const requested = (req.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        protocolVersion =
          typeof requested === "string" && (KNOWN_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION;
        await channel.send(
          resultResponse(req.id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: opts.name,
              version: opts.version ?? "0.0.0",
              ...(opts.title !== undefined && { title: opts.title }),
            },
            ...(opts.instructions !== undefined && { instructions: opts.instructions }),
          }),
        );
        return;
      }
      case "ping": {
        await channel.send(resultResponse(req.id, {}));
        return;
      }
      case "tools/list": {
        // No pagination: a full listing always comes back (no nextCursor), so
        // the client's pagination loop settles on page one.
        await channel.send(resultResponse(req.id, { tools: [...tools.values()].map(toDescriptor) }));
        return;
      }
      case "tools/call": {
        const params = (req.params ?? {}) as { name?: unknown; arguments?: unknown };
        const name = typeof params.name === "string" ? params.name : undefined;
        const tool = name !== undefined ? tools.get(name) : undefined;
        if (tool === undefined) {
          await channel.send(errorResponse(req.id, -32602, `Unknown tool: ${name ?? "(missing name)"}`));
          return;
        }
        const controller = new AbortController();
        pending.set(req.id, controller);
        const signal: AbortSignal = controller.signal;
        const timer = setTimeout(() => {
          controller.abort(new TimeoutError(`Tool '${name}' timed out after ${toolTimeoutMs}ms`));
        }, toolTimeoutMs);
        try {
          const ctx: ToolCallContext = {
            signal,
            toolCallId: String(req.id),
            conversationId: "",
            runtime,
            log: (level, msg, data) => log?.(level, msg, data),
          };
          const res = await tool.execute(params.arguments ?? {}, ctx);
          await channel.send(
            resultResponse(req.id, {
              content: capContent(toMcpContent(res.content), maxResultChars),
              ...(res.isError === true && { isError: true }),
            }),
          );
        } catch (err) {
          // The signal is the authority on WHY the call ended: the timer
          // aborts with a TimeoutError reason, notifications/cancelled (and
          // channel death) abort bare. The tool's own translation of the
          // abort — ANY error shape, not just AbortError — must not mask
          // either, so branch on the signal, not on the thrown value.
          if (signal.aborted) {
            const text = signal.reason instanceof TimeoutError ? errMsg(signal.reason) : "(cancelled)";
            await channel.send(resultResponse(req.id, { content: [{ type: "text", text }], isError: true }));
            return;
          }
          // A tool failure is a SUCCESSFUL call whose result carries isError
          // (the spec's convention) — never a JSON-RPC error object.
          await channel.send(
            resultResponse(req.id, {
              content: [{ type: "text", text: `Tool '${name}' failed: ${errMsg(err)}` }],
              isError: true,
            }),
          );
        } finally {
          clearTimeout(timer);
          pending.delete(req.id);
        }
        return;
      }
      default:
        // Unknown notification methods (e.g. notifications/progress) get no
        // response per the spec; unknown requested methods are -32601.
        if (req.method.startsWith("notifications/")) return;
        await channel.send(errorResponse(req.id, -32601, `Method not found: ${req.method}`));
    }
  }

  channel.onMessage((msg) => {
    // Cheap insurance: real channels only ever deliver parsed objects (the
    // parser returns undefined for noise), but a hand-rolled fake might not.
    if (typeof msg !== "object" || msg === null) return;
    if (isRequest(msg)) {
      // dispatch never throws by construction — a send/spawn failure lands
      // here and converts to a protocol error instead of dying silently.
      void dispatch(msg).catch((err) => {
        void channel.send(errorResponse(msg.id, -32603, `Internal error: ${errMsg(err)}`)).catch(() => {});
      });
      return;
    }
    if (isNotification(msg)) {
      if (msg.method === "notifications/initialized") return;
      if (msg.method === "notifications/cancelled") {
        const requestId = (msg.params as { requestId?: unknown } | undefined)?.requestId;
        // Narrow once to JsonRpcId — get() and delete() must key the same value.
        const key: JsonRpcId | undefined =
          typeof requestId === "number" || typeof requestId === "string" ? requestId : undefined;
        const live = key !== undefined ? pending.get(key) : undefined;
        if (live && key !== undefined) {
          pending.delete(key);
          live.abort(); // the response still goes out as "(cancelled)"
        }
      }
    }
    // Client responses (the server never sends requests) + noise: ignored.
  });

  channel.onClose(() => {
    // A dead channel can never answer its pending calls — abort them so the
    // in-flight tools end up settling instead of hanging on their budgets.
    for (const controller of pending.values()) controller.abort();
    pending.clear();
  });

  return {
    name: opts.name,
    version: opts.version ?? "0.0.0",
    get protocolVersion(): string {
      return protocolVersion;
    },
    registerTool(tool: Tool): void {
      tools.set(tool.name, tool);
    },
    unregisterTool(name: string): void {
      tools.delete(name);
    },
    close(): Promise<void> {
      return channel.close();
    },
  };
}
