// The Tool bridge: connect one MCP server (legacy initialize era), list its
// tools, and surface them as core `Tool` objects for createAgent({ tools }).
//
// Mapping highlights (see README for the full table):
// - name: `${prefix}__${sanitized server tool name}` — prefixed so multiple
//   servers (and host tools) never collide; collisions AFTER sanitization
//   fail the connect.
// - inputSchema: the MCP descriptor's JSON Schema passes through VERBATIM —
//   core's loop validates against it (draft-07 subset; a schema that sets
//   additionalProperties:false is enforced as-is).
// - permissions.tags ["mcp", "mcp:<prefix>"] for allowedToolTags gating;
//   permissions.network true only in url (HTTP) mode.
// - annotations.destructiveHint === true (policy "confirm", the default) maps
//   to permissions.destructive + requiresConfirmation — per DESIGN §7 a
//   destructive tool without a permissionGate is refused. Hosts that trust
//   the server can set destructivePolicy: "skip".
// - execute never throws: transport/protocol failures return isError results;
//   abort returns "(aborted)" (an AbortError escaping would kill the run).

import {
  AbortError,
  type Agent,
  type Content,
  type HttpTransport,
  type Tool,
  type ToolCallContext,
  type ToolResultValue,
} from "@lingjing-agent/core";
import {
  McpClient,
  type McpInitializeResult,
  type McpPromptGetResult,
  type McpResourceContent,
  type McpRetryOptions,
  type McpToolCallResult,
  type McpToolDescriptor,
  type McpServerInfo,
} from "./client.js";
import { createHttpMcpTransport } from "./http-transport.js";
import type { McpTransport } from "./mcp-transport.js";
import type { McpOAuthConfig } from "./oauth.js";

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOOLS = 200;
const STRUCTURED_CAP = 16 * 1024;

export interface McpToolsOptions {
  /** Short server label → tool-name prefix `${prefix}__${tool}` + tag `mcp:${prefix}`. Required. */
  name: string;
  /** Streamable-HTTP endpoint (e.g. "https://host/mcp"). Exactly one of url | transport. */
  url?: string;
  /** Prebuilt transport (stdio from "@lingjing-agent/mcp/node", a test fake, a custom bridge). */
  transport?: McpTransport;
  /** Extra headers on every HTTP request (Authorization etc.). url-mode only. */
  headers?: Record<string, string>;
  /** Underlying core HttpTransport for url-mode (e.g. wx.request bridge). Default fetchTransport(). */
  httpTransport?: HttpTransport;
  /** Timeout for the handshake + tools/list JSON-RPC requests. Default 60_000. */
  requestTimeoutMs?: number;
  /** Per-call timeout stamped on every bridged Tool (Tool.timeoutMs). Default 120_000. */
  toolTimeoutMs?: number;
  /** Override the tool-name prefix (defaults to sanitized `name`). */
  toolNamePrefix?: string;
  /**
   * annotations.destructiveHint handling: "confirm" (default) → permissions.destructive
   * + requiresConfirmation; "skip" → neither.
   */
  destructivePolicy?: "confirm" | "skip";
  /** Guard against a hostile tools/list. Default 200. Exceeding closes the session and throws. */
  maxTools?: number;
  /** Transient-failure retry (network loss, HTTP 5xx/408/429). Default { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 5000 }. */
  retry?: McpRetryOptions;
  /** OAuth 2.1 for this server (url-mode only): injects a Bearer token, refreshes on 401. */
  auth?: McpOAuthConfig;
  /** Bridge resources/list + resources/read as read-only tools. Default true (when the server advertises `capabilities.resources`). */
  bridgeResources?: boolean;
  /** Bridge prompts/list + prompts/get as read-only tools. Default true (when the server advertises `capabilities.prompts`). */
  bridgePrompts?: boolean;
}

