import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_NARRATION_MODEL,
  TOOL_SUMMARY_CUSTOM_TYPE,
  assistantPlainText,
  assistantToolCalls,
  buildNarrationRequest,
  createAgentSpeechController,
  normalizeNarrationText,
  redactNarrationText,
  resolveAgentTtsSettings,
  resolveNarrateSettings,
  resolveNarrationModel,
  sanitizeNarrationValue,
  toolResultText,
} from "../extensions/lib/tts-narration.js";
import {
  persistChoiceSetting,
  persistNarrateSetting,
  persistReadSetting,
  persistRingInputSetting,
  persistTtsSetting,
  readPersistedChoiceSettings,
  readPersistedNarrateSettings,
  readPersistedReadSettings,
  readPersistedRingInputSettings,
  readPersistedTtsSettings,
  resolveSpeakToolEnabled,
} from "../extensions/lib/tts-settings.js";
import { createTtsNarrationExtension } from "../extensions/tts-narration.js";

function harness({ runTextTurn, speech, settingsPath, persistedSettings = { tts: {}, narrate: {} } } = {}) {
  const commands = new Map();
  const handlers = new Map();
  const sent = [];
  const notifications = [];
  const renderers = new Map();
  const model = { provider: "github-copilot", id: "gpt-5.6-luna" };
  const ctx = {
    modelRegistry: {
      find(provider, id) { return provider === model.provider && id === model.id ? model : undefined; },
    },
    ui: { notify(message, level = "info") { notifications.push({ message, level }); } },
  };
  const pi = {
    registerCommand(name, def) { commands.set(name, def); },
    registerMessageRenderer(name, fn) { renderers.set(name, fn); },
    on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); },
    sendMessage(message, options) { sent.push({ message, options }); },
  };
  createTtsNarrationExtension({ runTextTurn, speech, env: {}, settingsPath, persistedSettings })(pi);
  const emit = (name, event) => { for (const fn of handlers.get(name) || []) fn(event, ctx); };
  return { pi, ctx, commands, handlers, sent, notifications, renderers, emit };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  return predicate();
}

test("assistant TTS extracts only plain text while tool batches retain parallel calls", () => {
  const message = {
    role: "assistant",
    timestamp: 1,
    content: [
      { type: "thinking", thinking: "private" },
      { type: "text", text: "I will inspect both." },
      { type: "toolCall", id: "a", name: "read", arguments: { path: "a", apiKey: "secret" } },
      { type: "toolCall", id: "b", name: "search", arguments: { query: "q" } },
    ],
  };
  assert.equal(assistantPlainText(message), "I will inspect both.");
  const calls = assistantToolCalls(message);
  assert.deepEqual(calls.map((call) => call.id), ["a", "b"]);
  assert.equal(calls[0].arguments.apiKey, "[REDACTED]");
});

test("narration helpers redact secrets, bound output, and force first-person one-line text", () => {
  assert.equal(redactNarrationText("Authorization: abc token=xyz Bearer top.secret"), "Authorization: [REDACTED] token=[REDACTED] Bearer [REDACTED]");
  assert.deepEqual(sanitizeNarrationValue({ password: "x", nested: { token: "y", ok: "z" } }), { password: "[REDACTED]", nested: { token: "[REDACTED]", ok: "z" } });
  assert.equal(toolResultText({ content: [{ type: "text", text: "api_key=hidden found 3 rows" }] }), "api_key=[REDACTED] found 3 rows");
  assert.equal(normalizeNarrationText("checking the files", "before"), "I am checking the files.");
  assert.equal(normalizeNarrationText("three rows matched", "after"), "I found three rows matched.");
  const request = buildNarrationRequest({ phase: "before", calls: [{ name: "read", arguments: { path: "a" } }] });
  assert.match(request.systemPrompt, /exactly one short plain-text sentence/);
  assert.match(request.systemPrompt, /untrusted data/);
});

test("narration model resolves exact provider/id and refuses unavailable models", () => {
  const registry = { find: (provider, id) => provider === "github-copilot" && id === "gpt-5.6-luna" ? { provider, id } : undefined };
  assert.deepEqual(resolveNarrationModel(registry), { provider: "github-copilot", id: "gpt-5.6-luna" });
  assert.throws(() => resolveNarrationModel(registry, "gpt"), /provider\/id/);
  assert.throws(() => resolveNarrationModel(registry, "github-copilot/missing"), /not available/);
  assert.equal(DEFAULT_NARRATION_MODEL, "github-copilot/gpt-5.6-luna");
});

test("speak tool enablement resolves env > agentUtils.tts > default", () => {
  assert.equal(resolveSpeakToolEnabled({}, {}), true);
  assert.equal(resolveSpeakToolEnabled({}, { speakToolEnabled: false }), false);
  assert.equal(resolveSpeakToolEnabled({ PI_SPEAK_TOOL_ENABLED: "1" }, { speakToolEnabled: false }), true);
  assert.equal(resolveSpeakToolEnabled({ PI_SPEAK_TOOL_ENABLED: "0" }, { speakToolEnabled: true }), false);
});

