// Host-neutral agent audio core for Durable hosts such as pi-daemon (bd-832b7a).
//
// This module owns /tts, /narrate and choice-audio behaviour for a host that
// delivers read-only agent events and per-session durable JSON state. It never
// imports Pi TUI APIs: the TUI extension (extensions/tts-narration.js and
// extensions/choice.js) and the Durable adaptor (extensions/durable/tts.mjs) are
// thin adaptors over the same speech, routing and provider libraries.
//
// Host contract (pi-daemon extension modules):
//   commands.<name>.run(args, ctx)  ctx: { sessionId, conversationId?, notify(text), state? }
//   observe(event, ctx)             ctx: { sessionId, conversationId, state? }
//   state: { get(key) -> Promise<json|undefined>, set(key, json) -> Promise }
// When a host does not provide `state` yet, an in-process map stands in so the
// commands still work; such settings last until the worker restarts.
//
// Playback is tied to agent events on the host where the session runs. It is
// never tied to whether a client is attached.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { parseEnvStyleArgs, expandEnvReferences } from "./env-args.js";
import {
  applyAgentTtsConfig,
  assistantPlainText,
  assistantReasoningSummary,
  assistantToolCalls,
  buildNarrationRequest,
  createAgentSpeechController,
  normalizeNarrationText,
  resolveAgentTtsSettings,
  resolveNarrateSettings,
  resolveNarrationModel,
  toolResultText,
} from "./tts-narration.js";
import { runPiTextTurn } from "./pi-inference.js";
import { createChoiceSpeaker, formatChoiceIntroduction } from "./choice.js";
import { resolveSessionSpeechAssignment, resolveSessionSpeechPolicy } from "./tts-identity.js";
import { DEFAULT_TTS_EMBEDDING, DEFAULT_TTS_VOICE, isAzureSpeechProvider, usesDaemonPlayback, createInterruptiblePcmPlayer } from "./tts.js";
import { speechCredentialStatus } from "./tts-provider-config.js";
import { createSpeechOutputRouting, speechRoutingStatus } from "./speech-output-routing.js";
import { createAudioProviders, rejectSurfaceAuthKeys } from "./audio-providers.js";
import { appendTtsFeed } from "./tts-feed.js";
import { ttsFeedEnabled } from "./privacy.js";
import { artifactIdentity } from "./artifact-state.js";

export const DURABLE_AUDIO_SETTINGS_KEY = "settings";
export const DURABLE_AUDIO_LEDGER_KEY = "spoken";
export const DURABLE_AUDIO_LEDGER_LIMIT = 256;
/** Ledger keys longer than this are stored as a prefix and a hash. */
const MAX_LEDGER_KEY_CHARS = 64;

/**
 * The key a once-only speech claim is stored under. A tool call's id can be hundreds of
 * characters (Copilot's carry an opaque suffix), and the ledger is written whole on each claim:
 * 256 such keys made each write about 115 KB.
 */
export function ledgerKey(key) {
  const text = String(key);
  if (text.length <= MAX_LEDGER_KEY_CHARS) return text;
  return `${text.slice(0, 32)}~${createHash("sha256").update(text).digest("base64url").slice(0, 22)}`;
}

/** The spoken ledger: a Set whose keys are stored short (ledgerKey), however they are asked. */
export class SpokenLedger extends Set {
  add(key) { return super.add(ledgerKey(key)); }
  has(key) { return super.has(ledgerKey(key)); }
  delete(key) { return super.delete(ledgerKey(key)); }
}
export const DURABLE_AUDIO_MAX_SESSIONS = 64;
export const DEFAULT_DURABLE_REPLAY_GRACE_MS = 60_000;
export const ASK_USER_TOOL = "ask_user";
export const NARRATE_PHASES = Object.freeze(["before", "after", "both"]);

const SECRET_KEY = /api_?key|token$|secret|password/i;
const ENV_REFERENCE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
const PROVIDER_SPECIFIC_KEYS = ["voice", "model", "lang", "speed", "embedding", "speaker", "speakerprofileid", "speaker_profile_id", "style", "styledegree", "style_degree", "endpoint", "base_url", "baseurl", "api_key", "apikey", "instructions", "pitch", "volume", "role"];
const NARRATE_SPEECH_KEYS = new Set(["provider", "voice", "tts_model", "daemon_url", "daemon_provider", "daemon_sink", "token_file", "playback", "endpoint", "base_url", "lang", "embedding", "instructions", "role", "pitch", "volume", "timeout_ms", "pan", "interrupt", "auth", "az", "resource", "tenant", "subscription", "resource_id"]);
const NARRATE_OWN_KEYS = new Set(["enabled", "on", "model", "phases", "phase", "mode", "speed", "style", "styledegree", "style_degree", "reasoning", "reasoning_summaries", "reasoningsummaries", "prefix", "suffix"]);

