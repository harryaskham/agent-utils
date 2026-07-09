// pi-wasm S11 (bd-0dc0bc) — session manager.
//
// Orchestrates the ACTIVE keyed session: builds its per-session VFS workdir
// (namespaced under /sessions/<id>/work in the shared IndexedDB store), wires
// the S4 file tools over it, constructs a PiWasmSession with the restored
// transcript, and persists the transcript back to the registry after each
// settled turn. Switching sessions tears down the previous subscription and
// re-activates the target. Nothing here regresses the single-session MVP: with
// one session it behaves exactly like S7, just durable across reloads.

import { PiWasmSession } from "../session.js";
import { createBrowserExecutionEnv, LightningFsVfs, type BrowserExecutionEnv, type Vfs } from "../vfs";
import { createBrowserAgentTools } from "../tools";
import { SettingsStore, toRuntimeConfig, type ModelSpec, type MicrovmConfig } from "../settings";
import { DEFAULT_MODEL_ID, DEFAULT_BASE_URL } from "../provider.js";
import {
  createExecBackend,
  isExecBackendId,
  NullExecBackend,
  type ExecBackend,
  type ExecBackendId,
  type HttpRelayTransportOptions,
  type MicrovmExecBackendOptions,
} from "../exec";
import { SessionRegistry, type SessionMeta, type PersistedSession } from "./registry.js";

export interface ActiveSession {
  meta: SessionMeta;
  session: PiWasmSession;
  env: BrowserExecutionEnv;
  /** Resolved exec backend id for this activation (S11.1). */
  backendId: ExecBackendId;
  /** Non-fatal notice when the selected backend could not be built (fell back to none). */
  backendNotice?: string;
  /** The active exec backend, retained so it can be disposed on switch-away. */
  backend?: ExecBackend;
}