test("durable TTS/narrate settings use env > persisted > defaults", () => {
  const tts = resolveAgentTtsSettings({
    persisted: { enabled: true, voice: "PersistedVoice", speed: 1.25, device: "persisted-sink" },
    env: { PI_TTS_VOICE: "EnvVoice", PULSE_SINK: "env-sink", PI_TTS_ENABLED: "0" },
  });
  assert.equal(tts.enabled, false);
  assert.equal(tts.enabledSource, "env");
  assert.equal(tts.config.voice, "EnvVoice");
  assert.equal(tts.config.speed, 1.25);
  assert.equal(tts.config.device, "env-sink");
  assert.equal(tts.config.apiKey, undefined, "API keys are never part of persisted resolution");

  const narrate = resolveNarrateSettings({
    persisted: { enabled: true, model: "github-copilot/persisted", speed: 2 },
    env: { PI_NARRATE_MODEL: "github-copilot/env" },
  });
  assert.equal(narrate.enabled, true);
  assert.equal(narrate.enabledSource, "settings");
  assert.equal(narrate.model, "github-copilot/env");
  assert.equal(narrate.modelSource, "env");
  assert.equal(narrate.speed, 2);
  assert.equal(narrate.speedSource, "settings");
});

test("settings read/write is scoped, rejects secret fields, and tolerates malformed input", () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-settings-"));
  const path = join(dir, "settings.json");
  try {
    writeFileSync(path, JSON.stringify({ untouched: { keep: true }, agentUtils: { other: { x: 1 } } }, null, 2));
    assert.equal(persistTtsSetting("voice", "MAI-Voice-2", path), true);
    assert.equal(persistTtsSetting("apiKey", "must-not-write", path), false);
    assert.equal(persistNarrateSetting("enabled", true, path), true);
    assert.equal(persistNarrateSetting("model", DEFAULT_NARRATION_MODEL, path), true);
    assert.equal(persistReadSetting("delayMs", 2000, path), true);
    assert.equal(persistChoiceSetting("timeoutMs", 30000, path), true);
    assert.equal(persistRingInputSetting("selectEvents", ["EVENT_RING_SELECT"], path), true);
    const all = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(all.untouched, { keep: true });
    assert.deepEqual(all.agentUtils.other, { x: 1 });
    assert.equal(all.agentUtils.tts.voice, "MAI-Voice-2");
    assert.equal(all.agentUtils.tts.apiKey, undefined);
    assert.deepEqual(readPersistedTtsSettings(path), { voice: "MAI-Voice-2" });
    assert.deepEqual(readPersistedNarrateSettings(path), { enabled: true, model: DEFAULT_NARRATION_MODEL });
    assert.deepEqual(readPersistedReadSettings(path), { delayMs: 2000 });
    assert.deepEqual(readPersistedChoiceSettings(path), { timeoutMs: 30000 });
    assert.deepEqual(readPersistedRingInputSettings(path), { selectEvents: ["EVENT_RING_SELECT"] });

    writeFileSync(path, "not json");
    assert.deepEqual(readPersistedTtsSettings(path), {});
    assert.deepEqual(readPersistedNarrateSettings(path), {});
    assert.deepEqual(readPersistedReadSettings(path), {});
    assert.deepEqual(readPersistedChoiceSettings(path), {});
    assert.deepEqual(readPersistedRingInputSettings(path), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings persistence writes through Home Manager-style symlinks without replacing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-settings-link-"));
  const target = join(dir, "source.json");
  const link = join(dir, "settings.json");
  try {
    writeFileSync(target, JSON.stringify({ agentUtils: {} }, null, 2));
    symlinkSync(target, link);
    assert.equal(persistTtsSetting("enabled", true, link), true);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readlinkSync(link), target);
    assert.equal(JSON.parse(readFileSync(target, "utf8")).agentUtils.tts.enabled, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit /tts and /narrate setters persist only non-secret runtime values", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tts-command-settings-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ unrelated: 7 }, null, 2));
  const config = { provider: "azure", voice: "Default", lang: "en-GB", speed: 2, embedding: "embed", style: null, styleDegree: null, endpoint: undefined, apiKey: undefined, backend: "pulse", server: undefined, device: "sink" };
  const speech = {
    getConfig: () => ({ ...config }),
    apply(values) {
      if (values.voice) config.voice = values.voice;
      if (values.speed) config.speed = Number(values.speed);
      if (values.api_key) config.apiKey = values.api_key;
      return { ...config };
    },
    interrupt() {}, dispose() {}, async speak() {},
  };
  try {
    const h = harness({ speech, runTextTurn: async () => ({ text: "" }), settingsPath: path, persistedSettings: undefined });
    await h.commands.get("tts").handler("voice=SavedVoice speed=1.6 api_key=temporary", h.ctx);
    await h.commands.get("narrate").handler(`enabled=true model=${DEFAULT_NARRATION_MODEL} speed=2`, h.ctx);
    const all = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(all.unrelated, 7);
    assert.equal(all.agentUtils.tts.enabled, true);
    assert.equal(all.agentUtils.tts.voice, "SavedVoice");
    assert.equal(all.agentUtils.tts.speed, 1.6);
    assert.equal(all.agentUtils.tts.apiKey, undefined, "runtime API key is never persisted");
    assert.equal(all.agentUtils.narrate.enabled, true);
    assert.equal(all.agentUtils.narrate.model, DEFAULT_NARRATION_MODEL);
    assert.equal(all.agentUtils.narrate.speed, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared /tts speech controller inherits /read defaults and interrupts stale synthesis/playback", async () => {
  const synthCalls = [];
  const synthesize = (text, options) => new Promise((resolve, reject) => {
    const call = { text, options, resolve, reject };
    synthCalls.push(call);
    options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    if (text === "second" || text === "override") resolve(Buffer.from(text));
  });
  const player = {
    interrupts: 0,
    plays: [],
    interrupt() { this.interrupts += 1; },
    async play(pcm, options) { this.plays.push({ text: String(pcm), options }); return { interrupted: false }; },
    isPlaying() { return false; },
  };
  const speech = createAgentSpeechController({ env: { PULSE_SINK: "hw_output" }, synthesize, player });
  assert.equal(speech.getConfig().voice, "MAI-Voice-2");
  assert.equal(speech.getConfig().speed, 2);
  const first = speech.speak("first");
  const second = speech.speak("second");
  assert.deepEqual(await first, { interrupted: true });
  await second;
  assert.equal(player.plays.length, 1);
  assert.equal(player.plays[0].text, "second");
  assert.equal(player.plays[0].options.streamName, "/tts");
  assert.equal(player.plays[0].options.device, "hw_output");
  speech.apply({ voice: "AnotherVoice", speed: "1.5" });
  assert.equal(speech.getConfig().voice, "AnotherVoice");
  assert.equal(speech.getConfig().speed, 1.5);
  await speech.speak("override", { speed: 2 });
  assert.equal(synthCalls.at(-1).options.speed, 2, "per-call narration speed overrides shared tts speed");
  assert.equal(speech.getConfig().speed, 1.5, "override does not mutate shared /tts config");
  assert.throws(() => speech.apply({ delay: "10" }), /belongs to \/read/);
});

test("persisted enabled modes are active immediately at extension startup", async () => {
  const spoken = [];
  const speech = {
    getConfig: () => ({ provider: "azure", voice: "MAI-Voice-2", lang: "en-GB", speed: 2, embedding: "set", style: null, styleDegree: null, backend: "pulse", device: "hw_output" }),
    apply() {}, interrupt() {}, dispose() {}, async speak(text) { spoken.push(text); },
  };
  const runTextTurn = async (_ctx, request) => ({
    text: request.systemPrompt.includes("Begin with 'I am'") ? "I am checking." : "I found it healthy.",
    model: DEFAULT_NARRATION_MODEL,
  });
  const h = harness({ speech, runTextTurn, persistedSettings: { tts: { enabled: true }, narrate: { enabled: true, model: DEFAULT_NARRATION_MODEL } } });
  h.emit("message_end", { message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "Auto spoken." }] } });
  await waitFor(() => spoken.includes("Auto spoken."));
  h.emit("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }] } });
  h.emit("tool_execution_end", { toolCallId: "a", toolName: "read", result: { content: [{ type: "text", text: "healthy" }] } });
  await waitFor(() => h.sent.length === 2);
  assert.deepEqual(h.sent.map((entry) => entry.message.content), [
    "[tool summary][before] I am checking.",
    "[tool summary][after] I found it healthy.",
  ]);
});

test("/tts speaks every plain assistant message verbatim without a speak tool call", async () => {
  const spoken = [];
  const speech = {
    getConfig: () => ({ provider: "azure", voice: "MAI-Voice-2", lang: "en-GB", speed: 2, embedding: "set", style: null, styleDegree: null, backend: "pulse", device: "hw_output" }),
    apply() {}, interrupt() {}, dispose() {},
    async speak(text) { spoken.push(text); },
  };
  const h = harness({ speech, runTextTurn: async () => ({ text: "", model: DEFAULT_NARRATION_MODEL }) });
  await h.commands.get("tts").handler("on", h.ctx);
  h.emit("message_end", { message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "Exact plain response." }, { type: "thinking", thinking: "not spoken" }] } });
  await waitFor(() => spoken.length === 1);
  assert.deepEqual(spoken, ["Exact plain response."]);
  // Same finalized message re-emission is deduplicated.
  h.emit("message_end", { message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "Exact plain response." }] } });
  await Promise.resolve();
  assert.equal(spoken.length, 1);
});

