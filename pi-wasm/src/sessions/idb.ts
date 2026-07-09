// pi-wasm S11 (bd-0dc0bc) — minimal promise-based IndexedDB key/value store.
//
// A dependency-free wrapper used by the session registry to persist keyed
// multi-session state (metadata + per-session transcripts) fully in the
// browser. Deliberately tiny: one database, one object store, string keys,
// structured-clone values. The agent's file work lives in the separate
// lightning-fs VFS store; this holds only session bookkeeping.

const DB_NAME = "pi-wasm-sessions";
const STORE = "kv";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | undefined;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("failed to open pi-wasm-sessions DB"));
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("idb request failed"));
      }),
  );
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  const v = await tx<T | undefined>("readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
  return v;
}

export function idbSet<T>(key: string, value: T): Promise<IDBValidKey> {
  return tx<IDBValidKey>("readwrite", (s) => s.put(value as unknown as never, key));
}

export function idbDelete(key: string): Promise<undefined> {
  return tx<undefined>("readwrite", (s) => s.delete(key) as IDBRequest<undefined>);
}

/** Best-effort: never throws (returns false) so callers can degrade to ephemeral. */
export async function idbAvailable(): Promise<boolean> {
  try {
    await openDb();
    return true;
  } catch {
    return false;
  }
}
