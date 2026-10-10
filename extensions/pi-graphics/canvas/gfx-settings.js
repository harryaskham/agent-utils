// renderer=gfx settings: gfx-core's own options, described by gfxsh
// (`gfxsh settings --json`: the same settings gfxsh's editor shows, with
// your gfxsh config's values). Pi inherits those and keeps its own
// overrides (piGraphics.full.gfx); only what gfx-core draws in Pi is shown.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** gfxsh's sections that mean something on Pi's canvas. */
const SECTIONS = new Set(["Background", "Panes", "Prompt card", "Caret & motion", "Lighting", "CRT"]);
/** …and single settings from others (dialogs, boxes). */
const EXTRA = new Set(["effects.boxes", "effects.frost"]);
/** Settings about a shell's commands or the terminal that Pi has no use for. */
const SKIP = new Set([
  "effects.edge_blend", "effects.pane_gap", "effects.pane_border", "effects.pane_backgrounds",
  "effects.type_in", "effects.stream_in", "effects.stream_ms",
]);

let cache = null;

/** gfxsh's settings description, or null without gfxsh. Cached; `fresh` re-reads. */
export function loadGfxshSettings({ env = process.env, run = spawnSync, fresh = false } = {}) {
  if (cache && !fresh) return cache.value;
  let value = null;
  for (const dir of String(env.PATH || "").split(":")) {
    const exe = join(dir || ".", "gfxsh");
    if (!existsSync(exe)) continue;
    try {
      const r = run(exe, ["settings", "--json"], { encoding: "utf8", timeout: 3000, env });
      if (r.status === 0) value = JSON.parse(String(r.stdout || "").trim().split("\n").pop());
    } catch {}
    break;
  }
  cache = { value };
  return value;
}

/** gfx-core effects as gfxsh is configured (effects.* values that are set). */
export function gfxshEffects(described) {
  const out = {};
  for (const section of described?.sections || []) {
    for (const s of section.settings || []) {
      if (!String(s.key).startsWith("effects.") || s.value === null || s.value === undefined) continue;
      out[s.key.slice(8)] = s.value;
    }
  }
  return out;
}

function stepValues(s) {
  const decimals = s.kind === "int" ? 0 : Number(s.decimals ?? 2);
  const step = Number(s.step) || (s.kind === "int" ? 1 : 0.1);
  const values = [];
  for (let v = Number(s.min); v <= Number(s.max) + step / 2 && values.length < 400; v += step) values.push(Number(v.toFixed(decimals)).toString());
  return values;
}

/**
 * The gfx-core settings Pi offers: [{ section, effect, label, help, values,
 * inherited }] — values as strings; booleans on/off.
 */
export function gfxSettingRows(described) {
  const rows = [];
  for (const section of described?.sections || []) {
    for (const s of section.settings || []) {
      if (!String(s.key).startsWith("effects.") || SKIP.has(s.key)) continue;
      if (!SECTIONS.has(section.title) && !EXTRA.has(s.key)) continue;
      let values;
      if (s.kind === "toggle") values = ["on", "off"];
      else if (s.kind === "choice") values = [...(s.choices || [])];
      else if (s.kind === "float" || s.kind === "int") values = stepValues(s);
      else continue; // free text: set with /gfx full <key> <value>
      let inherited = s.value ?? s.default;
      // (f32 values arrive with float noise: 0.800000011920929)
      if (s.kind === "float" && typeof inherited === "number") inherited = Number(inherited.toFixed(Number(s.decimals ?? 2)));
      rows.push({
        section: SECTIONS.has(section.title) ? section.title : "Dialogs & boxes",
        effect: s.key.slice(8),
        label: s.label,
        help: s.help,
        kind: s.kind,
        values,
        inherited: typeof inherited === "boolean" ? (inherited ? "on" : "off") : inherited === null || inherited === undefined ? "" : String(inherited),
      });
    }
  }
  return rows;
}

/** A row's value as gfx-core takes it. */
export function gfxSettingValue(row, text) {
  if (row.kind === "toggle") return !/^(off|false|0|no)$/i.test(String(text));
  if (row.kind === "float" || row.kind === "int") return Number(text);
  return String(text);
}
