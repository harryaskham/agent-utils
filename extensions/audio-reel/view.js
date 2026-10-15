// Audio reel presentation: a two-line passive widget and an interactive
// overlay (keyboard + SGR mouse). Pure over state/playback snapshots; actions
// are returned as intents for the extension controller.
import { choiceTextWidth, fitChoiceText } from "../lib/choice-layout.js";
import { describeAudioOutput } from "./playback.js";
import { formatClock, formatItemDetail, itemName } from "./state.js";

const paint = (theme, role, text) => {
  if (!role || !text) return text;
  try { return theme?.fg?.(role, text) ?? text; } catch { return text; }
};
const strong = (theme, text) => { try { return theme?.bold?.(text) ?? text; } catch { return text; } };

export const STATUS_GLYPHS = Object.freeze({ playing: "▶", paused: "‖", stopped: "■", ended: "■", idle: "·", error: "!" });

/// Current clip plus its live player state (only when the player owns it).
export function playbackView(state, snapshot = {}) {
  const item = state.items[state.index];
  const owned = item && snapshot.key === item.key;
  const status = owned ? snapshot.status : "idle";
  const durationMs = owned && Number.isFinite(snapshot.durationMs) ? snapshot.durationMs : item?.durationMs;
  // Sink buffering (or a duration probed after playback began) must never
  // show a position past the end of the clip.
  const raw = owned ? snapshot.positionMs || 0 : 0;
  const positionMs = Number.isFinite(durationMs) ? Math.min(raw, durationMs) : raw;
  return { item, index: state.index, status, positionMs, durationMs, error: owned ? snapshot.error : null };
}

/// Who shared a clip, compactly: operator additions and anonymous sessions
/// (no Cacophony identity) get readable names instead of raw session IDs.
export function agentLabel(item) {
  if (!item) return "";
  if (item.origin === "operator") return "you";
  if (!item.agent || /^session-/.test(item.agent)) return "this session";
  return item.agent;
}

/// Compose styled segments into one line no wider than `width`, recording
/// clickable cell ranges. One optional `flex` segment absorbs truncation.
export function composeSegments(segments, width, theme) {
  const w = Math.max(0, Math.trunc(width));
  const fixed = segments.filter((s) => !s.flex).reduce((sum, s) => sum + choiceTextWidth(s.text), 0);
  const flexBudget = Math.max(0, w - fixed);
  let x = 0, line = "";
  const hits = [];
  for (const segment of segments) {
    const room = w - x;
    if (room <= 0) break;
    const budget = segment.flex ? Math.min(room, flexBudget) : room;
    let text = fitChoiceText(segment.text, budget, segment.flex ? "…" : "");
    if (segment.flex && segment.pad) text = text + " ".repeat(Math.max(0, budget - choiceTextWidth(text)));
    const cells = choiceTextWidth(text);
    if (!cells) continue;
    if (segment.action) hits.push({ x0: x, x1: x + cells, action: segment.action });
    let styled = paint(theme, segment.role, text);
    if (segment.bold) styled = strong(theme, styled);
    line += styled;
    x += cells;
  }
  return { line, hits, width: x };
}

export function progressBar(positionMs, durationMs, width) {
  const cells = Math.max(0, Math.trunc(width));
  if (!cells) return "";
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "─".repeat(cells);
  const at = Math.max(0, Math.min(cells - 1, Math.round((positionMs / durationMs) * (cells - 1))));
  return "━".repeat(at) + "●" + "─".repeat(cells - at - 1);
}

function statusRole(status) {
  return status === "playing" ? "success" : status === "error" ? "error" : status === "paused" ? "warning" : "muted";
}

