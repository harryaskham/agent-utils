// pi-wasm S11 (bd-0dc0bc) — keyed session registry.
//
// Owns the set of named agent sessions and their durable state, all in the
// browser (IndexedDB via ./idb). Each session is an independent keyed instance
// of the single Pi agent: its own transcript, its own VFS workdir scope, and
// its own model selection. The registry persists:
//   * an index record  { activeId, sessions: SessionMeta[] }   (key "index")
//   * per-session transcript                                    (key "transcript:<id>")
// The agent's actual files live in the lightning-fs VFS under meta.workdir; the
// registry only tracks bookkeeping + conversation history.

import { idbGet, idbSet, idbDelete } from "./idb.js";

export interface SessionMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Per-session model id (falls back to the global S6 model when unset). */
  modelId?: string;
  /** VFS working directory scope for this session's file tools. */
  workdir: string;
}

interface RegistryIndex {
  activeId?: string;
  sessions: SessionMeta[];
}

/** A portable, self-contained session snapshot for export/import. */
export interface PersistedSession {
  kind: "pi-wasm-session";
  version: 1;
  meta: SessionMeta;
  messages: unknown[];
}

const INDEX_KEY = "index";
const transcriptKey = (id: string) => `transcript:${id}`;

function newId(): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `s-${uuid.replace(/-/g, "").slice(0, 12)}`;
}

export class SessionRegistry {
  private index: RegistryIndex | undefined;

  private async load(): Promise<RegistryIndex> {
    if (!this.index) {
      this.index = (await idbGet<RegistryIndex>(INDEX_KEY)) ?? { sessions: [] };
      if (!Array.isArray(this.index.sessions)) this.index.sessions = [];
    }
    return this.index;
  }

  private async persist(): Promise<void> {
    if (this.index) await idbSet(INDEX_KEY, this.index);
  }

  async list(): Promise<SessionMeta[]> {
    const idx = await this.load();
    // Most-recently-updated first.
    return [...idx.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<SessionMeta | undefined> {
    const idx = await this.load();
    return idx.sessions.find((s) => s.id === id);
  }

  async getActiveId(): Promise<string | undefined> {
    const idx = await this.load();
    // Repair a dangling pointer.
    if (idx.activeId && !idx.sessions.some((s) => s.id === idx.activeId)) idx.activeId = undefined;
    return idx.activeId;
  }

  async setActiveId(id: string): Promise<void> {
    const idx = await this.load();
    if (idx.sessions.some((s) => s.id === id)) {
      idx.activeId = id;
      await this.persist();
    }
  }

  async create(name?: string, modelId?: string): Promise<SessionMeta> {
    const idx = await this.load();
    const id = newId();
    const now = Date.now();
    const meta: SessionMeta = {
      id,
      name: (name ?? "").trim() || defaultName(idx.sessions.length + 1),
      createdAt: now,
      updatedAt: now,
      modelId,
      workdir: `/sessions/${id}/work`,
    };
    idx.sessions.push(meta);
    idx.activeId = id;
    await this.persist();
    return meta;
  }

  async rename(id: string, name: string): Promise<void> {
    const idx = await this.load();
    const meta = idx.sessions.find((s) => s.id === id);
    if (!meta) return;
    meta.name = name.trim() || meta.name;
    meta.updatedAt = Date.now();
    await this.persist();
  }

  /** Update mutable fields (model, touch updatedAt) after activity. */
  async update(id: string, patch: Partial<Pick<SessionMeta, "modelId">>): Promise<void> {
    const idx = await this.load();
    const meta = idx.sessions.find((s) => s.id === id);
    if (!meta) return;
    if (patch.modelId !== undefined) meta.modelId = patch.modelId;
    meta.updatedAt = Date.now();
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    const idx = await this.load();
    idx.sessions = idx.sessions.filter((s) => s.id !== id);
    if (idx.activeId === id) idx.activeId = idx.sessions[0]?.id;
    await this.persist();
    await idbDelete(transcriptKey(id));
  }

  async saveTranscript(id: string, messages: unknown[]): Promise<void> {
    await idbSet(transcriptKey(id), messages);
    const idx = await this.load();
    const meta = idx.sessions.find((s) => s.id === id);
    if (meta) {
      meta.updatedAt = Date.now();
      await this.persist();
    }
  }

  async loadTranscript(id: string): Promise<unknown[]> {
    return (await idbGet<unknown[]>(transcriptKey(id))) ?? [];
  }

  async exportSession(id: string): Promise<PersistedSession | undefined> {
    const meta = await this.get(id);
    if (!meta) return undefined;
    const messages = await this.loadTranscript(id);
    return { kind: "pi-wasm-session", version: 1, meta: { ...meta }, messages };
  }

  /** Import a snapshot as a brand-new session (fresh id + workdir). */
  async importSession(data: PersistedSession): Promise<SessionMeta> {
    if (data?.kind !== "pi-wasm-session") throw new Error("not a pi-wasm session export");
    const meta = await this.create(data.meta?.name ? `${data.meta.name} (import)` : undefined, data.meta?.modelId);
    if (Array.isArray(data.messages) && data.messages.length) {
      await this.saveTranscript(meta.id, data.messages);
    }
    return meta;
  }
}

function defaultName(n: number): string {
  return `Session ${n}`;
}
