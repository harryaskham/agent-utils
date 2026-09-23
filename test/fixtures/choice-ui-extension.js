// Explicit, isolated real-Pi QA extension. Never loaded by the package manifest.
import net from "node:net";
import { chmod, readFile, unlink } from "node:fs/promises";
import { createChoiceExtension } from "../../extensions/choice.js";

export default function choiceUiFixture(pi) {
  const socket = process.env.CHOICE_QA_SOCKET;
  const fixturePath = process.env.CHOICE_QA_FIXTURE;
  if (!socket || !fixturePath) throw new Error("choice UI fixture requires isolated socket and fixture paths");
  let tool, context, frame = null, pending = false, result = null, revision = 0, server;
  const clients = new Set();
  createChoiceExtension({
    cacophonyBridge: false, ahpBridge: false,
    speaker: { speak: async () => {}, interrupt() {}, dispose() {} },
    persistedSettings: { choice: { speechEnabled: false, timeoutMs: 0, expanded: true }, tts: {} },
  })({ ...pi, registerTool(definition) { tool = definition; pi.registerTool(definition); } });

  pi.on("session_start", async (_event, ctx) => {
    context = { ...ctx, ui: { ...ctx.ui, custom(factory, options) {
      return ctx.ui.custom((tui, theme, keys, done) => {
        const component = factory(tui, theme, keys, done);
        return { ...component, render(width) {
          const lines = component.render(width);
          frame = { columns: width, rows: tui.terminal.rows, lines, view: component.snapshot?.() };
          revision++;
          return lines;
        } };
      }, options);
    } } };
    server = net.createServer(client => {
      clients.add(client); client.setEncoding("utf8"); let buffer = "";
      client.on("close", () => clients.delete(client));
      client.on("error", () => {});
      client.on("data", async chunk => {
        buffer += chunk;
        if (buffer.length > 4096) { client.destroy(); return; }
        const newline = buffer.indexOf("\n"); if (newline < 0) return;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const request = JSON.parse(line);
          if (request.action === "open") {
            if (pending) throw new Error("choice already open");
            const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
            pending = true; result = null; frame = null;
            void tool.execute(`fixture-${revision}`, fixture, undefined, undefined, context).then(value => { result = value.details; pending = false; });
            client.end(JSON.stringify({ id: request.id, accepted: true }) + "\n");
          } else if (request.action === "snapshot") {
            client.end(JSON.stringify({ id: request.id, pending, result, revision, frame }) + "\n");
          } else throw new Error("unknown fixture action");
        } catch (error) { client.end(JSON.stringify({ error: error.message }) + "\n"); }
      });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    await chmod(socket, 0o600);
  });
  pi.on("session_shutdown", async () => {
    for (const client of clients) client.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    await unlink(socket).catch(() => {});
  });
}
