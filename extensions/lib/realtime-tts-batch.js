// One-shot batch TTS: text -> raw PCM16/24k/mono, for /cascade audio output
// (bd-7c6790). Spawns `tts --stdout --response-format pcm ... -- <text>` and
// resolves with the PCM buffer. Deliberately mirrors realtime-stt-batch.js: a PURE
// arg builder plus an injectable `spawnImpl` so the subprocess plumbing is
// unit-tested without the `tts` binary or any audio device.
//
// Why this shape
// --------------
//   * `--response-format pcm` emits raw int16 LE @ 24kHz mono, which is exactly the
//     format realtime-audio.js (SAMPLE_RATE=24000, mono, 16-bit) feeds to
//     playPcmBuffer — so cascade output needs no transcoding.
//   * Text is passed as a POSITIONAL argument after `--`. This is the tts CLI's
//     one-shot path and the trailing `--` protects text that begins with a dash.
//     We deliberately do NOT feed text on stdin: with no positional/--file the CLI
//     defaults to its streaming `--stdin` mode, which blocks rather than doing a
//     one-shot synth (verified live 2026-06-27).
//   * By default we pass NO provider/model/voice/base-url, so the tts CLI inherits
//     the env-configured defaults (TTS_PROVIDER, OPENAI_TTS_MODEL=azure/speech/...,
//     OPENAI_BASE_URL, OPENAI_TTS_VOICE) — i.e. EXACTLY caco's azure/speech TTS
//     path (operator request: "default to the same azure/speech/azure-tts as caco").
//     The direct `--provider azure-speech` cognitive-services path is a separate,
//     opt-in override. Per-participant overrides win when supplied.
//   * Bypasses `caco msg speak` / the daemon for latency (operator request
//     2026-06-27): cascade agents speak straight through the local `tts` CLI.

import { spawn } from "node:child_process";

// Opt-in constant for the DIRECT Azure Cognitive Services speech path (uses
// AZURE_SPEECH_*). NOT the default: by default cascade inherits the env TTS
// provider, which in a caco env is the proxy that already fronts azure/speech.
export const AZURE_SPEECH_PROVIDER = "azure-speech";

// Sentinel from realtime-participants.js meaning "use the provider's configured
// default voice" (caco's azure embedding default). We translate it to "omit
// --voice" so the tts CLI/provider picks its own default.
export const CASCADE_DEFAULT_VOICE_SENTINEL = "embedding:default";

/// Resolve a cascade voice for the tts CLI: the sentinel or an empty value -> undefined
/// (let the provider use its default voice); otherwise the explicit voice. Pure.
export function resolveCascadeTtsVoice(voice) {
  const v = String(voice ?? "").trim();
  if (!v || v === CASCADE_DEFAULT_VOICE_SENTINEL) return undefined;
  return v;
}

/// Build the `tts` argv for one-shot PCM synthesis. Text is passed as a
/// positional after `--` (leading-dash safe). By default no provider/model/voice
/// is forced, so the tts CLI inherits the env-configured caco azure defaults. Pure.
export function buildTtsBatchArgs({
  text,
  voice,
  model,
  provider,
  baseUrl,
  responseFormat = "pcm",
  speed,
  instructions,
} = {}) {
  const args = ["--stdout", "--response-format", String(responseFormat || "pcm")];
  const v = resolveCascadeTtsVoice(voice);
  if (v) args.push("--voice", v);
  if (model) args.push("--model", String(model));
  if (provider) args.push("--provider", String(provider));
  if (baseUrl) args.push("--base-url", String(baseUrl));
  const s = Number(speed);
  if (Number.isFinite(s) && s > 0 && s !== 1) args.push("--speed", String(speed));
  if (instructions) args.push("--instructions", String(instructions));
  const body = String(text ?? "");
  if (body) args.push("--", body);
  return args;
}

/// Synthesize `text` to a raw PCM16/24k/mono Buffer via a one-shot `tts`
/// subprocess. Resolves with the audio Buffer; rejects on empty text, spawn
/// error, or a non-zero exit (carrying stderr). `command`/`spawnImpl` injectable.
export function synthesizeToPcm(text, {
  voice,
  model,
  provider,
  baseUrl,
  speed,
  instructions,
  responseFormat,
  command = "tts",
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const body = String(text ?? "");
    if (!body.trim()) {
      reject(new Error("tts: refusing to synthesize empty text"));
      return;
    }
    let proc;
    try {
      proc = spawnImpl(
        command,
        buildTtsBatchArgs({ text: body, voice, model, provider, baseUrl, speed, instructions, responseFormat }),
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const errChunks = [];
    proc.stdout?.on("data", (d) => out.push(Buffer.from(d)));
    proc.stderr?.on("data", (d) => errChunks.push(Buffer.from(d)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out));
      } else {
        const errText = Buffer.concat(errChunks).toString("utf8").trim().slice(0, 500);
        reject(new Error(`tts exited ${code}${errText ? `: ${errText}` : ""}`));
      }
    });
  });
}
