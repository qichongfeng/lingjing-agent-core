import type { ProviderChunk, StopReason, TokenUsage } from "@lingjing-agent/core";
import { mapStop } from "./map-stop.js";
import { mapUsage } from "./map-usage.js";
import { enrichError } from "./enrich-error.js";
import type { AnthropicStreamEvent, AnthropicUsage } from "./types.js";

interface BlockState {
  type: "text" | "thinking" | "tool_use";
  id?: string; // tool_use id (from content_block_start)
  signature?: string; // accumulated thinking signature (from signature_delta)
}

/**
 * Map Anthropic streaming events (content_block_* / message_*) to core's neutral
 * ProviderChunk. Tool-use is id-keyed (Anthropic's content_block_start carries
 * the id up front, unlike OpenAI's index-keyed start). Thinking signature is
 * accumulated across `signature_delta` and emitted on `thinking_end`. Re-throws
 * any source rejection as a classified ProviderError via enrichError.
 */
export async function* mapStream(events: AsyncIterable<AnthropicStreamEvent>): AsyncIterable<ProviderChunk> {
  let messageId = "";
  let pendingStop: StopReason | undefined;
  let pendingUsage: TokenUsage | undefined;
  const blocks = new Map<number, BlockState>();

  try {
    for await (const ev of events) {
      switch (ev.type) {
        case "message_start": {
          const msg = (ev as unknown as{ message?: { id?: string; model?: string } }).message;
          messageId = msg?.id ?? "";
          if (messageId) {
            yield { type: "message_start", messageId, model: msg?.model ?? "" };
          }
          break;
        }
        case "content_block_start": {
          const index = (ev as unknown as{ index: number }).index;
          const block = (ev as unknown as{ content_block?: { type?: string; id?: string; name?: string } }).content_block;
          if (!block) break;
          if (block.type === "tool_use") {
            const id = block.id ?? `call_anthropic_${index}`;
            blocks.set(index, { type: "tool_use", id });
            yield { type: "tool_call_start", toolCallId: id, name: block.name ?? "" };
          } else if (block.type === "thinking") {
            blocks.set(index, { type: "thinking" });
          } else {
            blocks.set(index, { type: "text" });
          }
          break;
        }
        case "content_block_delta": {
          const index = (ev as unknown as{ index: number }).index;
          const delta = (
            ev as {
              delta?: {
                type?: string;
                text?: string;
                thinking?: string;
                partial_json?: string;
                signature?: string;
              };
            }
          ).delta;
          if (!delta) break;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            yield { type: "text_delta", text: delta.text };
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            yield { type: "thinking_delta", text: delta.thinking };
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const st = blocks.get(index);
            if (st?.id) yield { type: "tool_call_delta", toolCallId: st.id, inputJsonDelta: delta.partial_json };
          } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
            const st = blocks.get(index);
            if (st?.type === "thinking") st.signature = (st.signature ?? "") + delta.signature;
          }
          break;
        }
        case "content_block_stop": {
          const index = (ev as unknown as{ index: number }).index;
          const st = blocks.get(index);
          if (st?.type === "thinking") {
            yield { type: "thinking_end", ...(st.signature ? { signature: st.signature } : {}) };
          } else if (st?.type === "tool_use" && st.id) {
            yield { type: "tool_call_end", toolCallId: st.id };
          }
          break;
        }
        case "message_delta": {
          const d = (ev as unknown as{ delta?: { stop_reason?: string } }).delta;
          const u = (ev as unknown as{ usage?: AnthropicUsage }).usage;
          if (d?.stop_reason) pendingStop = mapStop(d.stop_reason);
          if (u) pendingUsage = mapUsage(u);
          if (pendingStop) {
            yield { type: "message_delta", stopReason: pendingStop, ...(pendingUsage ? { usage: pendingUsage } : {}) };
          }
          break;
        }
        case "message_stop": {
          yield {
            type: "message_end",
            stopReason: pendingStop ?? "end_turn",
            usage: pendingUsage ?? { inputTokens: 0, outputTokens: 0 },
          };
          pendingStop = undefined;
          break;
        }
        case "error": {
          const e = (ev as unknown as{ error?: { message?: string; type?: string } }).error;
          // Preserve the machine type as a ProviderError code (it was dropped
          // before) and classify model-gone as non-retryable — retrying the
          // same model cannot help. enrichError passes both through now.
          const type = e?.type;
          const code =
            type === "overloaded_error" ? "overloaded"
            : type === "model_not_found" || type === "not_found_error" ? "model_not_found"
            : type;
          throw Object.assign(new Error(e?.message ?? "Anthropic stream error"), {
            name: "ProviderError",
            status: (ev as unknown as{ status?: number }).status,
            ...(code !== undefined ? { code } : {}),
            ...(code === "model_not_found" ? { retryable: false } : {}),
          });
        }
        case "ping":
        default:
          break;
      }
    }
    // Fallback: stream ended without message_stop — emit message_end if we have a stop.
    if (pendingStop !== undefined) {
      yield {
        type: "message_end",
        stopReason: pendingStop,
        usage: pendingUsage ?? { inputTokens: 0, outputTokens: 0 },
      };
    }
  } catch (err) {
    throw enrichError(err);
  }
}
