// Stub tools for testing the loop: echo, fail, slow, add.

import type { Tool } from "../../src/tool.js";

export function echoTool(): Tool {
  return {
    name: "echo",
    description: "Echo back the input as a JSON string.",
    inputSchema: { jsonSchema: { type: "object", additionalProperties: true } },
    async execute(input) {
      return { content: JSON.stringify(input) };
    },
  };
}

export function failTool(): Tool {
  return {
    name: "fail",
    description: "Always throws — used to test tool-error handling.",
    inputSchema: { jsonSchema: { type: "object", additionalProperties: true } },
    async execute() {
      throw new Error("intentional failure");
    },
  };
}

/** `noTimeout` drops the generous per-tool budget, letting the agent-level
 *  `toolTimeoutMs` govern — the only way to exercise the timeout path. */
export function slowTool(ms: number, opts?: { noTimeout?: boolean }): Tool {
  return {
    name: "slow",
    description: `Sleeps ${ms}ms then returns.`,
    inputSchema: { jsonSchema: { type: "object", additionalProperties: true } },
    ...(opts?.noTimeout ? {} : { timeoutMs: ms + 1000 }), // generous so it doesn't trip the default unless overridden
    async execute(_input, ctx) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        ctx.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return { content: `slept ${ms}ms` };
    },
  };
}

export function addTool(): Tool {
  return {
    name: "add",
    description: "Add two integers.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: { a: { type: "integer" }, b: { type: "integer" } },
        required: ["a", "b"],
        additionalProperties: false,
      },
    },
    async execute(input) {
      const { a, b } = input as { a: number; b: number };
      return { content: String(a + b) };
    },
  };
}
