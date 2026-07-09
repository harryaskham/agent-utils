// pi-wasm S12 (bd-254c94) — slick native-feeling agent GUI/shell.
//
// A polished, product-feeling app over the SAME in-browser loop as aurora's S7
// MVP, built ADDITIVELY as its own entry (shell.html) so it never disturbs the
// S7 chat page (index.html) or the __PI_WASM__/data-pi-wasm-ready hooks the S8
// Playwright suite drives. Reuses every landed seam:
//   env      createBrowserExecutionEnv (S2)   tools  createBrowserAgentTools (S4)
//   settings SettingsStore/toRuntimeConfig (S6) session PiWasmSession (S7)
// All heavy logic (timeline derivation, VFS sort/format) is in the pure,
// unit-tested ./model. This file is the thin DOM renderer.
//
// Increment 1: multi-pane layout (conversation + tool timeline + VFS explorer),
// streamed rendering, tool-call cards, steer/abort, light/dark, keyboard
// shortcuts, live file explorer. Diff-view + tool lifecycle pairing follow.

import { PiWasmSession } from "../session.js";
import { DEFAULT_BASE_URL, DEFAULT_MODEL_ID } from "../provider.js";
import { createBrowserExecutionEnv, type BrowserExecutionEnv } from "../vfs";
import { createBrowserAgentTools } from "../tools";
import {
  SettingsStore,
  toRuntimeConfig,
  isRuntimeConfigReady,
  mountSettingsPanel,
  type PiWasmSettings,
} from "../settings";
import {
  deriveTimeline,
  conversationItems,
  toolItems,
  sortDirEntries,
  formatBytes,
  type TimelineItem,
} from "./model.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`pi-wasm shell: missing #${id}`);
  return el as T;
};

const THEME_KEY = "pi-wasm-shell-theme";

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private mode */
  }
}

function initialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  const prefersLight =
    typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
  return prefersLight ? "light" : "dark";
}

