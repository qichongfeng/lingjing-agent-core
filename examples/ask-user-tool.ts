// ask-user-tool — 一个"主动澄清"工具的参考实现。
//
// 当模型不确定 / 需要用户决策时,主动调用 ask_user 问用户(而非瞎猜)。
// 这和 core 的 permissionGate 不同:permissionGate 是"工具执行前的被动守卫"
// (loop 在 requiresConfirmation 的工具 execute 前触发),ask_user 是"模型主动
// 发起的 tool_call"(任何时候模型想问就调,答案作为 tool_result 回喂)。
//
// 本文件给两个 execute 版本:
//   1. Node readline(下面默认,demo 可跑)
//   2. 微信小程序 wx.showModal / wx.showActionSheet(注释块,复制到小程序工程用)
//
// 跑(Node,交互式):
//   pnpm --filter @lingjing/example-demo demo:ask-user
//   (模拟模型调 ask_user → readline 真实问终端 → 模型继续)

import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  createAgent,
  type LLMProvider,
  type ProviderChunk,
  type StopReason,
  type Tool,
} from "@lingjing/agent-core";

// ---------------------------------------------------------------------------
// ask_user 工具(Node readline 版)
// ---------------------------------------------------------------------------

const askUser: Tool = {
  name: "ask_user",
  description:
    "Ask the user a clarifying question when you are unsure or need a decision. " +
    "Use sparingly — try to decide yourself first; only ask when genuinely ambiguous.",
  inputSchema: {
    jsonSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask the user." },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional: constrain the answer to these choices.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  // 等用户回答可能很久 —— 覆盖默认 30s toolTimeoutMs。
  timeoutMs: 1000 * 60 * 30,
  async execute(rawInput, ctx) {
    const { question, options } = rawInput as { question: string; options?: string[] };
    const rl = readline.createInterface({ input, output });
    // run abort 时关闭 stdin → rl.question reject。
    const onAbort = (): void => rl.close();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const prompt =
        options && options.length > 0
          ? `${question}\n选项: ${options.join(" / ")}\n> `
          : `${question}\n> `;
      const answer = await rl.question(prompt);
      if (ctx.signal.aborted) return { content: "(用户取消)", isError: true };
      return { content: answer };
    } catch {
      return { content: "(用户取消或输入失败)", isError: true };
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      rl.close();
    }
  },
};

// ---------------------------------------------------------------------------
// 小程序版本(复制到小程序工程,用 wx.showModal / wx.showActionSheet 替换 execute)
// ---------------------------------------------------------------------------
//
// const askUserWx: Tool = {
//   name: "ask_user",
//   description: " ...(同上)... ",
//   inputSchema: { jsonSchema: { ...(同上)... } },
//   timeoutMs: 1000 * 60 * 30,
//   async execute(rawInput) {
//     const { question, options } = rawInput as { question: string; options?: string[] };
//     // 多选 → wx.showActionSheet;开放式提问 → wx.showModal(editable)
//     if (options && options.length > 0) {
//       return new Promise((resolve) =>
//         wx.showActionSheet({
//           itemList: options,
//           success: (res) => resolve({ content: options[res.tapIndex] ?? "" }),
//           fail: () => resolve({ content: "(用户取消)", isError: true }),
//         }),
//       );
//     }
//     return new Promise((resolve) =>
//       wx.showModal({
//         title: "需要你确认",
//         content: question,
//         editable: true,
//         placeholderText: "请输入",
//         success: (res) =>
//           res.confirm
//             ? resolve({ content: res.content ?? "" })
//             : resolve({ content: "(用户取消)", isError: true }),
//         fail: () => resolve({ content: "(失败)", isError: true }),
//       }),
//     );
//   },
// };

// ---------------------------------------------------------------------------
// demo:模拟"模型不确定 → 调 ask_user → readline 问 → 模型继续"(无网络)
// ---------------------------------------------------------------------------

// FakeProvider:第 1 轮调 ask_user 问"你想要什么颜色?",第 2 轮回复"明白了"。
class DemoProvider implements LLMProvider {
  readonly id = "fake";
  readonly capabilities = {
    stopReasons: ["tool_use", "end_turn"] as readonly StopReason[],
    streaming: true,
  };
  private turn = 0;
  constructor(private question: string) {}
  stream(): AsyncIterable<ProviderChunk> {
    const mine = this.turn++;
    const self = this;
    return (async function* (): AsyncIterable<ProviderChunk> {
      if (mine === 0) {
        yield { type: "message_start", messageId: "m1", model: "fake" };
        yield { type: "tool_call_start", toolCallId: "tc1", name: "ask_user" };
        yield {
          type: "tool_call_delta",
          toolCallId: "tc1",
          inputJsonDelta: JSON.stringify({ question: self.question }),
        };
        yield { type: "tool_call_end", toolCallId: "tc1" };
        yield { type: "message_end", stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } };
      } else {
        yield { type: "message_start", messageId: "m2", model: "fake" };
        yield { type: "text_delta", text: "明白了。" };
        yield { type: "message_end", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      }
    })();
  }
}

async function main(): Promise<void> {
  const agent = createAgent({
    provider: new DemoProvider("你想要什么颜色?"),
    model: "fake",
    system: "你是一个助手。不确定用户意图时,调用 ask_user 工具问用户,不要瞎猜。",
    tools: [askUser],
    maxTurns: 5,
  });

  console.log("用户: 帮我选个颜色\n");
  const { events, done } = agent.stream("帮我选个颜色", { conversationId: "demo" });
  for await (const e of events) {
    if (e.type === "tool_call") console.log(`\n[模型调用] ${e.name}(${JSON.stringify(e.input)})`);
    if (e.type === "tool_result")
      console.log(`[用户回答] → ${typeof e.content === "string" ? e.content : "<blocks>"}`);
    if (e.type === "text_delta") process.stdout.write(e.text);
  }
  await done;
  console.log("\n\n(demo 结束)");
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
