// Provide a headless IndexedDB (globalThis.indexedDB, IDBKeyRange, ...) so the
// lightning-fs VFS backend runs under vitest's node environment.
import "fake-indexeddb/auto";
