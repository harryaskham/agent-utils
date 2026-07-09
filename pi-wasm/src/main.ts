// pi-wasm — fully in-browser Pi agent loop · S7 app shell (bd-e8949f).
//
// The demoable MVP: a real multi-turn chat that runs the FULL agent loop
// client-side — S6 settings/keys, S3 streaming provider, and S4 file tools over
// the S2 IndexedDB VFS. Path A only (pi-agent-core + pi-ai; NEVER the
// pi-coding-agent barrel — the barrel trap, FEASIBILITY.md §3).
//
// Wiring per the seam authors (msm-0 S3/S6, ms2-2 S2/S4):
//   env   = await createBrowserExecutionEnv({ cwd: "/work" })   // S2
//   tools = createBrowserAgentTools(env)                        // S4 (bash-free)
//   cfg   = toRuntimeConfig(await new SettingsStore().load())   // S6
//   session = PiWasmSession({ ...cfg, tools })  // S3 stream + mock fallback
//
// Preserved hooks: __PI_WASM_SPIKE__ (S1), __PI_WASM_S3__ (?autorun), __PI_WASM__
// (chat harness + fileToolsSmoke for the S8 Playwright suite), __PI_WASM_SETTINGS__ (S6).

import { PiWasmSession } from "./session.js";
import { mountChat, type ChatUiHandle } from "./chat-ui.js";
import { currentAssistantText, messageText, DEFAULT_BASE_URL, DEFAULT_MODEL_ID } from "./provider.js";
import { createBrowserExecutionEnv, type BrowserExecutionEnv } from "./vfs";
import { createBrowserAgentTools, fileToolsSmoke } from "./tools";
import {
  SettingsStore,
  toRuntimeConfig,
  isRuntimeConfigReady,
  mountSettingsPanel,
  type PiWasmSettings,
} from "./settings";

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
  const settingsPanel = el<HTMLElement>("settings-panel");
  const settingsToggle = el<HTMLButtonElement>("settings-toggle");
  const statusEl = el<HTMLElement>("status");

  let env: BrowserExecutionEnv;
  let tools: ReturnType<typeof createBrowserAgentTools>;
  try {
    env = await createBrowserExecutionEnv({ cwd: "/work" }); // S2 VFS
    tools = createBrowserAgentTools(env); // S4 file tools (bash-free)
  } catch (err) {
    (globalThis as Record<string, unknown>).__PI_WASM_SPIKE__ = { ok: false, error: String(err) };
    app.setAttribute("data-pi-wasm-ready", "false");
    app.textContent = `pi-wasm failed to init the VFS/tools: ${String(err)}`;
    throw err;
  }

  const store = new SettingsStore();
  let settings: PiWasmSettings = await store.load();
  let session: PiWasmSession;
  let ui: ChatUiHandle;

  const setStatus = () => {
    const ready = isRuntimeConfigReady(settings);
    const cfg = toRuntimeConfig(settings);
    statusEl.textContent = ready
      ? `live · ${cfg.model?.id ?? "?"}`
      : "mock (no key/model) · open ⚙ Settings to go live";
    statusEl.className = ready ? "is-live" : "is-mock";
  };

  const exposeGlobals = () => {
    const state = session.agent.state as { messages?: unknown[]; tools?: unknown[] };
    (globalThis as Record<string, unknown>).__PI_WASM_SPIKE__ = {
      ok: true,
      detail: { shell: "S7", messages: state.messages?.length ?? 0, tools: state.tools?.length ?? 0 },
    };
    (globalThis as Record<string, unknown>).__PI_WASM__ = {
      session,
      ui,
      env,
      ready: true,
      async send(text: string) {
        await session.send(text);
        await session.agent.waitForIdle();
        ui.render();
      },
      getTranscript: () =>
        session.messages.map((m) => ({ role: (m as { role?: string }).role ?? "?", text: messageText(m) })),
      // S4/S8 acceptance: read→edit→write over the VFS (ms2-2's ready check).
      runToolsSmoke: () => fileToolsSmoke(env),
    };
    // S6/S8 settings hook on the chat page (matches settings-demo.ts shape).
    (globalThis as Record<string, unknown>).__PI_WASM_SETTINGS__ = {
      store,
      current: () => settings,
      toRuntimeConfig: () => store.load().then(toRuntimeConfig),
    };
  };

  const build = () => {
    ui?.dispose();
    const cfg = toRuntimeConfig(settings); // S6 → { model, baseUrl, apiKey, getApiKey }
    session = new PiWasmSession({
      modelId: cfg.model?.id ?? DEFAULT_MODEL_ID,
      baseUrl: cfg.baseUrl || DEFAULT_BASE_URL,
      providerId: cfg.model?.provider,
      getApiKey: cfg.getApiKey,
      tools,
    });
    ui = mountChat(app, session);
    setStatus();
    exposeGlobals();
  };

  // S6 settings panel — rebuild the session when the user saves new config.
  mountSettingsPanel(settingsPanel, store, {
    onSaved: (saved) => {
      settings = saved;
      build();
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

  build();
  app.setAttribute("data-pi-wasm-ready", "true");

  // Scripted end-to-end check for S8 (preserves the S3 __PI_WASM_S3__ contract).
  if (params.get("autorun") === "1") {
    await runAutorun();
  }

  async function runAutorun(): Promise<void> {
    const prompt = params.get("prompt") ?? "Say hello in exactly three words.";
    let chunks = 0;
    const unsub = session.subscribe(() => {
      chunks++;
    });
    const result: S3Result = {
      ok: false,
      model: toRuntimeConfig(settings).model?.id ?? DEFAULT_MODEL_ID,
      baseUrl: toRuntimeConfig(settings).baseUrl || DEFAULT_BASE_URL,
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
      ui.render();
    }
  }
}

void boot().catch((err) => {
  console.error("[pi-wasm] boot failed", err);
});
