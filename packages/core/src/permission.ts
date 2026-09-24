// Human-in-the-loop permission gate. When a tool requires confirmation, the
// loop emits a `permission_request` event and awaits the gate's decision.
// The run's AbortSignal stays active during the wait; abort cancels it.
//
// createPermissionRules below is the standard second half hosts otherwise
// rebuild every time: an ordered-less rule list (deny always wins), an ask
// handler for unmatched calls, session memory for "always allow/deny"
// decisions, and a serializable snapshot so those decisions survive reloads.

export type PermissionDecision =
  | { allow: true }
  | { allow: true; modifiedInput: unknown }
  | { allow: false; reason: string };

/** The call the loop asks a gate about — the `permission_request` event's
 *  payload plus the tool's declared tags (rules can match on those without
 *  hard-coding tool names). */
export interface PermissionCall {
  toolCallId: string;
  name: string;
  input: unknown;
  destructive: boolean;
  /** The tool's `permissions.tags` (e.g. ["fs:write", "shell"]). */
  tags?: string[];
}

export interface PermissionGate {
  request(call: PermissionCall, signal: AbortSignal): Promise<PermissionDecision>;
}

/**
 * Where a tool's confirmation comes from — the agent-level override of the
 * tools' own declarations (DESIGN §7's layer ladder):
 *  - "tool" (default): each tool's `requiresConfirmation` decides, and the
 *    gate is consulted only for tools that declare it;
 *  - "never": every tool skips the gate, declared or not — the host takes
 *    full responsibility (the agent-level opt-out of deny-by-default);
 *  - "always": every tool passes the gate, read-class tools included — the
 *    gate is consulted even without a declaration.
 * `confirm` wins over declarations in BOTH directions: it is the policy
 * layer above the declaration layer. Either way, a call that needs
 * confirmation with no permissionGate configured is refused.
 */
export type AgentConfirmMode = "tool" | "always" | "never";

// ---------------------------------------------------------------------------
// Rule-based gate
// ---------------------------------------------------------------------------

/** A static rule. Matches when EVERY specified field matches (unspecified
 *  fields are wildcards). Evaluation is order-independent: a matching `deny`
 *  always beats any `allow` — hosts can never accidentally order themselves
 *  into bypassing a hard deny. */
export interface PermissionRule {
  /** Exact tool name; "*" (or omitting every matcher) matches any tool. */
  tool?: string;
  /** Match the tool's `permissions.tags` containing this tag. */
  tag?: string;
  /** Extra input predicate (e.g. command prefixes, path prefixes). */
  when?: (input: unknown) => boolean;
  effect: "allow" | "deny";
}

/** What an ask handler resolves with — the human's answer, optionally a
 *  standing decision (`remember`) and/or a rewritten input. */
export interface PermissionAskResult {
  allow: boolean;
  reason?: string;
  /** Record this decision for the call's fingerprint — later calls with the
   *  same fingerprint skip the ask ("Always allow" buttons set this). */
  remember?: boolean;
  modifiedInput?: unknown;
}

export type PermissionAskHandler = (call: PermissionCall, signal: AbortSignal) => Promise<PermissionAskResult>;

/** One remembered standing decision — the serializable unit of snapshot(). */
export interface RememberedPermission {
  tool: string;
  fingerprint: string;
  effect: "allow" | "deny";
}

/** Durable storage for standing decisions — wires "always allow/deny" across
 *  sessions (localStorage / IDB / host DB). Both sides are best-effort by
 *  contract: a failing load starts an empty memory, a failing save never
 *  breaks the permission flow. */
export interface PermissionPersist {
  /** Load standing decisions once (the first request awaits it — keep it
   *  local and fast). Resolve [] when empty; reject to start blank. */
  load: () => Promise<RememberedPermission[]>;
  /** Called after every change (ask-remember, remember, forgetAll) with the
   *  full current snapshot. Fire-and-forget. */
  save: (snapshot: RememberedPermission[]) => void | Promise<void>;
}

export interface PermissionRulesGate extends PermissionGate {
  /** Record a standing decision directly (what an "always allow/deny" UI
   *  button calls with the fingerprint it shows). A remembered allow can
   *  never bypass a static deny rule — hard policy wins. */
  remember(effect: "allow" | "deny", tool: string, fingerprint?: string): void;
  /** All standing decisions — persist across sessions and seed a new gate
   *  via the `remembered` option. Pair with the SAME `fingerprintOf` on the
   *  receiving gate: fingerprints are only meaningful under the function
   *  that produced them. */
  snapshot(): RememberedPermission[];
  /** Drop every standing decision (rules and the ask handler stay). */
  forgetAll(): void;
}

