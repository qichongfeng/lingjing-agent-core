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
    | "afterTurn"
    | "beforeToolCall"
    | "afterToolCall";
  name?: string;
  stopReason?: StopReason;
  isError?: boolean;
  /** Run id of the hook set that recorded it (see `recordingHooks(tag)`). */
  tag?: string;
}

/** Hooks that record every call in order, for asserting execution sequence.
 * `beforeToolCall`/`afterToolCall` record the tool name; `afterTurn` records
 * the stopReason; `afterToolCall` records isError. beforeRequest is a no-op
 * (pass-through) so it does not alter history. Pass `tag` when composing more
 * than one recording set, so the onion order is assertable. */
export function recordingHooks(tag?: string): { hooks: Hooks; log: RecordedHook[] } {
  const log: RecordedHook[] = [];
  const hooks: Hooks = {
    async beforeRequest() {
      log.push({ type: "beforeRequest", ...(tag !== undefined ? { tag } : {}) });
    },
    async afterTurn(ctx) {
      log.push({ type: "afterTurn", stopReason: ctx.stopReason, ...(tag !== undefined ? { tag } : {}) });
    },
    async beforeToolCall(call) {
      log.push({ type: "beforeToolCall", name: call.name, ...(tag !== undefined ? { tag } : {}) });
    },
    async afterToolCall(call) {
      log.push({
        type: "afterToolCall", name: call.name, isError: call.isError,
        ...(tag !== undefined ? { tag } : {}),
      });
    },
  };
  return { hooks, log };
}

/** A beforeToolCall hook that vetoes with `reason`. */
export function vetoingHook(reason: string): Hooks {
  return {
    async beforeToolCall() {
      return { veto: true as const, reason };
    },
  };
}

/** A beforeToolCall hook that vetoes using the deprecated 0.1.0-beta spelling. */
export function legacyVetoingHook(reason: string): Hooks {
  return {
    async beforeToolCall() {
      return { abort: true as const, reason };
    },
  };
}

/** A beforeRequest hook that aborts the whole run with `reason`. */
export function abortingHook(reason: string): Hooks {
  return {
    async beforeRequest() {
      return { abortRun: true as const, reason };
    },
  };
}

/** A beforeRequest hook that aborts using the deprecated 0.1.0-beta spelling —
 *  it must still be read as a run abort (fail closed), never as a no-op. */
export function legacyAbortingHook(reason: string): Hooks {
  return {
    async beforeRequest() {
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

/** Hooks whose named members throw `error` (default: a fresh Error naming the
 *  hook), for asserting the error-isolation contract. */
export function throwingHooks(
  names: Array<"beforeRequest" | "afterTurn" | "beforeToolCall" | "afterToolCall">,
  error?: Error,
): Hooks {
  const hooks: Hooks = {};
  for (const name of names) {
    const boom = (): never => {
      throw error ?? new Error(`${name} blew up`);
    };
    if (name === "beforeRequest") hooks.beforeRequest = async () => boom();
    else if (name === "afterTurn") hooks.afterTurn = async () => boom();
    else if (name === "beforeToolCall") hooks.beforeToolCall = async () => boom();
    else hooks.afterToolCall = async () => boom();
  }
  return hooks;
}

/** A beforeRequest hook that mutates `ctx.messages` in place. The context
 *  carries a SNAPSHOT, so this must be a silent no-op — pinned by a test so
 *  nobody "fixes" it into passing the live array. */
export function mutatingHook(marker: string): Hooks {
  return {
    async beforeRequest(ctx) {
      ctx.messages.push({
        id: `mutated-${marker}`,
        role: "user",
        content: marker,
        createdAt: 0,
      });
    },
  };
}

// Re-export the decision types so tests importing from testing can reference them.
export type { PermissionDecision };
export type { Message, ToolResultValue, TokenUsage };
