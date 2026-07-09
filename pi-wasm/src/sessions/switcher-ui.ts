// pi-wasm S11 (bd-0dc0bc) — session switcher sidebar.
//
// Framework-free UI for keyed multi-session management: list / create / rename /
// switch / delete / export / import named agent instances. Delegates all state
// to SessionManager (which owns persistence); this module is pure view + events.
// Calls onChange(active) after any activation so the shell can re-mount the chat
// against the newly-active PiWasmSession.

import type { SessionManager, ActiveSession } from "./session-manager.js";
import type { SessionMeta } from "./registry.js";

export interface SwitcherHandle {
  refresh(): Promise<void>;
  dispose(): void;
}

export interface MountSwitcherOptions {
  onChange: (active: ActiveSession) => void;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function mountSwitcher(
  root: HTMLElement,
  manager: SessionManager,
  { onChange }: MountSwitcherOptions,
): SwitcherHandle {
  root.classList.add("pi-sessions");
  root.innerHTML = "";

  const header = document.createElement("div");
  header.className = "pi-sessions__head";
  const title = document.createElement("span");
  title.className = "pi-sessions__title";
  title.textContent = "Sessions";
  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "pi-sessions__new";
  newBtn.textContent = "+ New";
  newBtn.title = "Create a new session";
  header.append(title, newBtn);

  const listEl = document.createElement("ul");
  listEl.className = "pi-sessions__list";

  const footer = document.createElement("div");
  footer.className = "pi-sessions__foot";
  const importBtn = document.createElement("button");
  importBtn.type = "button";
  importBtn.className = "pi-sessions__import";
  importBtn.textContent = "Import";
  importBtn.title = "Import a session from a JSON file";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "application/json,.json";
  fileInput.hidden = true;
  footer.append(importBtn, fileInput);

  root.append(header, listEl, footer);

  async function activateAndNotify(fn: () => Promise<ActiveSession | undefined>): Promise<void> {
    const active = await fn();
    if (active) onChange(active);
    await refresh();
  }

  newBtn.addEventListener("click", () => {
    void activateAndNotify(() => manager.create());
  });

  importBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      await activateAndNotify(() => manager.importSession(data));
    } catch (err) {
      alert(`Import failed: ${String(err)}`);
    }
  });

  // Event delegation for per-row actions.
  listEl.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-session-id]");
    if (!row) return;
    const id = row.dataset.sessionId!;
    const action = target.dataset.action;
    if (action === "rename") {
      ev.stopPropagation();
      const current = row.querySelector(".pi-sessions__name")?.textContent ?? "";
      const name = prompt("Rename session", current);
      if (name != null) void manager.rename(id, name).then(refresh);
      return;
    }
    if (action === "delete") {
      ev.stopPropagation();
      if (confirm("Delete this session and its files? This cannot be undone.")) {
        void activateAndNotify(() => manager.remove(id));
      }
      return;
    }
    if (action === "export") {
      ev.stopPropagation();
      void exportSession(id);
      return;
    }
    // Row body click → switch.
    void activateAndNotify(() => manager.activate(id));
  });

  async function exportSession(id: string): Promise<void> {
    const snapshot = await manager.exportSession(id);
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${snapshot.meta.name.replace(/[^\w.-]+/g, "_") || "session"}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function renderRow(meta: SessionMeta, activeId: string | undefined): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "pi-sessions__item" + (meta.id === activeId ? " is-active" : "");
    li.dataset.sessionId = meta.id;
    li.innerHTML = `
      <div class="pi-sessions__row">
        <span class="pi-sessions__name"></span>
        <span class="pi-sessions__time"></span>
      </div>
      <div class="pi-sessions__actions">
        <button type="button" data-action="rename" title="Rename">✎</button>
        <button type="button" data-action="export" title="Export JSON">⭳</button>
        <button type="button" data-action="delete" title="Delete">🗑</button>
      </div>`;
    li.querySelector(".pi-sessions__name")!.textContent = meta.name;
    li.querySelector(".pi-sessions__time")!.textContent = fmtTime(meta.updatedAt);
    return li;
  }

  async function refresh(): Promise<void> {
    const [sessions, activeId] = await Promise.all([manager.list(), Promise.resolve(manager.current?.meta.id)]);
    listEl.innerHTML = "";
    for (const meta of sessions) listEl.append(renderRow(meta, activeId));
  }

  void refresh();

  return {
    refresh,
    dispose() {
      root.innerHTML = "";
      root.classList.remove("pi-sessions");
    },
  };
}
