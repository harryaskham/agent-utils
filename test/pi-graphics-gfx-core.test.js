import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { parseAnsiLine } from "../extensions/pi-graphics/canvas/ansi-cells.js";
import { createGfxCoreEngine, findGfxWasm, toGfxFrame } from "../extensions/pi-graphics/canvas/gfx-core-engine.js";
import { semanticMarker } from "../extensions/pi-graphics/canvas/semantics.js";

const mark = (role, kind, block, line, state = {}) => semanticMarker(role, block, line, kind || state.streaming || state.error ? { kind, ...state } : false);

function screen(lines, width = 40) {
  return lines.map((line) => ({ cells: parseAnsiLine(line, width).cells }));
}

test("renderer=gfx maps Pi's rows and semantics to gfx-core blocks", () => {
  const rows = screen([
    `${mark("user", "", "1", 0)}\x1b[1mexplain this\x1b[0m`,
    "",
    `${mark("assistant", "", "2", 0)}It draws panes.`,
    `${mark("assistant", "", "2", 1)}And \x1b[38;2;163;190;140mbadges\x1b[0m.`,
    "",
    `${mark("tool", "bash", "3", 0, { streaming: true })}⚙ bash cargo test`,
    `${mark("tool", "bash", "3", 1, { streaming: true })}ok`,
    "",
    "────────────────",
    "› hello",
  ]);
  const frame = toGfxFrame(rows, { cursor: { row: 9, col: 7 }, editor: { x: 0, y: 8, width: 40, height: 2 } });
  assert.equal(frame.rows.length, 10);
  // styled runs: bold user text; a green word
  assert.deepEqual(frame.rows[0][0].slice(0, 1), ["explain this"]);
  assert.equal(frame.rows[0][0][3] & 1, 1);
  assert.ok(frame.rows[3].some(([text, fg]) => text === "badges" && fg && fg[1] === 190));
  // the editor's rule line is cleared (the input card replaces it)
  assert.match(frame.rows[8].map((r) => r[0]).join(""), /^\s*$/);
  const [user, assistant, tool, editor] = frame.blocks;
  assert.deepEqual([user.prompt, user.end, user.badge], [0, 1, "you"]);
  assert.deepEqual([assistant.prompt, assistant.output, assistant.end], [2, 2, 4], "messages are all body");
  assert.deepEqual([tool.prompt, tool.output, tool.end, tool.status], [5, 6, 7, "running"], "tools: header + output, running while streaming");
  assert.deepEqual(editor, { prompt: 8, status: "prompt" });
  assert.deepEqual(frame.cursor, [7, 9]);
});

test("renderer=gfx renders through gfx-core (WebAssembly) when installed", { skip: !findGfxWasm() && "gfx_wasm.wasm not found (gfxsh / $PI_GFX_WASM)" }, async () => {
  const font = spawnSync("fc-match", ["-f", "%{file}", "monospace"], { encoding: "utf8" }).stdout.trim();
  const engine = await createGfxCoreEngine({ wasmPath: findGfxWasm(), font, cols: 50, rows: 12, cell: [10, 20], effects: { background: "static" } });
  const rows = screen([`${mark("user", "", "1", 0)}hello`, "", `${mark("tool", "bash", "2", 0)}⚙ bash ls`, `${mark("tool", "bash", "2", 1)}a b c`]);
  while (rows.length < 12) rows.push({ cells: parseAnsiLine("", 48).cells });
  const out = engine.frame(toGfxFrame(rows, { cursor: { row: 0, col: 5 } }));
  assert.match(out, /\x1b_Ga=t,f=100/, "uploads images");
  assert.match(out, /\x1b_Ga=p,/, "places them");
  const again = engine.frame(toGfxFrame(rows, { cursor: { row: 0, col: 5 } }));
  assert.ok(again.length < out.length / 4, "an unchanged frame is (nearly) free");
  assert.match(engine.clear(), /a=d/);
  engine.drop();
});
