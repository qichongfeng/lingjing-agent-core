# @lingjing-agent/mcp

**MCP client bridge** for [`@lingjing-agent/core`](https://www.npmjs.com/package/@lingjing-agent/core) — connect an external MCP server and surface its tools as core `Tool` objects you pass straight to `createAgent({ tools })`.

- **Legacy initialize era only** (`2024-11-05` → `2025-11-25`, handshake-based): tools, resources and prompts are bridged (as tools — core has no first-class resource/prompt surface). Sampling, elicitation and the modern (`2026-07-28+`, handshake-less) era are out of scope.
- **Cross-runtime** entry: zero `node:*` imports — the Streamable-HTTP transport rides core's injectable `HttpTransport`, so browser/Edge/WeChat mini-program hosts work with zero polyfills.
- **stdio** transport lives in the `@lingjing-agent/mcp/node` subpath (Node/Electron/Tauri-main only).

```bash
npm install @lingjing-agent/mcp
```

## Streamable HTTP

```ts
import { createAgent } from "@lingjing-agent/core";
import { createMcpTools } from "@lingjing-agent/mcp";

const session = await createMcpTools({
  name: "filesystem",                      // → tools prefixed `filesystem__…`, tagged `mcp:filesystem`
  url: "https://example.com/mcp",
  headers: { Authorization: "Bearer …" },  // static headers on every HTTP request
  // httpTransport: myWxTransport,         // inject a wx.request bridge for mini-programs
  // auth: { tokenStore, authorizationServer, authorize },  // OAuth 2.1 (see below)
});

const agent = createAgent({
  /* provider, model, … */
  tools: session.tools,
  allowedToolTags: ["mcp"],                // gate all bridged tools behind one tag
});

// Keep the agent's tool set in sync with the server automatically:
const detach = session.attach(agent);      // subscribes to notifications/tools/list_changed
```

`createMcpTools` resolves a session with `{ tools, serverInfo, protocolVersion, instructions?, refresh(), attach(), close() }`. One server → one `name` prefix (`${prefix}__${tool}`); collisions after name sanitization abort the connect rather than silently shadow.

- **`attach(agent)`** registers every bridged tool onto `agent` and subscribes to `notifications/tools/list_changed` — when the server changes its tool set the session re-lists, diffs by name, and updates the agent (unregister removed, register added/changed). It returns a detach function. A failed re-list keeps the prior set (never leaves the agent tool-less).
- **`refresh()`** re-lists and returns a fresh `Tool[]`; after `attach` the same diff is applied automatically, so you never hand-manage unregister/register.

## stdio (Node only)

```ts
import { createMcpTools } from "@lingjing-agent/mcp";
import { createStdioMcpTransport } from "@lingjing-agent/mcp/node";

const session = await createMcpTools({
  name: "local",
  transport: createStdioMcpTransport({
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
    stderr: "inherit",                     // or a per-line callback for server logs
  }),
});
```

The stdio transport spawns the child **argv-direct** (`shell: false`), serializes writes so parallel tool calls never interleave JSON frames, guards frames at 4 MiB, and closes with SIGTERM → SIGKILL. If the child exits unexpectedly, the bridge **reconnects**: it respawns the child, re-handshakes, and re-drives the in-flight request with exponential backoff (see *retry* below).

## Mapping to core Tools

| MCP descriptor field | core `Tool` field |
| --- | --- |
| `name` | `name`: `${prefix}__${sanitized(name)}` |
| `inputSchema` | `inputSchema.jsonSchema` (passed through **verbatim**; core validates) |
| `description` / `title` | `description` |
| `annotations.destructiveHint` | `permissions.destructive: true` + `requiresConfirmation: true` (policy `"confirm"`, the default) |
| — | `permissions.tags`: `["mcp", "mcp:${prefix}"]` · `permissions.network` (HTTP mode only) |

Safety defaults: a `tools/list` exceeding `maxTools` (default 200) closes the session; `execute` never throws — transport/protocol failures surface as `isError` results and aborts return `"(aborted)"` rather than killing the run.

`destructiveHint` policy: `"confirm"` (default) marks the tool destructive + confirmation, which core refuses to run without a permission gate; hosts that trust their server pass `destructivePolicy: "skip"`.

### resources & prompts

When the server advertises `capabilities.resources` / `capabilities.prompts` (and the matching `bridgeResources` / `bridgePrompts` option — default `true` — is left on), the session appends four read-only helper tools:

- `{prefix}__resources` — `resources/list`
- `{prefix}__read_resource` — `resources/read` (text inlined; images inlined as base64; other binaries summarized)
- `{prefix}__prompts` — `prompts/list`
- `{prefix}__get_prompt` — `prompts/get`

They carry the same tags and are never destructive. Pass `bridgeResources: false` / `bridgePrompts: false` to omit them.

### retry (automatic reconnect & transient-failure backoff)

A `retry` option shapes both reconnects and request retries: `{ maxAttempts = 5, baseDelayMs = 250, maxDelayMs = 5000 }` with jitter. **Transient** failures (network loss, transport drop, HTTP 5xx/408/429) are retried; **logical timeouts and aborts are never retried** (replaying a timed-out tool call would be unsafe). When the stdio child dies, the next request respawns + re-handshakes before retrying.

### OAuth 2.1 (HTTP mode)

Pass `auth` to authenticate against a browser-based OAuth 2.1 (RFC 9728) MCP server — full zero-dependency flow: RFC 8414 discovery, Dynamic Client Registration, PKCE (`S256`), and token refresh. The one environment-specific step — opening the browser and capturing the redirect — is delegated to your `authorize(url)` callback:

```ts
import { createMcpTools } from "@lingjing-agent/mcp";

const session = await createMcpTools({
  name: "cloud",
  url: "https://mcp-host/mcp",
  auth: {
    tokenStore: {
      get: async (key) => loadFromKeychain(key),
      set: async (key, tokens) => saveToKeychain(key, tokens),
      clear: async (key) => deleteFromKeychain(key),
    },
    authorizationServer: "https://mcp-host",
    scopes: ["openid"],
    clientId: "…",                          // or omit for dynamic client registration
    authorize: async (url) => {
      // open `url` in a browser and return the redirect the user landed on
      return await launchBrowserAndWaitForRedirect(url);
    },
  },
});
```

The transport injects `Authorization: Bearer <token>`, and on a `401` invalidates the access token only — the refresh grant runs first (the refresh token survives; rotation killed the access token, not the session), falling back to re-authorization only if that fails — then replays the request once, transparently. `TokenStore` is your persistence seam — keychain, a file, or in-memory.

## Low-level client

For non-agent use, `McpClient` speaks the JSON-RPC directly (`connect` / `listTools` / `callTool` / `listResources` / `readResource` / `listPrompts` / `getPrompt` / `close`) over any `McpTransport`; `createHttpMcpTransport({ url, headers, transport, auth })` and `createStdioMcpTransport(...)` are the two built-in transports.

## Server side

`createMcpServer` is the mirror image: expose your agent's core `Tool`s to external MCP clients (Claude Desktop, an IDE, another agent). Implementments the tools surface (`initialize` / `ping` / `tools/list` / `tools/call` + `notifications/cancelled`); the message channel is the server-direction seam — `createStdioMcpServerChannel()` (from `@lingjing-agent/mcp/node`) speaks over this process's own stdin/stdout, i.e. your process IS the MCP server:

```ts
import { createMcpServer } from "@lingjing-agent/mcp";
import { createStdioMcpServerChannel } from "@lingjing-agent/mcp/node";

const server = createMcpServer({
  channel: createStdioMcpServerChannel(), // stdin/stdout of THIS process
  name: "my-agent-tools",
  version: "1.0.0",
  instructions: "Optional usage instructions for clients.",
  tools: myCoreTools, // Tool[] — mutate later via server.registerTool
});
```

Contract notes (mirrors the client bridge):

- Tool descriptors pass `name` / `description` through and unwrap `inputSchema.jsonSchema` to the raw JSON Schema; a tool with `permissions.destructive: true` announces `annotations.destructiveHint: true` (read-only hints are not guessed).
- `tools/call` runs `tool.execute` with a per-request `AbortController` — a `notifications/cancelled` aborts it, a `toolTimeoutMs` budget (default 120 s) turns a hung tool into an `isError` result.
- Nothing throws across the wire: tool failures are `isError` results (the spec's convention), unknown tool / unknown method are `-32602` / `-32601`, and result text is capped (default 1 M chars) so it cannot break the transport's frame guard.
- Arguments pass through verbatim — schema enforcement is the caller's job (a well-behaved client validates before calling) or the tool's.
- Logging goes to stderr; stdout is the protocol channel and must never carry logs.