function boolValue(value, name) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be on or off`);
}

function optionalBool(value, fallback) {
  try { return value == null || String(value).trim() === "" ? fallback : boolValue(value, "value"); }
  catch { return fallback; }
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const SESSION_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** String variables from a host's per-session environment source. */
function sessionEnvValues(value) {
  return Object.fromEntries(Object.entries(plainObject(value)).filter(([key, entry]) => SESSION_ENV_NAME.test(key) && typeof entry === "string" && !entry.includes("\0")));
}

/** A stable identity for a session environment, without retaining another copy of its values. */
function sessionEnvKey(values) {
  const entries = Object.entries(values).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function persistedSlices(value = {}) {
  return { tts: plainObject(value.tts), narrate: plainObject(value.narrate), choice: plainObject(value.choice) };
}

function normalizePhases(value, name = "/narrate phases") {
  const phase = String(value ?? "").trim().toLowerCase();
  if (!NARRATE_PHASES.includes(phase)) throw new Error(`${name} must be before, after or both`);
  return phase;
}

function phaseEnabled(phases, phase) {
  return phases === "both" || phases === phase;
}

/** Keep only environment references for secrets; literal keys never become durable. */
export function durableSpeechValues(values = {}) {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => !SECRET_KEY.test(key) || ENV_REFERENCE.test(String(value))));
}

/** Short, deterministic spoken description of a tool batch. Never reads arguments aloud. */
export function describeToolBatch(names = [], phase = "before", { failed = [] } = {}) {
  const unique = [...new Set(names.map((name) => String(name || "tool").replace(/[_-]+/g, " ").trim()).filter(Boolean))];
  if (!unique.length) return "";
  const list = unique.length <= 3
    ? unique.length === 1 ? unique[0] : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`
    : `${unique.slice(0, 2).join(", ")} and ${unique.length - 2} more tools`;
  if (phase === "before") return `Running ${list}.`;
  const failedNames = [...new Set(failed.map((name) => String(name || "tool").replace(/[_-]+/g, " ").trim()))];
  if (failedNames.length) return `${failedNames.length === 1 ? failedNames[0] : `${failedNames.length} tools`} failed.`;
  return `Finished ${list}.`;
}

/** The assistant message of a message_end event: Durable's `entry.model` or the coding agent's `message`. */
export function eventAssistantMessage(event) {
  if (event?.message?.role === "assistant") return event.message;
  const model = Array.isArray(event?.entry?.model) ? event.entry.model : [];
  for (let i = model.length - 1; i >= 0; i -= 1) if (model[i]?.role === "assistant") return model[i];
  return null;
}

/** A tool_execution_end's result content, for both event shapes (Durable's `entry.model`). */
export function eventToolResult(event) {
  if (event?.result !== undefined) return event.result;
  const model = Array.isArray(event?.entry?.model) ? event.entry.model : [];
  return model.find((message) => message?.role === "toolResult") ?? null;
}

/** Whether a tool_execution_end reported an error, for both event shapes. */
export function eventToolFailed(event) {
  if (event?.isError === true) return true;
  const model = Array.isArray(event?.entry?.model) ? event.entry.model : [];
  if (model.some((message) => message?.isError === true)) return true;
  // Durable omits the entry when the tool task faulted or was orphaned.
  return event?.type === "tool_execution_end" && "entry" in (event || {}) && event.entry == null;
}

function textHash(text) {
  let hash = 0;
  for (const ch of String(text)) hash = (Math.imul(hash, 31) + ch.codePointAt(0)) | 0;
  return (hash >>> 0).toString(36);
}

function messageKey(event, message, text) {
  return String(event?.entry?.id ?? message?.responseId ?? `${message?.timestamp ?? ""}:${textHash(text)}`);
}

function askUserIntroduction(args = {}) {
  const question = String(args?.question ?? "").trim();
  const choices = Array.isArray(args?.choices) ? args.choices.map((choice) => String(choice ?? "").trim()).filter(Boolean) : [];
  if (choices.length >= 2) {
    try { return formatChoiceIntroduction(question, choices, 0); } catch {}
  }
  return question;
}

/** Resolve an executable on PATH (or an absolute override) without spawning it. */
export function findExecutable(command, { env = process.env, overrides = {} } = {}) {
  const candidate = overrides[command] || command;
  const check = (path) => { try { accessSync(path, fsConstants.X_OK); return true; } catch { return false; } };
  if (isAbsolute(candidate)) return check(candidate) ? candidate : null;
  for (const dir of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    const full = join(dir, candidate);
    if (check(full)) return full;
  }
  return null;
}

function playbackCommand(config) {
  const backend = String(config.backend || "pulse").trim().toLowerCase();
  if (["pulse", "pulseaudio", "pacat", "paplay", "auto"].includes(backend)) return "pacat";
  if (["sox", "play"].includes(backend)) return "play";
  if (["coreaudio", "ffplay", "ffmpeg"].includes(backend)) return "ffplay";
  return null;
}

/** Problems that would stop speech on this host, as short phrases. Empty when ready. */
export function speechReadiness(config, { env = process.env, executables = {}, which = findExecutable } = {}) {
  const problems = [];
  let credentials = "";
  try { credentials = speechCredentialStatus(config, env); } catch (error) { credentials = `invalid (${error?.message || error})`; }
  if (/missing|invalid/.test(credentials)) problems.push(`credentials ${credentials}`);
  if (["command", "local"].includes(config.provider)) {
    if (!String(config.command || "").trim()) problems.push("provider=command has no command");
  } else if (!usesDaemonPlayback(config)) {
    const command = playbackCommand(config);
    if (command && !which(command, { env, overrides: executables })) problems.push(`playback needs ${command} on PATH`);
  }
  return problems;
}

/** A spawn that maps bare playback commands to packaged absolute paths. */
export function spawnWithExecutables(spawnImpl, executables = {}) {
  return (command, args, options) => spawnImpl(executables[command] || command, args, options);
}

function memoryStateStore(map, sessionId) {
  return {
    async get(key) { const value = map.get(`${sessionId}\0${key}`); return value === undefined ? undefined : JSON.parse(value); },
    async set(key, value) { map.set(`${sessionId}\0${key}`, JSON.stringify(value)); },
  };
}

