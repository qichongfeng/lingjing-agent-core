// Intercept hooks — the in-process middleware channel.
//
// TWO CHANNELS, and they are not interchangeable:
//   - `AgentEvent` (events.ts) — OBSERVE. Serializable, one-way, post-hoc.
//     Forward it over IPC/SSE verbatim; it can never change a run.
//   - `Hooks` (this file) — INTERCEPT. In-process, receives live objects
//     (`Tool[]`, `AbortSignal`) and can RETURN A DECISION (inject / veto /
//     rewrite input / abort the run).
// Use events for UI, metrics and audit; use hooks when the run's behavior must
// change. Human approval is neither — it is `permissionGate` + the
// `permission_request` event (see permission.ts): a hook cannot ask a human,
// because it has no way to surface a question into the stream.
//
// NAMING CONVENTION: `before*` = intercept (can change or stop the action),
// `after*` = observe (its return value is ignored; it cannot change anything).
//
// ERROR ISOLATION — an intercept hook that throws never lets the guarded
// action through; an observe hook that throws never fails the run:
//
//   beforeRequest    intercept, run scope    throws -> FAIL CLOSED: the run
//                    dies with `error{code:"hook_error"}` and `done` rejects
//                    a `HookError` naming the hook. The request is not sent.
//   beforeToolCall   intercept, tool scope   throws -> FAIL CLOSED: the tool
//                    is not executed; the model gets an isError tool_result
//                    naming the hook. The run continues.
//   afterTurn        observe                 throws -> FAIL SOFT: logged as a
//                    warning through `AgentConfig.logger`, run continues.
//   afterToolCall    observe                 throws -> FAIL SOFT: same.
//
// WHAT beforeRequest CANNOT DO: it receives a SNAPSHOT of `ctx.messages`
// (`[...messages]`), so in-place mutation is a silent no-op. It can only
// APPEND (via `{inject}`); history is append-only by contract. Redacting
// content on the way out is a different job — use `redact()` (redact.ts),
// which filters the event stream at the egress boundary.
//
// `ctx.tools` IS live: it is the run's tool array, so pushing to it changes
// the tools available to that request (the only per-turn tool-scoping
// mechanism that exists). Pinned by a test — do not "tidy" it into a copy.

import type { StopReason, TokenUsage } from "./provider.js";
import type { Message } from "./types.js";
import { userMessage, withRunId } from "./types.js";
import type { Tool, ToolResultValue } from "./tool.js";

export interface HookContext {
  conversationId: string;
  turn: number;
  /** SNAPSHOT of the history at this instant — mutating it in place does NOT
   *  change the request. Append through `beforeRequest`'s `{inject}` instead. */
  messages: Message[];
  /** The run's LIVE tool array (see the file header). */
  tools: Tool[];
  signal: AbortSignal;
  /** True on the first request after a context compaction (soft trigger or
   *  overflow). Compaction folds early history into a summary — hooks can use
   *  this to re-inject durable state the recap may have lost (e.g. the current
   *  task plan), the way Claude Code re-injects its todo list after /compact. */
  compacted?: boolean;
}

export interface BeforeToolCallCall {
  toolCallId: string;
  name: string;
  input: unknown;
  ctx: HookContext;
}

export interface AfterToolCallCall {
  toolCallId: string;
  name: string;
  result: ToolResultValue;
  isError: boolean;
  ctx: HookContext;
}

/** What `beforeRequest` may inject: a string becomes a user message, a Message
 *  is used as-is, and an array is appended in order. */
export type HookInject = string | Message | Array<string | Message>;

export type BeforeRequestResult =
  | void
  | { abortRun: true; reason: string }
  | { inject: HookInject }
  /** @deprecated 0.1.0-beta spelling — read as `abortRun` (the fail-closed
   *  reading, so an un-migrated host cannot silently lose its guardrail).
   *  Removed in 0.2: this is a RUN-scope abort, not a tool veto. */
  | { abort: true; reason: string };

export type BeforeToolCallResult =
  | void
  | { veto: true; reason: string }
  | { modifiedInput: unknown }
  /** @deprecated 0.1.0-beta spelling — read as `veto` (the tool is not
   *  executed, the run continues). Removed in 0.2. */
  | { abort: true; reason: string };

export interface Hooks {
  /** INTERCEPT (run scope). Before sending to the provider; fires on EVERY
   *  turn, including each iteration of a tool loop. Can append context or stop
   *  the run. Throwing fails the run closed — see the file header. */
  beforeRequest?(ctx: HookContext): Promise<BeforeRequestResult>;
  /** OBSERVE. After the turn's response is stamped, pushed into history and
   *  persisted, before the `stopReason` dispatch. Fires on EVERY turn —
   *  `tool_use` turns included — so it is NOT a "final answer" hook; the
   *  final turn is the one whose `stopReason` is `end_turn`/`stop_sequence`.
   *  The response is already committed and cannot be changed. Throwing is
   *  logged and swallowed. Return value is ignored. */
  afterTurn?(
    ctx: HookContext & {
      response: Message;
      stopReason: StopReason;
      usage: TokenUsage;
    },
  ): Promise<void>;
  /** INTERCEPT (tool scope). After the input passed schema validation, before
   *  the permission gate. Can veto (the tool does not run; the model is told
   *  why) or rewrite the input (re-validated against the tool schema before
   *  execution). Throwing does NOT kill the run: the tool is skipped and the
   *  failure is reported to the model as an isError tool_result. */
  beforeToolCall?(
    call: BeforeToolCallCall,
  ): Promise<BeforeToolCallResult>;
  /** OBSERVE. After a tool call settles — success, failure OR timeout — before
   *  the `tool_result` event is emitted. Skipped when the run itself is
   *  aborted. Throwing is logged and swallowed. Return value is ignored. */
  afterToolCall?(call: AfterToolCallCall): Promise<void>;
}

/** An INTERCEPT hook threw. `hook` names it so a host can tell a broken
 *  guardrail from a provider outage (which reports `code: "provider_error"`);
 *  `cause` keeps the original error. */
export class HookError extends Error {
  override readonly name = "HookError";
  readonly hook: string;
  constructor(hook: string, cause: unknown) {
    super(
      `${hook} hook failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.hook = hook;
  }
}

/** A hook deliberately stopped the run (`beforeRequest` → `{abortRun}`).
 *  `message` is the hook's own reason. */
export class HookAbortError extends Error {
  override readonly name = "HookAbortError";
  constructor(reason: string) {
    super(reason);
  }
}

/** Turn a hook's `inject` payload into concrete messages: strings become user
 *  messages, everything is stamped with `runId` when one is given. Shared by
 *  the loop and structured.ts so injection normalizes in exactly one place. */
export function normalizeInjected(
  inject: HookInject,
  now: () => number,
  runId?: string,
): Message[] {
  const items = Array.isArray(inject) ? inject : [inject];
  return items.map((it) => {
    const m = typeof it === "string" ? userMessage(it, now) : it;
    return runId !== undefined ? withRunId(m, runId) : m;
  });
}
