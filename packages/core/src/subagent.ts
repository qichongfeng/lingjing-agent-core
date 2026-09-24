// Subagents — the spawn pattern (Claude Code / Codex style): a tool that runs
// a fresh, isolated conversation with a restricted toolset and returns only
// its final report. Pure composition over createAgent: no platform APIs, so
// the same code runs on web / 小程序 / Node. The host's IO isolation (e.g. FSA
// project scope) comes from which Tool instances it puts in each definition.

import { AbortError } from "./abort.js";
import { createAgent } from "./agent.js";
import type { AgentEvent } from "./events.js";
import type { Hooks } from "./hooks.js";
import type { ModelTiers } from "./models.js";
import type { LLMProvider } from "./provider.js";
import type { Tool, ToolCallContext, ToolResultValue } from "./tool.js";
import { extractText, randomId, type TextContent } from "./types.js";

/** Default per-call timeout for spawn_agent. A subagent run is a whole
 *  conversation, not a quick side effect, so this is deliberately far above
 *  the 30s default tool timeout. Kept finite (setTimeout overflow guard). */
export const DEFAULT_SPAWN_TIMEOUT_MS = 600_000;

/** Subagent turn cap. Lower than the host default (25): a delegated task that
 *  needs more than this is a sign the task was scoped too broadly. */
export const DEFAULT_SUBAGENT_MAX_TURNS = 15;

export interface SubagentDefinition {
  /** Unique identifier, also the value the model passes as `agent`. lowercase / digits / - / _ */
  name: string;
  /** WHEN to delegate to this subagent — surfaces to the model inside the
   *  spawn_agent tool description (model-driven routing, like .claude/agents). */
  description: string;
  /** The subagent's system prompt. */
  system: string | TextContent[];
  /** Whitelist of tools the subagent may use. Inject nothing extra: this IS
   *  the guardrail (subagents run headless — no permission gate). */
  tools: Tool[];
  /** Model override for THIS subagent (e.g. the fast tier). Omit to use the
   *  spawn tool's default. With `SpawnToolOptions.models` also set, the
   *  override rewrites the child's `main` tier — fast/max remain as downward
   *  fallbacks and auto-compact still wires up (a fast-tier override never
   *  upgrades on failure: fallbackChain steps down only). */
  model?: string;
  /** Turn cap for this subagent. Default DEFAULT_SUBAGENT_MAX_TURNS. */
  maxTurns?: number;
}

export interface SpawnEventMeta {
  /** Definition name of the running subagent. */
  agent: string;
  /** Unique id for THIS run — correlates the forwarded event stream. */
  runId: string;
  /** Nesting depth: 1 = spawned directly by the host agent. */
  depth: number;
  /** toolCallId of the spawn_agent call that started this run — hosts key
   *  their progress UI by it (parallel spawns correlate exactly). */
  toolCallId: string;
}

export interface SpawnToolOptions {
  provider: LLMProvider;
  /** Default model for subagents without their own `model`. */
  model?: string;
  /** Tier config passed through to subagents (enables per-turn fallback and
   *  auto-compact inside each subagent). Mutually exclusive per-subagent with
   *  `SubagentDefinition.model`. */
  models?: ModelTiers;
  /** Max nesting depth. 1 (default) = subagents cannot spawn further
   *  subagents; 2 = they get their own spawn tool (depth-capped). */
  maxDepth?: number;
  /** Max subagents running concurrently, shared across ALL nesting levels —
   *  the portable stand-in for per-runtime network limits (e.g. 小程序's
   *  wx.request concurrency cap). Default 3. */
  maxConcurrent?: number;
  /** Per-call timeout for the spawn tool. Default DEFAULT_SPAWN_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Forward every subagent event (start/turn_end/done/…), tagged with the
   *  subagent's name/runId/depth. Hosts render progress from this; the parent
   *  conversation only ever sees the final tool_result. */
  onEvent?: (event: AgentEvent, meta: SpawnEventMeta) => void;
  /** Hooks applied to every subagent run. The type accepts ONLY `beforeRequest`
   *  and that is deliberate: a subagent has its own tool whitelist, so
   *  inheriting the host's `beforeToolCall` veto rules would misfire, and the
   *  observe hooks would duplicate what `onEvent` already forwards in full.
   *
   *  These are NOT inherited from the host agent's `AgentConfig.hooks` — a Tool
   *  has no back-reference to the agent that registered it, so `createSpawnTool`
   *  cannot see that config. (Threading hooks through `ToolCallContext` would
   *  make it possible, at the cost of handing every tool a lever on agent-level
   *  policy; and a `beforeRequest` bound to the host's memory store would
   *  retrieve the host's other conversations into an ephemeral child.)
   *
   *  SECURITY: subagents run headless with NO permission gate — the tool
   *  whitelist is the primary control. A guardrail that must hold inside
   *  subagents therefore has to be declared HERE as well: if it is only on
   *  `AgentConfig.hooks`, it does not apply to any child run. */
  hooks?: Pick<Hooks, "beforeRequest">;
}

