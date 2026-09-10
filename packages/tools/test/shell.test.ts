import { describe, expect, it } from "vitest";
import { createSafeShell } from "../src/node/index.js";
import { testCtx } from "./helpers.js";

describe("createSafeShell", () => {
  it("runs an allowlisted command and reports exit code + stdout", async () => {
    const shell = createSafeShell({ allowlist: ["echo"] });
    const r = await shell.execute({ command: "echo hello world" }, testCtx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain("exit code: 0");
    expect(r.content).toContain("hello world");
  });

  it("handles quoted arguments", async () => {
    const shell = createSafeShell({ allowlist: ["echo"] });
    const r = await shell.execute({ command: `echo "two  spaces" 'a b'` }, testCtx());
    expect(r.content).toContain("two  spaces a b");
  });

  it("refuses executables outside the allowlist (never spawns)", async () => {
    const shell = createSafeShell({ allowlist: ["echo"] });
    const r = await shell.execute({ command: "rm -rf /tmp/x" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not in the allowlist");
  });

  it.each(["echo a && echo b", "echo a | cat", "echo a; echo b", "echo `id`", "echo $(id)", "echo a > /tmp/pwn", "echo a < /etc/passwd", "echo a || echo b"])(
    "refuses metacharacters: %s",
    async (command) => {
      const shell = createSafeShell({ allowlist: ["echo", "cat", "id"] });
      const r = await shell.execute({ command }, testCtx());
      expect(r.isError).toBe(true);
      expect(r.content).toContain("metacharacter");
    },
  );

  it("refuses unmatched quotes and empty commands", async () => {
    const shell = createSafeShell({ allowlist: ["echo"] });
    expect((await shell.execute({ command: 'echo "unclosed' }, testCtx())).isError).toBe(true);
    expect((await shell.execute({ command: "   " }, testCtx())).isError).toBe(true);
    expect((await shell.execute({}, testCtx())).isError).toBe(true);
  });

  it("kills on timeout and reports it", async () => {
    const shell = createSafeShell({ allowlist: ["sleep"], timeoutMs: 150 });
    const r = await shell.execute({ command: "sleep 5" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Timed out after 150ms");
  });

  it("kills the child when the run aborts", async () => {
    const shell = createSafeShell({ allowlist: ["sleep"], timeoutMs: 60_000 });
    const ac = new AbortController();
    const p = shell.execute({ command: "sleep 5" }, testCtx(ac.signal));
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.content).toBe("(aborted)");
  });

  it("returns (aborted) without spawning when already aborted", async () => {
    const shell = createSafeShell({ allowlist: ["echo"] });
    const ac = new AbortController();
    ac.abort();
    const r = await shell.execute({ command: "echo hi" }, testCtx(ac.signal));
    expect(r.content).toBe("(aborted)");
  });

  it("surfaces spawn failures (missing executable) without throwing", async () => {
    const shell = createSafeShell({ allowlist: ["definitely-not-a-real-cmd-xyz"] });
    const r = await shell.execute({ command: "definitely-not-a-real-cmd-xyz --v" }, testCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("Failed to run");
  });

  it("marks non-zero exit as isError", async () => {
    const shell = createSafeShell({ allowlist: ["ls"] });
    const r = await shell.execute({ command: "ls /definitely-not-a-dir-xyz" }, testCtx());
    expect(r.isError).toBe(true);
  });

  it("ships destructive + shell tag permissions", () => {
    const shell = createSafeShell({ allowlist: ["echo"] });
    expect(shell.permissions?.destructive).toBe(true);
    expect(shell.permissions?.network).toBe(true);
    expect(shell.permissions?.tags).toEqual(["shell"]);
  });
});
