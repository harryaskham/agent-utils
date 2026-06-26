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

## Porting TypeBox call sites: `import { ToolSchema as Type }`

If you are converting an extension that already uses `Type.object(...)` /
`Type.string(...)` TypeBox-style call sites (or you simply prefer that name),
alias the shim on import so the call sites do not have to change:

```js
import { ToolSchema as Type } from "./lib/tool-schema.js";

parameters: Type.object({
  id: Type.string({ description: "VM id" }),
  force: Type.optional(Type.boolean({ description: "Force teardown" })),
}, { required: ["id"] }),
```

The shim's API is intentionally lowercase and TypeBox-shaped
(`Type.object` / `Type.string` / `Type.boolean` / `Type.number`, with
`Type.optional` acting as identity), so most simple schemas port by changing
only the import line. `extensions/android.js` and `extensions/xvfb.js` use this
`as Type` alias.

## Which extensions use the shim vs TypeBox (import-test consequence)

The shim choice is what determines whether an extension can be loaded under
`node --test` in this checkout. typebox is only a peer dependency here, so an
extension that imports `@sinclair/typebox` directly throws `ERR_MODULE_NOT_FOUND`
the moment a test file imports it — which is why those extensions are tested via
other seams (extracted pure submodules, source-surface assertions) rather than
by importing the extension module itself.

| Extension | Schema source | Import-testable under `node --test`? |
| --- | --- | --- |
| `android.js` | `lib/tool-schema.js` shim (`as Type`) | Yes |
| `pi-self-update.js` | `lib/tool-schema.js` shim | Yes |
| `realtime-agent.js` | `lib/tool-schema.js` shim | Yes |
| `self-compact.js` | `lib/tool-schema.js` shim | Yes |
| `xvfb.js` | `lib/tool-schema.js` shim (`as Type`) | Yes |
| `app-automation.js` | `@sinclair/typebox` directly | No — peer dep not installed in this checkout |
| `firecracker-vm.js` | `@sinclair/typebox` directly | No |
| `kitty-image-preview.js` | `@sinclair/typebox` directly | No |
| `pi-graphics.js` | `@sinclair/typebox` directly | No |
| `web-search.js` | `@sinclair/typebox` directly | No |

Rule of thumb: **if you want a new extension unit-tested at import level, use the
shim, not typebox.** If an extension genuinely needs full TypeBox (or a host
profile guarantees the dependency), import typebox directly but expect to test
its behavior through an extracted pure module or source-surface assertions
instead of by importing the extension. The list above is current as of writing;
regenerate it with `grep -l '@sinclair/typebox' extensions/*.js` versus
`grep -l 'lib/tool-schema' extensions/*.js` if it drifts.

A third option also stays import-testable: some tool-registering extensions
(`effort.js`, `m.js`, `tendril-share.js`) pass **plain JSON-schema** `parameters`
objects and import neither the shim nor TypeBox. The real rule is therefore
*avoid a direct `@sinclair/typebox` import* — both the shim and plain JSON-schema
objects keep an extension loadable under `node --test`.
