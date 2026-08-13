// Cascade session controller + real-dep factories (bd-7c6790).
//
// CascadeController holds the persistent group-chat state (the running
// conversation and round counter) and turns a single human utterance into a
// cascade round via runCascadeRound. It is one-round-at-a-time: a human turn that
// arrives while a round is still playing is dropped, so voices never overlap.
//
// The factory helpers build the concrete `runTurn` / `speak` deps from the tested
// primitives (the chat-completions caller and the tts->pcm synthesiser), leaving
// only the audio `playImpl` and the live mic to the extension. Everything here is
// unit-tested with injected deps.

import { runCascadeRound } from "./realtime-cascade.js";
import { sanitizeForSpeech } from "./realtime-cascade.js";
import { DEFAULT_ORDER, MODE_CASCADE, buildParticipantRoster } from "./realtime-participants.js";
import { runChatCompletionTurn, runPiInferenceTurn } from "./realtime-cascade-llm.js";
import {
  synthesizeSpeechDirect,
  resolveAzureSpeechCreds,
  isAzureSpeechProvider,
  DEFAULT_TTS_PROVIDER,
} from "./tts.js";
import { parseEnvStyleArgs } from "./env-args.js";
import { readPersistedCascadeSettings } from "./realtime-settings.js";

/// Build a cascade roster from a raw `/cascade` argument string. Maps the
/// env-style args (n=, participants=, order=, plus main overrides voice/model/
/// base_url/tts/instructions/name) onto buildParticipantRoster. Pure given an
/// injected `parseArgs` / `env`. Returns { roster, values }.
export function cascadeRosterFromArgs(rawArgs, { env = process.env, parseArgs = parseEnvStyleArgs, persisted } = {}) {
  const { values } = parseArgs(rawArgs || "");
  // Durable cascade defaults (bd-b45224): a /cascade arg wins; otherwise fall
  // back to the persisted agentUtils.cascade slice in settings.json; otherwise
  // buildParticipantRoster's env/hardcoded default applies. So an operator can
  // move PI_CASCADE_VOICE etc. into settings.json and drop the env var.
  const p = persisted ?? readPersistedCascadeSettings();
  // TTS is always the shared native Azure REST path. The historical azure=true
  // switch is accepted but no longer needed; there is deliberately no CLI fallback.
  const directAzureSpeech = true;
  const defaultProvider = values.provider ?? p.provider ?? DEFAULT_TTS_PROVIDER;
  const roster = buildParticipantRoster({
    mode: MODE_CASCADE,
    n: values.n,
    participants: values.participants ?? values.peers,
    order: values.order || DEFAULT_ORDER,
    main: {
      name: values.name,
      voice: values.voice ?? p.voice,
      model: values.model ?? p.model,
      baseUrl: values.base_url ?? values.baseurl ?? values.openai_base_url ?? p.baseUrl,
      ttsModel: values.tts ?? values.tts_model ?? values.ttsmodel ?? p.ttsModel,
      provider: defaultProvider,
      speakerProfileId: values.speakerprofileid ?? values.speaker_profile_id ?? values.speaker ?? p.speakerProfileId,
      lang: values.lang ?? values.xml_lang ?? p.lang,
      style: values.style,
      styleDegree: values.styledegree ?? values.style_degree,
      instructions: values.instructions ?? values.persona,
    },
    env,
  });
  // Every participant uses the shared direct Azure REST path unless it already
  // carries an explicit provider (which the synthesizer validates).
  for (const participant of (roster?.participants || [])) {
    if (participant && !participant.provider) participant.provider = DEFAULT_TTS_PROVIDER;
  }
  return { roster, values, directAzureSpeech };
}

