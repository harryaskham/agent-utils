import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAnsiLine } from "../extensions/pi-graphics/canvas/ansi-cells.js";
import { createGfxCoreEngine, findGfxWasm, toGfxFrame } from "../extensions/pi-graphics/canvas/gfx-core-engine.js";
import { gfxSettingRows, gfxSettingValue, gfxshEffects } from "../extensions/pi-graphics/canvas/gfx-settings.js";
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
  assert.deepEqual(editor, { prompt: 8, end: 10, status: "prompt" }, "the card spans the editor's rows");
  assert.deepEqual(frame.cursor, [7, 9]);
});

test("renderer=gfx: the editor card sits editorPadding out from the text; Pi's cursor cell is not drawn", () => {
  const rows = screen([
    "transcript",
    "────────────────",
    "› hi\x1b[7m \x1b[27m",
    "────────────────",
  ]);
  const editor = { x: 0, y: 1, width: 40, height: 3 };
  // 0.5: the border through the middle of the rule rows (where the chips are)
  const half = toGfxFrame(rows, { cursor: { row: 2, col: 4 }, editor, editorPadding: 0.5 });
  assert.deepEqual(half.card, [-0.5, 1.5, 40.5, 3.5]);
  // 1: their outer edges (the whole box)
  assert.deepEqual(toGfxFrame(rows, { editor, editorPadding: 1 }).card, [-1, 1, 41, 4]);
  // the inverse cell at the cursor is plain (gfx-core draws the caret)
  const cursorRun = half.rows[2].find(([text]) => text.includes(" "));
  assert.ok(half.rows[2].every(([, , bg]) => bg === null), JSON.stringify(half.rows[2]));
  assert.ok(cursorRun);
});

test("renderer=gfx: Pi's overlays become dialog panels; multi-chunk images are read whole", () => {
  const ov = (col, width) => `\x1b_pi:gfx:ov:${col}:${width}\x07`;
  const rows = ["one", `on${ov(4, 10)}dialog`, `tw${ov(4, 10)}dialog`, "three"].map((line) => {
    const r = parseAnsiLine(line, 40);
    return { cells: r.cells, overlay: r.overlay };
  });
  assert.deepEqual(toGfxFrame(rows, {}).floats, [[4, 1, 10, 2]]);
  // Pi sends an image in 4 KB chunks: G a=T,…,m=1 then G m=1 … G m=0
  const line = "\x1b_Ga=T,f=100,i=7,c=4,r=2,m=1;AAAA\x1b\\\x1b_Gm=1;BBBB\x1b\\\x1b_Gm=0;CC\x1b\\";
  assert.equal(parseAnsiLine(line, 20).image.payload, "AAAABBBBCC");
});

test("renderer=gfx settings come from gfxsh's description (inherited, overridable)", () => {
  const described = { sections: [
    { title: "Background", settings: [
      { key: "effects.background", label: "background", kind: "choice", choices: ["aurora", "grid"], value: "grid", default: "aurora" },
      { key: "effects.background_opacity", label: "opacity", kind: "float", min: 0, max: 1, step: 0.25, decimals: 2, value: 0.800000011920929, default: 1 },
    ] },
    { title: "Prompt card", settings: [{ key: "effects.glow", label: "glow", kind: "toggle", value: true }] },
    { title: "App window", settings: [{ key: "app.tabs", label: "tabs", kind: "choice", choices: ["a"], value: "a" }] },
    { title: "Full-screen programs", settings: [{ key: "effects.frost", label: "frost", kind: "float", min: 0, max: 1, step: 0.5, decimals: 2, value: 0.5 }] },
  ] };
  const rows = gfxSettingRows(described);
  assert.deepEqual(rows.map((r) => r.effect), ["background", "background_opacity", "glow", "frost"], "only what Pi draws");
  assert.equal(rows[0].inherited, "grid");
  assert.equal(rows[1].inherited, "0.8", "rounded to the setting's precision");
  assert.deepEqual(rows[1].values, ["0", "0.25", "0.5", "0.75", "1"]);
  assert.equal(rows[2].inherited, "on");
  assert.equal(gfxSettingValue(rows[2], "off"), false);
  assert.equal(gfxSettingValue(rows[1], "0.25"), 0.25);
  assert.deepEqual(gfxshEffects(described), { background: "grid", background_opacity: 0.800000011920929, glow: true, frost: 0.5 });
});

