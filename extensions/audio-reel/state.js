// Pure audio-reel state: clip list, selection, persisted player settings and
// operator argument parsing. No terminal, process or Pi coupling.
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { normalizeOutputPatch } from "./playback.js";
import { AUDIO_MIME_EXTENSIONS } from "../lib/shared-audio.js";

export const REEL_STATE_KEY = "audioReelState";
export const REPEAT_MODES = Object.freeze(["off", "one", "all"]);
export const MAX_REEL_ITEMS = 500;
export const MAX_VOLUME = 150;

export function createReelState() {
  return { items: [], index: 0, visible: false, config: { volume: 100, repeat: "off", output: {} } };
}

export function reelItemKey(...parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

const text = (value, max) => typeof value === "string" && value.trim() ? value.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, max) : undefined;
const count = (value) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value)) : undefined;

export function sanitizeItem(item) {
  if (!item || typeof item.path !== "string" || !item.path) return null;
  return {
    key: typeof item.key === "string" && /^[a-f0-9]{8,64}$/.test(item.key) ? item.key : reelItemKey(item.path, item.addedAt),
    path: item.path,
    archivePath: typeof item.archivePath === "string" ? item.archivePath : undefined,
    archiveId: text(item.archiveId, 512),
    label: text(item.label, 512) || basename(item.path),
    title: text(item.title, 512),
    description: text(item.description, 4096),
    mimeType: text(item.mimeType, 64) || "audio/*",
    bytes: count(item.bytes),
    durationMs: count(item.durationMs),
    sampleRate: count(item.sampleRate),
    channels: count(item.channels),
    agent: text(item.agent, 256),
    origin: text(item.origin, 32) || "share",
    addedAt: count(item.addedAt) ?? Date.now(),
  };
}

export function serializeReelState(state) {
  return {
    version: 1,
    visible: !!state.visible,
    index: state.index,
    config: { volume: state.config.volume, repeat: state.config.repeat, output: { ...state.config.output } },
    items: state.items.map(sanitizeItem).filter(Boolean),
  };
}

export function restoreReelState(state, snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.items)) return false;
  state.items = snapshot.items.map(sanitizeItem).filter(Boolean).slice(-MAX_REEL_ITEMS);
  state.visible = !!snapshot.visible;
  state.index = clampIndex(snapshot.index, state.items.length);
  const config = snapshot.config || {};
  state.config = {
    volume: clampVolume(config.volume ?? 100),
    repeat: REPEAT_MODES.includes(config.repeat) ? config.repeat : "off",
    output: (() => { try { return normalizeOutputPatch(config.output || {}); } catch { return {}; } })(),
  };
  return true;
}

/// Archive receipts (from audio_share results) make restored clips durable
/// even when their session scratch copy was cleaned up.
export function applyArchiveReceipts(state, receipts = []) {
  for (const receipt of receipts) {
    if (!receipt?.key || typeof receipt.path !== "string") continue;
    for (const item of state.items) if (item.key === receipt.key) { item.archivePath = receipt.path; item.archiveId ||= receipt.id; }
  }
}

export function clampIndex(value, length) {
  const n = Math.trunc(Number(value));
  return length <= 0 ? 0 : Math.max(0, Math.min(length - 1, Number.isFinite(n) ? n : 0));
}
export function clampVolume(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_VOLUME, n)) : 100;
}

export function addItem(state, item) {
  const clean = sanitizeItem(item);
  if (!clean) throw new Error("Audio clip requires a path");
  const existing = state.items.findIndex((candidate) => candidate.key === clean.key);
  if (existing >= 0) { state.items[existing] = { ...state.items[existing], ...clean }; return existing; }
  state.items.push(clean);
  if (state.items.length > MAX_REEL_ITEMS) state.items.splice(0, state.items.length - MAX_REEL_ITEMS);
  return state.items.length - 1;
}

export function removeItem(state, index) {
  if (index < 0 || index >= state.items.length) return null;
  const [removed] = state.items.splice(index, 1);
  if (state.index > index || state.index >= state.items.length) state.index = Math.max(0, state.index - 1);
  return removed;
}

export function findItemIndex(state, reference) {
  if (reference === undefined || reference === null || reference === "") return state.index;
  const value = String(reference).trim();
  const byKey = state.items.findIndex((item) => item.key === value || item.archiveId === value);
  if (byKey >= 0) return byKey;
  if (/^\d+$/.test(value)) {
    const n = Number(value) - 1;
    return n >= 0 && n < state.items.length ? n : -1;
  }
  const needle = value.toLowerCase();
  return state.items.findIndex((item) => [item.label, item.title].some((field) => field?.toLowerCase().includes(needle)));
}