async function boot(): Promise<void> {
  const shell = $<HTMLElement>("shell");
  const statusEl = $<HTMLElement>("status");
  const conversation = $<HTMLElement>("conversation");
  const timeline = $<HTMLElement>("tool-timeline");
  const fileTree = $<HTMLElement>("file-tree");
  const fileViewer = $<HTMLElement>("file-viewer");
  const settingsPanel = $<HTMLElement>("settings-panel");
  const input = $<HTMLTextAreaElement>("composer-input");
  const sendBtn = $<HTMLButtonElement>("composer-send");
  const abortBtn = $<HTMLButtonElement>("composer-abort");

  applyTheme(initialTheme());
  $<HTMLButtonElement>("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(next);
  });

  // Tabs (Tools | Files).
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tab]"));
  const selectTab = (name: string) => {
    for (const t of tabs) t.classList.toggle("is-active", t.dataset.tab === name);
    for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) {
      panel.hidden = panel.dataset.panel !== name;
    }
  };
  for (const t of tabs) t.addEventListener("click", () => selectTab(t.dataset.tab ?? "tools"));
  selectTab("tools");

  // --- Seams: env (S2) + tools (S4) ---
  let env: BrowserExecutionEnv;
  let tools: ReturnType<typeof createBrowserAgentTools>;
  try {
    env = await createBrowserExecutionEnv({ cwd: "/work" });
    tools = createBrowserAgentTools(env);
  } catch (err) {
    shell.setAttribute("data-pi-wasm-shell-ready", "false");
    conversation.textContent = `pi-wasm shell failed to init VFS/tools: ${String(err)}`;
    throw err;
  }

  const store = new SettingsStore();
  let settings: PiWasmSettings = await store.load();
  let session: PiWasmSession;
  let unsubscribe: (() => void) | undefined;

  const setStatus = () => {
    const ready = isRuntimeConfigReady(settings);
    const cfg = toRuntimeConfig(settings);
    statusEl.textContent = ready ? `live · ${cfg.model?.id ?? "?"}` : "mock · add a key in Settings";
    statusEl.className = `pill ${ready ? "is-live" : "is-mock"}`;
  };

  const renderConversation = (items: TimelineItem[]) => {
    conversation.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Ask the in-browser agent to do real work — read, write, edit files in the VFS.";
      conversation.append(empty);
    }
    for (const row of items) {
      const bubble = document.createElement("div");
      bubble.className = `msg msg--${row.role}${row.streaming ? " is-streaming" : ""}`;
      bubble.dataset.role = row.role;
      const who = document.createElement("div");
      who.className = "msg__who";
      who.textContent = row.role;
      const body = document.createElement("div");
      body.className = "msg__body";
      body.textContent = row.text + (row.streaming ? " \u258d" : "");
      bubble.append(who, body);
      conversation.append(bubble);
    }
    const err = session.errorMessage;
    if (err) {
      const e = document.createElement("div");
      e.className = "msg msg--error";
      e.dataset.testid = "shell-error";
      e.textContent = `error: ${err}`;
      conversation.append(e);
    }
    conversation.scrollTop = conversation.scrollHeight;
  };

  const renderTimeline = (items: TimelineItem[]) => {
    timeline.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Tool calls will appear here as the agent works.";
      timeline.append(empty);
      return;
    }
    for (const row of items) {
      const card = document.createElement("div");
      card.className = `tool-card tool-card--${row.role}`;
      const head = document.createElement("div");
      head.className = "tool-card__head";
      head.textContent =
        row.role === "tool-call" ? `⚙ ${row.tool ?? "tool"}` : `${row.role === "tool-error" ? "✗" : "✓"} ${row.tool ?? "tool"}`;
      const body = document.createElement("div");
      body.className = "tool-card__body";
      body.textContent = row.text;
      card.append(head, body);
      timeline.append(card);
    }
    timeline.scrollTop = timeline.scrollHeight;
  };

  const render = () => {
    const tl = deriveTimeline(session.messages, session.streamingMessage);
    renderConversation(conversationItems(tl));
    renderTimeline(toolItems(tl));
    const busy = session.isStreaming;
    sendBtn.disabled = busy;
    input.disabled = busy;
    abortBtn.hidden = !busy;
    setStatus();
  };

  // --- VFS explorer (lazy tree) ---
  const openFile = async (path: string) => {
    fileViewer.hidden = false;
    fileViewer.querySelector(".viewer__path")!.textContent = path;
    const pre = fileViewer.querySelector<HTMLElement>(".viewer__body")!;
    pre.textContent = "loading…";
    const res = await env.readTextFile(path);
    pre.textContent = res.ok
      ? res.value.length > 20000
        ? res.value.slice(0, 20000) + "\n… (truncated)"
        : res.value || "(empty file)"
      : `(cannot read: ${res.error.code})`;
  };

  const renderDir = async (container: HTMLElement, dirPath: string, depth: number): Promise<void> => {
    const res = await env.listDir(dirPath);
    container.innerHTML = "";
    if (!res.ok) {
      container.textContent = `(cannot list ${dirPath}: ${res.error.code})`;
      return;
    }
    for (const entry of sortDirEntries(res.value)) {
      const row = document.createElement("div");
      row.className = `tree-row tree-row--${entry.kind}`;
      row.style.paddingLeft = `${depth * 14 + 6}px`;
      if (entry.kind === "directory") {
        let open = false;
        const kids = document.createElement("div");
        kids.hidden = true;
        const label = document.createElement("button");
        label.type = "button";
        label.className = "tree-btn";
        label.textContent = `▸ ${entry.name}/`;
        label.addEventListener("click", async () => {
          open = !open;
          label.textContent = `${open ? "▾" : "▸"} ${entry.name}/`;
          kids.hidden = !open;
          if (open && kids.childElementCount === 0) await renderDir(kids, entry.path, depth + 1);
        });
        row.append(label);
        container.append(row, kids);
      } else {
        const label = document.createElement("button");
        label.type = "button";
        label.className = "tree-btn tree-btn--file";
        const size = formatBytes(entry.size);
        label.textContent = `${entry.name}${size ? `  ·  ${size}` : ""}`;
        label.addEventListener("click", () => void openFile(entry.path));
        row.append(label);
        container.append(row);
      }
    }
  };

  const refreshFiles = () => void renderDir(fileTree, "/", 0);
  $<HTMLButtonElement>("files-refresh").addEventListener("click", refreshFiles);

  // --- Session build / rebuild ---
  const build = () => {
    unsubscribe?.();
    const cfg = toRuntimeConfig(settings);
    session = new PiWasmSession({
      modelId: cfg.model?.id ?? DEFAULT_MODEL_ID,
      baseUrl: cfg.baseUrl || DEFAULT_BASE_URL,
      providerId: cfg.model?.provider,
      getApiKey: cfg.getApiKey,
      tools,
    });
    unsubscribe = session.subscribe(() => render());
    render();
    exposeGlobals();
  };

  const exposeGlobals = () => {
    (globalThis as Record<string, unknown>).__PI_WASM_SHELL__ = {
      ready: true,
      session,
      env,
      render,
      refreshFiles,
      async send(text: string) {
        await session.send(text);
        await session.agent.waitForIdle();
        render();
        refreshFiles();
      },
    };
  };

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
    $<HTMLButtonElement>("settings-toggle").setAttribute("aria-expanded", String(open));
  };
  $<HTMLButtonElement>("settings-toggle").addEventListener("click", () => setPanelOpen(!panelOpen));
  setPanelOpen(false);

  // --- Composer ---
  const submit = async () => {
    const text = input.value.trim();
    if (!text || session.isStreaming) return;
    input.value = "";
    await session.send(text);
    await session.agent.waitForIdle();
    render();
    refreshFiles(); // surface any files the agent wrote this turn
  };
  sendBtn.addEventListener("click", () => void submit());
  abortBtn.addEventListener("click", () => session.abort());
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape" && session.isStreaming) {
      e.preventDefault();
      session.abort();
    }
  });
  // Global shortcut: Cmd/Ctrl+, opens Settings.
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      setPanelOpen(!panelOpen);
    }
  });

  build();
  refreshFiles();
  shell.setAttribute("data-pi-wasm-shell-ready", "true");
  input.focus();
}

void boot().catch((err) => {
  console.error("[pi-wasm shell] boot failed", err);
});
