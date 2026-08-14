import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import readAloudExtension, {
  DEFAULT_READ_DELAY_MS,
  defaultReadConfig,
  resolveReadEnvValue,
  applyReadConfigValues,
  formatReadStatus,
  isReadControlText,
  createReadModeController,
  createReadAloudExtension,
} from "../extensions/read-aloud.js";
import {
  DEFAULT_TTS_VOICE,
  DEFAULT_TTS_SPEED,
  DEFAULT_TTS_EMBEDDING,
} from "../extensions/lib/tts.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeCtx(initial = "") {
  let text = initial;
  const notifications = [];
  const statuses = new Map();
  const terminal = [];
  return {
    ctx: {
      ui: {
        getEditorText: () => text,
        setEditorText: (value) => { text = String(value ?? ""); },
        notify: (message, level = "info") => notifications.push({ message, level }),
        setStatus: (key, value) => value === undefined ? statuses.delete(key) : statuses.set(key, value),
        onTerminalInput: (handler) => { terminal.push(handler); return () => terminal.splice(terminal.indexOf(handler), 1); },
      },
    },
    setText: (value) => { text = value; },
    getText: () => text,
    notifications,
    statuses,
    terminal,
  };
}

test("/read durable timing resolves env > agentUtils.read > defaults", () => {
  const persisted = defaultReadConfig({}, { speed: 1.4 }, { enabled: true, delayMs: 750, onDelay: false, onSend: false, speed: 1.6 });
  assert.equal(persisted.delay, 750);
  assert.equal(persisted.speed, 1.6, "read speed overrides shared tts speed");
  assert.equal(persisted.onDelay, false);
  assert.equal(persisted.onSend, false);
  const env = defaultReadConfig({ PI_READ_DELAY_MS: "900", PI_READ_ON_DELAY: "1" }, {}, { delayMs: 750, onDelay: false });
  assert.equal(env.delay, 900);
  assert.equal(env.onDelay, true);
});

test("/read defaults match the requested native Azure mode", () => {
  const config = defaultReadConfig({ PULSE_SERVER: "pulse.example:4713" });
  assert.equal(config.provider, "azure");
  assert.equal(config.voice, DEFAULT_TTS_VOICE);
  assert.equal(config.speed, DEFAULT_TTS_SPEED);
  assert.equal(config.embedding, DEFAULT_TTS_EMBEDDING);
  assert.equal(config.lang, "en-GB");
  assert.equal(config.delay, DEFAULT_READ_DELAY_MS);
  assert.equal(config.onDelay, true);
  assert.equal(config.onSend, true);
  assert.equal(config.backend, "pulse");
  assert.equal(config.server, "pulse.example:4713");
  assert.equal(config.device, "@DEFAULT_SINK@");
  assert.equal(config.streamName, "/read");
});

test("/read resolves exact env references without interpolating arbitrary text", () => {
  const env = { AZURE_SPEECH_ENDPOINT: "https://speech.example", AZURE_SPEECH_API_KEY: "secret" };
  assert.equal(resolveReadEnvValue("$AZURE_SPEECH_ENDPOINT", env), "https://speech.example");
  assert.equal(resolveReadEnvValue("${AZURE_SPEECH_API_KEY}", env), "secret");
  assert.equal(resolveReadEnvValue("prefix-$AZURE_SPEECH_ENDPOINT", env), "prefix-$AZURE_SPEECH_ENDPOINT");
  assert.throws(() => resolveReadEnvValue("$MISSING", env), /environment variable MISSING is not set/);
});