export interface PermissionRulesOptions {
  /** Static policy. Deny wins over allow regardless of list order; both win
   *  over remembered decisions and the ask path. */
  rules?: PermissionRule[];
  /** Unmatched calls go here (render the question, resolve with the human's
   *  answer). Without it, unmatched calls are DENIED — the library default. */
  onAsk?: PermissionAskHandler;
  /** What "this same thing" means for `remember` (default: the tool name).
   *  Return e.g. the input's path/command to remember per-target. */
  fingerprintOf?: (call: PermissionCall) => string;
  /** Seed standing decisions (a previous gate's snapshot()). For cross-session
   *  memory prefer `persist` — it keeps the store updated automatically. */
  remembered?: RememberedPermission[];
  /** Durable cross-session storage: loaded once, saved after every change. */
  persist?: PermissionPersist;
}

/**
 * Decision ladder, most-specific first:
 *  1. any matching static `deny` rule → deny (hard policy, unbypassable);
 *  2. remembered decision for (tool, fingerprint) → that decision;
 *  3. any matching static `allow` rule → allow;
 *  4. `onAsk` → its answer (recorded when it says remember);
 *  5. nothing → deny (deny-by-default).
 */
export function createPermissionRules(opts: PermissionRulesOptions = {}): PermissionRulesGate {
  const rules = opts.rules ?? [];
  const fingerprintOf = opts.fingerprintOf ?? (() => "");
  const remembered = new Map<string, "allow" | "deny">();
  for (const r of opts.remembered ?? []) {
    remembered.set(JSON.stringify([r.tool, r.fingerprint]), r.effect);
  }
  // Cross-session persistence: loaded once (first request awaits it), saved
  // after every change. Best-effort both ways — see PermissionPersist.
  const persist = opts.persist;
  const ready: Promise<void> = persist
    ? persist.load().then(
        (list) => {
          for (const r of list ?? []) remembered.set(JSON.stringify([r.tool, r.fingerprint]), r.effect);
        },
        () => {
          /* storage error → start blank, never block a permission call */
        },
      )
    : Promise.resolve();

  function currentSnapshot(): RememberedPermission[] {
    return [...remembered.entries()].map(([key, effect]) => {
      const [tool, fingerprint] = JSON.parse(key) as [string, string];
      return { tool, fingerprint, effect };
    });
  }

  function persistSave(): void {
    if (!persist) return;
    try {
      Promise.resolve(persist.save(currentSnapshot())).catch(() => {
        /* storage write failed — the in-memory decision still applies */
      });
    } catch {
      /* sync throw from save() — same contract */
    }
  }

  function ruleMatches(rule: PermissionRule, call: PermissionCall): boolean {
    if (rule.tool !== undefined && rule.tool !== "*" && rule.tool !== call.name) return false;
    if (rule.tag !== undefined && !(call.tags ?? []).includes(rule.tag)) return false;
    if (rule.when !== undefined && !rule.when(call.input)) return false;
    return true;
  }

  return {
    async request(call, signal) {
      await ready; // no-op without persist; settles once after the first load
      const denyRule = rules.find((r) => r.effect === "deny" && ruleMatches(r, call));
      if (denyRule) {
        return { allow: false, reason: describeDeny(denyRule) };
      }
      const fp = JSON.stringify([call.name, fingerprintOf(call)]);
      const rememberedEffect = remembered.get(fp);
      if (rememberedEffect !== undefined) {
        return rememberedEffect === "allow"
          ? { allow: true }
          : { allow: false, reason: "Denied by a remembered decision (forget it to be asked again)" };
      }
      if (rules.some((r) => r.effect === "allow" && ruleMatches(r, call))) {
        return { allow: true };
      }
      if (opts.onAsk) {
        const answer = await opts.onAsk(call, signal);
        if (answer.remember) {
          remembered.set(fp, answer.allow ? "allow" : "deny");
          persistSave();
        }
        if (answer.allow) {
          return "modifiedInput" in answer && answer.modifiedInput !== undefined
            ? { allow: true, modifiedInput: answer.modifiedInput }
            : { allow: true };
        }
        return { allow: false, reason: answer.reason ?? "denied by user" };
      }
      return {
        allow: false,
        reason: `No permission rule matched tool '${call.name}' and no onAsk handler is configured`,
      };
    },

    remember(effect, tool, fingerprint = "") {
      remembered.set(JSON.stringify([tool, fingerprint]), effect);
      persistSave();
    },

    snapshot: currentSnapshot,

    forgetAll() {
      remembered.clear();
      persistSave();
    },
  };
}

function describeDeny(rule: PermissionRule): string {
  const matchers = [
    rule.tool !== undefined ? `tool=${rule.tool}` : undefined,
    rule.tag !== undefined ? `tag=${rule.tag}` : undefined,
    rule.when !== undefined ? "when(…)" : undefined,
  ].filter((s): s is string => s !== undefined);
  return `Denied by rule (${matchers.join(", ")})`;
}
