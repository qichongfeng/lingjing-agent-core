// Minimal JSON Schema (draft-07 subset) validator for tool input validation.
// Enforces: type, required, properties, additionalProperties:false, enum, items,
// plus string (minLength/maxLength/pattern) and number (minimum/maximum/
// exclusiveMinimum/exclusiveMaximum) bounds. `format` is accepted-but-unenforced
// (needs a third-party format library).

export type SchemaResult = { ok: true } | { ok: false; error: string };

export function validateJsonSchema(value: unknown, schema: unknown): SchemaResult {
  return validate(value, schema, "$");
}

function fail(path: string, msg: string): SchemaResult {
  return { ok: false, error: `${path}: ${msg}` };
}

function checkType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true; // unknown type → permissive
  }
}

function validate(value: unknown, schema: unknown, path: string): SchemaResult {
  if (typeof schema !== "object" || schema === null) return { ok: true };
  const s = schema as Record<string, unknown>;

  const type = s["type"];
  if (typeof type === "string" && !checkType(value, type)) {
    return fail(path, `expected ${type}, got ${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}`);
  }
  const enumVals = s["enum"];
  if (Array.isArray(enumVals) && !enumVals.includes(value)) {
    return fail(path, `not in enum`);
  }

  // Depth constraints (draft-07 subset). `format` intentionally not enforced.
  if (type === "string" && typeof value === "string") {
    const minLen = s["minLength"];
    if (typeof minLen === "number" && value.length < minLen) return fail(path, `shorter than minLength ${minLen}`);
    const maxLen = s["maxLength"];
    if (typeof maxLen === "number" && value.length > maxLen) return fail(path, `longer than maxLength ${maxLen}`);
    const pattern = s["pattern"];
    if (typeof pattern === "string") {
      try {
        if (!new RegExp(pattern).test(value)) return fail(path, `does not match pattern ${pattern}`);
      } catch {
        /* invalid pattern regex → skip defensively */
      }
    }
  }
  if ((type === "number" || type === "integer") && typeof value === "number") {
    const min = s["minimum"];
    if (typeof min === "number" && value < min) return fail(path, `less than minimum ${min}`);
    const max = s["maximum"];
    if (typeof max === "number" && value > max) return fail(path, `greater than maximum ${max}`);
    const exMin = s["exclusiveMinimum"];
    if (typeof exMin === "number" && value <= exMin) return fail(path, `not greater than exclusiveMinimum ${exMin}`);
    const exMax = s["exclusiveMaximum"];
    if (typeof exMax === "number" && value >= exMax) return fail(path, `not less than exclusiveMaximum ${exMax}`);
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = s["properties"];
    if (typeof props === "object" && props !== null) {
      for (const [k, sub] of Object.entries(props as Record<string, unknown>)) {
        if (k in obj) {
          const r = validate(obj[k], sub, `${path}.${k}`);
          if (!r.ok) return r;
        }
      }
    }
    const required = s["required"];
    if (Array.isArray(required)) {
      for (const k of required) {
        if (typeof k === "string" && !(k in obj)) return fail(`${path}.${k}`, "required");
      }
    }
    if (s["additionalProperties"] === false && typeof props === "object" && props !== null) {
      const allowed = new Set(Object.keys(props as Record<string, unknown>));
      for (const k of Object.keys(obj)) {
        if (!allowed.has(k)) return fail(`${path}.${k}`, "additional property not allowed");
      }
    }
  }

  if (Array.isArray(value)) {
    const items = s["items"];
    if (items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        const r = validate(value[i], items, `${path}[${i}]`);
        if (!r.ok) return r;
      }
    }
  }

  return { ok: true };
}