export interface McpToolsSession {
  /** Bridged core Tools — pass to createAgent({ tools }) / agent.registerTool. */
  tools: Tool[];
  serverInfo: McpServerInfo;
  /** Negotiated legacy protocol version in force for the session. */
  protocolVersion: string;
  /** Server-provided usage instructions, if any (hosts may append to the system prompt). */
  instructions?: string;
  /**
   * Re-run tools/list (+ resources/prompts) and return a FRESH Tool[]. When
   * this session is attached to an agent, the diff is applied automatically —
   * removed tools are unregistered, added/changed are re-registered; a failed
   * re-list keeps the prior set (never leaves the agent tool-less).
   */
  refresh(): Promise<Tool[]>;
  /**
   * Register the current tools onto `agent` and subscribe to
   * notifications/tools/list_changed so the agent's tool set tracks the server
   * automatically (no manual unregister/register). Returns a detach function
   * that unregisters everything this session bridged from that agent.
   */
  attach(agent: Agent): () => void;
  /** Terminate the session (kill the child / best-effort HTTP DELETE). Idempotent. */
  close(): Promise<void>;
}

/** [^a-zA-Z0-9_-] → "-", edge dashes trimmed, "mcp" if empty — keeps names
 *  valid for every provider's function-name rules. */
function sanitizeName(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "mcp" : cleaned;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map an MCP tools/call result into a core ToolResultValue. */
function mapToolCallResult(res: McpToolCallResult): ToolResultValue {
  const parts: Content[] = [];
  for (const block of res.content) {
    if (block.type === "text" && block.text !== undefined) {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "image" && block.data !== undefined) {
      parts.push({ type: "image", mediaType: block.mimeType ?? "image/png", data: block.data });
    } else if (block.type === "audio") {
      parts.push({ type: "text", text: `[unsupported audio content: ${block.mimeType ?? "unknown"}]` });
    } else if (block.type === "resource" && block.resource !== undefined) {
      const r = block.resource;
      if (r.text !== undefined) {
        parts.push({ type: "text", text: `[resource ${r.uri}]\n${r.text}` });
      } else {
        parts.push({
          type: "text",
          text: `[resource ${r.uri}, ${r.mimeType ?? "unknown"}, ${r.blob?.length ?? 0} base64 chars — not inlined]`,
        });
      }
    }
  }
  if (res.structuredContent !== undefined) {
    let s = JSON.stringify(res.structuredContent);
    if (s.length > STRUCTURED_CAP) s = `${s.slice(0, STRUCTURED_CAP)}\n[truncated]`;
    parts.push({ type: "text", text: `structured: ${s}` });
  }
  const content: string | Content[] =
    parts.length === 0
      ? "[empty response]"
      : parts.every((p) => p.type === "text")
        ? parts.map((p) => (p as { type: "text"; text: string }).text).join("\n")
        : parts;
  return { content, ...(res.isError === true && { isError: true }) };
}

/** resources/read `contents` → core ToolResultValue. Images inline as base64;
 *  other binaries are described, not inlined (bounded output). */
function mapResourceContents(contents: McpResourceContent[]): ToolResultValue {
  const parts: Content[] = [];
  for (const c of contents) {
    if (c.text !== undefined) {
      parts.push({ type: "text", text: c.text });
    } else if (c.blob !== undefined) {
      const mediaType = c.mimeType ?? "application/octet-stream";
      if (mediaType.startsWith("image/")) {
        parts.push({ type: "image", mediaType, data: c.blob });
      } else {
        parts.push({ type: "text", text: `[binary resource ${c.uri} (${mediaType}), ${c.blob.length} base64 chars — not inlined]` });
      }
    }
  }
  if (parts.length === 0) return { content: "[empty resource]" };
  if (parts.every((p) => p.type === "text")) {
    return { content: parts.map((p) => (p as { type: "text"; text: string }).text).join("\n") };
  }
  return { content: parts };
}

/** prompts/get result → plain text (description + role-tagged messages). */
function mapPromptGetResult(result: McpPromptGetResult): ToolResultValue {
  const lines: string[] = [];
  if (result.description) lines.push(result.description);
  for (const m of result.messages) {
    if (m.content.type === "text" && m.content.text !== undefined) lines.push(`${m.role}: ${m.content.text}`);
    else lines.push(`${m.role}: [image content]`);
  }
  return { content: lines.length > 0 ? lines.join("\n") : "[empty prompt]" };
}

export async function createMcpTools(opts: McpToolsOptions): Promise<McpToolsSession> {
  const hasUrl = opts.url !== undefined;
  const hasTransport = opts.transport !== undefined;
  if (hasUrl === hasTransport) {
    throw new Error("createMcpTools: provide exactly one of url (HTTP) or transport (stdio/custom)");
  }
  const transport: McpTransport = hasUrl
    ? createHttpMcpTransport({
        url: opts.url ?? "",
        ...(opts.httpTransport !== undefined && { transport: opts.httpTransport }),
        ...(opts.headers !== undefined && { headers: opts.headers }),
        ...(opts.auth !== undefined && { auth: opts.auth }),
      })
    : (opts.transport as McpTransport);

  const client = new McpClient({
    transport,
    ...(opts.requestTimeoutMs !== undefined && { requestTimeoutMs: opts.requestTimeoutMs }),
    ...(opts.retry !== undefined && { retry: opts.retry }),
  });
  let init: McpInitializeResult;
  try {
    init = await client.connect();
  } catch (err) {
    // connect() already died+closed; double-close is idempotent insurance.
    await transport.close();
    throw err;
  }

  const prefix = sanitizeName(opts.toolNamePrefix ?? opts.name);
  const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const destructivePolicy = opts.destructivePolicy ?? "confirm";
  const maxTools = opts.maxTools ?? DEFAULT_MAX_TOOLS;
  const isHttp = hasUrl;
  const bridgeResources = opts.bridgeResources ?? true;
  const bridgePrompts = opts.bridgePrompts ?? true;
  const capabilities = init.capabilities ?? {};

  function bridge(descriptors: McpToolDescriptor[], phase: string): Tool[] {
    if (descriptors.length > maxTools) {
      throw new Error(`MCP server '${opts.name}' exposed ${descriptors.length} tools (maxTools ${maxTools}) — ${phase}`);
    }
    const seen = new Set<string>();
    const tools: Tool[] = [];
    for (const d of descriptors) {
      const name = `${prefix}__${sanitizeName(d.name)}`;
      if (seen.has(name)) {
        throw new Error(`MCP tool name collision after sanitization: '${name}' (server '${opts.name}') — ${phase}`);
      }
      seen.add(name);
      const destructive = destructivePolicy === "confirm" && d.annotations?.destructiveHint === true;
      tools.push({
        name,
        description: d.description ?? d.title ?? `Tool '${d.name}' from MCP server '${init.serverInfo.name}'`,
        inputSchema: { jsonSchema: d.inputSchema },
        timeoutMs: toolTimeoutMs,
        permissions: {
          network: isHttp,
          tags: ["mcp", `mcp:${prefix}`],
          ...(destructive && { destructive: true }),
        },
        ...(destructive && { requiresConfirmation: true }),
        async execute(input: unknown, tctx: ToolCallContext): Promise<ToolResultValue> {
          if (client.isClosed) return { content: "MCP session closed", isError: true };
          try {
            const res = await client.callTool(d.name, input, { signal: tctx.signal, timeoutMs: toolTimeoutMs });
            return mapToolCallResult(res);
          } catch (err) {
            if (err instanceof AbortError) return { content: "(aborted)", isError: true };
            return { content: `MCP tool '${d.name}' failed: ${errMsg(err)}`, isError: true };
          }
        },
      });
    }
    return tools;
  }

  /** Read-only resource/prompt helper tools — same tags/network, never destructive. */
  function readOnlyTool(name: string, description: string, schema: object, exec: (input: unknown, tctx: ToolCallContext) => Promise<ToolResultValue>): Tool {
    return {
      name,
      description,
      inputSchema: { jsonSchema: schema },
      timeoutMs: toolTimeoutMs,
      permissions: { network: isHttp, tags: ["mcp", `mcp:${prefix}`] },
      async execute(input: unknown, tctx: ToolCallContext): Promise<ToolResultValue> {
        if (client.isClosed) return { content: "MCP session closed", isError: true };
        try {
          return await exec(input, tctx);
        } catch (err) {
          if (err instanceof AbortError) return { content: "(aborted)", isError: true };
          return { content: `MCP '${name}' failed: ${errMsg(err)}`, isError: true };
        }
      },
    };
  }

  function resourceTools(): Tool[] {
    return [
      readOnlyTool(
        `${prefix}__resources`,
        `List the resources exposed by MCP server '${init.serverInfo.name}'.`,
        { type: "object" },
        async () => ({ content: JSON.stringify(await client.listResources(), null, 2) }),
      ),
      readOnlyTool(
        `${prefix}__read_resource`,
        `Read a resource by URI from MCP server '${init.serverInfo.name}'.`,
        { type: "object", properties: { uri: { type: "string" } }, required: ["uri"], additionalProperties: false },
        async (input) => {
          const uri = (input as { uri?: unknown }).uri;
          if (typeof uri !== "string") return { content: "uri is required", isError: true };
          return mapResourceContents(await client.readResource(uri));
        },
      ),
    ];
  }

  function promptTools(): Tool[] {
    return [
      readOnlyTool(
        `${prefix}__prompts`,
        `List the prompts exposed by MCP server '${init.serverInfo.name}'.`,
        { type: "object" },
        async () => ({ content: JSON.stringify(await client.listPrompts(), null, 2) }),
      ),
      readOnlyTool(
        `${prefix}__get_prompt`,
        `Render a prompt by name from MCP server '${init.serverInfo.name}'.`,
        {
          type: "object",
          properties: { name: { type: "string" }, arguments: { type: "object" } },
          required: ["name"],
          additionalProperties: false,
        },
        async (input) => {
          const { name, arguments: args } = input as { name?: unknown; arguments?: unknown };
          if (typeof name !== "string") return { content: "name is required", isError: true };
          return mapPromptGetResult(await client.getPrompt(name, args));
        },
      ),
    ];
  }

  /** Full bridged set: server tools + (optional) resource/prompt helpers. */
  function buildAll(descriptors: McpToolDescriptor[], phase: string): Tool[] {
    const tools = bridge(descriptors, phase);
    if (bridgeResources && capabilities.resources !== undefined) tools.push(...resourceTools());
    if (bridgePrompts && capabilities.prompts !== undefined) tools.push(...promptTools());
    return tools;
  }

  const attached = new Set<Agent>();
  let current = new Map<string, Tool>();

  /** Apply a freshly-bridged set to every attached agent: replace persisted,
   *  register added, unregister removed. */
  function applyDiff(next: Map<string, Tool>): void {
    for (const [name, tool] of next) {
      if (attached.size > 0) {
        if (current.has(name)) for (const a of attached) a.unregisterTool(name);
        for (const a of attached) a.registerTool(tool);
      }
    }
    for (const [name] of current) {
      if (!next.has(name)) for (const a of attached) a.unregisterTool(name);
    }
    current = next;
  }

  async function refresh(): Promise<Tool[]> {
    const next = new Map<string, Tool>();
    for (const t of buildAll(await client.listTools(), "refresh")) next.set(t.name, t);
    applyDiff(next);
    return [...next.values()];
  }

  const handleChanged = async (): Promise<void> => {
    await refresh().catch(() => {
      /* re-list failed — keep the prior set (never leave the agent tool-less) */
    });
  };

  let tools: Tool[];
  try {
    tools = buildAll(await client.listTools(), "connect");
  } catch (err) {
    await client.close();
    throw err;
  }
  current = new Map(tools.map((t) => [t.name, t]));
  client.onToolsChanged(() => {
    void handleChanged();
  });

  return {
    tools,
    serverInfo: init.serverInfo,
    protocolVersion: client.protocolVersion,
    ...(init.instructions !== undefined && { instructions: init.instructions }),
    refresh,
    attach(agent: Agent): () => void {
      for (const t of current.values()) agent.registerTool(t);
      attached.add(agent);
      return () => {
        attached.delete(agent);
        for (const t of current.values()) agent.unregisterTool(t.name);
      };
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}
