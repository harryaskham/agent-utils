// pi-wasm S6 (bd-4c572a): IndexedDB-backed settings persistence.
//
// All values live in the user's OWN browser (IndexedDB), survive reload, and are
// never sent anywhere except directly to the model endpoint they configure. This
// is a small dependency-free single-object-store wrapper; under vitest it runs
// against fake-indexeddb (see test/setup.ts), so it is fully headless-testable.

import { DEFAULT_SETTINGS, type PiWasmSettings } from "./types";

const DEFAULT_DB_NAME = "pi-wasm-settings";
const STORE = "kv";
const KEY = "settings";
const DB_VERSION = 1;

function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txRequest<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = run(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error);
  });
}

export interface SettingsStoreOptions {
  /** IndexedDB database name. Override in tests for isolation. */
  dbName?: string;
}

/**
 * Persistent, browser-local settings store. All values live in the user's own
 * IndexedDB. Nothing is transmitted anywhere by this class.
 */
export class SettingsStore {
  private readonly dbPromise: Promise<IDBDatabase>;

  constructor(options: SettingsStoreOptions = {}) {
    this.dbPromise = openDb(options.dbName ?? DEFAULT_DB_NAME);
  }

  async load(): Promise<PiWasmSettings> {
    const db = await this.dbPromise;
    const raw = await txRequest<PiWasmSettings | undefined>(db, "readonly", (s) => s.get(KEY));
    return normalizeSettings(raw);
  }

  async save(settings: PiWasmSettings): Promise<void> {
    const db = await this.dbPromise;
    await txRequest(db, "readwrite", (s) => s.put(normalizeSettings(settings), KEY));
  }

  async update(patch: Partial<PiWasmSettings>): Promise<PiWasmSettings> {
    const next = normalizeSettings({ ...(await this.load()), ...patch });
    await this.save(next);
    return next;
  }

  /** Set or (with an empty key) remove a single provider's API key. */
  async setProviderKey(provider: string, key: string): Promise<PiWasmSettings> {
    const current = await this.load();
    const providerKeys = { ...current.providerKeys };
    if (key) providerKeys[provider] = key;
    else delete providerKeys[provider];
    return this.update({ providerKeys });
  }

  /** Wipe all persisted settings (reset/clear). */
  async clear(): Promise<void> {
    const db = await this.dbPromise;
    await txRequest(db, "readwrite", (s) => s.delete(KEY));
  }
}

/** Coerce arbitrary/partial persisted data into a valid PiWasmSettings. */
export function normalizeSettings(raw: Partial<PiWasmSettings> | undefined | null): PiWasmSettings {
  const r = raw ?? {};
  const models = Array.isArray(r.models)
    ? r.models.filter(
        (m): m is PiWasmSettings["models"][number] =>
          !!m && typeof m.id === "string" && typeof m.provider === "string",
      )
    : [];
  return {
    providerKeys: isPlainObject(r.providerKeys) ? { ...(r.providerKeys as Record<string, string>) } : {},
    baseUrl: typeof r.baseUrl === "string" ? r.baseUrl : DEFAULT_SETTINGS.baseUrl,
    models,
    selectedModelId: typeof r.selectedModelId === "string" ? r.selectedModelId : null,
    settings: isPlainObject(r.settings) ? { ...(r.settings as Record<string, unknown>) } : {},
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
