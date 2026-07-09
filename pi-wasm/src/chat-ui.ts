// pi-wasm S7 (bd-e8949f) — minimal chat UI over the agent event stream.
//
// Pure DOM (no framework) to keep the thin shell dependency-free. Renders the
// transcript from `session.messages` + `session.streamingMessage` on every
// agent event, and wires the composer to `session.send()`. Text extraction
// reuses S3's `messageText` (./provider.ts) for consistency.

import type { PiWasmSession } from "./session.js";
import { messageText } from "./provider.js";

export interface ChatUiHandle {
  render: () => void;
  submit: (text: string) => void;
  dispose: () => void;
}

interface RenderRow {
  role: string;
  text: string;
  streaming: boolean;
}

/** Extract text + tool-call summaries from one message's content. */
function partsOf(content: unknown): { text: string; tools: string[] } {
  const tools: string[] = [];
  if (typeof content === "string") return { text: content, tools };
  if (!Array.isArray(content)) return { text: "", tools };
  let text = "";
  for (const part of content) {
    if (!part || typeof part !== "object" || !("type" in part)) continue;
    const p = part as { type: string; text?: string; name?: string; arguments?: unknown };
    if (p.type === "text") text += p.text ?? "";
    else if (p.type === "toolCall") {
      let args = "";
      try {
        args = p.arguments ? JSON.stringify(p.arguments) : "";
      } catch {
        args = "";
      }
      tools.push(`${p.name ?? "tool"}(${args.length > 120 ? args.slice(0, 120) + "\u2026" : args})`);
    }
  }
  return { text, tools };
}

function messageRows(session: PiWasmSession): RenderRow[] {
  const rows: RenderRow[] = [];
  for (const m of session.messages) {
    const role = (m as { role?: string }).role ?? "?";
    const content = (m as { content?: unknown }).content;
    if (role === "toolResult") {
      const name = (m as { toolName?: string }).toolName ?? "tool";
      const isError = Boolean((m as { isError?: boolean }).isError);
      rows.push({
        role: isError ? "tool-error" : "tool-result",
        text: `${name} \u2192 ${messageText(m)}`,
        streaming: false,
      });
      continue;
    }
    const { text, tools } = partsOf(content);
    if (text.trim()) rows.push({ role, text, streaming: false });
    for (const t of tools) rows.push({ role: "tool-call", text: `\uD83D\uDD27 ${t}`, streaming: false });
  }
  const streaming = session.streamingMessage;
  if (streaming) {
    const { text, tools } = partsOf((streaming as { content?: unknown }).content);
    if (text.trim() || tools.length === 0) {
      rows.push({
        role: (streaming as { role?: string }).role ?? "assistant",
        text,
        streaming: true,
      });
    }
    for (const t of tools) rows.push({ role: "tool-call", text: `\uD83D\uDD27 ${t}`, streaming: true });
  }
  return rows;
}

/** Mount the chat UI into `root`, bound to `session`. */
export function mountChat(root: HTMLElement, session: PiWasmSession): ChatUiHandle {
  root.innerHTML = "";
  root.classList.add("pi-chat");

  const log = document.createElement("div");
  log.className = "pi-chat__log";
  log.setAttribute("data-testid", "chat-log");

  const form = document.createElement("form");
  form.className = "pi-chat__composer";

  const input = document.createElement("textarea");
  input.className = "pi-chat__input";
  input.setAttribute("data-testid", "chat-input");
  input.rows = 2;
  input.placeholder = "Message the in-browser agent…  (Enter to send, Shift+Enter for newline)";

  const send = document.createElement("button");
  send.type = "submit";
  send.className = "pi-chat__send";
  send.setAttribute("data-testid", "chat-send");
  send.textContent = "Send";

  form.append(input, send);
  root.append(log, form);

  const render = () => {
    const rows = messageRows(session);
    log.innerHTML = "";
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pi-chat__empty";
      empty.textContent = "No messages yet. Say hello to the in-browser agent.";
      log.append(empty);
    }
    for (const row of rows) {
      const el = document.createElement("div");
      el.className = `pi-chat__msg pi-chat__msg--${row.role}${row.streaming ? " is-streaming" : ""}`;
      el.setAttribute("data-role", row.role);

      const label = document.createElement("span");
      label.className = "pi-chat__role";
      label.textContent = row.role;

      const body = document.createElement("span");
      body.className = "pi-chat__text";
      body.textContent = row.text + (row.streaming ? " ▍" : "");

      el.append(label, body);
      log.append(el);
    }

    const err = session.errorMessage;
    if (err) {
      const el = document.createElement("div");
      el.className = "pi-chat__msg pi-chat__msg--error";
      el.setAttribute("data-testid", "chat-error");
      el.textContent = `error: ${err}`;
      log.append(el);
    }

    const busy = session.isStreaming;
    send.disabled = busy;
    input.disabled = busy;
    send.textContent = busy ? "…" : "Send";
    log.scrollTop = log.scrollHeight;
  };

  const submit = (text: string) => {
    const value = text.trim();
    if (!value) return;
    input.value = "";
    void session.send(value).then(render);
    render();
  };

  const onSubmit = (e: Event) => {
    e.preventDefault();
    submit(input.value);
  };
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(input.value);
    }
  };

  form.addEventListener("submit", onSubmit);
  input.addEventListener("keydown", onKeydown);
  const unsubscribe = session.subscribe(() => render());

  render();

  return {
    render,
    submit,
    dispose() {
      form.removeEventListener("submit", onSubmit);
      input.removeEventListener("keydown", onKeydown);
      unsubscribe();
    },
  };
}