test("/narrate batches parallel tools into one pre/post summary, speaks both, and injects no-trigger next-turn context", async () => {
  const spoken = [];
  const spokenOverrides = [];
  const speech = {
    getConfig: () => ({ provider: "azure", voice: "MAI-Voice-2", lang: "en-GB", speed: 1.4, embedding: "set", style: null, styleDegree: null, backend: "pulse", device: "hw_output" }),
    apply() {}, interrupt() {}, dispose() {},
    async speak(text, overrides) { spoken.push(text); spokenOverrides.push(overrides); },
  };
  const inference = [];
  const runTextTurn = async (_ctx, request) => {
    inference.push(request);
    const before = request.systemPrompt.includes("Begin with 'I am'");
    return { text: before ? "I am checking both sources." : "I found two matching records.", model: DEFAULT_NARRATION_MODEL };
  };
  const h = harness({ speech, runTextTurn, persistedSettings: { tts: { speed: 1.4 }, narrate: { speed: 2 } } });
  await h.commands.get("narrate").handler("on", h.ctx);
  h.emit("message_end", { message: { role: "assistant", content: [
    { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
    { type: "toolCall", id: "b", name: "search", arguments: { query: "b" } },
  ] } });
  h.emit("tool_execution_end", { toolCallId: "a", toolName: "read", result: { content: [{ type: "text", text: "one" }] }, isError: false });
  await Promise.resolve();
  assert.ok(h.sent.length <= 1, "post narration waits for every parallel sibling result");
  h.emit("tool_execution_end", { toolCallId: "b", toolName: "search", result: { content: [{ type: "text", text: "two" }] }, isError: false });
  await waitFor(() => h.sent.length === 2);

  assert.equal(inference.length, 2, "one inference before and one after the complete parallel batch");
  assert.deepEqual(h.sent.map((entry) => entry.message.content), [
    "[tool summary][before] I am checking both sources.",
    "[tool summary][after] I found two matching records.",
  ]);
  for (const entry of h.sent) {
    assert.equal(entry.message.customType, TOOL_SUMMARY_CUSTOM_TYPE);
    assert.deepEqual(entry.options, { deliverAs: "nextTurn", triggerTurn: false });
  }
  assert.deepEqual(spoken, ["I am checking both sources.", "I found two matching records."]);
  assert.deepEqual(spokenOverrides, [{ speed: 2 }, { speed: 2 }], "narration overrides shared tts speed per call");
});

test("a newer final assistant message aborts stale narration and its verbatim /tts wins", async () => {
  const spoken = [];
  const speech = {
    getConfig: () => ({ provider: "azure", voice: "v", lang: "en", speed: 1, embedding: null, style: null, styleDegree: null, backend: "pulse", device: "d" }),
    apply() {}, interrupt() {}, dispose() {}, async speak(text) { spoken.push(text); },
  };
  let narrationSignal;
  const runTextTurn = async (_ctx, request) => new Promise((resolve, reject) => {
    narrationSignal = request.signal;
    request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  const h = harness({ speech, runTextTurn });
  await h.commands.get("tts").handler("on", h.ctx);
  await h.commands.get("narrate").handler("on", h.ctx);
  h.emit("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }] } });
  await waitFor(() => !!narrationSignal);
  h.emit("message_end", { message: { role: "assistant", timestamp: 9, content: [{ type: "text", text: "Final answer wins." }] } });
  await waitFor(() => narrationSignal.aborted && spoken.includes("Final answer wins."));
  assert.equal(narrationSignal.aborted, true);
  assert.deepEqual(spoken, ["Final answer wins."]);
  assert.equal(h.sent.length, 0, "aborted stale narration injects no custom context");
});

test("narration failures are best-effort and never throw from tool/message hooks", async () => {
  const speech = {
    getConfig: () => ({ provider: "azure", voice: "v", lang: "en", speed: 1, embedding: null, style: null, styleDegree: null, backend: "pulse", device: "d" }),
    apply() {}, interrupt() {}, dispose() {}, async speak() {},
  };
  const h = harness({ speech, runTextTurn: async () => { throw new Error("model down"); } });
  await h.commands.get("narrate").handler("on", h.ctx);
  assert.doesNotThrow(() => h.emit("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }] } }));
  h.emit("tool_execution_end", { toolCallId: "a", toolName: "read", result: {}, isError: false });
  await waitFor(() => h.notifications.some((entry) => /model down/.test(entry.message)));
  assert.equal(h.sent.length, 0);
});
