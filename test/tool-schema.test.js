import test from "node:test";
import assert from "node:assert/strict";

import { ToolSchema } from "../extensions/lib/tool-schema.js";

// Zero -> full coverage for the typebox-free ToolSchema JSON-schema shim
// (bd-226293). Pure builders, so the assertions are exact.

test("string/boolean/number return their type and merge options through", () => {
  assert.deepEqual(ToolSchema.string(), { type: "string" });
  assert.deepEqual(ToolSchema.boolean(), { type: "boolean" });
  assert.deepEqual(ToolSchema.number(), { type: "number" });

  assert.deepEqual(
    ToolSchema.string({ description: "a name", minLength: 2 }),
    { type: "string", description: "a name", minLength: 2 },
  );
  assert.deepEqual(
    ToolSchema.boolean({ default: true }),
    { type: "boolean", default: true },
  );
  assert.deepEqual(
    ToolSchema.number({ minimum: 0, maximum: 10 }),
    { type: "number", minimum: 0, maximum: 10 },
  );
});

test("optional is an identity passthrough of the schema", () => {
  const schema = ToolSchema.string({ description: "x" });
  assert.equal(ToolSchema.optional(schema), schema); // same reference
  assert.deepEqual(ToolSchema.optional(schema), { type: "string", description: "x" });
});

test("object defaults to empty properties and required with no additionalProperties key", () => {
  const result = ToolSchema.object();
  assert.deepEqual(result, { type: "object", properties: {}, required: [] });
  assert.equal("additionalProperties" in result, false);
});

test("object honors supplied properties and required", () => {
  const props = { name: { type: "string" }, count: { type: "number" } };
  assert.deepEqual(
    ToolSchema.object(props, { required: ["name"] }),
    { type: "object", properties: props, required: ["name"] },
  );
});

test("object includes additionalProperties only when explicitly set", () => {
  const closed = ToolSchema.object({}, { additionalProperties: false });
  assert.equal("additionalProperties" in closed, true);
  assert.equal(closed.additionalProperties, false);

  const open = ToolSchema.object({}, { additionalProperties: true });
  assert.equal(open.additionalProperties, true);

  // Explicit undefined is treated as "not set" and the key is omitted.
  const unset = ToolSchema.object({}, { additionalProperties: undefined });
  assert.equal("additionalProperties" in unset, false);
});
