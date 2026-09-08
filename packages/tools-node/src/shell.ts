// Hardened shell tool for Node hosts (DESIGN.md §7.5).
//
// Defence in depth against prompt-injected command execution:
//   1. ALLOWLIST — the executable (first token) must be in the host-configured
//      allowlist. Allowlist by default, never a blocklist.
//   2. NO SHELL — spawn with shell:false, so even a smuggled metacharacter is
//      just a literal argument, not syntax. Belt to the suspenders below.
//   3. METACHAR REJECTION — `&&` `||` `|` `;` backticks `$( )` `<` `>` are
//      refused outright: a model that "wants" them is trying to chain/redirect,
//      which the tool cannot express anyway. Failing loudly beats silent
//      mangling.
//   4. BOUNDS — pinned cwd, per-call timeout (SIGKILL), output byte cap,
//      abort propagates from the agent run (ctx.signal kills the child).
//
// Ships with `permissions.destructive: true` — hosts get the permission gate
// unless they explicitly opt out.

import { spawn } from "node:child_process";
import type { Tool, ToolResultValue } from "@lingjing-agent/core";

export interface SafeShellOptions {
  /** Allowed executables (first token of the command), e.g. ["git", "ls", "cat", "rg"]. */
  allowlist: string[];
  /** Working directory pinned for every invocation. Default process.cwd(). */
  cwd?: string;
  /** Kill the process after this long. Default 30_000. */
  timeoutMs?: number;
  /** Per-stream (stdout/stderr) output cap. Default 64 KiB. */
  maxOutputBytes?: number;
}

const METACHARS = ["&&", "||", "|", ";", "`", "$(", "<", ">", "\n"] as const;

function refused(msg: string): ToolResultValue {
  return { content: `Refused: ${msg}`, isError: true };
}

/**
 * Quote-aware whitespace tokenizer (single + double quotes concatenate, like
 * POSIX shells). Returns null on unmatched quotes. NO escape/interp semantics —
 * with shell:false a backslash is a literal character.
 */
function tokenize(cmd: string): string[] | null {
  const args: string[] = [];
  let cur = "";
  let has = false;
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i]!;
    if (c === "'" || c === '"') {
      const close = cmd.indexOf(c, i + 1);
      if (close === -1) return null;
      cur += cmd.slice(i + 1, close);
      has = true;
      i = close + 1;
    } else if (c === " " || c === "\t" || c === "\r") {
      if (has) args.push(cur);
      cur = "";
      has = false;
      i++;
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  if (has) args.push(cur);
  return args;
}

export function createSafeShell(opts: SafeShellOptions): Tool {
  const allowed = new Set(opts.allowlist);
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxOutputBytes = opts.maxOutputBytes ?? 64 * 1024;

  return {
    name: "shell",
    description:
      `Run an allowlisted command (${[...allowed].join(", ") || "(none)"}). ` +
      "Arguments may be single- or double-quoted. No pipelines, redirection, " +
      "chaining, or variables — one command per call.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command line, e.g. `git status --short`." },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
    timeoutMs,
    permissions: { destructive: true, network: true, tags: ["shell"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      const { command } = raw as { command?: string };
      if (typeof command !== "string" || command.trim().length === 0) {
        return refused("input.command must be a non-empty string");
      }
      const bad = METACHARS.find((m) => command.includes(m));
      if (bad) return refused(`shell metacharacter ${JSON.stringify(bad)} is not allowed`);
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
      const argv = tokenize(command.trim());
      if (argv === null) return refused("unmatched quote in command");
      const exe = argv[0];
      if (exe === undefined || !allowed.has(exe)) {
        return refused(`executable '${exe ?? ""}' is not in the allowlist [${[...allowed].join(", ")}]`);
      }

      return await new Promise<ToolResultValue>((resolve) => {
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let timedOut = false;
        let kill: () => void = () => {};
        const cap = (s: string, chunk: string): string => {
          if (s.length >= maxOutputBytes) {
            truncated = true;
            return s;
          }
          if (s.length + chunk.length > maxOutputBytes) {
            truncated = true;
            return s + chunk.slice(0, maxOutputBytes - s.length);
          }
          return s + chunk;
        };

        // Linked stop: per-call timeout OR agent abort/run abort (ctx.signal).
        const timer = setTimeout(() => {
          timedOut = true;
          kill();
        }, timeoutMs);
        const onAbort = (): void => kill();
        ctx.signal.addEventListener("abort", onAbort, { once: true });

        const child = spawn(exe, argv.slice(1), {
          cwd,
          shell: false, // hard guarantee — argv is exec'd directly, never interpreted
          windowsHide: true,
        });
        kill = (): void => {
          if (!child.killed) child.kill("SIGKILL");
        };
        child.stdout?.setEncoding("utf8").on("data", (d: string) => {
          stdout = cap(stdout, d);
        });
        child.stderr?.setEncoding("utf8").on("data", (d: string) => {
          stderr = cap(stderr, d);
        });

        const finish = (r: ToolResultValue): void => {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          resolve(r);
        };
        child.on("error", (err) => {
          // ENOENT (exe vanished), EACCES, spawn failures — surface, never crash the loop.
          finish({ content: `Failed to run '${exe}': ${err.message}`, isError: true });
        });
        child.on("close", (code, signal) => {
          if (timedOut) {
            finish({
              content: `Timed out after ${timeoutMs}ms — process killed.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
              isError: true,
            });
            return;
          }
          if (ctx.signal.aborted) {
            finish({ content: "(aborted)", isError: true });
            return;
          }
          const parts = [
            `exit code: ${code ?? `signal ${signal ?? "?"}`}`,
            stdout ? `stdout:\n${stdout}` : "stdout: (empty)",
            stderr ? `stderr:\n${stderr}` : "",
            truncated ? "[output truncated]" : "",
          ].filter(Boolean);
          finish({ content: parts.join("\n"), isError: code !== 0 });
        });
      });
    },
  };
}
