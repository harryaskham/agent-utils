// Pure presentation state for the choice modal. Selection stays in ChoiceStateMachine.
import { stripVTControlCharacters } from "node:util";
import { charCellWidth } from "../pi-graphics/ansi-width.js";

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emoji = /^\p{RGI_Emoji}$/v;
const marks = /^(?:\p{Mark}|\p{Default_Ignorable_Code_Point})+$/u;
// Match the host terminal's conservative cell allocation for spacing marks.
const spacingMark = /^(?:[\p{Spacing_Mark}--[\u1734\u302E\u302F]]|[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E])$/v;
export const CHOICE_TEXT_ROWS = 5;

// Leave at least half the terminal to the transcript; tall windows need no more
// than eighteen rows for the choice dock. Fullscreen is an explicit preference.
export function choicePanelRows(rows, fullscreen = false) {
  const height = Math.max(0, Math.trunc(Number(rows) || 0));
  return fullscreen ? height : Math.min(18, Math.max(height ? 1 : 0, Math.floor(height / 2)));
}

export function choicePlainText(value) {
  return stripVTControlCharacters(String(value ?? "")).replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}
function glyphWidth(text) {
  if (emoji.test(text)) return 2;
  let width = 0;
  for (const ch of text) {
    if (spacingMark.test(ch)) { width++; continue; }
    if (marks.test(ch)) continue;
    const cp = ch.codePointAt(0);
    width += (cp >= 0x20000 && cp <= 0x3fffd) || (cp >= 0x1f1e6 && cp <= 0x1f1ff) ? 2 : charCellWidth(ch);
  }
  return width;
}
export function choiceTextWidth(text) {
  let width = 0;
  for (const { segment } of segments.segment(choicePlainText(text))) width += glyphWidth(segment);
  return width;
}
export function fitChoiceText(value, width, ellipsis = "…") {
  const text = choicePlainText(value).replace(/\n/g, " ");
  if (width <= 0) return "";
  if (choiceTextWidth(text) <= width) return text;
  let out = "", used = 0;
  const limit = Math.max(0, width - choiceTextWidth(ellipsis));
  for (const { segment } of segments.segment(text)) {
    const cells = glyphWidth(segment);
    if (used + cells > limit) break;
    out += segment; used += cells;
  }
  return out + (choiceTextWidth(ellipsis) <= width ? ellipsis : "");
}
export function wrapChoiceText(value, width) {
  if (width <= 0) return [];
  const result = [];
  for (const paragraph of choicePlainText(value).split("\n")) {
    let line = "", used = 0;
    const flush = () => { result.push(line); line = ""; used = 0; };
    for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
      const cells = choiceTextWidth(word);
      if (used && used + 1 + cells > width) flush();
      if (used) { line += " "; used++; }
      for (const { segment } of segments.segment(word)) {
        const n = glyphWidth(segment);
        if (used + n > width && line) flush();
        // A two-cell glyph cannot fit a one-cell terminal; keep that case bounded.
        line += n > width ? "�" : segment;
        used += Math.min(n, width);
      }
    }
    flush();
  }
  return result;
}
const clamp = (n, max) => Math.max(0, Math.min(Math.max(0, max), Math.trunc(Number(n) || 0)));
const colored = (theme, name, text) => { try { return theme?.fg?.(name, text) ?? text; } catch { return text; } };
const bold = (theme, text) => { try { return theme?.bold?.(text) ?? text; } catch { return text; } };

