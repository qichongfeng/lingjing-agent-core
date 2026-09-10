// stdio "server" for transport-loss handling: answers `initialize` and the
// FIRST `tools/list`, then exits with code 3 on the NEXT line (the session's
// refresh) WITHOUT answering it — the pending request must reject with the
// exit message, and close() must still resolve.
//
// Exiting only after consuming the refresh's line keeps the test
// deterministic: the client's write succeeds into a live pipe (no EPIPE
// race), so the sole failure signal is the child's close event carrying the
// exit code.

import { createInterface } from "node:readline";

let listed = false;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "die", version: "1.0" },
        },
      }) + "\n",
    );
  } else if (msg.method === "tools/list") {
    if (!listed) {
      listed = true;
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }) + "\n");
    } else {
      process.exit(3);
    }
  }
  // notifications/* and anything else: ignore.
});