test("/read config supports style/styledegree, booleans, and =none unsets", () => {
  const env = {
    AZURE_SPEECH_ENDPOINT: "https://speech.example",
    AZURE_SPEECH_API_KEY: "secret-key",
    PULSE_SERVER: "pulse.example",
  };
  const configured = applyReadConfigValues(defaultReadConfig(env), {
    provider: "azure",
    lang: "en-GB",
    base_url: "$AZURE_SPEECH_ENDPOINT",
    api_key: "$AZURE_SPEECH_API_KEY",
    speed: "1.6",
    style: "hopeful",
    styledegree: "1.53",
    embedding: DEFAULT_TTS_EMBEDDING,
    voice: "MAI-Voice-2",
    delay: "25",
    on_delay: "false",
    on_send: "true",
  }, env);
  assert.equal(configured.endpoint, "https://speech.example");
  assert.equal(configured.apiKey, "secret-key");
  assert.equal(configured.speed, 1.6);
  assert.equal(configured.style, "hopeful");
  assert.equal(configured.styleDegree, 1.53);
  assert.equal(configured.delay, 25);
  assert.equal(configured.onDelay, false);
  assert.equal(configured.onSend, true);

  const unset = applyReadConfigValues(configured, {
    style: "none",
    styledegree: "none",
    speed: "none",
    embedding: "none",
  }, env);
  assert.equal(unset.style, null);
  assert.equal(unset.styleDegree, null);
  assert.equal(unset.speed, null);
  assert.equal(unset.embedding, null);
});

test("/read rejects unknown settings and unsupported providers", () => {
  const config = defaultReadConfig({});
  assert.throws(() => applyReadConfigValues(config, { typo: "x" }, {}), /unknown setting/);
  assert.throws(() => applyReadConfigValues(config, { provider: "openai" }, {}), /unsupported provider/);
  assert.throws(() => applyReadConfigValues(config, { styledegree: "2.1" }, {}), /between 0.01 and 2/);
});

test("status never exposes an API key", () => {
  const config = { ...defaultReadConfig({}), apiKey: "super-secret", endpoint: "https://speech.example" };
  const status = formatReadStatus(true, config, {});
  assert.match(status, /api-key:override/);
  assert.doesNotMatch(status, /super-secret/);
  assert.match(status, /stream:\/read/);
});

test("read control commands are never synthesized", () => {
  assert.equal(isReadControlText("/read off"), true);
  assert.equal(isReadControlText("  /READ status"), true);
  assert.equal(isReadControlText("read this"), false);
});

test("read mode speaks the full editor after debounce, each changed version, and again on send", async () => {
  const spoken = [];
  const played = [];
  let interrupts = 0;
  const synthesize = async (text, options) => {
    spoken.push({ text, options });
    return Buffer.alloc(480); // 10ms PCM, enough for half-duplex duration math
  };
  const player = {
    interrupt: () => { interrupts += 1; return true; },
    play: async (pcm, options) => { played.push({ pcm, options }); return { interrupted: false }; },
    dispose() {},
  };
  const harness = makeCtx("");
  const controller = createReadModeController({ env: { AZURE_SPEECH_ENDPOINT: "https://speech.example", AZURE_SPEECH_API_KEY: "secret" }, synthesize, player });
  controller.setConfig({ ...controller.getConfig(), delay: 10 });
  controller.enable(harness.ctx);

  controller.handleTerminalInput("x", harness.ctx);
  harness.setText("The quick brown");
  await sleep(30);
  assert.deepEqual(spoken.map((entry) => entry.text), ["The quick brown"]);

  controller.handleTerminalInput("x", harness.ctx);
  harness.setText("The quick brown fox jumped");
  await sleep(30);
  assert.deepEqual(spoken.map((entry) => entry.text), ["The quick brown", "The quick brown fox jumped"]);

  controller.handleSubmittedText("The quick brown fox jumped", harness.ctx);
  await sleep(5);
  assert.deepEqual(spoken.map((entry) => entry.text), [
    "The quick brown",
    "The quick brown fox jumped",
    "The quick brown fox jumped",
  ]);
  assert.equal(played.length, 3);
  assert.equal(played.at(-1).options.streamName, "/read");
  assert.ok(interrupts >= 3, "every new synthesis interrupts stale playback first");
});