export class CascadeController {
  constructor({ roster = [], order = DEFAULT_ORDER, runTurn, speak, synth, play, onTurn, onSpeak, humanLabel, rng, maxHistory } = {}) {
    if (typeof runTurn !== "function") throw new Error("CascadeController requires a runTurn dep");
    this.roster = Array.isArray(roster) ? roster : (roster?.participants || []);
    this.order = order;
    this.runTurn = runTurn;
    this.speak = typeof speak === "function" ? speak : null;
    this.synth = typeof synth === "function" ? synth : null;
    this.play = typeof play === "function" ? play : null;
    this.onTurn = typeof onTurn === "function" ? onTurn : null;
    this.onSpeak = typeof onSpeak === "function" ? onSpeak : null;
    this.humanLabel = humanLabel;
    this.rng = typeof rng === "function" ? rng : Math.random;
    // Sliding-window cap on the running conversation so a long-lived group chat
    // does not grow context (and cost) without bound. 0/undefined = unbounded.
    const mh = Number(maxHistory);
    this.maxHistory = Number.isFinite(mh) && mh > 0 ? Math.floor(mh) : 0;
    this.conversation = [];
    this.round = 0;
    this.busy = false;
    this.lastError = null;
  }

  get active() { return this.busy; }

  /// Drive one cascade round from a human utterance. Returns the round result, or
  /// null if the text is empty or a round is already in flight (one at a time).
  async handleHumanUtterance(text) {
    const body = String(text ?? "").trim();
    if (!body) return null;
    if (this.busy) return null;
    this.busy = true;
    try {
      const res = await runCascadeRound({
        participants: this.roster,
        humanText: body,
        order: this.order,
        rng: this.rng,
        round: this.round,
        conversation: this.conversation,
        runTurn: this.runTurn,
        speak: this.speak || undefined,
        synth: this.synth || undefined,
        play: this.play || undefined,
        onTurn: this.onTurn || undefined,
        onSpeak: this.onSpeak || undefined,
        humanLabel: this.humanLabel,
      });
      this.conversation = this.maxHistory && res.conversation.length > this.maxHistory
        ? res.conversation.slice(-this.maxHistory)
        : res.conversation;
      this.round += 1;
      this.lastError = null;
      return res;
    } catch (err) {
      this.lastError = err?.message || String(err);
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /// Clear the conversation and round counter (start a fresh group chat).
  reset() {
    this.conversation = [];
    this.round = 0;
    this.lastError = null;
  }
}

/// Build a concrete `runTurn(participant, messages)` dep backed by the
/// chat-completions caller. Per-participant model/base-url win over `defaultModel`.
/// Defaults keep spoken replies short (maxTokens) unless overridden.
export function makeCascadeRunTurn({ defaultModel, defaultBaseUrl, envRead, fetchImpl, temperature, maxTokens = 200, piInferenceTurn } = {}) {
  return (participant, messages) => {
    // bd-15beec: an UNPINNED peer (no explicit model=) is "just the model loaded
    // in Pi" — route it through Pi's built-in inference on the loaded ctx model
    // (piInferenceTurn) instead of a raw chat-completions call to a possibly-
    // unservable default model (the n=1 "no healthy deployments" 400). A peer
    // that pins its own model= keeps the direct chat-completions path.
    if (typeof piInferenceTurn === "function" && !participant?.model) {
      return piInferenceTurn(participant, messages);
    }
    return runChatCompletionTurn({
      messages,
      model: participant?.model || defaultModel,
      baseUrl: participant?.baseUrl || defaultBaseUrl,
      temperature,
      maxTokens,
      fetchImpl,
      envRead,
    });
  };
}

/// Build a `runTurn(participant, messages)` dep backed by Pi's built-in inference
/// (`complete`) on the loaded ctx model (bd-15beec), so an unpinned cascade peer
/// (n=1) behaves like talking to the model already loaded in Pi. Returns null
/// when the ctx cannot provide a loaded model + auth accessor, so the caller can
/// fall back to the chat-completions path. `completeImpl` is injectable for tests.
export function makeCascadePiInferenceTurn({ ctx, model, completeImpl, maxTokens = 200 } = {}) {
  const loaded = model || ctx?.model;
  const getAuth = ctx?.modelRegistry?.getApiKeyAndHeaders;
  if (!loaded || typeof getAuth !== "function") return null;
  return async (participant, messages) => {
    const auth = await getAuth.call(ctx.modelRegistry, loaded);
    return runPiInferenceTurn({
      messages,
      model: loaded,
      auth,
      completeImpl,
      maxTokens,
      systemPrompt: participant?.instructions,
    });
  };
}

/// Build a concrete `speak(participant, text)` dep: synthesise the reply to PCM
/// (per-participant voice / tts model / base url) then hand it to `playImpl`.
export function makeCascadeSpeak({ synthImpl = synthesizeSpeechDirect, playImpl, speed } = {}) {
  if (typeof playImpl !== "function") throw new Error("makeCascadeSpeak requires a playImpl(pcm, participant) dep");
  return async (participant, text) => {
    const body = sanitizeForSpeech(text);
    if (!body) return;
    const pcm = await synthImpl(body, {
      voice: participant?.voice,
      model: participant?.ttsModel,
      baseUrl: participant?.baseUrl,
      provider: participant?.provider,
      speakerProfileId: participant?.speakerProfileId,
      lang: participant?.lang,
      style: participant?.style,
      styleDegree: participant?.styleDegree,
      instructions: participant?.instructions,
      speed,
    });
    if (pcm && pcm.length) await playImpl(pcm, participant);
  };
}

/// Build a `synth(participant, text) -> pcm` dep for PIPELINED rounds (synthesis
/// runs concurrently with playback). Applies sanitizeForSpeech, returns a PCM
/// buffer (empty for blank text). Pair with makeCascadePlay.
export function makeCascadeSynth({ synthImpl = synthesizeSpeechDirect, speed } = {}) {
  return async (participant, text) => {
    const body = sanitizeForSpeech(text);
    if (!body) return Buffer.alloc(0);
    return synthImpl(body, {
      voice: participant?.voice,
      model: participant?.ttsModel,
      baseUrl: participant?.baseUrl,
      provider: participant?.provider,
      speakerProfileId: participant?.speakerProfileId,
      lang: participant?.lang,
      style: participant?.style,
      styleDegree: participant?.styleDegree,
      instructions: participant?.instructions,
      speed,
    });
  };
}

/// Build a cascade synth `(text, opts) -> Promise<Buffer>` backed exclusively
/// by the shared native Azure Speech REST implementation. There is intentionally
/// no `tts` subprocess fallback. Azure endpoint/key come from the dedicated
/// AZURE_SPEECH_* environment, independent of chat-model base URLs. Injectable for tests.
export function makeCascadeTtsSynth({ env = process.env, fetchImpl } = {}) {
  return (text, opts = {}) => {
    const provider = opts.provider ?? DEFAULT_TTS_PROVIDER;
    if (!isAzureSpeechProvider(provider)) {
      return Promise.reject(new Error(`cascade TTS provider '${provider}' is unsupported; use provider=azure`));
    }
    // participant.baseUrl belongs to the chat model; Azure Speech routing is
    // independent and comes only from AZURE_SPEECH_ENDPOINT / credentials.
    const { endpoint, apiKey } = resolveAzureSpeechCreds({ env });
    return synthesizeSpeechDirect(text, {
      ...opts,
      provider,
      endpoint,
      apiKey,
      fetchImpl,
      env,
    });
  };
}

/// Build a `play(participant, pcm)` dep for PIPELINED rounds: plays non-empty PCM
/// through `playImpl` in the order the orchestrator serializes it. Pair with
/// makeCascadeSynth.
export function makeCascadePlay({ playImpl } = {}) {
  if (typeof playImpl !== "function") throw new Error("makeCascadePlay requires a playImpl(pcm, participant) dep");
  return async (participant, pcm) => {
    if (pcm && pcm.length) await playImpl(pcm, participant);
  };
}
