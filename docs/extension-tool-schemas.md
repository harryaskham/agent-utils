# Extension tool schema helpers

Pi tools accept plain JSON-schema-shaped `parameters` objects. Many examples use TypeBox, but package extensions should not import `@sinclair/typebox` unless the package declares it as a real runtime dependency. In this repository it is only a peer dependency for host/runtime compatibility, so importing it from an extension can fail in lightweight test or install environments.

For simple extension tools, use [`extensions/lib/tool-schema.js`](../extensions/lib/tool-schema.js):

```js
import { ToolSchema } from "./lib/tool-schema.js";

pi.registerTool({
  name: "example_tool",
  parameters: ToolSchema.object({
    path: ToolSchema.string({ description: "Path to inspect" }),
    dryRun: ToolSchema.optional(ToolSchema.boolean({ description: "Preview only" })),
  }, { required: ["path"] }),
  async execute(_id, params) {
    return { content: [{ type: "text", text: JSON.stringify(params) }] };
  },
});
```

Use TypeBox directly only when the package owns the dependency or when a host profile guarantees the dependency is installed. Keeping simple schemas dependency-free prevents `ERR_MODULE_NOT_FOUND` failures during `npm test`, Pi package loading, or partial installs.
