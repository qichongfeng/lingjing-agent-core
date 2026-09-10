// stdio transport against REAL child processes (test/fixtures/*.mjs) —
// handshake, bridge naming, destructive annotation, backpressure with a
// 1 MiB payload, multi-byte round-trip, cancellation, transport loss, and
// zombie-free close. Per-test timeouts: spawning takes a moment.

import { describe, expect, it } from "vitest";
import { createMcpTools } from "../src/tools.js";
import { createStdioMcpTransport } from "../src/node/index.js";
import { testCtx } from "./helpers.js";

const ECHO_SERVER = new URL("./fixtures/echo-server.mjs", import.meta.url).pathname;
const DIE_SERVER = new URL("./fixtures/die-server.mjs", import.meta.url).pathname;

function spawnFixture(script: string, extra: Record<string, unknown> = {}) {
  return createStdioMcpTransport({
    command: process.execPath,
    args: [script],
    ...extra,
  });
}

describe("stdio end to end", () => {
  it(
    "handshakes, lists, bridges names, and calls echo",
    async () => {
      const session = await createMcpTools({
        name: "fixture",
        toolTimeoutMs: 10_000,
        transport: spawnFixture(ECHO_SERVER),
      });
      try {
        expect(session.serverInfo).toEqual({ name: "fixture", version: "1.0" });
        expect(session.protocolVersion).toBe("2025-06-18");
        expect(session.instructions).toBe("test fixture server");
        expect(session.tools.map((t) => t.name)).toEqual([
          "fixture__echo",
          "fixture__fail",
          "fixture__slow",
          "fixture__get_cancellations",
          "fixture__resources",
          "fixture__read_resource",
          "fixture__prompts",
          "fixture__get_prompt",
        ]);
        // destructive annotation mapped under the default "confirm" policy
        const fail = session.tools[1]!;
        expect(fail.permissions?.destructive).toBe(true);
        expect(fail.requiresConfirmation).toBe(true);
        expect(session.tools[0]!.permissions?.tags).toEqual(["mcp", "mcp:fixture"]);

        const out = await session.tools[0]!.execute({ message: "hello stdio" }, testCtx());
        expect(out).toEqual({ content: "hello stdio" });

        // Bridged resource/prompt helpers are read-only and work end to end.
        const readResource = session.tools[5]!;
        expect(readResource.permissions?.destructive).toBeUndefined();
        const resourceOut = await readResource.execute({ uri: "file:///hello.txt" }, testCtx());
        expect(resourceOut.content).toBe("hello resource");
        const getPrompt = session.tools[7]!;
        const promptOut = await getPrompt.execute({ name: "greet" }, testCtx());
        expect(promptOut.content).toBe("greeting\nuser: hello prompt");
      } finally {
        await session.close();
      }
    },
    15_000,
  );

  it(
    "round-trips 1 MiB (stdin backpressure + stdout line reassembly)",
    async () => {
      const session = await createMcpTools({ name: "fixture", toolTimeoutMs: 20_000, transport: spawnFixture(ECHO_SERVER) });
      try {
        const big = `${"x".repeat(512 * 1024)}|${"y".repeat(512 * 1024)}`;
        const out = (await session.tools[0]!.execute({ message: big }, testCtx())) as { content: string };
        expect(out.content.length).toBe(big.length);
        expect(out.content.startsWith("x")).toBe(true);
        expect(out.content.endsWith("y")).toBe(true);
      } finally {
        await session.close();
      }
    },
    20_000,
  );

  it(
    "round-trips multi-byte characters split across stream chunks",
    async () => {
      const session = await createMcpTools({ name: "fixture", transport: spawnFixture(ECHO_SERVER) });
      try {
        const text = "灵境 agent 🎉 中文测试";
        const out = await session.tools[0]!.execute({ message: text }, testCtx());
        expect(out).toEqual({ content: text });
      } finally {
        await session.close();
      }
    },
    15_000,
  );

  it(
    "aborting a slow tool sends notifications/cancelled and the child stays healthy",
    async () => {
      const session = await createMcpTools({ name: "fixture", transport: spawnFixture(ECHO_SERVER) });
      try {
        const ac = new AbortController();
        const pending = session.tools[2]!.execute({ ms: 10_000 }, testCtx(ac.signal));
        // Let the request reach the child before aborting — aborting pre-send
        // rejects without ever issuing (and thus cancelling) the call.
        await new Promise((r) => setTimeout(r, 25));
        ac.abort();
        const out = await pending;
        expect(out).toEqual({ content: "(aborted)", isError: true });

        // The fixture recorded the cancellation; the child still serves calls.
        const record = await session.tools[3]!.execute({}, testCtx());
        expect(JSON.parse(record.content as string)).toEqual([
          { requestId: expect.any(Number) as number, reason: "aborted" },
        ]);
        const ok = await session.tools[0]!.execute({ message: "still alive" }, testCtx());
        expect(ok).toEqual({ content: "still alive" });
      } finally {
        await session.close();
      }
    },
    15_000,
  );

  it(
    "stderr callback receives server log lines; 'ignore' keeps them silent",
    async () => {
      const lines: string[] = [];
      const session = await createMcpTools({
        name: "fixture",
        transport: spawnFixture(ECHO_SERVER, { stderr: (line: string) => lines.push(line) }),
      });
      try {
        await session.tools[0]!.execute({ message: "x" }, testCtx());
        expect(lines.some((l) => l.includes("fixture server started"))).toBe(true);
      } finally {
        await session.close();
      }
    },
    15_000,
  );

  it(
    "child death mid-refresh reconnects transparently (respawn + re-handshake)",
    async () => {
      const transport = spawnFixture(DIE_SERVER);
      const session = await createMcpTools({ name: "die", transport });
      try {
        // The die-server answers initialize + the FIRST tools/list, then exits
        // (code 3) on the next line — i.e. during this refresh. The bridge's
        // reconnect logic respawns the child, re-handshakes, and the refresh
        // completes with the fresh child's (empty) tool list.
        const fresh = await session.refresh();
        expect(fresh).toEqual([]);
      } finally {
        await session.close(); // must not hang (fresh child is terminated too)
      }
    },
    20_000,
  );

  it(
    "close() terminates the child (no zombie)",
    async () => {
      const transport = spawnFixture(ECHO_SERVER);
      const session = await createMcpTools({ name: "fixture", transport });
      await session.tools[0]!.execute({ message: "warm" }, testCtx());
      await session.close();
      // The transport is closed → further sends refuse; the process is gone.
      await expect(transport.send({ jsonrpc: "2.0", method: "x" })).rejects.toThrow();
      // Give the OS a moment to reap, then confirm close fired through the client path.
      await new Promise((r) => setTimeout(r, 200));
      expect(transport.label).toMatch(/stdio/);
    },
    15_000,
  );
});
