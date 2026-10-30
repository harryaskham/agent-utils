// Visual thoughts: settings (`agentUtils.visualThoughts`), environment, and runtime changes.
//
// Startup settings are immutable policy; `/thoughts key value` changes the running session only.

export const DEFAULT_PROMPT_MODEL = "github-copilot/gpt-6-luna";

export const DEFAULTS = Object.freeze({
  enabled: false,
  promptModel: DEFAULT_PROMPT_MODEL,
  provider: "litellm",
  imageModel: "gpt-image-2.5-flare",
  size: "1536x1024",
  quality: "low",
  baseUrl: "",
  apiKeyEnv: "LITELLM_MASTER_KEY",
  maiEndpoint: "",
  maiAuth: "entra",
  maiKeyEnv: "AZURE_MAI_API_KEY",
  style: "",
  // Display.
  opacity: 0.3,
  fit: "cover",
  feather: 0.12,
  layer: "auto",
  holdMs: 18_000,
  fadeMs: 2_800,
  fps: 60,
  effect: "random",
  transitionPixels: 400_000,
  minShowMs: 5_000,
  minSet: 3,
  maxImages: 8,
  // Generation.
  minIntervalMs: 12_000,
  firstChars: 160,
  minChars: 600,
  maxPerRun: 10,
  maxConcurrent: 1,
  keep: 48,
  transport: "auto",
});

const NUMERIC = Object.freeze({
  opacity: [0, 1], feather: [0, 0.5], fps: [1, 120], transitionPixels: [20_000, 2_000_000],
  holdMs: [1_000, 600_000], fadeMs: [0, 60_000], minShowMs: [0, 600_000],
  minSet: [1, 32], maxImages: [1, 64], minIntervalMs: [0, 3_600_000], firstChars: [0, 100_000],
  minChars: [0, 100_000], maxPerRun: [0, 1_000], maxConcurrent: [1, 4], keep: [0, 10_000],
});
const CHOICES = Object.freeze({
  fit: ["cover", "contain", "stretch"],
  effect: ["random", "fade", "ripple", "wave", "dissolve", "bloom", "drift"],
  layer: ["auto", "over", "under"],
  provider: ["litellm", "mai"],
  maiAuth: ["entra", "key"],
  transport: ["auto", "file", "stream"],
});
const STRINGS = new Set(["promptModel", "imageModel", "size", "quality", "baseUrl", "apiKeyEnv", "maiEndpoint", "maiKeyEnv", "style"]);
/** Seconds-friendly aliases for the millisecond settings, and short names. */
const ALIASES = Object.freeze({
  hold: ["holdMs", 1000], fade: ["fadeMs", 1000], interval: ["minIntervalMs", 1000], "min-show": ["minShowMs", 1000],
  model: ["imageModel", 1], "image-model": ["imageModel", 1], "prompt-model": ["promptModel", 1],
  "max-images": ["maxImages", 1], "per-run": ["maxPerRun", 1], "min-set": ["minSet", 1], pixels: ["transitionPixels", 1],
});

function bool(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

/** One setting checked and normalized; undefined when invalid. */
export function normalizeSetting(key, value) {
  if (key === "enabled") return bool(value, undefined);
  if (NUMERIC[key]) {
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    const [min, max] = NUMERIC[key];
    return Math.min(max, Math.max(min, number));
  }
  if (CHOICES[key]) {
    const text = String(value ?? "").trim().toLowerCase();
    return CHOICES[key].includes(text) ? text : undefined;
  }
  if (STRINGS.has(key)) {
    const text = String(value ?? "").trim();
    if (/[\r\n\0]/.test(text) || text.length > 2_000) return undefined;
    return text;
  }
  return undefined;
}

/** The startup config: defaults < settings < environment. Incognito never enables. */
export function resolveVisualThoughtsConfig(settings = {}, env = process.env) {
  const raw = settings?.agentUtils?.visualThoughts || settings?.visualThoughts || {};
  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    const normalized = normalizeSetting(key, value);
    if (normalized !== undefined) config[key] = normalized;
  }
  // A MAI provider without an explicit size uses MAI's landscape minimum.
  if (config.provider === "mai" && raw.size === undefined) config.size = "1344x768";
  if (config.provider === "mai" && raw.imageModel === undefined) config.imageModel = "MAI-Image-2.5-Flash";
  const envMap = {
    PI_VISUAL_THOUGHTS: "enabled",
    PI_VISUAL_THOUGHTS_PROMPT_MODEL: "promptModel",
    PI_VISUAL_THOUGHTS_IMAGE_MODEL: "imageModel",
    PI_VISUAL_THOUGHTS_PROVIDER: "provider",
    PI_VISUAL_THOUGHTS_OPACITY: "opacity",
  };
  for (const [name, key] of Object.entries(envMap)) {
    if (env[name] == null || String(env[name]).trim() === "") continue;
    const normalized = normalizeSetting(key, env[name]);
    if (normalized !== undefined) config[key] = normalized;
  }
  config.incognito = bool(env.PI_INCOGNITO, false);
  if (config.incognito) config.enabled = false;
  return config;
}

/**
 * A runtime change from `/thoughts <key> <value>`: `{ key, value }` normalized, or `{ error }`.
 * Seconds aliases (`hold 20`, `fade 2.5`, `interval 30`) convert to milliseconds.
 */
export function parseSettingChange(name, value) {
  const alias = ALIASES[name];
  const key = alias ? alias[0] : name;
  const scale = alias ? alias[1] : 1;
  if (!(key in DEFAULTS) || key === "enabled") return { error: `unknown setting '${name}'` };
  const input = scale !== 1 && Number.isFinite(Number(value)) ? Number(value) * scale : value;
  const normalized = normalizeSetting(key, input);
  if (normalized === undefined) return { error: `invalid value for ${key}: '${value}'` };
  return { key, value: normalized };
}