export class SessionManager {
  private active: ActiveSession | undefined;
  private unsub: (() => void) | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly registry: SessionRegistry,
    private readonly store: SettingsStore,
  ) {}

  get current(): ActiveSession | undefined {
    return this.active;
  }

  list(): Promise<SessionMeta[]> {
    return this.registry.list();
  }

  /** Load the persisted active session, creating a first one if none exist. */
  async init(): Promise<ActiveSession> {
    let id = await this.registry.getActiveId();
    if (!id) {
      const list = await this.registry.list();
      id = list[0]?.id ?? (await this.registry.create()).id;
    }
    return this.activate(id);
  }

  /** Make `id` the active session: build its env, tools, and restored agent. */
  async activate(id: string): Promise<ActiveSession> {
    const prev = this.active;
    this.flush();
    this.unsub?.();
    this.unsub = undefined;
    // Dispose the previous backend so a booted microVM guest doesn't leak when
    // switching sessions (js-shell/remote have no-op or absent dispose).
    if (prev?.backend?.dispose) {
      try {
        await prev.backend.dispose();
      } catch {
        /* best-effort teardown */
      }
    }

    const meta = await this.registry.get(id);
    if (!meta) throw new Error(`session ${id} not found`);

    const settings = await this.store.load();
    const cfg = toRuntimeConfig(settings);
    // One shared VFS backs BOTH the file tools (via the env) and the microVM 9p
    // bridge, so a "microvm" guest sees this session's files at /mnt.
    const vfs = new LightningFsVfs("pi-wasm");
    const env = await createBrowserExecutionEnv({
      vfs,
      cwd: meta.workdir,
      seedDirs: ["/home/.pi/agent", meta.workdir],
    });

    // S11.1: per-session exec-backend selection over ms2-0's S13 registry.
    // Defensive vs IndexedDB-restored junk; createExecBackend never throws and
    // returns err(...) when a tier lacks config (e.g. "remote" without a relay).
    const backendId: ExecBackendId = isExecBackendId(meta.backendId ?? "")
      ? (meta.backendId as ExecBackendId)
      : "none";
    const relay = (settings as { relay?: HttpRelayTransportOptions }).relay;
    // Build the microVM machine only when that backend is selected (construction
    // is cheap — v86 boots LAZILY on first exec, not here, so switching in does
    // not block). settings.microvm is pure tuning; omitted ⇒ vendored defaults.
    const microvm =
      backendId === "microvm" ? await buildMicrovmOptions(vfs, meta.workdir, settings.microvm) : undefined;
    const backendResult = createExecBackend(backendId, { env, relay, microvm });
    let backendNotice: string | undefined;
    let backend: ExecBackend;
    if (backendResult.ok) {
      backend = backendResult.value;
    } else {
      backend = new NullExecBackend();
      backendNotice = backendResult.error;
    }
    env.setExecBackend(backend);
    // The agent gets a real shell tool only when a working backend is active.
    const bashActive = backendId !== "none" && backendResult.ok;
    const tools = createBrowserAgentTools(env, { bash: bashActive });
    const initialMessages = (await this.registry.loadTranscript(id)) as ActiveSession["session"]["messages"];

    const session = new PiWasmSession({
      modelId: meta.modelId ?? cfg.model?.id ?? DEFAULT_MODEL_ID,
      baseUrl: cfg.baseUrl || DEFAULT_BASE_URL,
      providerId: cfg.model?.provider,
      getApiKey: cfg.getApiKey,
      tools,
      initialMessages,
    });

    await this.registry.setActiveId(id);
    this.active = { meta, session, env, backendId, backendNotice, backend };
    // Persist the transcript shortly after activity settles (debounced).
    this.unsub = session.subscribe(() => this.scheduleSave());
    return this.active;
  }

  /** Persist a session's exec-backend choice and re-activate it (S11.1). */
  async setBackend(id: string, backendId: ExecBackendId): Promise<ActiveSession> {
    await this.registry.update(id, { backendId });
    return this.activate(id);
  }

  /** Persist a session's per-session model (undefined ⇒ follow global) and re-activate (S11.2). */
  async setModel(id: string, modelId: string | undefined): Promise<ActiveSession> {
    await this.registry.setModel(id, modelId);
    return this.activate(id);
  }

  /** The S6 model list, so the switcher can offer a per-session model dropdown. */
  async availableModels(): Promise<ModelSpec[]> {
    const settings = await this.store.load();
    return settings.models ?? [];
  }

  async create(name?: string): Promise<ActiveSession> {
    const meta = await this.registry.create(name);
    return this.activate(meta.id);
  }

  rename(id: string, name: string): Promise<void> {
    if (this.active?.meta.id === id) this.active.meta.name = name.trim() || this.active.meta.name;
    return this.registry.rename(id, name);
  }

  /** Delete a session: wipe its VFS workdir + transcript, then re-home active. */
  async remove(id: string): Promise<ActiveSession | undefined> {
    const meta = await this.registry.get(id);
    if (meta) await this.wipeWorkdir(meta.workdir);
    const wasActive = this.active?.meta.id === id;
    if (wasActive) {
      this.flush();
      this.unsub?.();
      this.unsub = undefined;
      this.active = undefined;
    }
    await this.registry.remove(id);
    if (wasActive) {
      const next = (await this.registry.list())[0]?.id ?? (await this.registry.create()).id;
      return this.activate(next);
    }
    return this.active;
  }

  /** Persist the current transcript immediately (e.g. before unload). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const a = this.active;
    if (a) void this.registry.saveTranscript(a.meta.id, a.session.messages as unknown[]);
  }

  exportSession(id: string): Promise<PersistedSession | undefined> {
    if (this.active?.meta.id === id) this.flush();
    return this.registry.exportSession(id);
  }

  async importSession(data: PersistedSession): Promise<ActiveSession> {
    const meta = await this.registry.importSession(data);
    return this.activate(meta.id);
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  private async wipeWorkdir(workdir: string): Promise<void> {
    try {
      // Remove the whole /sessions/<id> subtree from the shared VFS store.
      const root = workdir.replace(/\/work$/, "");
      const env = this.active?.env ?? (await createBrowserExecutionEnv({ cwd: "/work" }));
      await env.remove(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; a leftover dir is harmless (orphaned bytes only).
    }
  }
}

/**
 * Build the microVM ExecBackend options (S14): a V86Machine wired to a 9p server
 * over the SAME session VFS, so the guest's auto-mounted /mnt IS this session's
 * workdir. `cfg` is the optional persisted tuning (settings.microvm); omitted or
 * empty ⇒ the vendored-asset defaults. v86 boots LAZILY on first exec (inside
 * MicrovmExecBackend), so constructing this does not boot the guest.
 *
 * The v86 adapter (+ its dynamic `import('v86')`) and the 9p server are pulled in
 * with a DYNAMIC import so they are code-split OUT of the main app bundle and
 * only loaded when a session actually selects the microvm backend — the primary
 * app + node/vitest graph never reference the browser-only emulator.
 */
async function buildMicrovmOptions(
  vfs: Vfs,
  root: string,
  cfg: MicrovmConfig | undefined,
): Promise<MicrovmExecBackendOptions> {
  const [{ V86Machine }, { Vfs9pServer }] = await Promise.all([
    import("../exec/v86-machine"),
    import("../exec/ninep/server"),
  ]);
  const server = new Vfs9pServer({ vfs, root });
  const machine = new V86Machine({
    ...(cfg ?? {}),
    handle9p: (req, reply) => {
      void server.handle(req).then(reply);
    },
  });
  return { machine };
}
