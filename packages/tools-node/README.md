# @lingjing-agent/tools-node

**[简体中文](https://github.com/qichongfeng/lingjing-agent-core#内置工具可选注入)** | English

Optional built-in tools for [`@lingjing-agent/core`](https://www.npmjs.com/package/@lingjing-agent/core) on **Node / Electron / Tauri-main** hosts (imports `node:*` builtins — never bundle into Edge/browser/mini-program code). Everything is opt-in: import a factory, pass its tools to `createAgent({ tools })`.

```bash
npm install @lingjing-agent/tools-node
```

```ts
import { createAgent } from "@lingjing-agent/core";
import { createFsTools, createSafeShell, createGlobTool, createGrepTool } from "@lingjing-agent/tools-node";

const agent = createAgent({
  /* provider, model, … */
  tools: [
    ...createFsTools({ root: process.cwd() }),                  // read_file / write_file / list_dir / delete_path (path-confined)
    createSafeShell({ allowlist: ["git", "ls", "cat", "rg"] }), // hardened shell: no metachars, spawn(shell:false), timeout
    createGlobTool({ root: process.cwd() }),                    // find files by pattern
    createGrepTool({ root: process.cwd() }),                    // search file contents by regex
  ],
});
```

Security defaults (see [DESIGN.md §7](../../DESIGN.md)): model paths are confined to `root` (`..`/absolute-path/symlink escapes refused), `write_file`/`delete_path`/`shell` ship with `permissions.destructive: true` (permission-gated unless the host opts out), shell runs `spawn(cmd, args, { shell: false })` behind an executable allowlist + metacharacter rejection. Tools carry tags (`fs:read`/`fs:write`/`fs:delete`/`shell`) for `createAgent({ allowedToolTags })`.