test("send cancels a pending debounce so it speaks once, not again after delay", async () => {
  const spoken = [];
  const harness = makeCtx("");
  const controller = createReadModeController({
    env: {},
    synthesize: async (text) => { spoken.push(text); return Buffer.from([0, 0]); },
    player: { interrupt() {}, async play() {}, dispose() {} },
  });
  controller.setConfig({ ...controller.getConfig(), delay: 20 });
  controller.enable(harness.ctx);
  controller.handleTerminalInput("x", harness.ctx);
  harness.setText("send me");
  await sleep(2);
  controller.handleSubmittedText("send me", harness.ctx);
  await sleep(35);
  assert.deepEqual(spoken, ["send me"]);
});

test("a newer synthesis aborts the stale request and interrupts playback", async () => {
  const signals = [];
  let resolveFirst;
  const synthesize = (text, options) => {
    signals.push(options.signal);
    if (text === "first") return new Promise((resolve) => { resolveFirst = resolve; });
    return Promise.resolve(Buffer.from([0, 0]));
  };
  let interrupts = 0;
  const player = { interrupt: () => { interrupts += 1; }, async play() {}, dispose() {} };
  const harness = makeCtx("");
  const controller = createReadModeController({ env: {}, synthesize, player });
  const first = controller.speak("first", "manual", harness.ctx);
  await sleep(1);
  const second = controller.speak("second", "manual", harness.ctx);
  assert.equal(signals[0].aborted, true);
  resolveFirst(Buffer.from([0, 0]));
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.ok(interrupts >= 2);
});

test("/read command persists delay/speed/on-delay/on-send/enabled in agentUtils.read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "read-settings-"));
  const settingsPath = join(dir, "settings.json");
  const commands = new Map();
  const handlers = new Map();
  const pi = { registerCommand: (name, definition) => commands.set(name, definition), on: (event, handler) => handlers.set(event, handler) };
  const harness = makeCtx("");
  try {
    createReadAloudExtension({ persistedTts: {}, persistedRead: {}, settingsPath })(pi);
    handlers.get("session_start")({}, harness.ctx);
    await commands.get("read").handler("delay=123 speed=1.6 on_delay=false on_send=false", harness.ctx);
    let settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.deepEqual(settings.agentUtils.read, { delayMs: 123, speed: 1.6, onDelay: false, onSend: false, enabled: true });
    await commands.get("read").handler("off", harness.ctx);
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(settings.agentUtils.read.enabled, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("extension registers /read, attaches editor input, and exposes redacted status", async () => {
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerCommand: (name, definition) => commands.set(name, definition),
    on: (event, handler) => handlers.set(event, handler),
  };
  const harness = makeCtx("");
  createReadAloudExtension({ persistedTts: {}, persistedRead: {}, settingsPath: null })(pi);
  handlers.get("session_start")({ reason: "startup" }, harness.ctx);
  assert.ok(commands.has("read"));
  assert.match(commands.get("read").description, /Direct Azure editor-to-speech mode/);
  assert.equal(harness.terminal.length, 1);
  assert.equal(typeof handlers.get("input"), "function");

  const oldEndpoint = process.env.AZURE_SPEECH_ENDPOINT;
  const oldKey = process.env.AZURE_SPEECH_API_KEY;
  process.env.AZURE_SPEECH_ENDPOINT = "https://speech.example";
  process.env.AZURE_SPEECH_API_KEY = "secret-key";
  try {
    await commands.get("read").handler("provider=azure style=hopeful styledegree=1.53 delay=10", harness.ctx);
    assert.equal(pi.readAloud.isEnabled(), true);
    assert.match(harness.notifications.at(-1).message, /read:on/);
    assert.doesNotMatch(harness.notifications.at(-1).message, /secret-key/);
    await commands.get("read").handler("off", harness.ctx);
    assert.equal(pi.readAloud.isEnabled(), false);
  } finally {
    if (oldEndpoint === undefined) delete process.env.AZURE_SPEECH_ENDPOINT;
    else process.env.AZURE_SPEECH_ENDPOINT = oldEndpoint;
    if (oldKey === undefined) delete process.env.AZURE_SPEECH_API_KEY;
    else process.env.AZURE_SPEECH_API_KEY = oldKey;
  }
  handlers.get("session_shutdown")({ reason: "quit" }, harness.ctx);
  assert.equal(harness.terminal.length, 0);
});
