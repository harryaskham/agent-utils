import { createHash } from "node:crypto";

export const DEFAULT_SESSION_VOICES = Object.freeze([
  "de-DE-Klaus:MAI-Voice-2-Flash", "de-DE-Mia:MAI-Voice-2-Flash",
  "en-AU-Isla:MAI-Voice-2-Flash", "en-US-Ethan:MAI-Voice-2-Flash",
  "en-US-Grant:MAI-Voice-2-Flash", "en-US-Harper:MAI-Voice-2-Flash",
  "en-US-Iris:MAI-Voice-2-Flash", "en-US-Jasper:MAI-Voice-2-Flash",
  "en-US-Olivia:MAI-Voice-2-Flash", "es-MX-Alejo:MAI-Voice-2-Flash",
  "es-MX-Valeria:MAI-Voice-2-Flash", "fr-FR-Marc:MAI-Voice-2-Flash",
  "fr-FR-Soleil:MAI-Voice-2-Flash", "hi-IN-Arjun:MAI-Voice-2-Flash",
  "hi-IN-Dhruv:MAI-Voice-2-Flash", "hi-IN-Kavya:MAI-Voice-2-Flash",
  "hi-IN-Priya:MAI-Voice-2-Flash", "hu-HU-Bence:MAI-Voice-2-Flash",
  "hu-HU-Levente:MAI-Voice-2-Flash", "hu-HU-Lilla:MAI-Voice-2-Flash",
  "it-IT-Luca:MAI-Voice-2-Flash", "it-IT-Rosa:MAI-Voice-2-Flash",
  "ko-KR-Haena:MAI-Voice-2-Flash", "ko-KR-Junho:MAI-Voice-2-Flash",
  "nl-NL-Fleur:MAI-Voice-2-Flash", "nl-NL-Sander:MAI-Voice-2-Flash",
  "pt-BR-Caio:MAI-Voice-2-Flash", "pt-BR-Luana:MAI-Voice-2-Flash",
  "pt-BR-Pedro:MAI-Voice-2-Flash", "pt-BR-Rafael:MAI-Voice-2-Flash",
  "pt-PT-Rui:MAI-Voice-2-Flash", "ro-RO-Andrei:MAI-Voice-2-Flash",
  "ro-RO-Elena:MAI-Voice-2-Flash", "ro-RO-Radu:MAI-Voice-2-Flash",
  "ru-RU-Masha:MAI-Voice-2-Flash", "th-TH-Krit:MAI-Voice-2-Flash",
  "th-TH-Nattapong:MAI-Voice-2-Flash", "tr-TR-Elif:MAI-Voice-2-Flash",
  "zh-CN-Bo:MAI-Voice-2-Flash", "zh-CN-Mei:MAI-Voice-2-Flash",
  "zh-CN-Wei:MAI-Voice-2-Flash",
]);

function unitHash(identity, purpose) {
  const digest = createHash("sha256").update(`${identity}\0${purpose}`).digest();
  return Number(digest.readBigUInt64BE(0)) / Number(0xffffffffffffffffn);
}

export function sessionSpeechIdentity(ctx, env = process.env) {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (id) return String(id);
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (file) return String(file);
  } catch {}
  return String(env.CACO_AGENT_ID || env.AGENT_ID || env.PI_SESSION_ID || process.pid);
}

export function resolveSessionSpeechAssignment(identity, { voices = DEFAULT_SESSION_VOICES, panMin = -0.9, panMax = 0.9 } = {}) {
  const pool = [...new Set((Array.isArray(voices) ? voices : []).map(String).map((v) => v.trim()).filter(Boolean))];
  const min = Math.max(-1, Math.min(1, Number(panMin)));
  const max = Math.max(min, Math.min(1, Number(panMax)));
  const voice = pool.length ? pool[Math.min(pool.length - 1, Math.floor(unitHash(identity, "voice") * pool.length))] : undefined;
  const pan = min + unitHash(identity, "pan") * (max - min);
  return { identity, voice, pan };
}

export function resolveSessionSpeechPolicy(persisted = {}, env = process.env) {
  const voices = env.PI_TTS_VOICES
    ? env.PI_TTS_VOICES.split(",")
    : Array.isArray(persisted.voices) ? persisted.voices : DEFAULT_SESSION_VOICES;
  const range = persisted.panRange && typeof persisted.panRange === "object" ? persisted.panRange : {};
  return {
    voices,
    panMin: Number(env.PI_TTS_PAN_MIN ?? range.min ?? -0.9),
    panMax: Number(env.PI_TTS_PAN_MAX ?? range.max ?? 0.9),
  };
}
