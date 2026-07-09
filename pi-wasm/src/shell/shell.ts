// pi-wasm S12 (bd-254c94) — slick native-feeling agent GUI/shell.
//
// A polished, product-feeling app over the SAME in-browser loop as aurora's S7
// MVP, built ADDITIVELY as its own entry (shell.html) so it never disturbs the
// S7 chat page (index.html) or the __PI_WASM__/data-pi-wasm-ready hooks the S8
// Playwright suite drives. Reuses every landed seam:
//   session mgmt  S11 SessionManager (keyed multi-session, per-session VFS/model,
//                 persisted in IndexedDB) — drives the left session switcher
//   settings      SettingsStore/toRuntimeConfig (S6)   session  PiWasmSession (S7)
//   file tools    createBrowserAgentTools (S4)         env      browser VFS (S2)
// All heavy logic (timeline/diff derivation, VFS sort/format) is in the pure,
// unit-tested ./model. This file is the thin DOM renderer.
//
// Increment 1: multi-pane layout (conversation + tool timeline + VFS explorer),
// streamed rendering, tool-call cards, steer/abort, light/dark, keyboard.
// Increment 2: diff-view tab (before/after diffs for every write/edit).
// Increment 3: keyed multi-session — a left session switcher over S11's
// SessionManager; each session keeps its own transcript + VFS workdir + model,
// all persisted, so switching/reload restores state. Realizes the "multi-session
// slick shell" the S12 bead pairs with S11.

import {
  SettingsStore,
  toRuntimeConfig,
  isRuntimeConfigReady,
  mountSettingsPanel,
  type PiWasmSettings,
} from "../settings";
import { type BrowserExecutionEnv } from "../vfs";
import type { PiWasmSession } from "../session.js";
import { SessionRegistry, SessionManager, mountSwitcher, type ActiveSession } from "../sessions";
import {
  deriveTimeline,
  conversationItems,
  toolItems,
  sortDirEntries,
  formatBytes,
  diffLines,
  deriveEdits,
  type TimelineItem,
  type EditRecord,
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
  const diffView = $<HTMLElement>("diff-view");
  const switcherEl = $<HTMLElement>("session-switcher");
  const settingsPanel = $<HTMLElement>("settings-panel");
  const input = $<HTMLTextAreaElement>("composer-input");
  const sendBtn = $<HTMLButtonElement>("composer-send");
  const abortBtn = $<HTMLButtonElement>("composer-abort");

  applyTheme(initialTheme());
  $<HTMLButtonElement>("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(next);
  });

  // Tabs (Tools | Files | Diffs).
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-tab]"));
  const selectTab = (name: string) => {
    for (const t of tabs) t.classList.toggle("is-active", t.dataset.tab === name);
    for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) {
      panel.hidden = panel.dataset.panel !== name;
    }
  };
  for (const t of tabs) t.addEventListener("click", () => selectTab(t.dataset.tab ?? "tools"));
  selectTab("tools");

  // --- Session management (S11) ---
  const store = new SettingsStore();
  let settings: PiWasmSettings = await store.load();
  const registry = new SessionRegistry();
  const manager = new SessionManager(registry, store);

  // The active keyed session — session + env are re-pointed on every switch.
  let active: ActiveSession;
  let session: PiWasmSession;
  let env: BrowserExecutionEnv;
  let unsubscribe: (() => void) | undefined;

  const setStatus = () => {
    const ready = isRuntimeConfigReady(settings);
    const cfg = toRuntimeConfig(settings);
    const model = active?.meta.modelId ?? cfg.model?.id ?? "?";
    statusEl.textContent = ready ? `live · ${model}` : "mock · add a key in Settings";
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
        row.role === "tool-call"
          ? `⚙ ${row.tool ?? "tool"}`
          : `${row.role === "tool-error" ? "✗" : "✓"} ${row.tool ?? "tool"}`;
      const body = document.createElement("div");
      body.className = "tool-card__body";
      body.textContent = row.text;
      card.append(head, body);
      timeline.append(card);
    }
    timeline.scrollTop = timeline.scrollHeight;
  };

  const renderDiffs = (records: EditRecord[]) => {
    diffView.innerHTML = "";
    if (records.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "File writes/edits will show as diffs here as the agent changes the VFS.";
      diffView.append(empty);
      return;
    }
    for (const rec of records) {
      const card = document.createElement("div");
      card.className = "diff-card";
      const head = document.createElement("div");
      head.className = "diff-card__head";
      head.textContent = `${rec.kind === "write" ? "✎ write" : "± edit"}  ${rec.path}`;
      const body = document.createElement("div");
      body.className = "diff-card__body";
      for (const line of diffLines(rec.oldText, rec.newText)) {
        const ln = document.createElement("div");
        ln.className = `diff-line diff-line--${line.type}`;
        const sign = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
        ln.textContent = `${sign} ${line.text}`;
        body.append(ln);
      }
      card.append(head, body);
      diffView.append(card);
    }
    diffView.scrollTop = diffView.scrollHeight;
  };

  const render = () => {
    const tl = deriveTimeline(session.messages, session.streamingMessage);
    renderConversation(conversationItems(tl));
    renderTimeline(toolItems(tl));
    renderDiffs(deriveEdits(session.messages));
    const busy = session.isStreaming;
    sendBtn.disabled = busy;
    input.disabled = busy;
    abortBtn.hidden = !busy;
    setStatus();
  };

  // --- VFS explorer (lazy tree over the active session's env) ---
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

  const refreshFiles = () => {
    fileViewer.hidden = true;
    void renderDir(fileTree, "/", 0);
  };
  $<HTMLButtonElement>("files-refresh").addEventListener("click", refreshFiles);

  const exposeGlobals = () => {
    (globalThis as Record<string, unknown>).__PI_WASM_SHELL__ = {
      ready: true,
      manager,
      get session(): PiWasmSession {
        return session;
      },
      get env(): BrowserExecutionEnv {
        return env;
      },
      get active(): ActiveSession {
        return active;
      },
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

  // Re-point the shell at a newly-activated session (initial load + every switch).
  const bindSession = (a: ActiveSession): void => {
    unsubscribe?.();
    active = a;
    session = a.session;
    env = a.env;
    unsubscribe = session.subscribe(() => render());
    render();
    refreshFiles();
    exposeGlobals();
  };

  // --- Settings panel (rebuild the active session on save to pick up key/model) ---
  let panelOpen = false;
  const setPanelOpen = (open: boolean) => {
    panelOpen = open;
    settingsPanel.hidden = !open;
    $<HTMLButtonElement>("settings-toggle").setAttribute("aria-expanded", String(open));
  };
  mountSettingsPanel(settingsPanel, store, {
    onSaved: async (saved) => {
      settings = saved;
      bindSession(await manager.activate(active.meta.id));
      setPanelOpen(false);
    },
  });
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
  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ",") {
      e.preventDefault();
      setPanelOpen(!panelOpen);
    }
  });

  // --- Boot the first (persisted or fresh) session, then mount the switcher ---
  try {
    bindSession(await manager.init());
  } catch (err) {
    shell.setAttribute("data-pi-wasm-shell-ready", "false");
    conversation.textContent = `pi-wasm shell failed to init sessions/VFS: ${String(err)}`;
    throw err;
  }
  mountSwitcher(switcherEl, manager, { onChange: (a) => bindSession(a) });

  shell.setAttribute("data-pi-wasm-shell-ready", "true");
  input.focus();
}

void boot().catch((err) => {
  console.error("[pi-wasm shell] boot failed", err);
});
