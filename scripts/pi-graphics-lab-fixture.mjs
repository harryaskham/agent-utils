// Synthetic, privacy-free Pi session used by the Ghostty/Kitty graphics lab.
// It exercises user/assistant/thinking/tool/bash-like boxes, markdown, code,
// wide glyphs and long wrapped lines so box chrome and fullscreen scrolling
// have realistic content without copying a real transcript.
import { writeFileSync } from "node:fs";

export function writeLabSessionFixture(path, { cwd = process.cwd(), turns = 6 } = {}) {
  const t0 = Date.parse("2026-09-29T10:00:00Z");
  const entries = [];
  let parent = null;
  let n = 0;
  const id = () => (++n).toString(16).padStart(8, "0");
  const push = (entry) => { const e = { id: id(), parentId: parent, timestamp: new Date(t0 + n * 1000).toISOString(), ...entry }; parent = e.id; entries.push(e); };
  entries.push({ type: "session", version: 3, id: "0000lab0-0000-7000-8000-000000000000", timestamp: new Date(t0).toISOString(), cwd });
  const usage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content, stopReason = "stop") => ({ type: "message", message: { role: "assistant", content, api: "anthropic-messages", provider: "anthropic", model: "claude-lab", usage, stopReason, timestamp: t0 + n * 1000 } });
  for (let turn = 0; turn < turns; turn += 1) {
    push({ type: "message", message: { role: "user", content: [{ type: "text", text: turn === 0 ? "Render a quick tour of the graphics surfaces — boxes, code, wide glyphs 漢字 🎨 and a long wrapped line that keeps going well past the edge of a narrow terminal so wrapping is exercised." : `Follow-up ${turn}: show another tool call and summarise.` }], timestamp: t0 + n * 1000 } });
    const callId = `toolu_lab_${turn}`;
    push(assistant([
      { type: "thinking", thinking: `Planning turn ${turn}: inspect files, then explain the renderer pipeline and dirty tiles.` },
      { type: "text", text: `Here is turn **${turn}**. I'll list the extension directory first.` },
      { type: "toolCall", id: callId, name: "bash", arguments: { command: `ls extensions/pi-graphics | head -${4 + turn}` } },
    ], "toolUse"));
    push({ type: "message", message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: ["affordances.js", "box-chrome.js", "canvas-renderer.js", "components.js", "cursor-anchor.js", "editor-render.js", "png-renderer.js", "runtime.js"].slice(0, 4 + turn).join("\n") }], isError: false, timestamp: t0 + n * 1000 } });
    push(assistant([{ type: "text", text: [
      `### Turn ${turn} summary`,
      "",
      "- **Box chrome** frames each message with pixel strips.",
      "- *Cursor glow* follows the edit cursor.",
      "- `unicode` placeholders vs `relative` placements.",
      "",
      "```js",
      "const tile = renderer.tile(x, y); // dirty-rect upload",
      "emit(kitty.frame({ imageId, x, y, rgba }));",
      "```",
      "",
      "| mode | cost | portable |",
      "|------|------|----------|",
      "| unicode | low | yes |",
      "| relative | low | kitty |",
    ].join("\n") }]));
  }
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}