const TOOL_NAME = "spawn_agent";
const NAME_RE = /^[a-z0-9_-]{1,64}$/;

/**
 * Build the spawn_agent tool from a registry of subagent definitions. Register
 * it on the host agent like any other tool; the model routes by the
 * descriptions embedded in the tool description. Subagent conversations are
 * ephemeral (in-memory, fresh id per run) — they never touch the host's
 * memory store.
 */
export function createSpawnTool(defs: SubagentDefinition[], opts: SpawnToolOptions): Tool {
  if (!Array.isArray(defs) || defs.length === 0) {
    throw new Error("createSpawnTool requires at least one SubagentDefinition");
  }
  if (!opts?.provider) throw new Error("SpawnToolOptions.provider is required");
  const seen = new Set<string>();
  for (const def of defs) {
    if (!NAME_RE.test(def.name)) {
      throw new Error(`SubagentDefinition.name "${def.name}" must match ${NAME_RE}`);
    }
    if (seen.has(def.name)) throw new Error(`Duplicate subagent name: ${def.name}`);
    seen.add(def.name);
  }
  // Children need a default model the same way createAgent does: explicit
  // per-def model, or a spawn-tool-wide default (model / models.main).
  if (opts.models !== undefined && (typeof opts.models.main !== "string" || opts.models.main === "")) {
    throw new Error("SpawnToolOptions.models.main is required when `models` is set");
  }
  const defaultModel = typeof opts.model === "string" && opts.model !== "" ? opts.model : opts.models?.main;
  if (defaultModel === undefined && defs.some((d) => typeof d.model !== "string" || d.model === "")) {
    throw new Error("createSpawnTool needs a default model: set SpawnToolOptions.model or .models (or a model on every definition)");
  }
  const maxDepth = opts.maxDepth ?? 1;
  if (!(maxDepth >= 1)) throw new Error(`SpawnToolOptions.maxDepth must be >= 1 (got ${maxDepth})`);
  const maxConcurrent = opts.maxConcurrent ?? 3;
  if (!(maxConcurrent >= 1)) throw new Error(`SpawnToolOptions.maxConcurrent must be >= 1 (got ${maxConcurrent})`);

  const byName = new Map(defs.map((d) => [d.name, d] as const));
  const sem = new Semaphore(maxConcurrent);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;

  function toolAtDepth(spawnDepth: number): Tool {
    return {
      name: TOOL_NAME,
      // 模型面文案不提工具(host 约定:工具能力只在各工具自己的 description
      // 里;这里只说委托语义与何时可用)。
      description:
        "Delegate a self-contained task to a specialized subagent running in its own fresh context. " +
        "The subagent sees ONLY the task text — no prior conversation — so keep the task complete and " +
        "specific (goal, constraints, expected output). Its final report comes back as the tool result. " +
        "Available subagents:\n" +
        defs.map((d) => `- ${d.name}: ${d.description}`).join("\n"),
      inputSchema: {
        jsonSchema: {
          type: "object",
          properties: {
            // No enum: an invalid name must yield OUR error listing the roster
            // (schema-level rejection would say "not in enum" and nothing more).
            agent: { type: "string", description: "Which subagent to run — one of the names listed above." },
            task: { type: "string", description: "The complete, self-contained task for the subagent." },
          },
          required: ["agent", "task"],
          additionalProperties: false,
        },
      },
      timeoutMs,
      execute(input, ctx) {
        return runSubagent(input, ctx, spawnDepth);
      },
    };
  }

  async function runSubagent(input: unknown, ctx: ToolCallContext, spawnDepth: number): Promise<ToolResultValue> {
    const { agent, task } = (input ?? {}) as { agent?: string; task?: string };
    const def = typeof agent === "string" ? byName.get(agent) : undefined;
    if (!def) {
      // Recoverable misroute: tell the model what exists so the next call lands.
      return {
        content: `Unknown subagent ${JSON.stringify(agent)}. Available: ${[...byName.keys()].join(", ")}`,
        isError: true,
      };
    }
    if (typeof task !== "string" || task === "") {
      return { content: "spawn_agent input `task` must be a non-empty string", isError: true };
    }

    const runId = randomId();
    // Link the tool call's signal (run abort + tool timeout) onto the child
    // run, so stopping the parent stops the subagent with it.
    const childAbort = new AbortController();
    const onOuterAbort = (): void => childAbort.abort();
    if (ctx.signal.aborted) childAbort.abort();
    else ctx.signal.addEventListener("abort", onOuterAbort, { once: true });

    // Only release what was acquired: a waiter aborted out of the queue never
    // held a slot, and releasing anyway would inflate the semaphore's capacity.
    let acquired = false;
    try {
      await sem.acquire(ctx.signal);
      acquired = true;

      // Nested spawn: hand the subagent its own (deeper) spawn tool unless the
      // depth cap says no. A definition that already carries a tool of this
      // name keeps its own — the host made that choice explicitly.
      const nested = spawnDepth < maxDepth && !def.tools.some((t) => t.name === TOOL_NAME);
      const child = createAgent({
        provider: opts.provider,
        ...(def.model !== undefined && opts.models !== undefined
          ? { models: { ...opts.models, main: def.model } } // override rewrites main; tiers stay as downward fallbacks
          : def.model !== undefined
            ? { model: def.model }
            : opts.models !== undefined
              ? { models: opts.models }
              : { model: defaultModel! }), // non-null by validation above
        system: def.system,
        tools: nested ? [...def.tools, toolAtDepth(spawnDepth + 1)] : def.tools,
        maxTurns: def.maxTurns ?? DEFAULT_SUBAGENT_MAX_TURNS,
        // Only what the spawn tool declared — never the host agent's hooks
        // (see SpawnToolOptions.hooks). A deeper nest inherits automatically:
        // `toolAtDepth` closes over the same `opts`.
        ...(opts.hooks ? { hooks: opts.hooks } : {}),
      });

      const handle = child.conversation(`subagent-${runId}`).send(task, { signal: childAbort.signal });
      // Drain + forward the child's events; a throwing onEvent callback must
      // not take the child run down with it.
      let reportUsage: { inputTokens: number; outputTokens: number; turns: number } | undefined;
      const drain = (async () => {
        try {
          for await (const e of handle.events) {
            if (e.type === "done") {
              reportUsage = { inputTokens: e.totalUsage.inputTokens, outputTokens: e.totalUsage.outputTokens, turns: e.turns };
            }
            try {
              opts.onEvent?.(e, { agent: def.name, runId, depth: spawnDepth, toolCallId: ctx.toolCallId });
            } catch {
              /* host callback error — keep forwarding */
            }
          }
        } catch {
          /* queue is single-consumer and we are the only consumer; unreachable */
        }
      })();

      try {
        const final = await handle.done;
        await drain; // let buffered events (incl. done/usage) flush before we read them
        const text = extractText(final);
        // Usage rollup: the child's tokens ride the tool result so the parent
        // model (and any transcript reader) sees the real cost of delegation.
        const footer =
          reportUsage !== undefined
            ? `\n\n[subagent "${def.name}": ${reportUsage.turns} turn(s), ~${reportUsage.inputTokens} in / ~${reportUsage.outputTokens} out tokens]`
            : "";
        return { content: (text !== "" ? text : "(subagent returned no text)") + footer };
      } catch (err) {
        await drain; // flush whatever the child produced before failing
        if (childAbort.signal.aborted) {
          return { content: `subagent "${def.name}" aborted`, isError: true };
        }
        return {
          content: `subagent "${def.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    } catch (err) {
      // Semaphore wait aborted, or setup failed before the child started.
      if (err instanceof AbortError || ctx.signal.aborted) {
        return { content: `subagent "${def.name}" aborted`, isError: true };
      }
      return {
        content: `subagent "${def.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    } finally {
      ctx.signal.removeEventListener("abort", onOuterAbort);
      if (acquired) sem.release();
    }
  }

  return toolAtDepth(1);
}

/** Counting semaphore, FIFO. `release()` hands its slot directly to the first
 *  live waiter (active count unchanged) so a burst of acquires can never
 *  overshoot the limit between the handoff microtasks. Abortable: a waiter
 *  removed from the queue rejects with AbortError. */
class Semaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    dead: boolean;
  }> = [];

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.active < this.limit && this.waiters.length === 0) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = { resolve, dead: false };
      this.waiters.push(waiter);
      const onAbort = (): void => {
        if (waiter.dead) return;
        waiter.dead = true;
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new AbortError("subagent queue aborted"));
      };
      // Per-call signals are short-lived (one tool call); the listener dies
      // with the signal — no removeEventListener bookkeeping needed.
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  release(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      if (!waiter.dead) {
        waiter.dead = true; // slot transferred — active count already covers it
        waiter.resolve();
        return;
      }
    }
    this.active--;
  }
}
