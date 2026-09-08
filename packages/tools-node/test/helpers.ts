// Shared test context builder — a minimal ToolCallContext for direct
// tool.execute() calls (no agent loop needed for unit tests).

import type { ToolCallContext } from "@lingjing-agent/core";

export function testCtx(signal?: AbortSignal): ToolCallContext {
  return {
    signal: signal ?? new AbortController().signal,
    toolCallId: "tc-test",
    conversationId: "c-test",
    runtime: "node",
    log: () => {},
  };
}
