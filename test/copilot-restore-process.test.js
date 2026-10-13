import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { buildPiRestartPlan } from "../extensions/pi-self-update.js";
const enabled = process.env.PI_RUN_MODEL_RESTORE_SMOKE === "1";
const pause = () => new Promise(resolve => setTimeout(resolve, 25));

for (const mode of ["restart", "continue", "session"]) test(`real Pi ${mode}: legacy resume${mode === "restart" ? " preserves the selected model" : " recovers after one normal model selection"}`, { skip: !enabled, timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "copilot-restore-"));
  const requests = [], children = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 2e6) { res.writeHead(413); res.end(); return; } }
    if (req.method !== "POST" || !req.url.startsWith("/v1/messages")) { res.writeHead(404); res.end(); return; }
    requests.push({ url: req.url, model: JSON.parse(raw).model });
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { id: `fixture-${requests.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const wait = async predicate => {
    const deadline = Date.now() + 20000;
    while (!await predicate()) { assert.ok(Date.now() < deadline, "fixture timed out"); await pause(); }
  };
  const receipt = path.join(root, "ready.jsonl");
  const notes = async () => (await readFile(receipt, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const env = Object.fromEntries(["PATH", "LANG", "TMPDIR"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  const common = ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "-e", path.resolve(import.meta.dirname, "fixtures/copilot-restore-extension.js")];
  async function launch(args) {
    const events = []; let stderr = "", buffer = "";
    const proc = spawn(process.env.PI_BIN || "pi", args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    children.push(proc); proc.stdin.on("error", () => {});
    proc.stdout.on("data", chunk => {
      buffer += chunk;
      for (let at; (at = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try { events.push(JSON.parse(line)); } catch { /* startup text isn't protocol */ }
      }
    });
    proc.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-6000); });
    return { proc, events, stderr: () => stderr };
  }
  async function stop(proc) {
    proc.kill("SIGTERM");
    const end = Date.now() + 5000;
    while (proc.exitCode === null && proc.signalCode === null && Date.now() < end) await pause();
    if (proc.exitCode === null && proc.signalCode === null) { proc.kill("SIGKILL"); await new Promise(resolve => proc.once("exit", resolve)); }
  }
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    Object.assign(env, { HOME: root, PI_CODING_AGENT_DIR: root, PI_DISABLE_AHP: "1", DISABLE_PI_CACO: "1", PI_OFFLINE: "1", PI_TELEMETRY: "0", COPILOT_RESTORE_QA_URL: `http://127.0.0.1:${server.address().port}`, COPILOT_RESTORE_QA_RECEIPT: receipt });
    // Continue/session recovery must work on stock Pi 1.1+, without the Agent
    // Utils compatibility hook, aliases, CLI model flags or Pi source patches.
    if (mode !== "restart") env.COPILOT_RESTORE_QA_NO_HOOK = "1";
    await writeFile(path.join(root, "settings.json"), JSON.stringify({ packages: [], defaultProvider: "github-copilot", defaultModel: "gpt-6-astra" }));
    const first = await launch([...common, "--model", "github-copilot/claude-opus-5.5"]);
    await wait(async () => (await notes()).length === 1);
    const session = (await notes())[0].file;
    first.proc.stdin.write(JSON.stringify({ id: "first", type: "prompt", message: "Reply OK." }) + "\n");
    await wait(() => first.events.some(e => e.type === "agent_end"));
    await stop(first.proc);
    const entries = (await readFile(session, "utf8")).trim().split("\n").map(JSON.parse);
    const message = entries.find(e => e.message?.role === "assistant");
    assert.equal(message.message.model, "claude-opus-5.5");
    // ONLY synthetic test-owned history is altered to reproduce a pre-fix file.
    message.message.model = "claude-opus-5-5";
    await writeFile(session, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
    const plan = buildPiRestartPlan({ argv: ["pi", "/old/pi", ...common, "--model", "gpt-6-astra", "do-not-replay-this-prompt"], env, sessionFile: session, model: { provider: "github-copilot", id: "claude-opus-5.5" } });
    const args = mode === "restart" ? plan.restartArgs : mode === "continue" ? [...common, "--continue"] : [...common, "--session", session];
    // The continue/session cases deliberately contain NO provider/model override.
    if (mode !== "restart") assert.ok(!args.includes("--model") && !args.includes("--provider"));
    let second = await launch(args);
    await wait(async () => (await notes()).length === 2);
    if (mode !== "restart") {
      // Reproduce the old entry fallback, then do exactly what /model does:
      // append one ordinary session-scoped selection using Pi's supported RPC.
      assert.equal((await notes())[1].model.id, "gpt-6-astra");
      second.proc.stdin.write(JSON.stringify({ id: "save-model", type: "set_model", provider: "github-copilot", modelId: "claude-opus-5.5" }) + "\n");
      await wait(() => second.events.some(e => e.id === "save-model" && e.type === "response"));
      assert.equal(second.events.find(e => e.id === "save-model" && e.type === "response").success, true);
      await stop(second.proc);
      assert.equal(requests.length, 1, "selecting a model must not generate an assistant turn");
      const settings = JSON.parse(await readFile(path.join(root, "settings.json"), "utf8"));
      assert.equal(settings.defaultModel, "gpt-6-astra", "selection must not change the default for other sessions");
      second = await launch(args);
      await wait(async () => (await notes()).length === 3);
    }
    assert.equal((await notes()).at(-1).model.id, "claude-opus-5.5");
    assert.doesNotMatch(second.stderr(), /Could not restore model/);
    assert.equal(requests.length, 1, "resume replayed an old prompt");
    const resumedEntries = (await readFile(session, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(resumedEntries.find(e => e.id === message.id).message.model, "claude-opus-5-5", "resume must not rewrite old response metadata");
    second.proc.stdin.write(JSON.stringify({ id: "second", type: "prompt", message: "Reply OK." }) + "\n");
    await wait(() => second.events.some(e => e.type === "agent_end"));
    await stop(second.proc);
    if (mode !== "restart") {
      const final = await launch(args);
      await wait(async () => (await notes()).length === 4);
      assert.equal((await notes()).at(-1).model.id, "claude-opus-5.5", "a new reply must not reintroduce the bad restore identity");
      assert.doesNotMatch(final.stderr(), /Could not restore model/);
      await stop(final.proc);
    }
    assert.deepEqual(requests.map(r => r.model), ["claude-opus-5.5", "claude-opus-5.5"]);
    assert.ok(requests.every(r => r.url.startsWith("/v1/messages")));
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await stop(child);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
