import { writeFileSync } from "node:fs";
// Renders every speech indicator state on Nord editor rails as HTML for visual
// review: node scripts/speech-indicator-review.mjs [out-dir]; then screenshot
// review.html (it expects FiraCodeNerdFontMono-Regular.ttf beside it).
import { buildEditorChipRails, resolveEditorChipsConfig } from "../extensions/lib/editor-chips.js";
const COLORS = { borderMuted: [59,66,82], borderAccent: [143,188,187], thinkingHigh: [143,188,187], thinkingOff: [76,86,106], thinkingMinimal: [129,161,193], success: [163,190,140], warning: [235,203,139], error: [191,97,106], muted: [129,161,193], text: [236,239,244] }; // kitty-graphics-nord-transparent
const theme = { getFgAnsi: (t) => { const [r,g,b] = COLORS[t] || COLORS.text; return `\x1b[38;2;${r};${g};${b}m`; } };
const config = resolveEditorChipsConfig({ agentUtils: { editorChips: { enabled: true, topLeft: ["speech"], topRight: ["model","effort"], topCenter: ["directory"], bottomLeft: ["meter"], bottomCenter: ["branch","diff"], bottomRight: ["mcp","cost","context"] } } }, {});
const base = { provider: "github-copilot", model: "claude-opus-5.5", effort: "high", mcpCount: 19, cost: 12.4, contextPct: 31, contextMax: 1000000, directory: "~/cosmos/projects/agent-utils", branch: "main", inGitRepo: true, additions: 120, deletions: 14 };
const states = [
  ["no voice mode", { phase: "disabled" }],
  ["/ptt armed", { phase: "armed", surface: "PTT", hint: "⌃␣ talk" }],
  ["PTT on air (quiet)", { phase: "on-air", surface: "PTT", hint: "⌃␣ send", meter: true, level: 0.12, db: -48, threshold: 0.14 }],
  ["PTT on air (speech, chunk transcribing)", { phase: "on-air", surface: "PTT", hint: "⌃␣ send", meter: true, level: 0.62, db: -24, threshold: 0.14, transcribing: true }],
  ["PTT on air (loud)", { phase: "on-air", surface: "PTT", hint: "⌃␣ send", meter: true, level: 1, db: -3, threshold: 0.14 }],
  ["PTT sending", { phase: "transcribing", surface: "PTT", hint: "sending", transcribing: true }],
  ["sent", { phase: "sent", surface: "PTT", hint: "sent" }],
  ["/stt listening", { phase: "listening", surface: "STT", meter: true, level: 0.05, db: -60, threshold: 0.14 }],
  ["/stt speech", { phase: "on-air", surface: "STT", meter: true, level: 0.5, db: -27, threshold: 0.14 }],
  ["/stt transcribing", { phase: "transcribing", surface: "STT", meter: true, level: 0.08, db: -55, threshold: 0.14, transcribing: true }],
  ["agent speaking", { phase: "muted", surface: "STT", hint: "agent speaking" }],
  ["STT error", { phase: "error", surface: "STT", hint: "stt failed" }],
];
const esc = (t) => t.replace(/&/g,"&amp;").replace(/</g,"&lt;");
function html(line) {
  let fg = "#d8dee9", bg = "transparent", out = "";
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    const m = /^\x1b\[([0-9;]*)m$/.exec(part);
    if (m) { const c = m[1].split(";").map(Number); if (c[0]===0) { fg="#d8dee9"; bg="transparent"; } else if (c[0]===38) fg=`rgb(${c[2]},${c[3]},${c[4]})`; else if (c[0]===48) bg=`rgb(${c[2]},${c[3]},${c[4]})`; continue; }
    if (part) out += `<span style="color:${fg};background:${bg}">${esc(part)}</span>`;
  }
  return out;
}
let body = "";
for (const width of [120, 64]) for (const [label, speech] of states) {
  const rails = buildEditorChipRails({ width, config, values: { ...base, speech }, theme });
  body += `<div class=label>${label} · ${width} cols</div><pre>${html(rails.top)}\n<span style="color:#d8dee9"> draft text…</span>\n${html(rails.bottom)}</pre>`;
}
const outDir = process.argv[2] || "/tmp/speech-chip-review";
writeFileSync(`${outDir}/review.html`, `<!doctype html><meta charset=utf-8><style>@font-face{font-family:NF;src:url(FiraCodeNerdFontMono-Regular.ttf)}body{background:#2e3440;margin:16px;font:14px NF,monospace}pre{font:14px/1.25 NF,monospace;margin:2px 0 12px}.label{color:#81a1c1;font:12px sans-serif}</style>${body}`);
