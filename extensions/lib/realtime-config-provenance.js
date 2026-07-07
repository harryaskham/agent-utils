// Config-provenance map for realtime / cascade / stt fields (bd-798015).
//
// One readable place that answers the operator question "where does each
// realtime config value come from, and is it written back to settings.json?".
// It maps each config field -> its env var(s) -> whether it reads a persisted
// settings.json slice -> its built-in default. Precedence for EVERY field is
// env > persisted(settings.json) > default, and env values are never written
// back (durable-settings contract, bd-b45224).
//
// This table is the human-authored artifact, but it is DERIVED-CHECKABLE: the
// companion test (test/realtime-config-provenance.test.js) binds it to the
// actual source of truth so it cannot silently drift —
//   * every env var here must be a real quoted env(...) literal in
//     realtime-config.js, and vice-versa;
//   * the persisted="realtime" fields here must equal PERSISTED_REALTIME_FIELDS
//     (realtime-settings.js), and each persisted.<field> read in
//     makeInitialConfig must appear here;
//   * the literal defaults here must match makeInitialConfig() run with env
//     cleared and empty persisted slices.

import {
  DEFAULT_AZURE_ENDPOINT,
  DEFAULT_AZURE_API_VERSION,
} from "./realtime-config.js";
import {
  PERSISTED_REALTIME_FIELDS,
  PERSISTED_STT_FIELDS,
  PERSISTED_CASCADE_FIELDS,
} from "./realtime-settings.js";

// Each row: { field, env:[...first-set-wins], persisted: "realtime"|null,
//   sttFallback?: true, default, derivedDefault?: true, notes? }
// `default` is the literal built-in default; `derivedDefault:true` marks defaults
// computed by a helper (realtime-models.js) or another field, which the defaults
// test does not literal-compare.
export const REALTIME_CONFIG_PROVENANCE = [
  { field: "baseUrl", env: ["PI_RT_BASE_URL", "OPENAI_BASE_URL"], persisted: "realtime", default: "https://api.openai.com" },
  { field: "model", env: ["PI_RT_MODEL", "OPENAI_REALTIME_MODEL"], persisted: "realtime", default: "(normalizeRealtimeModelId default)", derivedDefault: true },
  { field: "betaHeader", env: ["PI_RT_BETA_HEADER"], persisted: null, default: false, notes: "GA models reject OpenAI-Beta:realtime=v1; set =1 only for legacy/self-hosted beta endpoints (bd-0b40ce)" },
  { field: "directAzure", env: ["PI_RT_PROVIDER", "PI_RT_DIRECT_AZURE"], persisted: "realtime", default: true, notes: "resolveDirectAzureDefault: PI_RT_PROVIDER=azure forces Azure (openai/proxy forces the proxy path), else PI_RT_DIRECT_AZURE, else persisted, else true (bd-8b6f12)" },
  { field: "azureEndpoint", env: ["PI_RT_AZURE_ENDPOINT", "AZURE_CANADACENTRAL_ENDPOINT", "AZURE_OPENAI_ENDPOINT"], persisted: "realtime", default: DEFAULT_AZURE_ENDPOINT },
  { field: "azureDeployment", env: ["PI_RT_AZURE_DEPLOYMENT", "AZURE_CANADACENTRAL_DEPLOYMENT"], persisted: "realtime", default: "(falls back to resolved model)", derivedDefault: true },
  { field: "azureApiVersion", env: ["PI_RT_AZURE_API_VERSION", "AZURE_OPENAI_API_VERSION"], persisted: "realtime", default: DEFAULT_AZURE_API_VERSION, notes: "GA realtime omits api-version; \"none\" = omitted (bd-cb74b5)" },
  { field: "azureProtocol", env: ["PI_RT_AZURE_PROTOCOL"], persisted: "realtime", default: "v1" },
  { field: "transcriptionModel", env: ["PI_RT_TRANSCRIPTION_MODEL", "OPENAI_REALTIME_TRANSCRIPTION_MODEL"], persisted: "realtime", sttFallback: true, default: "(normalizeTranscriptionModel default)", derivedDefault: true },
  { field: "voice", env: [], persisted: "realtime", default: "(resolveRealtimeVoice default)", derivedDefault: true, notes: "no env key; persisted.voice or default only" },
  { field: "speed", env: ["PI_RT_SPEED", "OPENAI_REALTIME_SPEED"], persisted: "realtime", default: 1.0 },
  { field: "vadThreshold", env: ["PI_RT_VAD_THRESHOLD"], persisted: "realtime", sttFallback: true, default: 0.7 },
  { field: "bufferMs", env: ["PI_RT_BUFFER_MS", "TTS_REALTIME_BUFFER_MS"], persisted: null, default: 180 },
  { field: "playbackChunkMs", env: ["PI_RT_PLAYBACK_CHUNK_MS"], persisted: null, default: 80 },
  { field: "reasoningEffort", env: ["PI_RT_REASONING_EFFORT"], persisted: null, default: "off" },
  { field: "sendReasoning", env: ["PI_RT_SEND_REASONING"], persisted: null, default: false },
  { field: "audioEnabled", env: ["PI_RT_DISABLE_AUDIO"], persisted: null, default: true, notes: "inverted: audioEnabled = !PI_RT_DISABLE_AUDIO" },
  { field: "debug", env: ["PI_RT_DEBUG"], persisted: null, default: false },
  { field: "recordCommand", env: ["PI_RT_RECORD_CMD"], persisted: null, default: undefined },
  { field: "playbackCommand", env: ["PI_RT_PLAYBACK_CMD"], persisted: null, default: undefined },
  { field: "reconnectMaxAttempts", env: ["PI_RT_RECONNECT_MAX_ATTEMPTS"], persisted: null, default: 5 },
  { field: "reconnectBaseDelayMs", env: ["PI_RT_RECONNECT_BASE_DELAY_MS"], persisted: null, default: 1000 },
  { field: "summaryContext", env: ["PI_RT_SUMMARY"], persisted: null, default: false },
  { field: "chimeEnabled", env: ["PI_RT_CHIME"], persisted: null, default: true },
  { field: "speakReplies", env: ["PI_RT_SPEAK_REPLIES"], persisted: "realtime", default: false },
  { field: "speakThinking", env: ["PI_RT_SPEAK_THINKING"], persisted: "realtime", default: false },
];

