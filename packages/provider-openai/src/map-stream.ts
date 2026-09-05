import type { ProviderChunk } from "@lingjing/agent-core";
import { mapStop } from "./map-stop.js";
import { mapUsage } from "./map-usage.js";
import { enrichError } from "./enrich-error.js";
import type { ChatCompletionChunk } from "./types.js";

/**
 * Map OpenAI streaming ChatCompletionChunks to the core's neutral ProviderChunk.
 *
 * OpenAI streams deltas where tool calls are INDEXED by an integer `index`
 * (not id-first like Anthropic): the first delta for a tool call carries its
 * `id` + `function.name`; subsequent deltas carry `function.arguments`
 * fragments that must be concatenated per-index. Core's `tool_call_delta` is
 * keyed by `toolCallId`, so we use the start-delta id (synthesizing a stable id
 * when OpenAI omits it) as the key.
 *
 * OpenAI emits usage ONLY when `stream_options.include_usage` is set, and it
 * arrives in a FINAL chunk whose `choices` array is empty. `finish_reason`
 * arrives in an earlier chunk. So we emit `message_delta{stopReason}` at
 * `finish_reason` and DEFER `message_end` until the usage chunk (or, if usage
 * never arrives, on stream close as a fallback). Exactly one `message_end` per
 * turn is emitted — core's consumeStream depends on it.
 */

interface AccTool {
  id: string;
}

export async function* mapStream(chunks: AsyncIterable<ChatCompletionChunk>): AsyncIterable<ProviderChunk> {
  let messageId = "";
  let model = "";
  let pendingStop: import("@lingjing/agent-core").StopReason | undefined;
  const tools = new Map<number, AccTool>();

  try {
    for await (const chunk of chunks) {
      // First identifying chunk: capture id/model and emit message_start once.
      if (!messageId && chunk.id) {
        messageId = chunk.id;
        model = chunk.model ?? "";
        yield { type: "message_start", messageId, model };
      } else if (chunk.model && !model) {
        model = chunk.model;
      }

      const choices = chunk.choices ?? [];

      // Usage-only final chunk: empty choices + usage present → emit message_end.
      if (choices.length === 0 && chunk.usage) {
        const usage = mapUsage(chunk.usage);
        yield {
          type: "message_end",
          stopReason: pendingStop ?? "end_turn",
          usage,
        };
        // Mark emitted by clearing pendingStop so the close-fallback is a no-op.
        pendingStop = undefined;
        continue;
      }

      for (const choice of choices) {
        const delta = choice.delta;

        if (delta?.content) {
          yield { type: "text_delta", text: delta.content };
        }

        // o-series reasoning content is vendor-proprietary (no core replay path
        // for OpenAI) — discard it rather than fabricate a thinking_delta.
        // (delta.reasoning / delta.reasoning_content intentionally ignored.)

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const existing = tools.get(tc.index);
            // Start of a new tool call: an id and/or function.name arrives.
            if (!existing) {
              const id = tc.id ?? `call_openai_${tc.index}`;
              const name = tc.function?.name ?? "";
              tools.set(tc.index, { id });
              yield { type: "tool_call_start", toolCallId: id, name };
              // An arguments fragment may accompany the start delta.
              const args = tc.function?.arguments;
              if (args) yield { type: "tool_call_delta", toolCallId: id, inputJsonDelta: args };
            } else {
              // Subsequent fragments: accumulate arguments (OpenAI splits JSON args).
              const args = tc.function?.arguments;
              if (args) yield { type: "tool_call_delta", toolCallId: existing.id, inputJsonDelta: args };
            }
          }
        }

        if (choice.finish_reason) {
          const stopReason = mapStop(choice.finish_reason);
          // Finalize any tool-call blocks first, then surface the stop reason —
          // matches the anthropic ordering (content_block_stop → message_delta).
          for (const acc of tools.values()) {
            yield { type: "tool_call_end", toolCallId: acc.id };
          }
          pendingStop = stopReason;
          yield { type: "message_delta", stopReason };
        }
      }
    }

    // Fallback: if OpenAI didn't honor include_usage (no final usage chunk),
    // emit exactly one message_end at stream close with zeroed usage.
    if (pendingStop !== undefined) {
      yield {
        type: "message_end",
        stopReason: pendingStop,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
  } catch (err) {
    throw enrichError(err);
  }
}
