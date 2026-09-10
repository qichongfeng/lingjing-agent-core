// Minimal legacy-era stdio MCP server for tests — plain Node, zero deps.
// NDJSON on stdin/stdout; exits when stdin closes.
//
// Tools: echo (text back), fail (destructiveHint, isError), slow (honours
// notifications/cancelled), get_cancellations (reports recorded cancellations).
// Also answers ping; unknown methods → -32601.

import { createInterface } from "node:readline";

const cancellations = [];
const pendingSlow = new Map(); // request id → cancel hook

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const TOOLS = [
  {
    name: "echo",
    description: "Echo the message back as text.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fail",
    description: "Destructive tool that always errors.",
    inputSchema: { type: "object" },
    annotations: { destructiveHint: true },
  },
  {
    name: "slow",
    description: "Sleeps (default 5s) — cancellable via notifications/cancelled.",
    inputSchema: { type: "object", properties: { ms: { type: "number" } } },
  },
  {
    name: "get_cancellations",
    description: "Returns recorded cancellation {requestId, reason} pairs.",
    inputSchema: { type: "object" },
  },
];

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const s = line.trim();
  if (s === "") return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  if (msg.jsonrpc !== "2.0") return;

  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "fixture", version: "1.0" },
      instructions: "test fixture server",
    });
  } else if (msg.method === "notifications/initialized") {
    // no-op
  } else if (msg.method === "ping") {
    reply(msg.id, {});
  } else if (msg.method === "tools/list") {
    reply(msg.id, { tools: TOOLS });
  } else if (msg.method === "resources/list") {
    reply(msg.id, { resources: [{ uri: "file:///hello.txt", name: "hello", mimeType: "text/plain" }] });
  } else if (msg.method === "resources/read") {
    reply(msg.id, {
      contents: [{ uri: msg.params?.uri ?? "file:///hello.txt", text: "hello resource", mimeType: "text/plain" }],
    });
  } else if (msg.method === "prompts/list") {
    reply(msg.id, { prompts: [{ name: "greet", description: "Say hi" }] });
  } else if (msg.method === "prompts/get") {
    reply(msg.id, {
      description: "greeting",
      messages: [{ role: "user", content: { type: "text", text: "hello prompt" } }],
    });
  } else if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    if (name === "echo") {
      reply(msg.id, { content: [{ type: "text", text: String(args.message ?? "") }] });
    } else if (name === "fail") {
      reply(msg.id, { content: [{ type: "text", text: "boom" }], isError: true });
    } else if (name === "slow") {
      const ms = Number(args.ms ?? 5_000);
      const timer = setTimeout(() => {
        pendingSlow.delete(msg.id);
        reply(msg.id, { content: [{ type: "text", text: "finally" }] });
      }, ms);
      pendingSlow.set(msg.id, () => {
        clearTimeout(timer);
        reply(msg.id, { content: [{ type: "text", text: "cancelled" }] });
      });
    } else if (name === "get_cancellations") {
      reply(msg.id, { content: [{ type: "text", text: JSON.stringify(cancellations) }] });
    } else {
      replyError(msg.id, -32601, `Unknown tool: ${name}`);
    }
  } else if (msg.method === "notifications/cancelled") {
    const { requestId, reason } = msg.params ?? {};
    cancellations.push({ requestId, reason });
    pendingSlow.get(requestId)?.();
    pendingSlow.delete(requestId);
  } else if (msg.id !== undefined) {
    replyError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
});

process.stderr.write("fixture server started\n");
rl.on("close", () => process.exit(0));
