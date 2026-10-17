import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const enabled = process.env.PI_RUN_COMPACT_NEXT_RUNTIME === "1";
// npm prepends the pinned SDK's .bin directory; that is not the running host.
function realPiBinary() {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  for (const dir of String(process.env.PATH || "").split(":")) {
    if (!dir || dir.includes("node_modules")) continue;
    const path = join(dir, "pi");
    try { accessSync(path, constants.X_OK); return path; } catch {}
  }
  throw new Error("Pi host not found; set PI_BIN to a Pi 1.3.0+ executable");
}

// CN-06: real slash command -> complete tool batch -> native summary generator ->
// committed boundary compaction -> next provider request, in the SAME agent run.
for (const scenario of [
  { title: "tool batch resumes without a new prompt", resume: "none", final: false },
  { title: "final assistant uses a hidden checkpoint", resume: "auto", final: true },
  { title: "explicit continue uses a visible checkpoint", resume: "continue", final: true },
]) test(`real Pi compact-next: ${scenario.title}`, { skip: !enabled, timeout: 45000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "compact-next-runtime-"));
  const agent = join(dir, "agent");
  mkdirSync(agent);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 0 }, packages: [] }));
  const tracePath = join(dir, "trace.jsonl");
  writeFileSync(tracePath, "");
  const child = spawn(realPiBinary(), [
    "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "-e", resolve("test/fixtures/compact-next-runtime.js"), "--provider", "compact-next-fixture", "--model", "fixture",
  ], { cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"), PI_OFFLINE: "1", COMPACT_NEXT_TRACE: tracePath, COMPACT_NEXT_FINAL: scenario.final ? "1" : "0" }, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  let stdout = "", stderr = "", seq = 0;
  child.stdout.on("data", chunk => {
    stdout += chunk;
    let end;
    while ((end = stdout.indexOf("\n")) >= 0) {
      const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      try { messages.push(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const trace = () => readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const wait = async (predicate, description) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (child.exitCode !== null || Date.now() > deadline) assert.fail(`${description}\n${stderr.slice(-2000)}\n${JSON.stringify(messages).slice(-6000)}\n${JSON.stringify(trace()).slice(-6000)}`);
      await delay(10);
    }
  };
  const send = request => { const id = `r${++seq}`; child.stdin.write(`${JSON.stringify({ ...request, id })}\n`); return id; };
  const command = async text => {
    const id = send({ type: "prompt", message: text });
    await wait(() => messages.some(m => m.type === "response" && m.id === id), text);
    assert.equal(messages.find(m => m.type === "response" && m.id === id).success, true);
  };
  try {
    const id = send({ type: "get_commands" });
    await wait(() => messages.some(m => m.id === id), "extension registration");
    assert.ok(messages.find(m => m.id === id).data.commands.some(c => c.name === "compact-next"));
    send({ type: "prompt", message: "Perform the offline fixture task. Preserve both completed tool results." });
    if (scenario.final) await wait(() => trace().some(e => e.event === "model"), "assistant response in flight");
    else await wait(() => trace().some(e => e.event === "tool-start" && e.name === "one"), "first tool starts");
    await command(`/compact-next resume=${scenario.resume} Preserve fixture progress`);
    assert.equal(trace().some(e => e.event === "summary"), false);
    if (scenario.final) await command("/cn-release response");
    else {
      await command("/cn-release one");
      await wait(() => trace().some(e => e.event === "tool-start" && e.name === "two"), "second tool starts");
      assert.equal(trace().some(e => e.event === "summary"), false, "a single tool completion is not a safe batch boundary");
      await command("/cn-release two");
    }
    await wait(() => trace().some(e => e.event === "agent_settled"), "resumed run settles");
    const events = trace();
    assert.equal(events.filter(e => e.event === "agent_start").length, 1, "no detached replacement run");
    assert.equal(events.filter(e => e.event === "summary").length, 1);
    assert.ok(events.filter(e => e.event === "tool-end").every(e => !e.aborted));
    if (!scenario.final) assert.ok(events.findIndex(e => e.event === "summary") > events.findIndex(e => e.event === "tool-end" && e.name === "two"));
    const calls = events.filter(e => e.event === "model");
    assert.equal(calls.length, 2);
    const resumed = calls[1].messages;
    assert.ok(resumed.some(m => JSON.stringify(m.content).includes("Complete fixture work")), "compacted summary is applied before next request");
    assert.equal(resumed.filter(m => m.role === "toolResult").length, scenario.final ? 0 : 2);
    assert.equal(resumed.some(m => JSON.stringify(m.content).includes("Continue.")), scenario.final);
    const checkpoint = messages.find(m => m.type === "entry_appended" && m.entry?.customType === "agent-utils.compact-next-continue");
    if (scenario.final) assert.equal(checkpoint?.entry.display, scenario.resume === "continue");
    assert.equal(messages.some(m => m.type === "extension_error"), false);
    assert.equal(events.at(-1).aborted, false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
      await exited;
      clearTimeout(kill);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