// One registry for modal view keys and help. Does not include selection/freeform keys.
export const CHOICE_VIEW_KEYS = Object.freeze([
  { action: "toggle", label: "v expand", keys: ["v", "V", "\x1b[118u", "\x1b[118;1u"] },
  { action: "toggle-fullscreen", label: "f fullscreen/bottom", keys: ["f", "F", "\x1b[102u", "\x1b[102;1u"] },
  { action: "focus", label: "Tab focus", keys: ["\t", "\x1b[9u", "\x1b[9;1u", "\x1b[Z"] },
  { action: "page-up", label: "PgUp/PgDn text", keys: ["\x1b[5~", "["] },
  { action: "page-down", keys: ["\x1b[6~", "]"] },
  { action: "question-up", label: "Shift+PgUp/PgDn question", keys: ["\x1b[5;2~", "{"] },
  { action: "question-down", keys: ["\x1b[6;2~", "}"] },
  { action: "list-up", label: "Ctrl+PgUp/PgDn list", keys: ["\x1b[5;5~", "<"] },
  { action: "list-down", keys: ["\x1b[6;5~", ">"] },
  { action: "home", keys: ["\x1b[H", "\x1b[1~", "\x1bOH"] },
  { action: "end", keys: ["\x1b[F", "\x1b[4~", "\x1bOF"] },
  { action: "help", label: "? keys", keys: ["?"] },
]);
export function choiceViewKey(data) {
  const kitty = /^\x1b\[(\d+)(?::[\d:]+)?(?:;(\d+)(?::(\d+))?)?(?:;[\d:]+)?u$/.exec(data);
  if (kitty && kitty[3] !== "3" && (!kitty[2] || ["1", "2"].includes(kitty[2]))) {
    if ([86, 118].includes(Number(kitty[1]))) return "toggle";
    if ([70, 102].includes(Number(kitty[1]))) return "toggle-fullscreen";
    if (Number(kitty[1]) === 9) return "focus";
  }
  const normalized = String(data).replace(/;([125]):[12](?=[~ABHF])/g, ";$1").replace(/^\x1b\[([56]);1~$/, "\x1b[$1~");
  return CHOICE_VIEW_KEYS.find(entry => entry.keys.includes(normalized))?.action ?? null;
}

export class ChoiceView {
  constructor({ expanded = true, fullscreen = false } = {}) {
    this.expanded = expanded;
    this.fullscreen = fullscreen;
    this.focus = "choices";
    this.questionOffset = 0;
    this.choiceOffsets = new Map();
    this.listOffset = 0;
    this.help = false;
    this.layout = null;
    this.cache = new Map();
    this.previousIndex = null;
    this.previousQuestion = null;
    this.ensureSelection = true;
  }
  setExpanded(expanded) { this.expanded = expanded; this.listOffset = 0; this.ensureSelection = true; }
  invalidate() { this.layout = null; }
  wrapped(text, width) {
    const key = `${width}\0${text}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const value = wrapChoiceText(text, width);
    // At most two geometries of question/option content; no session-global cache.
    if (this.cache.size >= 64) this.cache.clear();
    this.cache.set(key, value);
    return value;
  }
  scroll(region, delta, index = this.layout?.index) {
    const layout = this.layout;
    if (!layout) return false;
    if (region === "question") this.questionOffset = clamp(this.questionOffset + delta, layout.question.total - layout.question.height);
    else if (region === "list") this.listOffset = clamp(this.listOffset + delta, layout.list.total - layout.list.height);
    else {
      const block = layout.blocks[index];
      if (!block) return false;
      this.choiceOffsets.set(block.id, clamp((this.choiceOffsets.get(block.id) || 0) + delta, block.total - block.height));
    }
    return true;
  }
  input(action) {
    if (action === "focus") { this.focus = this.focus === "question" ? "choices" : "question"; return true; }
    if (action === "help") { this.help = !this.help; return true; }
    if (action === "question-up" || action === "question-down") return this.scroll("question", action.endsWith("down") ? CHOICE_TEXT_ROWS : -CHOICE_TEXT_ROWS);
    if (action === "list-up" || action === "list-down") return this.scroll("list", (action.endsWith("down") ? 1 : -1) * Math.max(1, (this.layout?.list.height || 2) - 1));
    if (action === "page-up" || action === "page-down") return this.scroll(this.focus === "question" ? "question" : "choice", action.endsWith("down") ? CHOICE_TEXT_ROWS : -CHOICE_TEXT_ROWS);
    if (action === "home" || action === "end") return this.scroll(this.focus === "question" ? "question" : "choice", action === "home" ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER);
    if (this.focus === "question" && ["up", "down"].includes(action)) return this.scroll("question", action === "down" ? 1 : -1);
    return false;
  }
  // The host sets rowOffset for the bottom-anchored dock. Wheel reads its pane,
  // never changes selection. Clicks return intents for the extension input bus.
  mouse(data, columns, rows) {
    const event = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
    if (!event) return null;
    const layout = this.layout;
    if (!layout || layout.width !== columns || layout.terminalRows !== rows) return { type: "ignored" };
    const button = Number(event[1]), x = Number(event[2]) - 1, y = Number(event[3]) - 1 - (layout.rowOffset || 0);
    if (x < 0 || x >= layout.width || y < 0 || y >= layout.height) return { type: "ignored" };
    if (event[4] === "m" || button & 32) return { type: "ignored" };
    if (button & 64) {
      const delta = button & 1 ? 2 : -2;
      if (y >= layout.question.top && y < layout.question.top + layout.question.height) this.scroll("question", delta);
      else if (y >= layout.list.top && y < layout.list.top + layout.list.height) {
        const hit = layout.hitRows[y];
        if (hit?.overflow && x >= layout.textIndent) this.scroll("choice", delta, hit.index);
        else this.scroll("list", delta);
      }
      return { type: "render" };
    }
    if ((button & 3) !== 0) return { type: "ignored" };
    if (y === 0) return { type: "toggle" };
    if (y >= layout.question.top && y < layout.question.top + layout.question.height) { this.focus = "question"; return { type: "render" }; }
    const hit = layout.hitRows[y];
    if (hit) return { type: "choose", index: hit.index };
    return { type: "ignored" };
  }
  render({ question, choices, index, freeformMode, freeformText, timeoutMs = 0 }, width, terminalRows, theme) {
    const w = Math.max(0, Math.trunc(Number(width) || 0));
    const h = Math.max(0, Math.trunc(Number(terminalRows) || 0));
    if (!w || !h) { this.layout = null; return []; }
    const paint = (role, text) => colored(theme, role, text);
    const fit = (text) => fitChoiceText(text, w);
    const indent = Math.min(5, Math.max(0, w - 2));
    const textWidth = Math.max(1, w - indent);
    if (this.previousQuestion !== question) {
      this.questionOffset = 0; this.listOffset = 0; this.choiceOffsets.clear(); this.ensureSelection = true;
      this.previousQuestion = question;
    }
    if (this.previousIndex !== index) { this.ensureSelection = true; this.previousIndex = index; }
    if (this.lastWidth !== w || this.lastHeight !== h) this.ensureSelection = true;
    this.lastWidth = w; this.lastHeight = h;
    const compact = !this.expanded;
    const questionLines = this.wrapped(question, Math.max(1, w - Math.min(2, w - 1)));
    let footer = freeformMode === "text"
      ? [fit(`Reply: ${freeformText || ""}▏`), fit("Enter submit · Esc back · Backspace delete")]
      : freeformMode === "ptt"
        ? [fit("PTT reply · recording/transcribing…"), fit("Enter/Space finish · Esc/Ctrl-C cancel")]
        : [fit(w >= 75 ? "↑↓/jk choices · Enter/1–9 choose · i reply · Space PTT · Esc/q cancel" : w >= 36 ? "↑↓ pick · Enter · v/f view · ? help" : "↑↓ · Enter · v/f · ?")];
    const mode = this.expanded ? "Expanded" : "Compact";
    const title = fit(`◇ Choice · ${index + 1}/${choices.length} · v ${mode}${w >= 60 ? ` · f ${this.fullscreen ? "Bottom" : "Fullscreen"}` : " · f"}${timeoutMs > 0 ? ` · ${Math.ceil(timeoutMs / 1000)}s` : ""}`);
    if (this.help && !freeformMode) footer = [
      ...wrapChoiceText("↑↓/jk choices · Enter/1–9 choose · i text reply · Space PTT · Esc/q cancel", w),
      ...wrapChoiceText(CHOICE_VIEW_KEYS.filter(k => k.label).map(k => k.label).join(" · "), w),
      ...wrapChoiceText("Home/End text ends · [ ] details · { } question · < > list · Wheel scroll · Click choose", w),
    ];
    // Collapse chrome before the primary option. The last option/text line remains
    // reachable even when the host shrinks to a very short terminal.
    footer = footer.slice(0, Math.min(footer.length, Math.max(0, h - (freeformMode ? 1 : 5))));
    const chrome = 1 + footer.length;
    const questionHeight = Math.min(compact ? 1 : CHOICE_TEXT_ROWS, questionLines.length, Math.max(0, h - chrome - (h >= 10 ? 6 : 3)));
    this.questionOffset = clamp(this.questionOffset, questionLines.length - questionHeight);
    const questionHeader = questionHeight > 0 && h - chrome - questionHeight >= 3;
    const listHeader = h - chrome - questionHeight - Number(questionHeader) >= 2;
    const listHeight = Math.max(1, h - chrome - questionHeight - Number(questionHeader) - Number(listHeader));
    const blocks = choices.map((choice, i) => {
      const headline = choice.headline || choice.label;
      const content = [{ role: "headline", text: headline }];
      if (choice.label && choice.label.trim().toLowerCase() !== headline.trim().toLowerCase()) content.push({ role: "label", text: choice.label });
      if (choice.summary) content.push({ role: "summary", text: choice.summary });
      const all = content.flatMap(part => this.wrapped(part.text, textWidth).map(text => ({ ...part, text })));
      const total = all.length;
      const maxRows = Math.max(1, listHeight - (total > Math.min(CHOICE_TEXT_ROWS, listHeight) ? 1 : 0));
      const height = Math.min(total, compact ? Math.min(content.length, 2) : CHOICE_TEXT_ROWS, maxRows);
      const id = choice.id || String(i);
      const offset = compact ? 0 : clamp(this.choiceOffsets.get(id) || 0, total - height);
      if (!compact) this.choiceOffsets.set(id, offset);
      const compactContent = [content[0], content.find(part => part.role === "summary") || content[1]].filter(Boolean);
      const visible = compact
        ? compactContent.slice(0, height).map(part => ({ ...part, text: fitChoiceText(part.text, textWidth) }))
        : all.slice(offset, offset + height);
      return { id, index: i, total, height, offset, overflow: !compact && total > height, visible };
    });
    const listLines = [], listHits = [];
    for (const block of blocks) {
      block.start = listLines.length;
      const selected = block.index === index;
      for (let row = 0; row < block.visible.length; row++) {
        const part = block.visible[row];
        const prefix = row === 0 ? `${selected ? "◆" : "·"} ${block.index + 1}. ` : " ".repeat(5);
        const prefixText = fitChoiceText(prefix, indent, "");
        const lead = paint(selected ? "accent" : "muted", prefixText);
        const text = selected && part.role === "headline" ? paint("accent", bold(theme, part.text)) : paint(part.role === "label" ? "muted" : "text", part.text);
        listLines.push(lead + text);
        listHits.push({ index: block.index, overflow: block.overflow });
      }
      if (block.overflow && listHeight > 1) {
        const hint = `${block.offset > 0 ? "↑" : "·"} ${block.offset + 1}–${block.offset + block.height}/${block.total} ${block.offset + block.height < block.total ? "↓" : "·"}${selected ? "  PgUp/PgDn" : ""}`;
        listLines.push(" ".repeat(indent) + paint(selected ? "accent" : "muted", fitChoiceText(hint, textWidth)));
        listHits.push({ index: block.index, overflow: true });
      }
      block.end = listLines.length;
    }
    const selectedBlock = blocks[index];
    if (this.ensureSelection && selectedBlock) {
      if (selectedBlock.start < this.listOffset) this.listOffset = selectedBlock.start;
      else if (selectedBlock.end > this.listOffset + listHeight) this.listOffset = selectedBlock.end - listHeight;
      this.ensureSelection = false;
    }
    this.listOffset = clamp(this.listOffset, listLines.length - listHeight);
    const lines = [paint("accent", bold(theme, title))];
    if (questionHeader) lines.push(paint(this.focus === "question" ? "accent" : "muted", fit(`Question${questionLines.length > questionHeight ? ` ${this.questionOffset + 1}–${this.questionOffset + questionHeight}/${questionLines.length} ↑↓` : ""} · Tab focus`)));
    const questionTop = lines.length;
    lines.push(...questionLines.slice(this.questionOffset, this.questionOffset + questionHeight).map(line => " ".repeat(Math.min(2, w - 1)) + paint("text", line)));
    if (listHeader) lines.push(paint(this.focus === "choices" ? "accent" : "muted", fit(`Choices${listLines.length > listHeight ? ` ${this.listOffset + 1}–${Math.min(listLines.length, this.listOffset + listHeight)}/${listLines.length} ↑↓` : ""}${this.focus === "choices" ? " · PgUp/PgDn text" : ""}`)));
    const listTop = lines.length, hitRows = {};
    const visibleList = listLines.slice(this.listOffset, this.listOffset + listHeight);
    visibleList.forEach((line, row) => { lines.push(line); hitRows[listTop + row] = listHits[this.listOffset + row]; });
    // Fill only the allocated dock/fullscreen region, covering the suspended
    // editor and anchoring controls without obscuring the transcript above.
    while (this.fullscreen && lines.length < h - footer.length) lines.push("");
    lines.push(...footer.map(line => paint("muted", line)));
    this.layout = { width: w, terminalRows: h, height: Math.min(lines.length, h), index, textIndent: indent,
      question: { top: questionTop, height: questionHeight, total: questionLines.length, offset: this.questionOffset },
      list: { top: listTop, height: visibleList.length, total: listLines.length, offset: this.listOffset }, blocks, hitRows };
    return lines.slice(0, h);
  }
}
