// ask_user tool — ask the human user a clarifying question mid-run.
//
// The one tool that is NOT about the world but about the operator: when the
// model is genuinely blocked on a choice only the user can settle ("which
// site did you mean?", "zh or en sources?"), it asks instead of guessing.
// execute() blocks until the HOST-provided handler resolves with the user's
// answer — waiting for a human is slow, hence the family's largest default
// timeout (10 min; the loop enforces it and reports the timeout to the
// model, which should then proceed on its own judgment).
//
// Not a web tool: standalone factory, host injects the interaction (UI,
// CLI prompt, test double). The handler owns the entire UX — rendering
// options, joining a multi-select, mapping a dismiss to an empty string —
// and MUST honor the passed signal (run aborted / timed out): stop waiting,
// the answer would be discarded anyway.
//
// Family discipline: never throws (Refused:/Ask failed:/(aborted) results),
// respects ctx.signal, no network, tags ["ask"].

import { type Tool, type ToolResultValue } from "@lingjing-agent/core";

const DEFAULT_TIMEOUT_MS = 600_000;
const QUESTION_CAP = 2_000;
const ANSWER_CAP = 4_000;
const MAX_OPTIONS = 4;
const LABEL_CAP = 200;
const DESCRIPTION_CAP = 500;

export interface AskUserOption {
  label: string;
  description?: string;
}

/** Everything the host needs to render the question. */
export interface AskUserQuestion {
  question: string;
  /** 0-4 clickable choices; absent = free-text answer only. */
  options?: AskUserOption[];
  /** true = the user may pick several options (host decides the join). */
  allowMultiple?: boolean;
  toolCallId: string;
  conversationId: string;
}

/**
 * Surface the question to the human and resolve with their answer string.
 * MUST respect `signal`: when it aborts, stop waiting and reject/resolve —
 * the run is over and any late answer is discarded.
 */
export type AskUserHandler = (q: AskUserQuestion, signal: AbortSignal) => Promise<string>;

export interface AskUserToolOptions {
  /** Host callback that renders the question and resolves with the answer. Required. */
  handler: AskUserHandler;
  /** Tool-level timeout — waiting for a human is slow. Default 600_000 ms (10 min). */
  timeoutMs?: number;
}

export function createAskUserTool(opts: AskUserToolOptions): Tool {
  const handler = opts.handler;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "ask_user",
    description:
      "Ask the human user one clarifying question and wait for their answer — call this " +
      "ONLY when you are genuinely blocked and the answer changes what you do next; when " +
      "a reasonable default exists, decide yourself and say so. When the choice is " +
      "enumerable, offer 2-4 options instead of an open question. The tool result is the " +
      "user's verbatim answer (their own words, or chosen option labels). If the tool " +
      "errors or times out (the user did not answer), proceed with your best judgment " +
      "and note the assumption in your reply.",
    inputSchema: {
      jsonSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: `The question to show the user, in their language (max ${QUESTION_CAP} chars). Ask exactly one thing.`,
          },
          options: {
            type: "array",
            description: `1-${MAX_OPTIONS} clickable choices for the user (omit for a free-text answer). Prefer offering these when the choice is enumerable.`,
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: `Choice label (max ${LABEL_CAP} chars).` },
                description: { type: "string", description: `One-line hint shown under the label (max ${DESCRIPTION_CAP} chars, optional).` },
              },
              required: ["label"],
              additionalProperties: false,
            },
          },
          allowMultiple: { type: "boolean", description: "true = the user may pick several options. Default false. Only meaningful with options." },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
    timeoutMs,
    permissions: { tags: ["ask"] },
    async execute(raw, ctx): Promise<ToolResultValue> {
      if (ctx.signal.aborted) return { content: "(aborted)", isError: true };

      const question = (raw as { question?: unknown }).question;
      if (typeof question !== "string" || question.trim() === "") {
        return { content: "Refused: input.question must be a non-empty string", isError: true };
      }

      // Options are sanitized, not trusted: malformed entries are dropped,
      // the list is capped — an over-long choice menu is worse than none.
      const rawOptions = (raw as { options?: unknown }).options;
      const options: AskUserOption[] = Array.isArray(rawOptions)
        ? rawOptions
            .filter((o): o is { label?: unknown; description?: unknown } => typeof o === "object" && o !== null)
            .map((o) => ({
              label: typeof o.label === "string" ? o.label.slice(0, LABEL_CAP) : "",
              ...(typeof o.description === "string" && o.description !== ""
                ? { description: o.description.slice(0, DESCRIPTION_CAP) }
                : {}),
            }))
            .filter((o) => o.label !== "")
            .slice(0, MAX_OPTIONS)
        : [];
      const rawAllowMultiple = (raw as { allowMultiple?: unknown }).allowMultiple;
      const allowMultiple = rawAllowMultiple === true;

      const q: AskUserQuestion = {
        question: question.slice(0, QUESTION_CAP),
        ...(options.length > 0 ? { options } : {}),
        ...(allowMultiple ? { allowMultiple: true } : {}),
        toolCallId: ctx.toolCallId,
        conversationId: ctx.conversationId,
      };

      try {
        const answer = (await handler(q, ctx.signal)).trim();
        if (answer === "") return { content: "(the user submitted an empty answer)" };
        return { content: answer.length > ANSWER_CAP ? `${answer.slice(0, ANSWER_CAP)} [truncated]` : answer };
      } catch (err) {
        if (ctx.signal.aborted) return { content: "(aborted)", isError: true };
        return { content: `Ask failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  };
}