test("renderer=gfx finds gfx-core: setting, $PI_GFX_WASM, beside gfxsh, or `gfxsh wasm`", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gfxwasm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wasm = join(dir, "cached.wasm");
  writeFileSync(wasm, "\0asm");
  // a cargo-installed gfxsh: no share/ beside it; `gfxsh wasm` prints the cached copy
  mkdirSync(join(dir, "bin"));
  const exe = join(dir, "bin", "gfxsh");
  writeFileSync(exe, `#!/bin/sh\n[ "$1" = wasm ] && echo ${wasm}\n`);
  chmodSync(exe, 0o755);
  const env = { PATH: join(dir, "bin") };
  assert.equal(findGfxWasm("", env), wasm, "asks gfxsh");
  assert.equal(findGfxWasm(exe, env), exe, "an explicit path wins");
  assert.equal(findGfxWasm("", { ...env, PI_GFX_WASM: exe }), exe, "then $PI_GFX_WASM");
  // installed with share/ beside the binary: no process spawned
  mkdirSync(join(dir, "share", "gfxsh"), { recursive: true });
  writeFileSync(join(dir, "share", "gfxsh", "gfx_wasm.wasm"), "\0asm");
  let spawned = false;
  const installedWasm = realpathSync(join(dir, "share", "gfxsh", "gfx_wasm.wasm"));
  assert.equal(findGfxWasm("", env, () => { spawned = true; return { status: 1 }; }), installedWasm, "installed lookup follows the real executable (including macOS /var aliases)");
  assert.equal(spawned, false);
  // A package-manager PATH symlink must resolve beside the real executable,
  // not beside the link. Keep this portable regression explicit on Linux too.
  const linkedBin = join(dir, "profile-bin");
  mkdirSync(linkedBin);
  symlinkSync(exe, join(linkedBin, "gfxsh"));
  assert.equal(findGfxWasm("", { PATH: linkedBin }, () => assert.fail("installed lookup must not spawn")), installedWasm);
  assert.equal(findGfxWasm("", { PATH: join(dir, "nowhere") }), "", "no gfxsh: not found");
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
  // gfx-core's own looks pass through (piGraphics.full.gfx); invalid ones are refused
  engine.effects({ background: "static", card_style: "neon", caret: "comet", scanlines: 0.5, crt_frame: 0.5 });
  const styled = engine.frame(toGfxFrame(rows, { cursor: { row: 0, col: 5 } }));
  assert.match(styled, /\x1b_Ga=t,f=100/, "restyled frame re-renders");
  assert.throws(() => engine.effects({ card_style: "velvet" }), /card_style/);
  assert.match(engine.clear(), /a=d/);
  engine.drop();
});

test("renderer=gfx: padding lays the text out as gfxsh does; the card and dialogs come from the host", { skip: !findGfxWasm() && "gfx_wasm.wasm not found (gfxsh / $PI_GFX_WASM)" }, async () => {
  const font = spawnSync("fc-match", ["-f", "%{file}", "monospace"], { encoding: "utf8" }).stdout.trim();
  const engine = await createGfxCoreEngine({ wasmPath: findGfxWasm(), font, cols: 50, rows: 12, cell: [10, 20], padding: [16, 16, 16, 16], effects: { background: "static" } });
  const area = engine.area();
  // padding + a card's inset (12px) at the sides; whole cells, centred
  assert.deepEqual([area.cols, area.rows], [44, 10]);
  assert.ok(area.ox >= 28 && area.oy >= 16, JSON.stringify(area));
  const rows = screen(["hello", "", "────────", "› hi", "────────"], area.cols);
  while (rows.length < area.rows) rows.push({ cells: parseAnsiLine("", area.cols).cells });
  rows[1] = { ...rows[1], overlay: { col: 2, width: 20 } };
  const frame = toGfxFrame(rows, { cursor: { row: 3, col: 4 }, editor: { x: 0, y: 2, width: area.cols, height: 3 }, editorPadding: 0.5 });
  assert.deepEqual(frame.card, [-0.5, 2.5, 44.5, 4.5]);
  assert.deepEqual(frame.floats, [[2, 1, 20, 1]]);
  const out = engine.frame(frame);
  assert.match(out, /\x1b_Ga=p,/, "draws");
  engine.drop();
});
