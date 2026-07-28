// Runtime /image-config slash-command helpers (bd-9b5b18). Pure over a plain
// config object so the parsing/validation can be unit-tested without a live Pi
// session. The main extension wires applyConfigArgs into a registerImageCommand
// handler that re-renders the current image after a successful update.

import {
  PREVIEW_PLACEMENTS,
  SIDE_PANEL_MAX_ALLOWED_WIDTH_RATIO,
  SIDE_PANEL_MAX_WIDTH_RATIO,
  SIDE_PANEL_MIN_WIDTH_RATIO,
} from "./constants.js";

// Enum option sets mirror the tool-schema enums in kitty-image-preview.js so the
// runtime command and the tool API accept the same values.
export const PLACEMENT_MODE_OPTIONS = ["auto", "unicode", "cursor"];
export const TRANSFER_MODE_OPTIONS = ["auto", "memory", "file"];
export const PASSTHROUGH_OPTIONS = ["auto", "tmux", "none"];

// Field metadata: how to parse and validate each runtime-settable key. Keys are
// the canonical config field names; `aliases` lets the operator use the
// friendlier status-line names (graphicsPlacement, transfer, z).
const FIELD_SPECS = {
  placement: { kind: "enum", options: PREVIEW_PLACEMENTS },
  placementMode: { kind: "enum", options: PLACEMENT_MODE_OPTIONS, aliases: ["graphicsplacement", "graphics-placement"] },
  transferMode: { kind: "enum", options: TRANSFER_MODE_OPTIONS, aliases: ["transfer"] },
  passthrough: { kind: "enum", options: PASSTHROUGH_OPTIONS },
  zIndex: { kind: "int", min: -2_147_483_648, max: 2_147_483_647, aliases: ["z", "z-index"] },
  columns: { kind: "int", min: 1, max: 4096 },
  rows: { kind: "int", min: 1, max: 4096, nullable: true },
  maxRows: { kind: "int", min: 1, max: 4096 },
  minRows: { kind: "int", min: 1, max: 4096 },
  background: { kind: "bool" },
  showCaption: { kind: "bool", aliases: ["caption"] },
  clearPrevious: { kind: "bool", aliases: ["clear-previous"] },
  widthRatio: { kind: "ratio", nullable: true, aliases: ["width", "image-width", "width-ratio", "panelwidth", "panel-width"] },
};

// Accepted spellings for "go back to the default width share".
const WIDTH_RESET_WORDS = ["", "auto", "default", "reset", "none", "null"];

// Parse an /image-width argument into a side-rail width fraction.
//
//   "25%" | "25"   -> 0.25   (a bare number >1 is read as a percentage)
//   "0.25" | ".25" -> 0.25   (0 < n <= 1 is read as a fraction)
//   "auto"/"reset"/"default"/"" -> undefined (restore the built-in default)
//
// Values are clamped into the supported band rather than rejected, so an
// over-eager "/image-width 99%" still leaves a usable text column. Throws only
// on genuinely unparseable input. Pure.
export function parseWidthRatioValue(raw) {
  const value = String(raw ?? "").trim();
  if (WIDTH_RESET_WORDS.includes(value.toLowerCase())) return undefined;
  const percent = value.endsWith("%");
  const numeric = Number.parseFloat(percent ? value.slice(0, -1) : value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`expected a width like 50%, 0.5, or auto, got "${raw}"`);
  }
  // A bare number greater than 1 is a percentage ("/image-width 25"); anything
  // in (0, 1] without a % suffix is already a fraction.
  const ratio = percent || numeric > 1 ? numeric / 100 : numeric;
  return Math.min(SIDE_PANEL_MAX_ALLOWED_WIDTH_RATIO, Math.max(SIDE_PANEL_MIN_WIDTH_RATIO, ratio));
}

// Render a width fraction as an operator-facing percentage ("50%"), or "auto"
// when unset. Pure.
export function formatWidthRatio(ratio) {
  if (ratio === undefined || ratio === null || !Number.isFinite(Number(ratio))) return "auto";
  return `${Math.round(Number(ratio) * 100)}%`;
}

// One-line usage hint for the /image-width command.
export function widthUsageHint() {
  return [
    "Usage: /image-width [25% | 0.25 | auto]",
    `default: ${formatWidthRatio(SIDE_PANEL_MAX_WIDTH_RATIO)} of the terminal width`,
    `range: ${formatWidthRatio(SIDE_PANEL_MIN_WIDTH_RATIO)}-${formatWidthRatio(SIDE_PANEL_MAX_ALLOWED_WIDTH_RATIO)} (the text column always keeps at least 20 columns)`,
  ].join("\n");
}

