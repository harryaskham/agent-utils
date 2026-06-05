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

export const ToolSchema = {
  string(options = {}) { return { type: "string", ...options }; },
  boolean(options = {}) { return { type: "boolean", ...options }; },
  number(options = {}) { return { type: "number", ...options }; },
  optional(schema) { return schema; },
  object(properties = {}, options = {}) {
    return {
      type: "object",
      properties,
      required: options.required || [],
      ...(options.additionalProperties !== undefined ? { additionalProperties: options.additionalProperties } : {}),
    };
  },
};
