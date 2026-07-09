// pi-wasm — fully in-browser Pi agent loop · S11 keyed multi-session shell
// (bd-0dc0bc), built on the S7 app shell (bd-e8949f).
//
// Runs MANY named agent sessions in one browser, each an independent keyed
// instance of the single Pi agent with its own transcript + VFS workdir scope,
// ALL state persisted in the browser (IndexedDB) so every session survives a
// reload. Still Path A only (pi-agent-core + pi-ai; NEVER the pi-coding-agent
// barrel — the barrel trap, FEASIBILITY.md §3).
//
// Layers: S2 VFS + S4 tools (per session, via SessionManager) · S3 streaming +
// mock fallback (PiWasmSession) · S6 settings/keys · S11 registry + switcher.
//
// Preserved hooks: __PI_WASM_SPIKE__ (S1), __PI_WASM_S3__ (?autorun), __PI_WASM__
// (chat harness + fileToolsSmoke for the S8 Playwright suite), __PI_WASM_SETTINGS__
// (S6). New: __PI_WASM_SESSIONS__ (S11 session-management surface for S8).

import { mountChat, type ChatUiHandle } from "./chat-ui.js";
import { currentAssistantText, messageText, DEFAULT_BASE_URL, DEFAULT_MODEL_ID } from "./provider.js";
import { fileToolsSmoke } from "./tools";
import {
  SettingsStore,
  toRuntimeConfig,
  isRuntimeConfigReady,
  mountSettingsPanel,
  type PiWasmSettings,
} from "./settings";
import { SessionManager, SessionRegistry, mountSwitcher, type SwitcherHandle } from "./sessions";

const params = new URLSearchParams(location.search);
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

interface S3Result {
  ok: boolean;
  text?: string;
  model?: string;
  baseUrl?: string;
  chunks?: number;
  error?: string;
}

