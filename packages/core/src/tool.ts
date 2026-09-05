// Tool contract + defineTool helper. `Tool` takes a raw JSON Schema (no deps).
// `defineTool` accepts a zod schema (zod is an OPTIONAL peer dep — only needed
// if you use defineTool). zod→JSON-Schema conversion is best-effort, duck-typed
// against zod v3 internals, so the core never imports zod at runtime.

import type { Content } from "./types.js";

export interface ToolInputSchema {
  jsonSchema: object; // JSON Schema draft-07; built from zod or hand-written
  zodSchema?: unknown; // optional zod ref for host-side validation
}

export interface ToolCallContext {
  signal: AbortSignal; // cancelled if run aborted or per-call timeout fires
  toolCallId: string;
  conversationId: string;
  runtime: "node" | "browser" | "edge";
  log: (level: "debug" | "info" | "warn" | "error", msg: string, data?: unknown) => void;
}

export interface ToolResultValue {
  content: string | Content[];
  isError?: boolean;
}

export interface Tool {
  name: string; // unique within an agent
  description: string; // prescriptive about WHEN to call — surfaces to model
  inputSchema: ToolInputSchema;
  execute(input: unknown, ctx: ToolCallContext): Promise<ToolResultValue>;
  /** Human-in-the-loop: if true (or predicate true), emit permission_request before executing. */
  requiresConfirmation?: boolean | ((input: unknown) => boolean);
  timeoutMs?: number; // default from AgentConfig.toolTimeoutMs
  permissions?: {
    destructive?: boolean; // irreversible / side-effecting outside sandbox
    network?: boolean;
    tags?: string[]; // host allowlist matching, e.g. ["shell","fs:write"]
  };
}

// We avoid a runtime import of zod to keep core dep-free. The generic constraint
// uses a type-only import (erased at compile time).
import type { z } from "zod";

export function defineTool<S extends z.ZodTypeAny>(opts: {
  name: string;
  description: string;
  input: S;
  execute: (input: z.infer<S>, ctx: ToolCallContext) => Promise<ToolResultValue>;
  requiresConfirmation?: Tool["requiresConfirmation"];
  timeoutMs?: number;
  permissions?: Tool["permissions"];
}): Tool {
  const zodSchema = opts.input as unknown as {
    safeParse?: (x: unknown) => { success: boolean; data?: unknown; error?: { format?: () => unknown } };
  };
  const jsonSchema = zodToJsonSchema(opts.input);
  const tool: Tool = {
    name: opts.name,
    description: opts.description,
    inputSchema: { jsonSchema, zodSchema: opts.input },
    async execute(input: unknown, ctx: ToolCallContext): Promise<ToolResultValue> {
      if (typeof zodSchema.safeParse === "function") {
        const parsed = zodSchema.safeParse(input);
        if (!parsed.success) {
          const errObj = parsed.error as { format?: () => unknown } | undefined;
          const details = typeof errObj?.format === "function" ? JSON.stringify(errObj.format()) : "validation failed";
          return { content: `Invalid input: ${details}`, isError: true };
        }
        return opts.execute(parsed.data as z.infer<S>, ctx);
      }
      return opts.execute(input as z.infer<S>, ctx);
    },
  };
  if (opts.requiresConfirmation !== undefined) tool.requiresConfirmation = opts.requiresConfirmation;
  if (opts.timeoutMs !== undefined) tool.timeoutMs = opts.timeoutMs;
  if (opts.permissions !== undefined) tool.permissions = opts.permissions;
  return tool;
}

/**
 * Best-effort zod → JSON Schema. Covers ZodObject/String/Number/Boolean/Array/
 * Enum/Literal/Optional/Nullable/Default/Union + `.description`. Returns a
 * permissive `{}` for unrecognized types. Duck-typed against zod v3 internals
 * (`_def.typeName`, `_def.shape`/`.shape`, `_def.checks`).
 */
export function zodToJsonSchema(schema: unknown): object {
  if (!schema || typeof schema !== "object") return {};
  const s = schema as Record<string, unknown> & {
    _def?: Record<string, unknown>;
    _zod?: { def?: Record<string, unknown> };
    shape?: Record<string, unknown> | (() => Record<string, unknown>);
    description?: unknown;
  };
  const def = (s._def ?? s._zod?.def) as Record<string, unknown> | undefined;
  const typeName = (def?.typeName ?? def?.type) as string | undefined;
  const desc = typeof s.description === "string" ? (s.description as string) : undefined;
  const wrap = (obj: Record<string, unknown>): Record<string, unknown> =>
    desc ? { ...obj, description: desc } : obj;

  const shapeRaw = typeof s.shape === "function"
    ? (s.shape as () => Record<string, unknown>)()
    : (s.shape ?? (s._zod?.def?.shape as Record<string, unknown> | undefined));
  if (shapeRaw && typeof shapeRaw === "object" && (typeName === "ZodObject" || !typeName)) {
    const props: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shapeRaw as Record<string, unknown>)) {
      props[k] = zodToJsonSchema(v);
      if (!isOptionalZod(v)) required.push(k);
    }
    return wrap({ type: "object", properties: props, required, additionalProperties: false });
  }
  switch (typeName) {
    case "ZodString":
      return wrap({ type: "string" });
    case "ZodNumber": {
      const checks = def?.["checks"] as Array<{ kind?: string }> | undefined;
      const isInt = Array.isArray(checks) && checks.some((c) => c?.kind === "int");
      return wrap({ type: isInt ? "integer" : "number" });
    }
    case "ZodBoolean":
      return wrap({ type: "boolean" });
    case "ZodArray":
      return wrap({ type: "array", items: zodToJsonSchema(def?.["element"] ?? (s as { element?: unknown }).element) });
    case "ZodEnum":
      return wrap({ type: "string", enum: def?.["values"] ?? [] });
    case "ZodLiteral":
      return wrap({ enum: [def?.["value"]] });
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return zodToJsonSchema(def?.["innerType"]);
    case "ZodUnion": {
      const options = def?.["options"] as unknown[] | undefined;
      return wrap({ anyOf: Array.isArray(options) ? options.map(zodToJsonSchema) : [] });
    }
    default:
      return wrap({});
  }
}

function isOptionalZod(v: unknown): boolean {
  const s = v as { _def?: { typeName?: string }; _zod?: { def?: { typeName?: string } } };
  const tn = s._def?.typeName ?? s._zod?.def?.typeName;
  return tn === "ZodOptional" || tn === "ZodNullable";
}
