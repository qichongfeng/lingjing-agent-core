// Test scaffolding: permission gates + recording hooks for asserting loop
// behavior (allow / deny / modify / hook execution order) without real I/O.

import type { Hooks } from "../../src/hooks.js";
import type {
  PermissionDecision,
  PermissionGate,
} from "../../src/permission.js";
import type { StopReason, TokenUsage } from "../../src/provider.js";
import type { ToolResultValue } from "../../src/tool.js";
import type { Message } from "../../src/types.js";

/** A gate that approves every request. */
export function allowGate(log?: string[]): PermissionGate {
  return {
    async request(call) {
      log?.push(`allow:${call.name}`);
      return { allow: true };
    },
  };
}

/** A gate that denies every request with `reason`. */
export function denyGate(reason = "denied", log?: string[]): PermissionGate {
  return {
    async request(call) {
      log?.push(`deny:${call.name}`);
      return { allow: false, reason };
    },
  };
}

/** A gate that approves but rewrites the tool input to `modifiedInput`. */
export function modifyingGate(modifiedInput: unknown, log?: string[]): PermissionGate {
  return {
    async request(call) {
      log?.push(`modify:${call.name}`);
      return { allow: true, modifiedInput };
    },
  };
}

export interface RecordedHook {
  type:
    | "beforeRequest"
    | "afterResponse"
    | "beforeToolCall"
    | "afterToolCall";
  name?: string;
  stopReason?: StopReason;
  isError?: boolean;
}

/** Hooks that record every call in order, for asserting execution sequence.
 * `beforeToolCall`/`afterToolCall` record the tool name; `afterResponse` records
 * the stopReason; `afterToolCall` records isError. beforeRequest is a no-op
 * (pass-through) so it does not alter history. */
export function recordingHooks(): { hooks: Hooks; log: RecordedHook[] } {
  const log: RecordedHook[] = [];
  const hooks: Hooks = {
    async beforeRequest() {
      log.push({ type: "beforeRequest" });
    },
    async afterResponse(ctx) {
      log.push({ type: "afterResponse", stopReason: ctx.stopReason });
    },
    async beforeToolCall(call) {
      log.push({ type: "beforeToolCall", name: call.name });
    },
    async afterToolCall(call) {
      log.push({ type: "afterToolCall", name: call.name, isError: call.isError });
    },
  };
  return { hooks, log };
}

/** A beforeToolCall hook that vetoes with `reason`. */
export function vetoingHook(reason: string): Hooks {
  return {
    async beforeToolCall() {
      return { abort: true as const, reason };
    },
  };
}

/** A beforeToolCall hook that rewrites input to `modifiedInput`. */
export function inputRewritingHook(modifiedInput: unknown): Hooks {
  return {
    async beforeToolCall() {
      return { modifiedInput };
    },
  };
}

// Re-export the decision types so tests importing from testing can reference them.
export type { PermissionDecision };
export type { Message, ToolResultValue, TokenUsage };
