// Pi host API bridge.
//
// Pi's extension loader resolves STATIC imports of its packages to the running
// Pi's own modules (virtualModules in compiled/bundled builds, dist aliases in
// source builds). This is the documented way extensions get host classes such
// as CustomEditor, so the class always matches the Pi version that is running,
// with no reflection over the live component tree.
//
// Load this module with a dynamic `import("./lib/pi-host.js")` inside
// try/catch: its static import is what Pi maps to the host, and keeping it out
// of an extension's own top-level imports confines any resolution failure to
// the feature that needs it. Outside Pi (tests, standalone use) the import
// resolves to Agent Utils' pinned dependency instead.
import { CustomEditor } from "@earendil-works/pi-coding-agent";

export { CustomEditor };
