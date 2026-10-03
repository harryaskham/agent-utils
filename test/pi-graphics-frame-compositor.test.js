import test from "node:test";
import assert from "node:assert/strict";

import { approximateVisibleCells, clampRenderedLineToWidth } from "../extensions/pi-graphics/ansi-width.js";
import {
  analyzeFrame,
  createFrameCompositor,
  createOverlayPlacementSet,
  gfxMarker,
  injectBeforeFrameEnd,
  scanGfxMarkers,
  stripGfxMarkers,
} from "../extensions/pi-graphics/frame-compositor.js";
import { parsePixelGeometryReply, tapTerminalInput } from "../extensions/pi-graphics/terminal-io.js";
import { captureTuiFromUi, createHostComponentRegistry } from "../extensions/pi-graphics/host-components.js";

test("BEL-terminated APC markers are zero-width and never swallow text", () => {
  // Pi's CURSOR_MARKER is `ESC _ pi:c BEL`; the old ST-only pattern consumed
  // everything up to the next ST (here: the kitty APC), mis-measuring columns.
  const cursor = "ab\x1b_pi:c\x07\x1b[7mc\x1b[0md";
  assert.equal(approximateVisibleCells(cursor), 4);
  const line = `${gfxMarker("footer")}abc\x1b[1mdef\x1b[0m\x1b_Ga=p,i=1\x1b\\gh`;
  assert.equal(approximateVisibleCells(line), 8);
  const visible = stripGfxMarkers(clampRenderedLineToWidth(line, 5)).replace(/\x1b_[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(visible, "abcde");
});

test("markers are located at their visible column and stripped from output", () => {
  const lines = ["plain", `  ${gfxMarker("a")}x\x1b[31m漢${gfxMarker("b#1")}y`, "tail"];
  const markers = scanGfxMarkers(lines, { top: 1, height: 2 });
  assert.deepEqual(markers.get("a"), { row: 0, col: 2 });
  assert.deepEqual(markers.get("b#1"), { row: 0, col: 5 });
  assert.equal(stripGfxMarkers(lines[1]), "  x\x1b[31m漢y");
});

test("fullscreen frame analysis reads Pi's IME cursor and placement-clearing commands", () => {
  const renderer = { mode: "fullscreen", terminal: { columns: 40, rows: 10 }, previousScreen: [`${gfxMarker("m")}hi`] };
  const buffer = "\x1b[?2026h\x1b_Ga=d,d=A,q=2\x1b\\\x1b[2J\x1b[1;1H\x1b[2Khi\x1b[8;5H\x1b[?25l\x1b[?2026l";
  const frame = analyzeFrame(renderer, buffer);
  assert.deepEqual(frame.cursor, { row: 7, col: 4 });
  assert.equal(frame.cleared, true);
  assert.equal(frame.freed, true);
  assert.deepEqual(frame.markers.get("m"), { row: 0, col: 0 });
  const regular = analyzeFrame({ mode: "regular", terminal: { columns: 40, rows: 10 }, previousLines: ["a", "b", "c"], previousViewportTop: 1, hardwareCursorRow: 2 }, "\x1b[?2026h\r\x1b[2Kc\x1b[?2026l\x1b[3G\x1b[?25l");
  assert.deepEqual(regular.cursor, { row: 1, col: 2 });
  assert.equal(regular.freed, false);
});

test("overlay placement set emits minimal diffs, crops at edges and re-places after clears", () => {
  const serialize = (control) => `<${Object.entries(control).map(([k, v]) => `${k}=${v}`).join(",")}>`;
  const set = createOverlayPlacementSet({ serialize });
  const frame = { width: 20, height: 10, cleared: false };
  const halo = { key: "cursor", imageId: 7, placementId: 1, row: 1, col: -3, cols: 11, rows: 5, z: -5, cellWidthPx: 10, cellHeightPx: 20 };
  const first = set.update(frame, [halo]);
  assert.match(first, /^\x1b7\x1b\[2;1H<a=p,i=7,p=1,C=1,q=2,z=-5,x=30,y=0,w=80,h=100,c=8,r=5>\x1b8$/);
  assert.equal(set.update(frame, [halo]), "", "unchanged placements emit nothing");
  assert.match(set.update({ ...frame, cleared: true }, [halo]), /a=p/, "a cleared frame re-places");
  const moved = set.update(frame, [{ ...halo, imageId: 8 }]);
  assert.match(moved, /<a=d,d=i,i=7,p=1,q=2>/, "changing image deletes the previous placement");
  assert.match(set.update(frame, []), /<a=d,d=i,i=8,p=1,q=2>/);
  assert.equal(set.size(), 0);
});

test("frame compositor wraps doRender, injects before ESU and strips markers", () => {
  class Renderer {
    constructor() { this.mode = "fullscreen"; this.terminal = new Terminal(); this.previousScreen = []; }
    doRender() {
      this.previousScreen = [`${gfxMarker("row")}hello`];
      this.terminal.write(`\x1b[?2026h\x1b[1;1H\x1b[2K${gfxMarker("row")}hello\x1b[1;3H\x1b[?25l\x1b[?2026l`);
    }
  }
  class Terminal { constructor() { this.out = []; this.columns = 20; this.rows = 5; } write(data) { this.out.push(data); } }
  const renderer = new Renderer();
  const frames = [];
  const compositor = createFrameCompositor({
    getTui: () => renderer,
    onFrame(frame) { frames.push(frame); return { inject: "<INJ>" }; },
  });
  assert.equal(compositor.ensure(), true);
  renderer.doRender();
  assert.equal(renderer.terminal.out.length, 1);
  assert.equal(renderer.terminal.out[0], "\x1b[?2026h\x1b[1;1H\x1b[2Khello\x1b[1;3H\x1b[?25l<INJ>\x1b[?2026l");
  assert.deepEqual(frames[0].markers.get("row"), { row: 0, col: 0 });
  assert.deepEqual(frames[0].cursor, { row: 0, col: 2 });
  assert.equal(Object.prototype.hasOwnProperty.call(renderer.terminal, "write"), false, "terminal.write is restored");
  compositor.dispose();
  renderer.doRender();
  assert.match(renderer.terminal.out[1], /pi:gfx/, "disposed compositor no longer intercepts");
  assert.equal(injectBeforeFrameEnd("abc", "X"), "abcX");
});

test("terminal input tap observes, rewrites and swallows before Pi, and restores", () => {
  class Terminal { inputHandler; start(fn) { this.inputHandler = fn; } forward(data) { this.inputHandler?.(data); } }
  const terminal = new Terminal();
  const seen = [];
  terminal.start((data) => seen.push(data));
  const untap = tapTerminalInput(terminal, (data) => (data === "x" ? null : data === "a" ? "b" : undefined));
  terminal.forward("a"); terminal.forward("x"); terminal.forward("c");
  terminal.start((data) => seen.push(`new:${data}`));
  terminal.forward("a");
  assert.deepEqual(seen, ["b", "c", "new:b"]);
  untap();
  terminal.forward("a");
  assert.deepEqual(seen.at(-1), "new:a");
  assert.deepEqual(parsePixelGeometryReply("\x1b[6;24;10t"), { kind: "cell", heightPx: 24, widthPx: 10 });
  assert.deepEqual(parsePixelGeometryReply("\x1b[4;816;1100t"), { kind: "textArea", heightPx: 816, widthPx: 1100 });
});

test("host component registry learns live classes from the tree and later addChild calls", () => {
  class Container { constructor() { this.children = []; } addChild(c) { this.children.push(c); } render() { return []; } }
  class CustomEditor { render() { return []; } }
  class AssistantMessageComponent extends Container {}
  const root = new Container();
  root.addChild(new CustomEditor());
  const discovered = [];
  const registry = createHostComponentRegistry({ onDiscover: (name) => discovered.push(name) });
  registry.discover(root);
  assert.equal(registry.get("CustomEditor"), CustomEditor);
  assert.equal(registry.source("CustomEditor"), "live");
  root.addChild(new AssistantMessageComponent());
  assert.equal(registry.get("AssistantMessageComponent"), AssistantMessageComponent);
  assert.ok(discovered.includes("AssistantMessageComponent"));
  registry.dispose();
  assert.equal(Container.prototype.addChild.name, "addChild", "observer removed on dispose");
  const ui = { widgets: new Map(), setWidget(key, factory) { if (factory) factory({ tag: "tui" }); } };
  assert.deepEqual(captureTuiFromUi(ui), { tag: "tui" });
});

test("pixel geometry is queried actively, derived from the text area, or reported precisely", async () => {
  const { createPixelGeometryTracker } = await import("../extensions/pi-graphics/terminal-io.js");
  const make = (replies) => {
    class Terminal { inputHandler; constructor() { this.writes = []; } start(fn) { this.inputHandler = fn; } write(data) { this.writes.push(data); setTimeout(() => { for (const reply of replies(data)) this.inputHandler?.(reply); }, 5); } }
    const terminal = new Terminal(); const seen = [];
    terminal.start((data) => seen.push(data));
    const tracker = createPixelGeometryTracker();
    tracker.attach(terminal);
    return { terminal, tracker, seen };
  };
  // Full reply (Ghostty/Kitty): cell size from CSI 16 t.
  let t = make((data) => (data.includes("[16t") ? ["\x1b[6;24;10t", "\x1b[4;816;1100t"] : []));
  assert.deepEqual(await t.tracker.ensure({ columns: 110, rows: 34 }), { known: true, source: "csi16t" });
  assert.equal(t.tracker.geometry.cellWidthPx, 10);
  assert.ok(!t.seen.some((d) => d.startsWith("\x1b[4;")), "text-area reply never leaks to Pi as input");
  // Only the text area answers: derive the cell from the character grid.
  t = make((data) => (data.includes("[14t") ? ["\x1b[4;800;1200t"] : []));
  assert.deepEqual(await t.tracker.ensure({ columns: 120, rows: 40, timeoutMs: 50 }), { known: true, source: "csi14t" });
  assert.deepEqual([t.tracker.geometry.cellWidthPx, t.tracker.geometry.cellHeightPx], [10, 20]);
  // Silent terminal (Termux): unknown, and the Kitty probe says no graphics.
  t = make(() => []);
  assert.deepEqual(await t.tracker.ensure({ columns: 80, rows: 24, timeoutMs: 30 }), { known: false, source: "none" });
  assert.deepEqual(await t.tracker.probeKittyGraphics({ timeoutMs: 30 }), { supported: false, reply: null });
  assert.equal(t.tracker.assume(9, 19), true);
  assert.equal(t.tracker.known(), true);
  // Kitty-capable but no size reply: the probe succeeds and is swallowed.
  t = make((data) => (data.includes("a=q") ? ["\x1b_Gi=31337;OK\x1b\\"] : []));
  assert.deepEqual(await t.tracker.probeKittyGraphics({ timeoutMs: 100 }), { supported: true, reply: "OK" });
  assert.equal(t.seen.length, 0);
});

test("terminal identity comes from XTVERSION and never leaks to Pi", async () => {
  const { createPixelGeometryTracker } = await import("../extensions/pi-graphics/terminal-io.js");
  class Terminal { inputHandler; start(fn) { this.inputHandler = fn; } write(data) { if (data.includes("[>0q")) setTimeout(() => this.inputHandler("\x1bP>|ghostty 1.3.1\x1b\\"), 5); } }
  const terminal = new Terminal(); const seen = [];
  terminal.start((d) => seen.push(d));
  const tracker = createPixelGeometryTracker();
  tracker.attach(terminal);
  assert.equal(await tracker.probeTerminalName({ timeoutMs: 100 }), "ghostty 1.3.1");
  assert.equal(seen.length, 0);
});

test("detach unhooks the renderer but a later ensure() reinstalls (live settings)", async () => {
  const { createFrameCompositor } = await import("../extensions/pi-graphics/frame-compositor.js");
  class Renderer { constructor() { this.terminal = { write: () => {} }; } doRender() { this.terminal.write("x"); } }
  const tui = new Renderer();
  let frames = 0;
  const compositor = createFrameCompositor({ getTui: () => tui, onFrame: () => { frames += 1; return {}; } });
  assert.equal(compositor.ensure(tui), true);
  tui.doRender();
  compositor.detach();
  tui.doRender();
  assert.equal(frames, 1, "detached: frames bypass the hook");
  assert.equal(compositor.ensure(tui), true, "detach is not dispose");
  tui.doRender();
  assert.equal(frames, 2);
  compositor.dispose();
  assert.equal(compositor.ensure(tui), false);
});

test("modal key names understand legacy, xterm-modifier and Kitty keyboard sequences", async () => {
  const { modalKeyName } = await import("../extensions/pi-graphics/key-names.js");
  assert.equal(modalKeyName("\x1b[C"), "right");
  assert.equal(modalKeyName("\x1b[1;1:1C"), "right", "kitty press with event type");
  assert.equal(modalKeyName("\x1b[1;1:3C"), "release");
  assert.equal(modalKeyName("\x1bOB"), "down");
  assert.equal(modalKeyName("\x1b[13u"), "enter");
  assert.equal(modalKeyName("\x1b[27;1:1u"), "escape");
  assert.equal(modalKeyName("\x1b[9;2u"), "shift-tab");
  assert.equal(modalKeyName("\x1b[106u"), "j");
  assert.equal(modalKeyName("\x1b[106;5u"), "", "ctrl+j is not j");
  assert.equal(modalKeyName("\x1b[6~"), "pagedown");
  assert.equal(modalKeyName("\t"), "tab");
});