export function itemName(item) {
  return item ? item.title || item.label || basename(item.path) : "";
}

/// m:ss / h:mm:ss. `scale` (usually the clip duration) selects sub-second
/// precision for short clips so position and duration use the same style.
export function formatClock(ms, scale = ms) {
  if (!Number.isFinite(ms)) return "--:--";
  if (Number.isFinite(scale) && scale > 0 && scale < 10000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function formatItemDetail(item) {
  const bits = [];
  if (item.mimeType && item.mimeType !== "audio/*") bits.push(AUDIO_MIME_EXTENSIONS.get(item.mimeType) || item.mimeType.replace(/^audio\/(?:x-)?/, ""));
  if (item.sampleRate) bits.push(`${item.sampleRate >= 1000 ? `${+(item.sampleRate / 1000).toFixed(1)} kHz` : `${item.sampleRate} Hz`}`);
  if (item.channels) bits.push(item.channels === 1 ? "mono" : item.channels === 2 ? "stereo" : `${item.channels} ch`);
  if (item.bytes) bits.push(item.bytes >= 1048576 ? `${(item.bytes / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.round(item.bytes / 1024))} KiB`);
  return bits.join(" · ");
}

/// "+10", "-5", "90", "1:23", "1:02:03", "50%" → absolute milliseconds.
export function parseSeekArgument(input, { positionMs = 0, durationMs } = {}) {
  const value = String(input ?? "").trim();
  if (!value) throw new Error("seek needs a position: seconds, m:ss, +/-seconds or percent");
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(value);
  if (percent) {
    if (!Number.isFinite(durationMs)) throw new Error("percent seeking needs a known clip duration");
    return Math.round(Math.min(100, Number(percent[1])) / 100 * durationMs);
  }
  const relative = /^([+-])(.+)$/.exec(value);
  const seconds = (raw) => {
    const parts = raw.split(":");
    if (parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))) throw new Error(`invalid seek position '${input}'`);
    return parts.reduce((total, part) => total * 60 + Number(part), 0);
  };
  const target = relative ? positionMs + (relative[1] === "-" ? -1 : 1) * seconds(relative[2]) * 1000 : seconds(value) * 1000;
  const bounded = Math.max(0, target);
  return Math.round(Number.isFinite(durationMs) ? Math.min(bounded, durationMs) : bounded);
}

/// "80", "80%", "+10", "-10", "mute" → percent 0–150.
export function parseVolumeArgument(input, current = 100) {
  const value = String(input ?? "").trim().toLowerCase();
  if (!value) return current;
  if (value === "mute" || value === "off") return 0;
  const match = /^([+-])?(\d+(?:\.\d+)?)%?$/.exec(value);
  if (!match) throw new Error(`invalid volume '${input}' (0–${MAX_VOLUME}, +N or -N)`);
  const n = Number(match[2]);
  return clampVolume(match[1] === "+" ? current + n : match[1] === "-" ? current - n : n);
}

export function parseRepeatArgument(input, current = "off") {
  const value = String(input ?? "").trim().toLowerCase();
  if (!value) return REPEAT_MODES[(REPEAT_MODES.indexOf(current) + 1) % REPEAT_MODES.length];
  if (!REPEAT_MODES.includes(value)) throw new Error("repeat must be off, one or all");
  return value;
}

/// "backend=pulse sink=foo server=tcp:host:4713", "sink=default", "reset".
export function parseOutputArguments(input) {
  const tokens = String(input ?? "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { show: true };
  if (tokens.length === 1 && ["reset", "default", "defaults", "clear"].includes(tokens[0].toLowerCase())) return { reset: true };
  const patch = {}, inherit = [];
  for (const token of tokens) {
    const match = /^([a-z]+)=(.*)$/i.exec(token);
    if (!match) throw new Error(`expected key=value, got '${token}' (backend, server, sink)`);
    const key = match[1].toLowerCase() === "device" ? "sink" : match[1].toLowerCase();
    if (!["backend", "server", "sink"].includes(key)) throw new Error(`unknown output setting '${match[1]}' (backend, server, sink)`);
    const raw = match[2], lower = raw.toLowerCase();
    // inherit = follow PI_AUDIO_* / PULSE_* again; default = explicit default.
    if (lower === "inherit") { inherit.push(key); continue; }
    patch[key] = key === "backend" ? (lower === "default" ? "auto" : raw) : ["default", ""].includes(lower) ? null : raw;
  }
  return { patch: normalizeOutputPatch(patch), inherit };
}
