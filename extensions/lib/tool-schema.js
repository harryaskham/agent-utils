// Minimal JSON-schema helpers for extension tool parameter definitions.
// Use these for simple Pi tool schemas when importing TypeBox would add an
// unnecessary runtime dependency to the package under test/runtime.

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