/**
 * Create the agent audio core for one host process.
 *
 * Options are injection points for tests and adaptors:
 * - `createSpeech({ sessionId, config, env, routing })` returns a controller shaped like
 *   createAgentSpeechController (speak/interrupt/apply/getConfig/setConfig/dispose).
 * - `createChoiceSpeech({ sessionId, env, persisted, routing })` returns { speak, interrupt, dispose }.
 * - `createRouting({ sessionId, env })` returns a session's speech output routing
 *   (createSpeechOutputRouting): its /tts focus and /tts solo, overlaid on each utterance.
 * - `persistedSettings` is the immutable startup `{ tts, narrate, choice }` slice.
 * - `sessionEnv(ctx)` optionally returns a session's host-owned variables, such as
 *   pi-daemon `sessionEnvFiles`; they overlay `env` for that session only.
 * - `readPersistedSettings(env)` rereads settings special forms with that session environment.
 */
const ROUTING_MODES = ["focus", "solo"];

/** A session's saved routing: focus and solo, each on or off. */
function savedRouting(value) {
  const saved = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { focus: saved.focus === true, solo: saved.solo === true };
}

export function createDurableAgentAudio({
  env = process.env,
  persistedSettings = {},
  createSpeech,
  createChoiceSpeech,
  createRouting = ({ env: routingEnv = env } = {}) => createSpeechOutputRouting({ env: routingEnv }),
  executables = {},
  spawnImpl,
  which = findExecutable,
  now = Date.now,
  loadedAt = now(),
  replayGraceMs,
  memoryState = new Map(),
  maxSessions = DURABLE_AUDIO_MAX_SESSIONS,
  log = (line) => { try { process.stderr.write(`${line}\n`); } catch {} },
  appendFeed = appendTtsFeed,
  runTextTurn = runPiTextTurn,
  sessionEnv,
  readPersistedSettings,
} = {}) {
  const startupPersisted = persistedSlices(persistedSettings);
  const graceMs = Number.isFinite(Number(replayGraceMs ?? env.PI_DURABLE_AUDIO_REPLAY_GRACE_MS))
    ? Number(replayGraceMs ?? env.PI_DURABLE_AUDIO_REPLAY_GRACE_MS)
    : DEFAULT_DURABLE_REPLAY_GRACE_MS;
  const audioProviders = createAudioProviders({});
  const makePlayer = () => createInterruptiblePcmPlayer({ queue: true, ...(spawnImpl || Object.keys(executables).length ? { spawnImpl: spawnWithExecutables(spawnImpl || spawn, executables) } : {}) });
  // Each session routes its own speech (/tts focus, /tts solo): the worker's environment
  // (PULSE_SERVER, PULSE_SINK) is every session's default, and a session's routing overlays
  // the output of each of its utterances.
  const speechFactory = createSpeech || (({ config, routing, env: speechEnv = env }) => createAgentSpeechController({ env: speechEnv, initialConfig: config, routing, player: makePlayer() }));
  const choiceFactory = createChoiceSpeech || (({ routing, env: choiceEnv = env, persisted = startupPersisted }) => createChoiceSpeaker({ env: choiceEnv, persisted: plainObject(persisted.tts), routing, audioProviders, player: makePlayer() }));

  /** sessionId -> runtime record; bounded, least recently used first. */
  const sessions = new Map();
  const pending = new Set();
  let disposed = false;

  const sessionEnvironment = async (ctx) => {
    if (typeof sessionEnv !== "function") return { env, persisted: startupPersisted, key: "" };
    let overlay = {};
    try { overlay = sessionEnvValues(await sessionEnv(ctx)); }
    catch (error) { log(`agent-utils durable audio: session environment unavailable: ${error?.message || error}`); }
    return { overlay, key: sessionEnvKey(overlay) };
  };

  const persistedFor = (sessionEnvValue) => {
    if (typeof readPersistedSettings !== "function") return startupPersisted;
    try { return persistedSlices(readPersistedSettings(sessionEnvValue)); }
    catch (error) {
      log(`agent-utils durable audio: session settings unavailable: ${error?.message || error}`);
      return startupPersisted;
    }
  };

  const defaults = (sessionEnvValue, persisted) => {
    const tts = resolveAgentTtsSettings({ env: sessionEnvValue, persisted: persisted.tts, audioProviders });
    const narrate = resolveNarrateSettings({ env: sessionEnvValue, persisted: persisted.narrate });
    let phases = "before";
    try { phases = normalizePhases(sessionEnvValue.PI_NARRATE_PHASES ?? persisted.narrate.phases ?? "before", "PI_NARRATE_PHASES"); } catch {}
    return {
      config: tts.config,
      tts: { enabled: tts.enabled, prefix: tts.prefix, suffix: tts.suffix, choices: optionalBool(sessionEnvValue.PI_CHOICE_SPEECH_ENABLED, optionalBool(persisted.choice.speechEnabled, true)), speech: {} },
      narrate: { enabled: narrate.enabled, phases, model: narrate.model, speed: narrate.speed, style: narrate.style, styleDegree: narrate.styleDegree, reasoningSummaries: narrate.reasoningSummaries, prefix: narrate.prefix, suffix: narrate.suffix },
    };
  };

  const stateFor = (ctx) => {
    const store = ctx?.state;
    if (store && typeof store.get === "function" && typeof store.set === "function") return { store, durable: true };
    return { store: memoryStateStore(memoryState, String(ctx?.sessionId ?? "default")), durable: false };
  };

  const disposeEntry = (record) => {
    void Promise.resolve(record.loading).then((loaded) => {
      try { loaded?.speech?.dispose?.(); loaded?.choices?.dispose?.(); } catch {}
      void Promise.resolve(loaded?.routing?.shutdown?.()).catch(() => {});
    }).catch(() => {});
  };

  const evict = () => {
    while (sessions.size > maxSessions) {
      const [oldest, record] = sessions.entries().next().value;
      sessions.delete(oldest);
      disposeEntry(record);
    }
  };

  const loadSession = async (ctx, knownEnvironment) => {
    const sessionId = String(ctx?.sessionId ?? "default");
    const environment = knownEnvironment ?? await sessionEnvironment(ctx);
    let entry = sessions.get(sessionId);
    if (entry) {
      sessions.delete(sessionId);
      // A rewritten session environment changes that session's startup defaults and voice.
      if (entry.envKey !== environment.key) {
        disposeEntry(entry);
        return loadSession(ctx, environment);
      }
      sessions.set(sessionId, entry);
      const session = await entry.loading;
      // A host may begin passing durable state after the first event; prefer it.
      if (!session.durable && stateFor(ctx).durable) { sessions.delete(sessionId); return loadSession(ctx, environment); }
      if (typeof ctx?.cwd === "string" && ctx.cwd) session.cwd = ctx.cwd;
      return session;
    }
    entry = { envKey: environment.key, loading: (async () => {
      const { store, durable } = stateFor(ctx);
      const sessionEnvValue = environment.overlay ? { ...env, ...environment.overlay } : environment.env;
      const persisted = environment.overlay ? persistedFor(sessionEnvValue) : environment.persisted;
      const base = defaults(sessionEnvValue, persisted);
      let saved = {};
      let ledger = [];
      try { saved = plainObject(await store.get(DURABLE_AUDIO_SETTINGS_KEY)); } catch (error) { log(`agent-utils durable audio: state read failed: ${error?.message || error}`); }
      try { const value = await store.get(DURABLE_AUDIO_LEDGER_KEY); ledger = Array.isArray(value) ? value.map(String) : Array.isArray(value?.ids) ? value.ids.map(String) : []; } catch {}
      const tts = { ...base.tts, ...plainObject(saved.tts) };
      tts.speech = durableSpeechValues(plainObject(saved.tts?.speech));
      tts.routing = savedRouting(saved.tts?.routing);
      const narrate = { ...base.narrate, ...plainObject(saved.narrate) };
      if (!NARRATE_PHASES.includes(narrate.phases)) narrate.phases = base.narrate.phases;
      let config = base.config;
      try { if (Object.keys(tts.speech).length) config = applyAgentTtsConfig(config, tts.speech, sessionEnvValue); }
      catch (error) { log(`agent-utils durable audio: saved speech settings ignored: ${error?.message || error}`); }
      config = assignSessionVoice(config, sessionId, tts.speech, resolveSessionSpeechPolicy(persisted.tts, sessionEnvValue));
      const routing = createRouting({ sessionId, env: sessionEnvValue });
      const session = {
        sessionId,
        cwd: typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : undefined,
        env: sessionEnvValue,
        persisted,
        store,
        durable,
        tts,
        narrate,
        routing,
        speech: speechFactory({ sessionId, config, env: sessionEnvValue, routing }),
        choices: null,
        ledger: new SpokenLedger(ledger.slice(-DURABLE_AUDIO_LEDGER_LIMIT)),
        batches: new Map(),
        // Side completions narrating tool batches: a newer batch (or the final answer)
        // supersedes older ones, as in TUI narration.
        generation: 0,
        inflight: new Set(),
        lastError: null,
        reported: new Set(),
      };
      // The session's saved focus and solo, as before the worker restarted.
      for (const mode of ROUTING_MODES) {
        if (!tts.routing[mode]) continue;
        try { await routing.setMode(mode, true, routingOptions(session)); }
        catch (error) {
          session.lastError = `/tts ${mode}: ${error?.message || error}`;
          log(`agent-utils durable audio: /tts ${mode} not restored: ${error?.message || error}`);
        }
      }
      return session;
    })() };
    sessions.set(sessionId, entry);
    evict();
    try { return await entry.loading; }
    catch (error) { if (sessions.get(sessionId) === entry) sessions.delete(sessionId); throw error; }
  };

  const assignSessionVoice = (config, sessionId, speechValues, speechPolicy) => {
    const assignment = resolveSessionSpeechAssignment(sessionId, speechPolicy);
    const explicitVoice = ["voice", "embedding", "speaker", "speakerprofileid", "speaker_profile_id"].some((key) => Object.hasOwn(speechValues, key));
    return {
      ...config,
      // As TUI /tts: the session's pool voice over the configured default (settings or
      // PI_TTS_VOICE), so concurrent sessions sound apart; a voice chosen for the session wins.
      ...(isAzureSpeechProvider(config.provider) && assignment.voice && !explicitVoice ? { voice: assignment.voice, embedding: null } : {}),
      pan: config.pan !== undefined ? config.pan : assignment.pan,
      panSource: config.pan !== undefined ? config.panSource || "explicit" : "session",
    };
  };

  /** What a session's routing needs to switch focus or solo on. */
  const routingOptions = (session) => ({
    base: { ...(session.speech.getConfig?.() ?? {}), env: session.env },
    focus: plainObject(session.persisted.tts.focus),
    identity: { session: session.sessionId },
  });

  const saveSettings = async (session) => {
    await session.store.set(DURABLE_AUDIO_SETTINGS_KEY, {
      version: 1,
      tts: { ...session.tts, speech: durableSpeechValues(session.tts.speech) },
      narrate: Object.fromEntries(Object.entries(session.narrate).filter(([, value]) => value !== undefined)),
    });
  };

  /** Claim a once-only speech key. Persisted before speaking: at most once across restarts. */
  const claim = async (session, key) => {
    if (session.ledger.has(key)) return false;
    session.ledger.add(key);
    while (session.ledger.size > DURABLE_AUDIO_LEDGER_LIMIT) session.ledger.delete(session.ledger.values().next().value);
    try { await session.store.set(DURABLE_AUDIO_LEDGER_KEY, [...session.ledger]); }
    catch (error) { log(`agent-utils durable audio: ledger write failed: ${error?.message || error}`); }
    return true;
  };

  const report = (session, kind, error) => {
    const message = error?.message || String(error);
    session.lastError = { kind, message, at: now() };
    if (session.reported.has(kind)) return;
    session.reported.add(kind);
    log(`agent-utils durable audio (${session.sessionId}) ${kind}: ${message}`);
  };

  const track = (promise) => {
    const tracked = Promise.resolve(promise).finally(() => pending.delete(tracked));
    pending.add(tracked);
    return tracked;
  };

  /** sessionId -> speech requests queued or playing; voice input mutes while any are (bd-6ffaf9). */
  const speaking = new Map();
  const whileSpeaking = (session, promise) => {
    const id = session.sessionId;
    speaking.set(id, (speaking.get(id) ?? 0) + 1);
    return Promise.resolve(promise).finally(() => {
      const left = (speaking.get(id) ?? 1) - 1;
      if (left > 0) speaking.set(id, left); else speaking.delete(id);
    });
  };

  // The node's speech feed (~/.local/state/agent-utils/tts/speech.jsonl), as
  // interactive Pi writes it: `ag tts` and ag dash's TTS panel read it. One
  // record per spoken line, written whether or not playback succeeds.
  const recordFeed = (session, kind, text) => {
    if (!ttsFeedEnabled(session.env)) return;
    // Named as the session's media shares are (durable-media): a configured agent
    // name, else `pi-daemon-<directory>`, so ag shows one agent per session.
    const place = session.cwd ? basename(session.cwd) : "";
    const identity = artifactIdentity(null, {
      cwd: session.cwd,
      sessionManager: { getSessionId: () => session.sessionId, getSessionName: () => (place ? `pi-daemon-${place}` : undefined) },
    }, session.env);
    track(Promise.resolve()
      .then(() => appendFeed({ ...identity, text, kind }, { env: session.env }))
      .catch((error) => report(session, "tts feed", error)));
  };

  const speak = (session, kind, text, overrides = {}) => {
    const body = String(text ?? "");
    if (disposed || !body.trim()) return;
    recordFeed(session, kind === "tts" ? "tts" : "narrate", body);
    track(whileSpeaking(session, Promise.resolve()
      .then(() => session.speech.speak(body, { ...overrides, speechKind: kind, streamName: `/${kind}` })))
      .then((result) => { for (const warning of result?.warnings || []) report(session, `${kind} daemon`, new Error(warning)); })
      .catch((error) => report(session, kind, error)));
  };

  /**
   * A sentence about a tool batch from a side completion with the narration model, as TUI
   * narration makes (bd-06d998), when the host offers the profile's models (pi-daemon's
   * `info.modelRegistry`). Empty when it cannot, failed or was superseded: callers fall back.
   */
  const inferNarration = async (session, ctx, phase, calls, results = []) => {
    const registry = ctx?.modelRegistry;
    if (!registry || typeof registry.find !== "function" || typeof registry.complete !== "function") return "";
    let model;
    try { model = resolveNarrationModel(registry, session.narrate.model); }
    catch (error) { report(session, "narrate model", error); return ""; }
    const controller = new AbortController();
    session.inflight.add(controller);
    try {
      const request = buildNarrationRequest({ phase, calls, results });
      const response = await runTextTurn(ctx, { model, ...request, signal: controller.signal, abortedMessage: "narration superseded" });
      return controller.signal.aborted ? "" : normalizeNarrationText(response?.text, phase);
    } catch (error) {
      if (!controller.signal.aborted) report(session, "narrate inference", error);
      return "";
    } finally {
      session.inflight.delete(controller);
    }
  };

  const supersedeNarration = (session) => {
    session.generation += 1;
    for (const controller of session.inflight) { try { controller.abort(); } catch {} }
    session.inflight.clear();
  };

  const speakChoice = (session, text) => {
    if (disposed || !String(text || "").trim()) return;
    recordFeed(session, "choices", String(text));
    session.choices ||= choiceFactory({ sessionId: session.sessionId, env: session.env, persisted: session.persisted, routing: session.routing });
    try { session.choices.assignSession?.({ sessionManager: { getSessionId: () => session.sessionId } }); } catch {}
    track(whileSpeaking(session, Promise.resolve().then(() => session.choices.speak(text))).catch((error) => report(session, "choices", error)));
  };

  const narrateOverrides = (session) => ({
    ...(session.narrate.speed ? { speed: session.narrate.speed } : {}),
    ...(session.narrate.style ? { style: session.narrate.style } : {}),
    ...(session.narrate.styleDegree ? { styleDegree: session.narrate.styleDegree } : {}),
  });

  const affix = (prefix, text, suffix) => `${prefix || ""}${text}${suffix || ""}`;

  const stale = (message) => {
    const timestamp = Number(message?.timestamp);
    return graceMs >= 0 && Number.isFinite(timestamp) && timestamp > 0 && timestamp < loadedAt - graceMs;
  };

  const onMessageEnd = async (session, event, ctx) => {
    const message = eventAssistantMessage(event);
    if (!message) return;
    const calls = assistantToolCalls(message);
    const text = assistantPlainText(message);
    const key = messageKey(event, message, text);
    const narratedCalls = calls.filter((call) => call.name !== ASK_USER_TOOL);
    let batch;
    if (session.narrate.enabled && narratedCalls.length) {
      supersedeNarration(session);
      batch = { key, calls: narratedCalls, results: new Map(), generation: session.generation, before: null };
      for (const call of narratedCalls) session.batches.set(call.id, batch);
    } else if (session.narrate.enabled && text) {
      supersedeNarration(session); // the final answer wins over stale narration
    }
    const speakTts = session.tts.enabled && text && !(session.narrate.enabled && narratedCalls.length);
    const narrateBefore = session.narrate.enabled && narratedCalls.length && phaseEnabled(session.narrate.phases, "before");
    if (!speakTts && !narrateBefore) return;
    // Tool starts covered by this message's line are marked with the same write.
    if (narrateBefore) for (const call of narratedCalls) session.ledger.add(`start:${call.id}`);
    if (stale(message)) { await claim(session, `message:${key}`); return; }
    if (!await claim(session, `message:${key}`)) return;
    if (speakTts) speak(session, "tts", affix(session.tts.prefix, text, session.tts.suffix));
    if (narrateBefore) {
      // The main model's own words first (reasoning summary, preamble); else a side completion
      // describes the batch; the deterministic sentence only when that is unavailable.
      const reasoning = session.narrate.reasoningSummaries ? normalizeNarrationText(assistantReasoningSummary(message), "before") : "";
      const native = reasoning || normalizeNarrationText(text, "before");
      if (native) {
        speak(session, "narrate", affix(session.narrate.prefix, native, session.narrate.suffix), narrateOverrides(session));
        return;
      }
      const fallback = describeToolBatch(narratedCalls.map((call) => call.name), "before");
      const generation = session.generation;
      // Never awaited: the observer holds the session's event stream.
      const before = track(inferNarration(session, ctx, "before", narratedCalls).then((line) => {
        if (generation !== session.generation) return;
        speak(session, "narrate", affix(session.narrate.prefix, line || fallback, session.narrate.suffix), narrateOverrides(session));
      }));
      if (batch) batch.before = before;
    }
  };

  const onToolStart = async (session, event) => {
    const id = String(event?.toolCallId ?? "");
    const name = String(event?.toolName ?? "");
    if (name === ASK_USER_TOOL) {
      if (!session.tts.choices) return;
      const intro = askUserIntroduction(event?.args);
      if (!intro || !await claim(session, `ask:${id}`)) return;
      speakChoice(session, intro);
      return;
    }
    // A tool whose assistant message was coalesced away still gets a before line.
    if (!session.narrate.enabled || !phaseEnabled(session.narrate.phases, "before") || !id) return;
    if (session.batches.has(id) || session.ledger.has(`start:${id}`)) return;
    if (!await claim(session, `start:${id}`)) return;
    speak(session, "narrate", affix(session.narrate.prefix, describeToolBatch([name], "before"), session.narrate.suffix), narrateOverrides(session));
  };

  const onToolEnd = async (session, event, ctx) => {
    const id = String(event?.toolCallId ?? "");
    const batch = session.batches.get(id);
    if (!batch) return;
    const failed = eventToolFailed(event);
    batch.results.set(id, {
      name: String(event?.toolName ?? batch.calls.find((call) => call.id === id)?.name ?? "tool"),
      failed,
      isError: failed,
      text: toolResultText(eventToolResult(event)),
    });
    if (batch.results.size < batch.calls.length) return;
    for (const call of batch.calls) session.batches.delete(call.id);
    if (!session.narrate.enabled || !phaseEnabled(session.narrate.phases, "after")) return;
    if (!await claim(session, `after:${batch.key}`)) return;
    const results = [...batch.results.values()];
    const fallback = describeToolBatch(results.map((result) => result.name), "after", { failed: results.filter((result) => result.failed).map((result) => result.name) });
    const generation = batch.generation ?? session.generation;
    // After the batch's before line, a side completion summarizes the outcome; never awaited.
    track(Promise.resolve(batch.before).catch(() => {}).then(async () => {
      if (generation !== session.generation) return;
      const line = await inferNarration(session, ctx, "after", batch.calls, results);
      if (generation !== session.generation) return;
      speak(session, "narrate", affix(session.narrate.prefix, line || fallback, session.narrate.suffix), narrateOverrides(session));
    }));
  };

  async function observe(event, ctx = {}) {
    if (disposed || !event || typeof event !== "object") return;
    const type = event.type;
    if (!["message_end", "tool_execution_start", "tool_execution_end"].includes(type)) return;
    let session;
    try { session = await loadSession(ctx); } catch (error) { log(`agent-utils durable audio: session load failed: ${error?.message || error}`); return; }
    if (!session.tts.enabled && !session.narrate.enabled && !(type === "tool_execution_start" && event.toolName === ASK_USER_TOOL && session.tts.choices)) return;
    if (type === "message_end") return onMessageEnd(session, event, ctx);
    if (type === "tool_execution_start") return onToolStart(session, event);
    return onToolEnd(session, event, ctx);
  }

  const optional = (value) => value == null || value === "" ? "none" : String(value);

  const readinessNote = (session) => {
    const problems = speechReadiness(session.speech.getConfig(), { env: session.env, executables, which });
    return problems.length ? ` · warning: speech unavailable on this host (${problems.join("; ")}); events will be skipped quietly` : "";
  };

  const lastErrorNote = (session) => session.lastError ? ` · last-error:${session.lastError.kind}: ${session.lastError.message}` : "";
  const scopeNote = (session) => `scope:session${session.durable ? "" : " (in-memory: host has no durable state)"}`;

  const ttsStatus = (session, { check = false } = {}) => {
    const config = session.speech.getConfig();
    let credentials = "";
    try { credentials = speechCredentialStatus(config, session.env); } catch {}
    return [
      `tts:${session.tts.enabled ? "on" : "off"}`,
      `provider:${config.providerName && config.providerName !== config.provider ? `${config.providerName}(${config.provider})` : config.provider}`,
      `voice:${optional(config.voice)}`,
      `speed:${optional(config.speed)}`,
      `pan:${optional(config.pan == null ? null : Number(config.pan).toFixed(2))}`,
      credentials,
      `output:${usesDaemonPlayback(config) ? `daemon/${config.daemonSink || "server-default"}` : `${config.backend}/${optional(config.device)}`}`,
      `choices:${session.tts.choices ? "on" : "off"}`,
      `prefix:${session.tts.prefix ? "set" : "none"}`,
      `suffix:${session.tts.suffix ? "set" : "none"}`,
      scopeNote(session),
    ].filter(Boolean).join(" · ") + (check ? readinessNote(session) : "") + lastErrorNote(session);
  };

  const narrateStatus = (session, { check = false } = {}) => [
    `narrate:${session.narrate.enabled ? "on" : "off"}`,
    `phases:${session.narrate.phases}`,
    `model:${session.narrate.model || "default"}`,
    `speed:${session.narrate.speed ?? "tts"}`,
    `style:${session.narrate.style ?? "tts"}`,
    `styledegree:${session.narrate.styleDegree ?? "tts"}`,
    `reasoning-summaries:${session.narrate.reasoningSummaries ? "prefer" : "off"}`,
    `prefix:${session.narrate.prefix ? "set" : "none"}`,
    `suffix:${session.narrate.suffix ? "set" : "none"}`,
    "lines:agent preamble, else the narration model (when the host offers models), else tool names",
    scopeNote(session),
  ].join(" · ") + (check ? readinessNote(session) : "") + lastErrorNote(session);

  const reply = (ctx, text) => {
    try { ctx?.notify?.(text); } catch {}
    return text;
  };

  const applySpeechValues = (session, values, surface) => {
    if (!Object.keys(values).length) return;
    rejectSurfaceAuthKeys(values, surface, session.speech.getConfig());
    const before = session.speech.getConfig();
    session.speech.apply(values);
    const after = session.speech.getConfig();
    const providerOf = (config) => config.providerName || config.provider;
    if (providerOf(before) !== providerOf(after)) for (const key of PROVIDER_SPECIFIC_KEYS) delete session.tts.speech[key];
    session.tts.speech = durableSpeechValues({ ...session.tts.speech, ...values });
  };

  const useHarryVoice = (session) => {
    session.speech.setConfig({ ...session.speech.getConfig(), voice: DEFAULT_TTS_VOICE, embedding: DEFAULT_TTS_EMBEDDING });
    session.tts.speech = { ...session.tts.speech, voice: DEFAULT_TTS_VOICE, embedding: DEFAULT_TTS_EMBEDDING };
  };

  async function runTts(args, ctx = {}) {
    const session = await loadSession(ctx);
    const raw = String(args ?? "").trim();
    const simple = raw.toLowerCase();
    try {
      if (/^(focus|solo)(?:\s|$)/.test(simple)) {
        // This session's speech only: the focus sink, or a sink of its own.
        const [mode, action, ...extra] = simple.split(/\s+/);
        if (extra.length || (action && !["on", "off", "toggle", "status"].includes(action))) throw new Error(`Usage: /tts ${mode} [on|off|toggle|status]`);
        if (action === "status") return reply(ctx, speechRoutingStatus(session.routing.snapshot()));
        const state = await session.routing.setMode(mode, action === "on" ? true : action === "off" ? false : undefined, routingOptions(session));
        session.tts.routing = { focus: !!state.focus, solo: !!state.solo };
        await saveSettings(session);
        return reply(ctx, speechRoutingStatus(state));
      }
      if (simple === "status") return reply(ctx, ttsStatus(session, { check: true }));
      if (simple === "off") {
        session.tts.enabled = false;
        await saveSettings(session);
        await session.speech.interrupt({ kind: "tts" });
        return reply(ctx, `tts:off · ${scopeNote(session)}`);
      }
      if (simple === "harry" || simple === "--harry") useHarryVoice(session);
      else if (raw && simple !== "on") {
        const parsed = parseEnvStyleArgs(raw);
        if (parsed.positionals.length) throw new Error(`/tts: unexpected argument '${parsed.positionals[0]}'`);
        const { prefix, suffix, choices, prefix_with_session_name, prefixwithsessionname, ...speechValues } = parsed.values;
        if (prefix_with_session_name !== undefined || prefixwithsessionname !== undefined) throw new Error("/tts: prefix_with_session_name needs a Pi session name; use prefix= instead");
        if (prefix !== undefined) session.tts.prefix = expandEnvReferences(prefix, session.env, "/tts prefix");
        if (suffix !== undefined) session.tts.suffix = expandEnvReferences(suffix, session.env, "/tts suffix");
        if (choices !== undefined) session.tts.choices = boolValue(choices, "/tts choices");
        applySpeechValues(session, speechValues, "/tts");
      }
      session.tts.enabled = true;
      session.reported.clear();
      session.lastError = null;
      await saveSettings(session);
      return reply(ctx, ttsStatus(session, { check: true }));
    } catch (error) {
      return reply(ctx, `/tts: ${String(error?.message || error).replace(/^\/tts:\s*/, "")}`);
    }
  }

  async function runNarrate(args, ctx = {}) {
    const session = await loadSession(ctx);
    const raw = String(args ?? "").trim();
    const simple = raw.toLowerCase();
    try {
      if (simple === "status") return reply(ctx, narrateStatus(session, { check: true }));
      if (simple === "off") {
        session.narrate.enabled = false;
        session.batches.clear();
        supersedeNarration(session);
        await saveSettings(session);
        await session.speech.interrupt({ kind: "narrate" });
        return reply(ctx, narrateStatus(session));
      }
      if (simple === "harry" || simple === "--harry") { useHarryVoice(session); session.narrate.enabled = true; }
      else if (NARRATE_PHASES.includes(simple)) { session.narrate.phases = simple; session.narrate.enabled = true; }
      else if (!raw || simple === "on") session.narrate.enabled = true;
      else {
        const parsed = parseEnvStyleArgs(raw);
        if (parsed.positionals.length) throw new Error(`/narrate: unexpected argument '${parsed.positionals[0]}'`);
        const values = parsed.values;
        for (const key of Object.keys(values)) {
          if (key === "text" || key === "text_enabled") throw new Error(`/narrate: ${key}= is not available in Durable sessions`);
          if (!NARRATE_SPEECH_KEYS.has(key) && !NARRATE_OWN_KEYS.has(key)) throw new Error(`/narrate: unknown setting '${key}'`);
        }
        const next = { ...session.narrate };
        const phases = values.phases ?? values.phase ?? values.mode;
        if (phases !== undefined) next.phases = normalizePhases(phases);
        if (values.speed !== undefined) {
          const speed = Number(values.speed);
          if (!Number.isFinite(speed) || speed <= 0) throw new Error("/narrate: speed must be greater than zero");
          next.speed = speed;
        }
        if (values.model !== undefined) {
          const model = String(values.model).trim();
          if (!/^[^/\s]+\/\S+$/.test(model)) throw new Error("/narrate: model must be provider/id");
          next.model = model;
        }
        if (values.style !== undefined) next.style = String(values.style).trim() || undefined;
        const degreeRaw = values.styledegree ?? values.style_degree;
        if (degreeRaw !== undefined) {
          const degree = Number(degreeRaw);
          if (!Number.isFinite(degree) || degree < 0.01 || degree > 2) throw new Error("/narrate: styledegree must be between 0.01 and 2");
          next.styleDegree = degree;
        }
        const reasoning = values.reasoning_summaries ?? values.reasoningsummaries ?? values.reasoning;
        if (reasoning !== undefined) next.reasoningSummaries = boolValue(reasoning, "/narrate reasoning_summaries");
        if (values.prefix !== undefined) next.prefix = expandEnvReferences(values.prefix, session.env, "/narrate prefix");
        if (values.suffix !== undefined) next.suffix = expandEnvReferences(values.suffix, session.env, "/narrate suffix");
        next.enabled = values.enabled !== undefined ? boolValue(values.enabled, "/narrate enabled")
          : values.on !== undefined ? boolValue(values.on, "/narrate on") : true;
        const speechValues = Object.fromEntries(Object.entries(values).filter(([key]) => NARRATE_SPEECH_KEYS.has(key)).map(([key, value]) => [key === "tts_model" ? "model" : key, value]));
        applySpeechValues(session, speechValues, "/narrate");
        session.narrate = next;
      }
      if (!session.narrate.enabled) { session.batches.clear(); await session.speech.interrupt({ kind: "narrate" }); }
      session.reported.clear();
      session.lastError = null;
      await saveSettings(session);
      return reply(ctx, narrateStatus(session, { check: session.narrate.enabled }));
    } catch (error) {
      return reply(ctx, `/narrate: ${String(error?.message || error).replace(/^\/narrate:\s*/, "")}`);
    }
  }

  const commands = {
    tts: {
      description: "Speak this session's final assistant messages on the daemon host. /tts [on|off|status|harry|key=value …]; choices=on|off speaks ask_user questions; prefix=/suffix= wrap speech; /tts focus|solo [on|off|toggle|status] routes this session's speech to the focus sink, or a sink of its own.",
      run: runTts,
    },
    narrate: {
      description: "Speak short lines about this session's tool work on the daemon host. /narrate [on|off|status|before|after|both|key=value …] (phases=, speed=, style=, styledegree=, reasoning_summaries=, prefix=, suffix=).",
      run: runNarrate,
    },
  };

  return {
    commands,
    observe,
    memoryState,
    loadedAt,
    /** Settle every in-flight speech request (tests and orderly shutdown). */
    async idle() { while (pending.size) await Promise.allSettled([...pending]); },
    /** Whether a session's speech is queued or playing (voice input mutes meanwhile). */
    isSpeaking(sessionId) { return (speaking.get(String(sessionId)) ?? 0) > 0; },
    async dispose() {
      disposed = true;
      const loaded = await Promise.allSettled([...sessions.values()].map((entry) => entry.loading));
      sessions.clear();
      for (const result of loaded) {
        if (result.status !== "fulfilled") continue;
        try { await result.value.speech?.dispose?.(); } catch {}
        try { await result.value.choices?.dispose?.(); } catch {}
        try { await result.value.routing?.shutdown?.(); } catch {}
      }
    },
  };
}