async function boot(): Promise<void> {
  const app = el<HTMLElement>("app");
  const sidebar = el<HTMLElement>("sessions");
  const settingsPanel = el<HTMLElement>("settings-panel");
  const settingsToggle = el<HTMLButtonElement>("settings-toggle");
  const statusEl = el<HTMLElement>("status");

  const store = new SettingsStore();
  let settings: PiWasmSettings = await store.load();
  const registry = new SessionRegistry();
  const manager = new SessionManager(registry, store);

  let ui: ChatUiHandle | undefined;
  let switcher: SwitcherHandle | undefined;

  const setStatus = () => {
    const ready = isRuntimeConfigReady(settings);
    const cfg = toRuntimeConfig(settings);
    const active = manager.current;
    const name = active?.meta.name ?? "session";
    const modelId = active?.session.modelId ?? cfg.model?.id ?? "?";
    const shell = `shell:${active?.backendId ?? "none"}`;
    const base = ready ? `live · ${modelId} · ${name}` : `mock (no key) · ${modelId} · ${name}`;
    statusEl.textContent = active?.backendNotice ? `${base} · ${shell} ⚠` : `${base} · ${shell}`;
    statusEl.title = active?.backendNotice ?? "";
    statusEl.className = ready ? "is-live" : "is-mock";
  };

  const exposeGlobals = () => {
    const active = manager.current;
    const state = active?.session.agent.state as { messages?: unknown[]; tools?: unknown[] } | undefined;
    (globalThis as Record<string, unknown>).__PI_WASM_SPIKE__ = {
      ok: true,
      detail: {
        shell: "S11",
        session: active?.meta.id,
        messages: state?.messages?.length ?? 0,
        tools: state?.tools?.length ?? 0,
      },
    };
    (globalThis as Record<string, unknown>).__PI_WASM__ = {
      get session() {
        return manager.current?.session;
      },
      get env() {
        return manager.current?.env;
      },
      get ui() {
        return ui;
      },
      manager,
      ready: true,
      async send(text: string) {
        const s = manager.current?.session;
        if (!s) return;
        await s.send(text);
        await s.agent.waitForIdle();
        ui?.render();
      },
      getTranscript: () =>
        (manager.current?.session.messages ?? []).map((m) => ({
          role: (m as { role?: string }).role ?? "?",
          text: messageText(m),
        })),
      // S4/S8 acceptance: read→edit→write over the active session's VFS.
      runToolsSmoke: () => fileToolsSmoke(manager.current!.env),
    };
    // S11 session-management surface (for S8 + programmatic control).
    (globalThis as Record<string, unknown>).__PI_WASM_SESSIONS__ = {
      list: () => manager.list(),
      current: () => manager.current?.meta,
      create: async (name?: string) => {
        await manager.create(name);
        buildChatForActive();
        await switcher?.refresh();
        return manager.current?.meta;
      },
      switchTo: async (id: string) => {
        await manager.activate(id);
        buildChatForActive();
        await switcher?.refresh();
        return manager.current?.meta;
      },
      rename: async (id: string, name: string) => {
        await manager.rename(id, name);
        await switcher?.refresh();
      },
      remove: async (id: string) => {
        await manager.remove(id);
        buildChatForActive();
        await switcher?.refresh();
        return manager.current?.meta;
      },
      exportSession: (id: string) => manager.exportSession(id),
      setBackend: async (id: string, backendId: string) => {
        await manager.setBackend(id, backendId as Parameters<SessionManager["setBackend"]>[1]);
        buildChatForActive();
        await switcher?.refresh();
        return { id: manager.current?.meta.id, backendId: manager.current?.backendId, notice: manager.current?.backendNotice };
      },
      setModel: async (id: string, modelId?: string) => {
        await manager.setModel(id, modelId);
        buildChatForActive();
        await switcher?.refresh();
        return { id: manager.current?.meta.id, modelId: manager.current?.meta.modelId, activeModel: manager.current?.session.modelId };
      },
      importSession: async (data: unknown) => {
        await manager.importSession(data as Parameters<SessionManager["importSession"]>[0]);
        buildChatForActive();
        await switcher?.refresh();
        return manager.current?.meta;
      },
    };
    (globalThis as Record<string, unknown>).__PI_WASM_SETTINGS__ = {
      store,
      current: () => settings,
      toRuntimeConfig: () => store.load().then(toRuntimeConfig),
    };
  };

  const buildChatForActive = () => {
    const active = manager.current;
    if (!active) return;
    ui?.dispose();
    ui = mountChat(app, active.session);
    setStatus();
    exposeGlobals();
  };

  // Initialize the active keyed session (builds its VFS workdir + S4 tools).
  try {
    await manager.init();
  } catch (err) {
    (globalThis as Record<string, unknown>).__PI_WASM_SPIKE__ = { ok: false, error: String(err) };
    app.setAttribute("data-pi-wasm-ready", "false");
    app.textContent = `pi-wasm failed to init sessions/VFS: ${String(err)}`;
    throw err;
  }

  // Session switcher sidebar — re-mount the chat against whatever it activates.
  switcher = mountSwitcher(sidebar, manager, { onChange: () => buildChatForActive() });

  // S6 settings — on save, re-activate the current session so the new
  // model/key applies (transcript is flushed + restored across the rebuild).
  mountSettingsPanel(settingsPanel, store, {
    onSaved: async (saved) => {
      settings = saved;
      const id = manager.current?.meta.id;
      if (id) {
        await manager.activate(id);
        buildChatForActive();
        await switcher?.refresh();
      }
      setPanelOpen(false);
    },
  });

  let panelOpen = false;
  const setPanelOpen = (open: boolean) => {
    panelOpen = open;
    settingsPanel.hidden = !open;
    settingsToggle.setAttribute("aria-expanded", String(open));
  };
  settingsToggle.addEventListener("click", () => setPanelOpen(!panelOpen));
  setPanelOpen(false);

  buildChatForActive();
  app.setAttribute("data-pi-wasm-ready", "true");

  // Persist the active transcript on tab close (belt-and-braces; turns also save).
  window.addEventListener("beforeunload", () => manager.flush());

  // Scripted end-to-end check for S8 (preserves the S3 __PI_WASM_S3__ contract).
  if (params.get("autorun") === "1") {
    await runAutorun();
  }

  async function runAutorun(): Promise<void> {
    const session = manager.current!.session;
    const prompt = params.get("prompt") ?? "Say hello in exactly three words.";
    let chunks = 0;
    const unsub = session.subscribe(() => {
      chunks++;
    });
    const cfg = toRuntimeConfig(settings);
    const result: S3Result = {
      ok: false,
      model: cfg.model?.id ?? DEFAULT_MODEL_ID,
      baseUrl: cfg.baseUrl || DEFAULT_BASE_URL,
    };
    try {
      await session.send(prompt);
      await session.agent.waitForIdle();
      const text = currentAssistantText(session.agent);
      const error = session.errorMessage;
      result.text = text;
      result.chunks = chunks;
      result.ok = !error && text.trim().length > 0;
      result.error = result.ok ? undefined : (error ?? "empty_response");
    } catch (err) {
      result.error = String(err);
      result.chunks = chunks;
    } finally {
      unsub();
      (globalThis as Record<string, unknown>).__PI_WASM_S3__ = result;
      document.title = result.ok ? "pi-wasm S7:ok" : "pi-wasm S7:fail";
      ui?.render();
    }
  }
}

void boot().catch((err) => {
  console.error("[pi-wasm] boot failed", err);
});
