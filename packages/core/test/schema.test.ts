import { describe, expect, test } from "vitest";
import { validateJsonSchema } from "../src/schema.js";

describe("validateJsonSchema depth constraints", () => {
  test("string minLength / maxLength", () => {
    const s = { type: "string", minLength: 3, maxLength: 5 };
    expect(validateJsonSchema("ab", s).ok).toBe(false);
    expect(validateJsonSchema("abc", s).ok).toBe(true);
    expect(validateJsonSchema("abcdef", s).ok).toBe(false);
  });

  test("string pattern", () => {
    expect(validateJsonSchema("abc", { type: "string", pattern: "^[a-z]+$" }).ok).toBe(true);
    expect(validateJsonSchema("abc1", { type: "string", pattern: "^[a-z]+$" }).ok).toBe(false);
    expect(validateJsonSchema("abc", { type: "string", pattern: "(invalid[" }).ok).toBe(true); // bad regex → skip defensively
  });

  test("number minimum / maximum", () => {
    const s = { type: "number", minimum: 1, maximum: 10 };
    expect(validateJsonSchema(0, s).ok).toBe(false);
    expect(validateJsonSchema(1, s).ok).toBe(true);
    expect(validateJsonSchema(10, s).ok).toBe(true);
    expect(validateJsonSchema(11, s).ok).toBe(false);
  });

  test("number exclusiveMinimum / exclusiveMaximum", () => {
    const s = { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 10 };
    expect(validateJsonSchema(0, s).ok).toBe(false);
    expect(validateJsonSchema(10, s).ok).toBe(false);
    expect(validateJsonSchema(5, s).ok).toBe(true);
  });

  test("integer rejects non-integer even when in range", () => {
    expect(validateJsonSchema(1.5, { type: "integer", minimum: 0 }).ok).toBe(false);
    expect(validateJsonSchema(2, { type: "integer", minimum: 0 }).ok).toBe(true);
  });

  test("nested object properties enforce depth", () => {
    const s = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 2 },
        age: { type: "number", minimum: 0 },
      },
      required: ["name"],
    };
    expect(validateJsonSchema({ name: "a" }, s).ok).toBe(false); // name too short
    expect(validateJsonSchema({ name: "ab", age: -1 }, s).ok).toBe(false); // age below min
    expect(validateJsonSchema({ name: "ab", age: 5 }, s).ok).toBe(true);
  });
});