/// Passive widget: now-playing/progress line plus a reel strip.
export function renderReelWidget({ state, snapshot, width, theme, hint = "/audio-reel" }) {
  const w = Math.max(1, Math.trunc(width || 1));
  if (!state.visible || !state.items.length) return [];
  const view = playbackView(state, snapshot);
  const glyph = STATUS_GLYPHS[view.status] || "·";
  const clock = `${formatClock(view.positionMs, view.durationMs)} / ${formatClock(view.durationMs)}`;
  const barWidth = Math.max(0, Math.min(40, Math.floor(w * 0.3)));
  const head = [
    { text: "♪ ", role: "accent" },
    { text: `${glyph} `, role: statusRole(view.status) },
    { text: `${view.index + 1}/${state.items.length} `, role: "muted" },
    { text: itemName(view.item), role: "text", bold: view.status === "playing", flex: true, pad: true },
    ...(barWidth >= 8 && w >= 60 ? [{ text: ` ${progressBar(view.positionMs, view.durationMs, barWidth)}`, role: "accent" }] : []),
    { text: ` ${clock}`, role: "muted" },
  ];
  const lines = [composeSegments(head, w, theme).line];
  const status = view.status === "error" && view.error
    ? [{ text: `  ${view.error}`, role: "error", flex: true }]
    : [
      { text: "  ", role: "muted" },
      ...stripSegments(state, w),
      { text: `  vol ${state.config.volume}%${state.config.repeat !== "off" ? ` · repeat ${state.config.repeat}` : ""} · ${hint}`, role: "dim" },
    ];
  lines.push(composeSegments(status, w, theme).line);
  return lines;
}

function stripSegments(state, width) {
  // Neighbours around the current clip, compact enough for one line.
  const out = [];
  const budget = Math.max(0, width - 44);
  let used = 0;
  const start = Math.max(0, state.index - 2);
  for (let i = start; i < state.items.length && used < budget; i++) {
    const current = i === state.index;
    const label = `${current ? "[" : ""}${i + 1} ${fitChoiceText(itemName(state.items[i]), 18)}${current ? "]" : ""}`;
    const cell = `${out.length ? "  " : ""}${label}`;
    if (used + choiceTextWidth(cell) > budget) { out.push({ text: " …", role: "dim" }); break; }
    out.push({ text: cell, role: current ? "accent" : "dim" });
    used += choiceTextWidth(cell);
  }
  return out;
}

// ---- keyboard --------------------------------------------------------------

