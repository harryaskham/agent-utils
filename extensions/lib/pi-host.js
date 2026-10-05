// Pi host API bridge.
//
// Pi's extension loader resolves STATIC imports of its packages to the running
// Pi's own modules (virtualModules in compiled/bundled builds, dist aliases in
// source builds). This is the documented way extensions get host classes such
// as CustomEditor, so the class always matches the Pi version that is running,
// with no reflection over the live component tree.
//
// Import this module STATICALLY from an extension. Pi's loader does not map
// dynamic import() of host packages in its compiled build (verified: a
// dynamic import from inside this package resolves natively and fails), while
// static imports always get the host module. Each extension is loaded
// independently, so a resolution failure could only affect the importing
// extension. Outside Pi (tests, standalone use) the import resolves to Agent
// Utils' pinned dependency.
import { CustomEditor } from "@earendil-works/pi-coding-agent";

export { CustomEditor };
