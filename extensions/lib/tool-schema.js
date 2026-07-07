// Minimal JSON-schema helpers for extension tool parameter definitions.
// Use these for simple Pi tool schemas when importing TypeBox would add an
// unnecessary runtime dependency to the package under test/runtime.
//
// typebox is only a peerDependency in this repo, so importing it directly makes
// an extension fail to load under `node --test` (ERR_MODULE_NOT_FOUND). Prefer
// this shim if you want the extension unit-tested at import level. To port
// existing TypeBox call sites with minimal churn, alias on import:
//   import { ToolSchema as Type } from "./lib/tool-schema.js";
// See docs/extension-tool-schemas.md for the shim-vs-typebox guidance and the
// list of which extensions use which.
//
// Two naming surfaces are provided (bd-aacc0c):
//   - lowercase (`object`/`string`/`optional`/...): the original shim contract.
//     `object()` marks a property required ONLY when it appears in
//     `options.required`. Existing call sites (android.js, xvfb.js,
//     realtime-agent.js, self-compact.js, pi-self-update.js) depend on this
//     exact behavior, so it is preserved byte-for-byte.
//   - Uppercase (`Object`/`String`/`Optional`/...): TypeBox-compatible aliases
//     so `import { ToolSchema as Type }` is a drop-in for the `Type.Object(...)`
//     / `Type.String(...)` subset used by extensions being ported off
//     `@sinclair/typebox`. Crucially, uppercase `Object` mirrors TypeBox's
//     `required` semantics: every property NOT wrapped in `Optional(...)` is
//     required (unless `options.required` is supplied explicitly). This keeps a
//     ported extension's live tool schema identical to its former TypeBox shape.

// Schemas produced by `optional()`/`Optional()` are tracked in this WeakSet so
// the TypeBox-faithful uppercase `Object()` can infer `required` the way TypeBox
// does — without mutating the emitted schema object (the mark lives outside it,
// so the produced JSON schema is unchanged and `optional(x) === x` still holds).
const OPTIONAL_SCHEMAS = new WeakSet();

function markOptional(schema) {
  if (schema && typeof schema === "object") OPTIONAL_SCHEMAS.add(schema);
  return schema;
}

function isOptionalSchema(schema) {
  return typeof schema === "object" && schema !== null && OPTIONAL_SCHEMAS.has(schema);
}

// Lowercase `object`: required is ONLY what options.required lists (original
// shim contract; no inference).
function lowercaseObject(properties = {}, options = {}) {
  const out = { type: "object", properties, required: options.required || [] };
  if (options.additionalProperties !== undefined) out.additionalProperties = options.additionalProperties;
  return out;
}

// Uppercase `Object`: TypeBox-faithful — a property is required unless it is
// wrapped in `Optional(...)`, unless options.required overrides explicitly.
function typeboxObject(properties = {}, options = {}) {
  const required = Array.isArray(options.required)
    ? options.required
    : Object.keys(properties).filter((key) => !isOptionalSchema(properties[key]));
  const out = { type: "object", properties, required };
  if (options.additionalProperties !== undefined) out.additionalProperties = options.additionalProperties;
  return out;
}

export const ToolSchema = {
  string(options = {}) { return { type: "string", ...options }; },
  boolean(options = {}) { return { type: "boolean", ...options }; },
  number(options = {}) { return { type: "number", ...options }; },
  integer(options = {}) { return { type: "integer", ...options }; },
  // TypeBox's `Type.Any()` matches anything; a bare `{}` (plus any options such
  // as `description`) is the JSON-schema equivalent.
  any(options = {}) { return { ...options }; },
  array(items, options = {}) {
    return { type: "array", ...(items !== undefined ? { items } : {}), ...options };
  },
  // TypeBox's `Type.Record(keySchema, valueSchema)` -> an object whose values
  // all conform to valueSchema. The key schema is a string in JSON schema, so
  // only the value schema is carried through as additionalProperties.
  record(_keySchema, valueSchema, options = {}) {
    return { type: "object", additionalProperties: valueSchema ?? true, ...options };
  },
  stringEnum(values = [], options = {}) {
    return { type: "string", enum: [...values], ...options };
  },
  optional(schema) { return markOptional(schema); },
  object(properties = {}, options = {}) { return lowercaseObject(properties, options); },
};

// Uppercase TypeBox-compatible aliases so `import { ToolSchema as Type }` is a
// drop-in for the `Type.Object(...)` call-site style. `Object` uses the
// required-inferring builder; the scalar builders are shared with lowercase.
ToolSchema.String = ToolSchema.string;
ToolSchema.Boolean = ToolSchema.boolean;
ToolSchema.Number = ToolSchema.number;
ToolSchema.Integer = ToolSchema.integer;
ToolSchema.Any = ToolSchema.any;
ToolSchema.Array = ToolSchema.array;
ToolSchema.Record = ToolSchema.record;
ToolSchema.StringEnum = ToolSchema.stringEnum;
ToolSchema.Optional = markOptional;
ToolSchema.Object = typeboxObject;

// Named export for the pi-ai-compatible `StringEnum(values, options)` helper so
// extensions can drop the `@earendil-works/pi-ai` import for enum schemas
// (bd-4c80c0 / bd-aacc0c). Signature mirrors pi-ai's StringEnum(values, opts).
export function StringEnum(values = [], options = {}) {
  return ToolSchema.stringEnum(values, options);
}

export default ToolSchema;