const CSI_U = /^\x1b\[(\d+)(?::\d+)*(?:;(\d+)(?::(\d+))?)?u$/;
const CSI_ARROW = /^\x1b\[(?:1;(\d+)(?::(\d+))?)?([ABCDHF])$/;
const SS3 = /^\x1bO([ABCDHF])$/;
const ARROWS = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const KITTY_FUNCTIONAL = { 57350: "left", 57351: "right", 57352: "up", 57353: "down", 57356: "home", 57357: "end", 57349: "delete" };

/// Normalize legacy, application-cursor and Kitty CSI-u keys. Releases and
/// paste are ignored (null).
export function normalizeReelKey(data) {
  const key = String(data ?? "");
  if (!key || key.includes("\x1b[200~")) return null;
  if (key === "\x1b") return "escape";
  if (key === "\r" || key === "\n") return "enter";
  if (key === "\x7f" || key === "\b") return "backspace";
  if (key === "\x1b[3~") return "delete";
  if (key === "\x1b[1~" || key === "\x1b[7~") return "home";
  if (key === "\x1b[4~" || key === "\x1b[8~") return "end";
  if (key === "\x1b[5~") return "pageup";
  if (key === "\x1b[6~") return "pagedown";
  let m = SS3.exec(key);
  if (m) return ARROWS[m[1]];
  m = CSI_ARROW.exec(key);
  if (m) {
    if (m[2] === "3") return null;
    const shift = m[1] && ((Number(m[1]) - 1) & 1);
    return `${shift ? "shift-" : ""}${ARROWS[m[3]]}`;
  }
  m = CSI_U.exec(key);
  if (m) {
    if (m[3] === "3") return null;
    const code = Number(m[1]);
    const mods = m[2] ? Number(m[2]) - 1 : 0;
    if (mods & ~1) return null; // Ctrl/Alt/Super chords are not reel controls.
    if (KITTY_FUNCTIONAL[code]) return `${mods & 1 && ["left", "right"].includes(KITTY_FUNCTIONAL[code]) ? "shift-" : ""}${KITTY_FUNCTIONAL[code]}`;
    if (code === 27) return "escape";
    if (code === 13) return "enter";
    if (code === 32) return "space";
    if (code === 127) return "backspace";
    const ch = String.fromCodePoint(code);
    return mods & 1 ? ch.toUpperCase() : ch;
  }
  if (key === " ") return "space";
  return [...key].length === 1 ? key : null;
}

export const REEL_KEY_HELP = "↑↓ select · Enter play · Space pause · ←→ ±5s · H/L ±30s · [ ] clip · +/− vol · m mute · s stop · r repeat · x remove · Esc close";

export function reelKeyAction(data) {
  const key = normalizeReelKey(data);
  switch (key) {
    case "escape": case "q": case "Q": return { type: "close" };
    case "up": case "k": return { type: "select", delta: -1 };
    case "down": case "j": return { type: "select", delta: 1 };
    case "pageup": return { type: "select", delta: -10 };
    case "pagedown": return { type: "select", delta: 10 };
    case "home": case "g": return { type: "select", to: 0 };
    case "end": case "G": return { type: "select", to: Infinity };
    case "enter": return { type: "playSelected" };
    case "space": case "p": return { type: "toggle" };
    case "left": case "h": return { type: "seekBy", deltaMs: -5000 };
    case "right": case "l": return { type: "seekBy", deltaMs: 5000 };
    case "shift-left": case "H": return { type: "seekBy", deltaMs: -30000 };
    case "shift-right": case "L": return { type: "seekBy", deltaMs: 30000 };
    case "[": case "<": case ",": return { type: "previous" };
    case "]": case ">": case ".": return { type: "next" };
    case "+": case "=": return { type: "volumeBy", delta: 5 };
    case "-": case "_": return { type: "volumeBy", delta: -5 };
    case "m": case "M": return { type: "mute" };
    case "s": case "S": return { type: "stop" };
    case "r": case "R": return { type: "repeat" };
    case "x": case "X": case "delete": return { type: "removeSelected" };
    default: return null;
  }
}

// ---- overlay ---------------------------------------------------------------

export function reelOverlayHeight(rows, itemCount) {
  const total = Math.max(1, Math.trunc(rows || 24));
  return Math.max(1, Math.min(total, Math.max(9, Math.floor(total * 0.6)), Math.max(9, itemCount + 8)));
}

/// Interactive overlay. `render` stores a hit-test layout; `mouse` converts SGR
/// mouse reports (bottom-anchored overlay) into controller intents.
export class AudioReelView {
  constructor() {
    this.selected = null;
    this.listOffset = 0;
    this.layout = null;
  }

  clampSelection(state) {
    if (this.selected === null || this.selected === undefined) this.selected = state.index;
    this.selected = Math.max(0, Math.min(Math.max(0, state.items.length - 1), this.selected));
    return this.selected;
  }

  select(state, action) {
    this.clampSelection(state);
    if (action.to !== undefined) this.selected = action.to === Infinity ? state.items.length - 1 : action.to;
    else this.selected += action.delta || 0;
    this.clampSelection(state);
  }

  render({ state, snapshot = {}, output, width, height, theme, message = "" }) {
    const w = Math.max(1, Math.trunc(width || 1));
    const h = Math.max(1, Math.trunc(height || 1));
    const rows = [];
    const add = (segments) => { const composed = composeSegments(segments, w, theme); rows.push(composed); return composed; };
    const selected = this.clampSelection(state);
    const view = playbackView(state, snapshot);
    const playing = view.status === "playing";
    const volume = state.config.volume;

    add([
      { text: "♪ Audio reel", role: "accent", bold: true },
      { text: ` · ${state.items.length} clip${state.items.length === 1 ? "" : "s"}`, role: "muted", flex: true, pad: true },
      { text: "  ✕ close ", role: "dim", action: { type: "close" } },
    ]);
    if (view.item) {
      const agent = `${agentLabel(view.item)} · `;
      // The clip name keeps priority; provenance/format details yield first.
      add([
        { text: `${STATUS_GLYPHS[view.status] || "·"} `, role: statusRole(view.status), bold: true },
        { text: `${view.index + 1}/${state.items.length}  `, role: "muted" },
        { text: fitChoiceText(itemName(view.item), Math.max(12, Math.floor(w * 0.6))), role: "text", bold: true },
        { text: `  ${agent}${formatItemDetail(view.item)}`, role: "dim", flex: true },
      ]);
      const left = `${formatClock(view.positionMs, view.durationMs)} `, right = ` ${formatClock(view.durationMs)}`;
      const barCells = Math.max(1, w - choiceTextWidth(left) - choiceTextWidth(right));
      const bar = add([
        { text: left, role: "muted" },
        { text: progressBar(view.positionMs, view.durationMs, barCells), role: playing ? "accent" : "muted" },
        { text: right, role: "muted" },
      ]);
      bar.seekBar = { x0: choiceTextWidth(left), x1: choiceTextWidth(left) + barCells, durationMs: view.durationMs };
    } else {
      add([{ text: "No clip selected", role: "muted" }]);
    }
    // Full labels when they fit (~84 cells), glyph-only buttons otherwise.
    const wide = w >= 84;
    const button = (full, short, action, role = "accent") => [{ text: `[${wide ? full : short}]`, role, action }, { text: " ", role: "dim" }];
    add([
      ...button("« prev", "«", { type: "previous" }),
      ...button("‹ 5s", "‹", { type: "seekBy", deltaMs: -5000 }),
      ...button(playing ? "‖ pause" : "▶ play", playing ? "‖" : "▶", { type: "toggle" }, playing ? "warning" : "success"),
      ...button("■ stop", "■", { type: "stop" }),
      ...button("5s ›", "›", { type: "seekBy", deltaMs: 5000 }),
      ...button("next »", "»", { type: "next" }),
      { text: wide ? "  " : " ", role: "dim" },
      { text: "[−]", role: "accent", action: { type: "volumeBy", delta: -5 } },
      { text: ` ${wide ? "vol " : ""}${String(volume).padStart(3)}% `, role: volume ? "text" : "warning", action: { type: "mute" } },
      { text: "[+]", role: "accent", action: { type: "volumeBy", delta: 5 } },
      { text: wide ? "  " : " ", role: "dim" },
      { text: `[${wide ? "repeat " : "↻ "}${state.config.repeat}]`, role: state.config.repeat === "off" ? "muted" : "accent", action: { type: "repeat" } },
    ]);
    const outputText = view.error ? `error: ${view.error}` : message || (output ? `out: ${describeAudioOutput(output)}` : "");
    const extra = [];
    if (outputText) extra.push([{ text: outputText, role: view.error ? "error" : message ? "warning" : "dim", flex: true }]);
    if (view.item?.description) extra.push([{ text: `“${view.item.description}”`, role: "muted", flex: true }]);
    const hint = w >= 100 ? REEL_KEY_HELP : w >= 60 ? "↑↓ Enter play · Space pause · ←→ seek · [ ] clip · +/− vol · Esc" : "↑↓ · Enter · Space · ←→ · Esc";

    // Chrome before the list; collapse optional rows on short terminals.
    const listRoom = () => h - rows.length - extra.length - 2;
    while (extra.length && listRoom() < Math.min(3, state.items.length || 1)) extra.pop();
    for (const segments of extra) add(segments);
    if (h - rows.length >= 3) add([{ text: "─".repeat(w), role: "dim" }]);
    const listTop = rows.length;
    const listHeight = Math.max(0, h - rows.length - 1);
    if (selected < this.listOffset) this.listOffset = selected;
    if (selected >= this.listOffset + listHeight) this.listOffset = selected - listHeight + 1;
    this.listOffset = Math.max(0, Math.min(this.listOffset, Math.max(0, state.items.length - listHeight)));
    const listRows = [];
    for (let row = 0; row < listHeight; row++) {
      const i = this.listOffset + row;
      const item = state.items[i];
      if (!item) { add([{ text: "" }]); continue; }
      const isCurrent = i === state.index;
      const glyph = isCurrent ? STATUS_GLYPHS[view.status] || "·" : " ";
      const marker = i === selected ? "›" : " ";
      const role = i === selected ? "accent" : isCurrent ? "text" : "muted";
      const composed = add([
        { text: `${marker}${glyph} `, role: isCurrent ? statusRole(view.status) : role, action: { type: "play", index: i } },
        { text: `${String(i + 1).padStart(String(state.items.length).length)}. `, role: "dim", action: { type: "play", index: i } },
        { text: itemName(item), role, bold: i === selected, flex: true, pad: true, action: { type: "play", index: i } },
        { text: `  ${formatClock(item.durationMs)}`, role: "muted", action: { type: "play", index: i } },
        { text: `  ${fitChoiceText(agentLabel(item), 18)}`, role: "dim", action: { type: "play", index: i } },
      ]);
      composed.listIndex = i;
      listRows.push(i);
    }
    add([{ text: state.items.length > listHeight && listHeight > 0 ? `${this.listOffset + 1}–${Math.min(state.items.length, this.listOffset + listHeight)}/${state.items.length} · ${hint}` : hint, role: "dim", flex: true }]);
    const lines = rows.slice(0, h);
    this.layout = { width: w, height: lines.length, rows: lines, listTop, listHeight, count: state.items.length };
    return lines.map((row) => row.line);
  }

  /// SGR mouse (1006) report → intent. `rows` is the terminal height; the
  /// overlay occupies the bottom `layout.height` rows.
  mouse(data, columns, rows) {
    const event = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(String(data ?? ""));
    if (!event) return null;
    const layout = this.layout;
    if (!layout) return { type: "ignored" };
    const button = Number(event[1]);
    const x = Number(event[2]) - 1;
    const y = Number(event[3]) - 1 - (Math.trunc(rows) - layout.height);
    if (y < 0 || y >= layout.height || x < 0 || x >= layout.width) return { type: "ignored" };
    const row = layout.rows[y];
    if (button & 64) {
      const down = (button & 1) === 1;
      if (row?.seekBar) return { type: "seekBy", deltaMs: down ? -5000 : 5000 };
      if (row?.listIndex !== undefined || (y >= layout.listTop && y < layout.listTop + layout.listHeight)) return { type: "scroll", delta: down ? 3 : -3 };
      if (row?.hits.some((hit) => hit.action?.type === "volumeBy")) return { type: "volumeBy", delta: down ? -5 : 5 };
      return { type: "ignored" };
    }
    if (event[4] === "m" || (button & 32) || (button & 3) !== 0) return { type: "ignored" };
    if (row?.seekBar && x >= row.seekBar.x0 && x < row.seekBar.x1) {
      const cells = Math.max(1, row.seekBar.x1 - row.seekBar.x0 - 1);
      return { type: "seekFraction", fraction: Math.max(0, Math.min(1, (x - row.seekBar.x0) / cells)) };
    }
    const hit = row?.hits.find((candidate) => x >= candidate.x0 && x < candidate.x1);
    if (!hit) return row?.listIndex !== undefined ? { type: "play", index: row.listIndex } : { type: "ignored" };
    return hit.action;
  }
}
