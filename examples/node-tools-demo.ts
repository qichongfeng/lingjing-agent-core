// node-tools-demo — 内置工具包(tools-node / tools-fetch)的无网络端到端 demo。
//
// 流程:scripted DemoProvider 第 1 轮调 list_dir(真实执行,confined 到 demo
// 工作区)→ 第 2 轮调 grep(真实搜索)→ 第 3 轮调 read_file 尝试越界读取(被
// 拒绝,演示路径 confinement)→ 第 4 轮收尾。工具是真实跑的,模型是假的
// —— 证明 wiring 正确,不需要 API key。
//
// 跑(无网络):
//   pnpm --filter @lingjing-agent/example-demo demo:node-tools

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAgent,
  type LLMProvider,
  type ProviderChunk,
  type StopReason,
  type Tool,
} from "@lingjing-agent/core";
import { createFsTools, createGrepTool } from "@lingjing-agent/tools-node";

type Step = { toolCallId: string; name: string; input: object } | { text: string };

// DemoProvider:两次正常工具调用 + 一次越界尝试,然后收尾。
const SCRIPT: Step[][] = [
  [{ toolCallId: "tc1", name: "list_dir", input: {} }],
  [{ toolCallId: "tc2", name: "grep", input: { pattern: "TODO", glob: "*.ts" } }],
  [{ toolCallId: "tc3", name: "read_file", input: { path: "../outside-secret.txt" } }],
  [{ text: "工具链路验证完毕:正常调用在 root 内真实执行,越界读取被拒绝。" }],
];

class DemoProvider implements LLMProvider {
  readonly id = "fake";
  readonly capabilities = {
    stopReasons: ["tool_use", "end_turn"] as readonly StopReason[],
    streaming: true,
  };
  private turn = 0;
  stream(): AsyncIterable<ProviderChunk> {
    const mine = this.turn++;
    return (async function* (): AsyncIterable<ProviderChunk> {
      const plan = SCRIPT[mine]!;
      yield { type: "message_start", messageId: `m${mine + 1}`, model: "fake" };
      for (const step of plan) {
        if ("text" in step) {
          yield { type: "text_delta", text: step.text };
        } else {
          yield { type: "tool_call_start", toolCallId: step.toolCallId, name: step.name };
          yield {
            type: "tool_call_delta",
            toolCallId: step.toolCallId,
            inputJsonDelta: JSON.stringify(step.input),
          };
          yield { type: "tool_call_end", toolCallId: step.toolCallId };
        }
      }
      yield {
        type: "message_end",
        stopReason: "toolCallId" in plan[0]! ? "tool_use" : "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    })();
  }
}

async function main(): Promise<void> {
  // demo 工作区:临时目录里造几个文件;root 外放一个"诱饵"文件。
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "node-tools-demo-"));
  await fsp.writeFile(path.join(root, "app.ts"), "const x = 1; // TODO: refactor\n");
  await fsp.writeFile(path.join(root, "util.ts"), "export const id = (s: string) => s;\n");
  await fsp.writeFile(path.join(root, "notes.md"), "nothing to see\n");
  await fsp.writeFile(path.join(path.dirname(root), "outside-secret.txt"), "SECRET");

  const tools: Tool[] = [...createFsTools({ root }), createGrepTool({ root })];
  const agent = createAgent({
    provider: new DemoProvider(),
    model: "fake",
    system: "你是文件助手。用提供的工具查看工作区。",
    tools,
    maxTurns: 6,
  });

  console.log(`工作区: ${root}\n`);
  const { events, done } = agent.stream("看看工作区里有什么 TODO", { conversationId: "demo" });
  for await (const e of events) {
    if (e.type === "tool_call") console.log(`[模型调用] ${e.name}(${JSON.stringify(e.input)})`);
    if (e.type === "tool_result") {
      const text = e.content
        .map((b) => (b.type === "text" ? b.text : `(${b.type})`))
        .join("\n");
      const head = text.split("\n").slice(0, 6).join("\n");
      console.log(`[工具结果${e.isError ? "·错误" : ""}] →\n${head}\n`);
    }
    if (e.type === "text_delta") process.stdout.write(e.text);
  }
  await done;

  await fsp.rm(root, { recursive: true, force: true });
  await fsp.rm(path.join(path.dirname(root), "outside-secret.txt"), { force: true });
  console.log("\n\n(demo 结束,工作区已清理)");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
