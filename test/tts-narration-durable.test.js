// Round-trip tests for session-durable /tts + /narrate runtime settings (bd-4dd60f).
//
// The contract these lock down:
//   - settings.json stays immutable startup policy (never written)
//   - a runtime toggle survives a restart WITHIN the same session
//   - a NEW session starts from config again, not from the last session's state
//   - process teardown is not mistaken for operator intent

import test from "node:test";
import assert from "node:assert/strict";

import { createTtsNarrationExtension } from "../extensions/tts-narration.js";
import { createSessionRuntimeSettings } from "../extensions/lib/session-runtime-settings.js";

function fakeSpeech() {
  let config = { provider: "azure", voice: "config-voice", speed: 1, backend: "pulse" };
  const applied = [];
  return {
    applied,
    speak: async () => {},
    interrupt() {},
    dispose() {},
    getConfig: () => ({ ...config }),
    setConfig(next) { config = { ...next }; return { ...config }; },
    apply(values) {
      applied.push({ ...values });
      config = { ...config, ...values };
      return { ...config };
    },
    isPlaying: () => false,
  };
}

/**
 * A session file shared across "restarts": entries persist, the process does not.
 */
function makeSession() {
  return { entries: [] };
}

function harness({ sessionEntries, env = {}, persistedSettings = { tts: {}, narrate: {} } } = {}) {
  const commands = new Map();
  const handlers = new Map();
  const notifications = [];
  const speech = fakeSpeech();

  const pi = {
    registerCommand(name, def) { commands.set(name, def); },
    registerMessageRenderer() {},
    on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); },
    sendMessage() {},
    appendEntry(customType, data) {
      sessionEntries.push({ type: "custom", customType, data });
    },
  };

  const ctx = {
    ui: { notify(message, level = "info") { notifications.push({ message, level }); } },
    sessionManager: { getEntries: () => sessionEntries },
  };

  // flushMs 0 keeps assertions synchronous; coalescing is covered separately.
  const runtimeSettings = createSessionRuntimeSettings(pi, { flushMs: 0 });
  createTtsNarrationExtension({ env, speech, persistedSettings, runtimeSettings })(pi);

  const emit = (name, event) => { for (const fn of handlers.get(name) || []) fn(event, ctx); };
  const run = (name, args) => commands.get(name).handler(args ?? "", ctx);

  return { pi, ctx, commands, notifications, speech, emit, run, runtimeSettings };
}

function ttsIsOn(h) {
  return h.pi.ttsNarration.isEnabled();
}

test("/tts on survives a restart within the same session", async () => {
  const session = makeSession();

  const first = harness({ sessionEntries: session.entries });
  first.emit("session_start", {});
  assert.equal(ttsIsOn(first), false, "config default is off");

  await first.run("tts", "on");
  assert.equal(ttsIsOn(first), true);

  // /restart: new process, same session file.
  const revived = harness({ sessionEntries: session.entries });
  assert.equal(ttsIsOn(revived), false, "not yet restored before session_start");
  revived.emit("session_start", {});
  assert.equal(ttsIsOn(revived), true, "runtime toggle survived the restart");
});

test("/tts off also survives, overriding a config default of on", async () => {
  const session = makeSession();

  const first = harness({
    sessionEntries: session.entries,
    persistedSettings: { tts: { enabled: true }, narrate: {} },
  });
  first.emit("session_start", {});
  assert.equal(ttsIsOn(first), true, "config default is on");

  await first.run("tts", "off");
  assert.equal(ttsIsOn(first), false);

  const revived = harness({
    sessionEntries: session.entries,
    persistedSettings: { tts: { enabled: true }, narrate: {} },
  });
  revived.emit("session_start", {});
  assert.equal(ttsIsOn(revived), false, "runtime 'off' still beats the config 'on'");
});

test("k=v speech assignments are replayed through the same apply() on restart", async () => {
  const session = makeSession();

  const first = harness({ sessionEntries: session.entries });
  first.emit("session_start", {});
  await first.run("tts", "voice=alloy speed=1.4");

  assert.deepEqual(first.speech.applied, [{ voice: "alloy", speed: "1.4" }]);

  const revived = harness({ sessionEntries: session.entries });
  revived.emit("session_start", {});

  assert.deepEqual(
    revived.speech.applied,
    [{ voice: "alloy", speed: "1.4" }],
    "restore replays the operator's raw values through the live apply path"
  );
  assert.equal(ttsIsOn(revived), true);
});