// Map any accepted spelling (canonical or alias, case-insensitive) to its
// canonical field name.
const KEY_LOOKUP = (() => {
  const lookup = new Map();
  for (const [canonical, spec] of Object.entries(FIELD_SPECS)) {
    lookup.set(canonical.toLowerCase(), canonical);
    for (const alias of spec.aliases || []) lookup.set(alias.toLowerCase(), canonical);
  }
  return lookup;
})();

export const CONFIG_FIELD_NAMES = Object.keys(FIELD_SPECS);

function parseBool(raw) {
  const value = String(raw).trim().toLowerCase();
  if (["true", "on", "yes", "1"].includes(value)) return true;
  if (["false", "off", "no", "0"].includes(value)) return false;
  throw new Error(`expected a boolean (true/false), got "${raw}"`);
}

function parseInteger(raw, spec) {
  const value = String(raw).trim();
  if (spec.nullable && ["", "auto", "none", "null"].includes(value.toLowerCase())) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value.replace(/^\+/, "")) {
    throw new Error(`expected an integer, got "${raw}"`);
  }
  if (parsed < spec.min || parsed > spec.max) {
    throw new Error(`must be between ${spec.min} and ${spec.max}, got ${parsed}`);
  }
  return parsed;
}

function parseEnum(raw, spec) {
  const value = String(raw).trim();
  if (!spec.options.includes(value)) {
    throw new Error(`must be one of ${spec.options.join(", ")}, got "${raw}"`);
  }
  return value;
}

// Split a raw args array/string into key=value tokens. Accepts arrays (from Pi
// command args), a single "k=v k2=v2" string, or "key value" pairs are NOT
// supported — values must be attached with "=".
export function tokenizeConfigArgs(args) {
  if (Array.isArray(args)) return args.flatMap((part) => String(part).split(/\s+/)).filter(Boolean);
  if (args == null) return [];
  return String(args).split(/\s+/).filter(Boolean);
}

// Parse tokens into a validated { field: value } patch. Throws on the first
// invalid key or value with an operator-readable message. A value of undefined
// (for nullable rows reset) is preserved in the patch as an explicit reset.
export function parseConfigPatch(tokens) {
  const patch = {};
  const resets = new Set();
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) throw new Error(`expected key=value, got "${token}"`);
    const rawKey = token.slice(0, eq);
    const rawValue = token.slice(eq + 1);
    const canonical = KEY_LOOKUP.get(rawKey.trim().toLowerCase());
    if (!canonical) {
      throw new Error(`unknown config key "${rawKey}". Known keys: ${CONFIG_FIELD_NAMES.join(", ")}`);
    }
    const spec = FIELD_SPECS[canonical];
    let value;
    try {
      if (spec.kind === "bool") value = parseBool(rawValue);
      else if (spec.kind === "int") value = parseInteger(rawValue, spec);
      else if (spec.kind === "ratio") value = parseWidthRatioValue(rawValue);
      else value = parseEnum(rawValue, spec);
    } catch (error) {
      throw new Error(`invalid value for ${canonical}: ${error.message}`);
    }
    if (value === undefined) resets.add(canonical);
    patch[canonical] = value;
  }
  return { patch, resets };
}

// Apply a parsed patch to a config object in place, returning the list of
// changed fields as { key, from, to } for confirmation messaging.
export function applyConfigPatch(config, patch) {
  const changes = [];
  for (const [key, value] of Object.entries(patch)) {
    const from = config[key];
    if (from === value) continue;
    config[key] = value;
    changes.push({ key, from, to: value });
  }
  return changes;
}

// Render the current runtime-settable config as a stable "key=value" summary.
export function formatConfigSummary(config) {
  return CONFIG_FIELD_NAMES
    .map((key) => {
      if (key === "widthRatio") return `${key}=${formatWidthRatio(config[key])}`;
      return `${key}=${config[key] === undefined ? "auto" : config[key]}`;
    })
    .join(" ");
}

// One-line usage hint listing the keys and notable enum option sets.
export function configUsageHint() {
  return [
    "Usage: /image-config [key=value ...]",
    `keys: ${CONFIG_FIELD_NAMES.join(", ")}`,
    `placement: ${PREVIEW_PLACEMENTS.join("|")}`,
    `placementMode(graphicsPlacement): ${PLACEMENT_MODE_OPTIONS.join("|")}`,
    `transferMode(transfer): ${TRANSFER_MODE_OPTIONS.join("|")}`,
    `passthrough: ${PASSTHROUGH_OPTIONS.join("|")}`,
    "widthRatio(width): side-rail share of the terminal, e.g. 25% or 0.25 or auto (see /image-width)",
  ].join("\n");
}
