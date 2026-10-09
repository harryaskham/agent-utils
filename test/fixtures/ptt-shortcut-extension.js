// Private real-Pi PTY fixture. All microphone and transcription work is fake.
import { createServer } from "node:net";
import { chmod, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import realtimeAgentExtension, { __setLocalVadHooksForTest } from "../../extensions/realtime-agent.js";

export default function pttShortcutFixture(pi) {
  const endpoint = process.env.PTT_QA_SOCKET;
  if (!endpoint) throw new Error("PTT_QA_SOCKET is required for this isolated fixture");
  const state = { ready: false, captures: 0, active: 0, transcriptions: 0, sent: [], modal: false, shortcuts: [] };
  let ctx, server, dismiss;
  __setLocalVadHooksForTest({
    capture: () => {
      state.captures++; state.active++;
      const capture = new EventEmitter(); capture.stdout = new EventEmitter(); capture.stderr = new EventEmitter();
      let killed = false;
      capture.kill = () => { if (!killed) { killed = true; state.active--; } };
      queueMicrotask(() => {
        if (killed) return;
        const pcm = Buffer.alloc(24000);
        for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(8000, i);
        capture.stdout.emit("data", pcm);
      });
      return capture;
    },
    transcribe: async (_pcm, options) => {
      options.signal?.throwIfAborted();
      state.transcriptions++;
      return "fixture PTT transcript";
    },
  });
  realtimeAgentExtension({
    ...pi,
    registerShortcut(key, definition) { state.shortcuts.push(key); pi.registerShortcut(key, definition); },
    sendUserMessage(text) { state.sent.push(text); }, // never calls a model
  });
  const snapshot = () => ({ ...state, editor: ctx?.ui.getEditorText() || "" });
  const action = request => {
    switch (request) {
      case "snapshot": return snapshot();
      case "clear": ctx.ui.setEditorText(""); return snapshot();
      case "modal":
        void ctx.ui.custom((_tui, _theme, _keys, done) => {
          dismiss = done; state.modal = true;
          return { render: () => ["PTT shortcut fixture modal"], invalidate() {}, handleInput(data) { if (data === "\x1b") done(); } };
        }).finally(() => { state.modal = false; dismiss = null; });
        return snapshot();
      default: throw new Error("unknown fixture action");
    }
  };
  pi.on("session_start", async (_event, context) => {
    ctx = context;
    server = createServer(socket => {
      socket.setTimeout(3000, () => socket.destroy());
      let data = "";
      socket.on("error", () => {});
      socket.on("data", chunk => {
        data += chunk;
        if (data.length > 4096) { socket.destroy(); return; }
        if (!data.includes("\n")) return;
        try { socket.end(`${JSON.stringify(action(JSON.parse(data).action))}\n`); }
        catch { socket.end('{"error":"fixture request failed"}\n'); }
      });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
    await chmod(endpoint, 0o600);
    state.ready = true;
  });
  pi.on("session_shutdown", async () => {
    dismiss?.();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(endpoint, { force: true });
    __setLocalVadHooksForTest({});
  });
}