// Server-side VAD turn-detection (buildServerVadTurnDetection), sent on
// session.update. Env-only (no persisted slice); options at call sites override.
export const SERVER_VAD_PROVENANCE = [
  { field: "threshold", env: ["PI_RT_VAD_THRESHOLD"], persisted: null, default: 0.7 },
  { field: "prefix_padding_ms", env: ["PI_RT_VAD_PREFIX_PADDING_MS"], persisted: null, default: 300 },
  { field: "silence_duration_ms", env: ["PI_RT_VAD_SILENCE_MS"], persisted: null, default: 1100 },
];

// Persisted settings.json slices (agentUtils.<slice>), from the authoritative
// allowlists in realtime-settings.js. The realtime slice is the primary layer;
// the stt slice is a fallback below realtime for transcriptionModel/vadThreshold;
// the cascade slice feeds cascadeRosterFromArgs (realtime-cascade-session.js) —
// its env/default provenance lives there and is out of scope for this table.
export const PERSISTED_SLICES = {
  realtime: PERSISTED_REALTIME_FIELDS,
  stt: PERSISTED_STT_FIELDS,
  cascade: PERSISTED_CASCADE_FIELDS,
};

/// Union of every env var across the realtime + server-VAD tables (deduped, sorted).
export function allProvenanceEnvKeys() {
  const keys = new Set();
  for (const row of [...REALTIME_CONFIG_PROVENANCE, ...SERVER_VAD_PROVENANCE]) {
    for (const k of row.env) keys.add(k);
  }
  return [...keys].sort();
}

function renderDefault(row) {
  if (row.derivedDefault) return String(row.default);
  const d = row.default;
  if (d === undefined) return "(unset)";
  if (d === "") return '""';
  return String(d);
}

function renderRows(rows, { withPersisted }) {
  return rows
    .map((row) => {
      const envCell = row.env.length ? row.env.join(", ") : "(none)";
      const cells = [row.field, envCell];
      if (withPersisted) {
        let slice = row.persisted ? `agentUtils.${row.persisted}` : "no";
        if (row.sttFallback) slice += " (+agentUtils.stt fallback)";
        cells.push(slice);
      }
      cells.push(renderDefault(row));
      cells.push(row.notes || "");
      return `| ${cells.join(" | ")} |`;
    })
    .join("\n");
}

/// Render the provenance tables as deterministic Markdown. The committed doc
/// docs/realtime-config-provenance.md is this output; the test regenerates and
/// compares so the doc cannot drift.
export function renderProvenanceMarkdown() {
  return `# Realtime / cascade / STT config provenance

<!-- GENERATED from extensions/lib/realtime-config-provenance.js — do not edit by hand.
     Regenerate: node -e "import('./extensions/lib/realtime-config-provenance.js').then(m=>process.stdout.write(m.renderProvenanceMarkdown()))" > docs/realtime-config-provenance.md
     test/realtime-config-provenance.test.js binds this table to realtime-config.js + realtime-settings.js so it cannot drift. -->

Answers "where does each realtime config value come from, and is it written back to \`settings.json\`?" without tracing across \`makeInitialConfig\` (realtime-config.js), the \`/rt\` setters (realtime-agent.js / realtime-settings.js), and the env helpers.

**Precedence for every field: \`env > persisted (settings.json) > default\`.** A non-empty env value always wins; persisted (\`agentUtils.<slice>\`) only fills the gap; env is NEVER written back (durable-settings contract, bd-b45224). To make a value durable, set it via the \`/rt\` setter (persists to \`agentUtils.realtime.<field>\`) rather than an env var — and remove the env override so the persisted value is visible.

## Realtime fields (makeInitialConfig)

| Field | Env vars (first set wins) | Persisted | Default | Notes |
|---|---|---|---|---|
${renderRows(REALTIME_CONFIG_PROVENANCE, { withPersisted: true })}

## Server VAD turn-detection (buildServerVadTurnDetection)

Sent on \`session.update\`; env-only, call-site options override.

| Field | Env vars | Default | Notes |
|---|---|---|---|
${renderRows(SERVER_VAD_PROVENANCE, { withPersisted: false })}

## Persisted settings.json slices (agentUtils.<slice>)

- \`agentUtils.realtime\`: ${PERSISTED_SLICES.realtime.join(", ")}
- \`agentUtils.stt\` (fallback below realtime for transcriptionModel/vadThreshold): ${PERSISTED_SLICES.stt.join(", ")}
- \`agentUtils.cascade\` (feeds cascadeRosterFromArgs in realtime-cascade-session.js; env/default provenance lives there): ${PERSISTED_SLICES.cascade.join(", ")}
`;
}
