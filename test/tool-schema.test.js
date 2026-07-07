import test from "node:test";
import assert from "node:assert/strict";

import { ToolSchema, StringEnum } from "../extensions/lib/tool-schema.js";

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

// --- Uppercase TypeBox-compatible surface (bd-aacc0c) -----------------------

test("uppercase scalar aliases mirror the lowercase builders", () => {
  assert.deepEqual(ToolSchema.String({ description: "x" }), { type: "string", description: "x" });
  assert.deepEqual(ToolSchema.Boolean(), { type: "boolean" });
  assert.deepEqual(ToolSchema.Number({ minimum: 1 }), { type: "number", minimum: 1 });
  assert.deepEqual(ToolSchema.Integer(), { type: "integer" });
});

test("Optional is a same-reference passthrough like optional", () => {
  const s = ToolSchema.String({ description: "y" });
  assert.equal(ToolSchema.Optional(s), s);
  assert.deepEqual(ToolSchema.Optional(s), { type: "string", description: "y" });
});

test("uppercase Object infers required from non-Optional properties (TypeBox parity)", () => {
  const schema = ToolSchema.Object({
    kernelPath: ToolSchema.String({ description: "required" }),
    rootfsPath: ToolSchema.String({ description: "required" }),
    cpuCount: ToolSchema.Optional(ToolSchema.Number({ description: "optional" })),
  });
  assert.equal(schema.type, "object");
  assert.deepEqual([...schema.required].sort(), ["kernelPath", "rootfsPath"]);
});

test("uppercase Object with all-Optional properties requires nothing", () => {
  const schema = ToolSchema.Object({
    a: ToolSchema.Optional(ToolSchema.String()),
    b: ToolSchema.Optional(ToolSchema.Boolean()),
  });
  assert.deepEqual(schema.required, []);
});

test("explicit options.required overrides inference on uppercase Object", () => {
  const schema = ToolSchema.Object(
    { a: ToolSchema.String(), b: ToolSchema.String() },
    { required: ["a"] },
  );
  assert.deepEqual(schema.required, ["a"]);
});

test("lowercase object does NOT infer required (original shim contract preserved)", () => {
  // A non-Optional property with no explicit required must stay non-required for
  // lowercase callers (e.g. realtime-agent's speak tool text field).
  const schema = ToolSchema.object({ text: ToolSchema.string(), voice: ToolSchema.optional(ToolSchema.string()) });
  assert.deepEqual(schema.required, []);
});

test("Array carries items and options through", () => {
  assert.deepEqual(
    ToolSchema.Array(ToolSchema.String({ description: "id" }), { description: "ids" }),
    { type: "array", items: { type: "string", description: "id" }, description: "ids" },
  );
  assert.deepEqual(ToolSchema.Array(), { type: "array" });
});

test("Record maps value schema onto additionalProperties", () => {
  assert.deepEqual(
    ToolSchema.Record(ToolSchema.String(), ToolSchema.Any(), { description: "params" }),
    { type: "object", additionalProperties: {}, description: "params" },
  );
});

test("Any is an unconstrained schema that still merges options", () => {
  assert.deepEqual(ToolSchema.Any(), {});
  assert.deepEqual(ToolSchema.Any({ description: "anything" }), { description: "anything" });
});

test("StringEnum (method and named export) builds a string enum schema", () => {
  const viaMethod = ToolSchema.StringEnum(["http", "https"], { description: "proto" });
  assert.deepEqual(viaMethod, { type: "string", enum: ["http", "https"], description: "proto" });
  assert.deepEqual(StringEnum(["a", "b"]), { type: "string", enum: ["a", "b"] });
  // Copies the values array (no shared mutable reference leaking into the schema).
  const values = ["x"];
  const schema = StringEnum(values);
  values.push("y");
  assert.deepEqual(schema.enum, ["x"]);
});

test("an Optional array/record property is not marked required by Object", () => {
  const schema = ToolSchema.Object({
    services: ToolSchema.Optional(ToolSchema.Array(ToolSchema.String())),
    params: ToolSchema.Optional(ToolSchema.Record(ToolSchema.String(), ToolSchema.Any())),
    name: ToolSchema.String(),
  });
  assert.deepEqual(schema.required, ["name"]);
});