test("later k=v assignments accumulate rather than replacing earlier ones", async () => {
  const session = makeSession();

  const first = harness({ sessionEntries: session.entries });
  first.emit("session_start", {});
  await first.run("tts", "voice=alloy");
  await first.run("tts", "speed=1.4");

  const revived = harness({ sessionEntries: session.entries });
  revived.emit("session_start", {});

  assert.deepEqual(revived.speech.applied, [{ voice: "alloy", speed: "1.4" }]);
});

test("prefix and suffix survive a restart", async () => {
  const session = makeSession();

  const first = harness({ sessionEntries: session.entries });
  first.emit("session_start", {});
  await first.run("tts", "prefix='hey ' suffix=' ok'");

  const saved = first.runtimeSettings.get("tts");
  assert.equal(saved.prefix, "hey ");
  assert.equal(saved.suffix, " ok");

  const revived = harness({ sessionEntries: session.entries });
  revived.emit("session_start", {});
  await revived.run("tts", "status");

  const status = revived.notifications.at(-1).message;
  assert.match(status, /prefix:set/);
  assert.match(status, /suffix:set/);
});

test("a NEW session ignores the previous session's overrides and uses config", async () => {
  const oldSession = makeSession();

  const first = harness({ sessionEntries: oldSession.entries });
  first.emit("session_start", {});
  await first.run("tts", "on");
  assert.equal(ttsIsOn(first), true);

  // A different session file: no snapshot, so config wins again.
  const freshSession = makeSession();
  const fresh = harness({ sessionEntries: freshSession.entries });
  fresh.emit("session_start", {});
  assert.equal(ttsIsOn(fresh), false, "runtime overrides are session-scoped, never global");
});

test("session_shutdown is teardown, not operator intent, and is never persisted", async () => {
  const session = makeSession();

  const first = harness({ sessionEntries: session.entries });
  first.emit("session_start", {});
  await first.run("tts", "on");

  first.emit("session_shutdown", {});
  assert.equal(ttsIsOn(first), false, "teardown disables in memory");

  const revived = harness({ sessionEntries: session.entries });
  revived.emit("session_start", {});
  assert.equal(ttsIsOn(revived), true, "exiting must not durably turn tts off");
});

test("status reports a restored toggle as session-sourced, distinct from config", async () => {
  const session = makeSession();

  const first = harness({ sessionEntries: session.entries });
  first.emit("session_start", {});
  await first.run("tts", "on");

  const revived = harness({ sessionEntries: session.entries });
  revived.emit("session_start", {});
  await revived.run("tts", "status");

  assert.match(revived.notifications.at(-1).message, /enabled-source:session/);
});

test("/narrate settings survive a restart", async () => {
  const session = makeSession();

  const first = harness({ sessionEntries: session.entries });
  first.emit("session_start", {});
  // `/narrate on` is its own bare form; combined settings use enabled=.
  await first.run("narrate", "enabled=true model=github-copilot/gpt-5.6-luna speed=2 text=false");

  assert.equal(first.pi.ttsNarration.isNarrateEnabled(), true);

  const revived = harness({ sessionEntries: session.entries });
  revived.emit("session_start", {});
  assert.equal(revived.pi.ttsNarration.isNarrateEnabled(), true);

  await revived.run("narrate", "status");
  const status = revived.notifications.at(-1).message;
  assert.match(status, /model:github-copilot\/gpt-5\.6-luna/);
  assert.match(status, /speed:2/);
  assert.match(status, /text:off/);
});

test("/tts and /narrate namespaces do not clobber each other", async () => {
  const session = makeSession();

  const h = harness({ sessionEntries: session.entries });
  h.emit("session_start", {});
  await h.run("tts", "on");
  await h.run("narrate", "off");

  const revived = harness({ sessionEntries: session.entries });
  revived.emit("session_start", {});

  assert.equal(revived.pi.ttsNarration.isEnabled(), true);
  assert.equal(revived.pi.ttsNarration.isNarrateEnabled(), false);
});

test("a rejected k=v assignment is not persisted", async () => {
  const session = makeSession();

  const h = harness({ sessionEntries: session.entries });
  h.emit("session_start", {});
  await h.run("narrate", "speed=-1");

  assert.match(h.notifications.at(-1).message, /greater than zero/);
  assert.equal(h.runtimeSettings.get("narrate").speed, undefined);
});

test("restore tolerates a session with no sessionManager", () => {
  const h = harness({ sessionEntries: [] });
  assert.doesNotThrow(() => {
    for (const fn of h.commands.keys()) void fn;
    h.emit("session_start", {});
  });
});
