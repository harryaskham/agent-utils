import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { choiceTextWidth } from "../extensions/lib/choice-layout.js";
import { pcmToWav } from "../extensions/lib/shared-audio.js";
import {
  addItem, applyArchiveReceipts, createReelState, findItemIndex, formatClock, parseOutputArguments, parseRepeatArgument,
  parseSeekArgument, parseVolumeArgument, removeItem, restoreReelState, serializeReelState,
} from "../extensions/audio-reel/state.js";
import { AudioReelView, agentLabel, normalizeReelKey, playbackView, reelKeyAction, reelOverlayHeight, renderReelWidget } from "../extensions/audio-reel/view.js";
import { AUDIO_REEL_ENTRY_TYPE, createAudioReelExtension, splitFirstArgument } from "../extensions/audio-reel.js";
import { createStrictMockPi } from "./helpers/strict-mock-pi.js";
import { drainingSink, fakeSpawner } from "./helpers/fake-audio-spawn.js";

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error("condition timed out");
    await settle(10);
  }
}
const pcm = (seconds, rate = 24000) => Buffer.alloc(Math.round(seconds * rate) * 2, 1);

function reel(count = 5) {
  const state = createReelState();
  state.visible = true;
  for (let i = 0; i < count; i++) addItem(state, { key: `00000000000000${String(i).padStart(2, "0")}`, path: `/tmp/clip-${i}.wav`, title: `Clip ${i} ${"long ".repeat(i)}`, durationMs: (i + 1) * 61000, mimeType: "audio/wav", sampleRate: 48000, channels: 2, agent: "agent" });
  return state;
}

test("argument parsing: seek, volume, repeat, output, clip references", () => {
  const at = { positionMs: 30000, durationMs: 120000 };
  assert.equal(parseSeekArgument("90", at), 90000);
  assert.equal(parseSeekArgument("1:23", at), 83000);
  assert.equal(parseSeekArgument("+10", at), 40000);
  assert.equal(parseSeekArgument("-45", at), 0);
  assert.equal(parseSeekArgument("50%", at), 60000);
  assert.equal(parseSeekArgument("9:00", at), 120000, "clamped to duration");
  assert.throws(() => parseSeekArgument("50%", { positionMs: 0 }), /duration/);
  assert.throws(() => parseSeekArgument("soon", at), /invalid seek/);
  assert.equal(parseVolumeArgument("80", 100), 80);
  assert.equal(parseVolumeArgument("+70", 100), 150);
  assert.equal(parseVolumeArgument("-200", 100), 0);
  assert.equal(parseVolumeArgument("mute", 100), 0);
  assert.throws(() => parseVolumeArgument("loud"), /invalid volume/);
  assert.equal(parseRepeatArgument("", "off"), "one");
  assert.equal(parseRepeatArgument("", "all"), "off");
  assert.throws(() => parseRepeatArgument("forever"), /off, one or all/);
  assert.deepEqual(parseOutputArguments(""), { show: true });
  assert.deepEqual(parseOutputArguments("reset"), { reset: true });
  assert.deepEqual(parseOutputArguments("backend=pacat server=tcp:h:4713 device=studio"), { patch: { backend: "pulse", server: "tcp:h:4713", sink: "studio" }, inherit: [] });
  assert.deepEqual(parseOutputArguments("sink=default server=inherit backend=default"), { patch: { backend: "auto", sink: null }, inherit: ["server"] });
  assert.throws(() => parseOutputArguments("volume=3"), /unknown output setting/);
  assert.throws(() => parseOutputArguments("pulse"), /key=value/);
  const state = reel(3);
  assert.equal(findItemIndex(state, "2"), 1);
  assert.equal(findItemIndex(state, "clip 2"), 2);
  assert.equal(findItemIndex(state, "0000000000000001"), 1);
  assert.equal(findItemIndex(state, "9"), -1);
  assert.deepEqual(splitFirstArgument('"my song.wav" Great take'), ["my song.wav", "Great take"]);
  assert.deepEqual(splitFirstArgument("a.wav"), ["a.wav", ""]);
  assert.equal(formatClock(83000), "1:23"); assert.equal(formatClock(3723000), "1:02:03");
  assert.equal(formatClock(250, 400), "0.3s"); assert.equal(formatClock(undefined), "--:--");
});

test("state snapshots sanitize, bound and restore with archive receipts", () => {
  const state = reel(3);
  state.index = 2; state.config.volume = 70; state.config.repeat = "all"; state.config.output = { sink: "studio" };
  const snapshot = JSON.parse(JSON.stringify(serializeReelState(state)));
  snapshot.items.push({ path: 42 }, { path: "/x.wav", label: "bad\u0007label", key: "../../evil" });
  const restored = createReelState();
  assert.ok(restoreReelState(restored, snapshot));
  assert.equal(restored.items.length, 4, "path-less entries dropped");
  assert.equal(restored.items[3].label, "bad label");
  assert.match(restored.items[3].key, /^[a-f0-9]{16}$/, "unsafe keys replaced");
  assert.equal(restored.index, 2); assert.equal(restored.config.volume, 70); assert.equal(restored.config.repeat, "all");
  assert.deepEqual(restored.config.output, { sink: "studio" });
  applyArchiveReceipts(restored, [{ key: restored.items[1].key, id: "agent/aud-x.wav", path: "/archive/aud-x.wav" }]);
  assert.equal(restored.items[1].archivePath, "/archive/aud-x.wav");
  assert.equal(restoreReelState(restored, { version: 2, items: [] }), false);
  removeItem(restored, 0);
  assert.equal(restored.index, 1, "selection follows the removed clip's neighbours");
});

test("widget and overlay lines always fit the terminal width and height", () => {
  const state = reel(12);
  state.index = 3;
  state.items[3].description = "A long description ".repeat(10);
  const snapshot = { status: "playing", key: state.items[3].key, positionMs: 61000, durationMs: 244000 };
  const view = new AudioReelView();
  for (const width of [8, 20, 40, 63, 84, 120, 200]) {
    for (const line of renderReelWidget({ state, snapshot, width, theme: null })) assert.ok(choiceTextWidth(line) <= width, `widget ${width}: ${line}`);
    for (const rows of [6, 12, 24, 50]) {
      const height = reelOverlayHeight(rows, state.items.length);
      const lines = view.render({ state, snapshot, output: { backend: "pulse", server: null, sink: null }, width, height, theme: null });
      assert.ok(lines.length <= height && lines.length <= rows, `overlay ${width}x${rows}: ${lines.length} > ${height}`);
      for (const line of lines) assert.ok(choiceTextWidth(line) <= width, `overlay ${width}x${rows}: ${line}`);
    }
  }
  assert.deepEqual(renderReelWidget({ state: { ...state, visible: false }, snapshot, width: 80 }), []);
  assert.ok(renderReelWidget({ state, snapshot: { ...snapshot, status: "error", error: "pacat: Connection refused" }, width: 80 })[1].includes("Connection refused"));
});

test("playback view clamps overrun positions and labels anonymous/operator sources", () => {
  const state = reel(2);
  const view = playbackView(state, { status: "playing", key: state.items[0].key, positionMs: 99999999 });
  assert.equal(view.positionMs, state.items[0].durationMs, "never past the end");
  assert.equal(playbackView(state, { status: "playing", key: "someone-else", positionMs: 5000 }).status, "idle");
  assert.equal(agentLabel({ agent: "chirp-agent" }), "chirp-agent");
  assert.equal(agentLabel({ agent: "session-01a13d04" }), "this session");
  assert.equal(agentLabel({ agent: "chirp-agent", origin: "operator" }), "you");
});

test("keyboard normalization covers legacy, application-cursor and Kitty CSI-u; ignores releases and paste", () => {
  assert.equal(normalizeReelKey("\x1b[A"), "up");
  assert.equal(normalizeReelKey("\x1bOB"), "down");
  assert.equal(normalizeReelKey("\x1b[1;2C"), "shift-right");
  assert.equal(normalizeReelKey("\x1b[1;1:3D"), null, "release");
  assert.equal(normalizeReelKey("\x1b[57351u"), "right");
  assert.equal(normalizeReelKey("\x1b[106u"), "j");
  assert.equal(normalizeReelKey("\x1b[108;2u"), "L");
  assert.equal(normalizeReelKey("\x1b[106;5u"), null, "ctrl chords are not controls");
  assert.equal(normalizeReelKey("\x1b[32u"), "space");
  assert.equal(normalizeReelKey("\x1b[200~pasted"), null);
  assert.deepEqual(reelKeyAction(" "), { type: "toggle" });
  assert.deepEqual(reelKeyAction("\x1b[1;2D"), { type: "seekBy", deltaMs: -30000 });
  assert.deepEqual(reelKeyAction("]"), { type: "next" });
  assert.deepEqual(reelKeyAction("\x1b"), { type: "close" });
  assert.deepEqual(reelKeyAction("\x1b[3~"), { type: "removeSelected" });
  assert.equal(reelKeyAction("z"), null);
});

test("overlay mouse: buttons, seek bar fraction, list rows, wheel and offset by terminal height", () => {
  const state = reel(4);
  const snapshot = { status: "paused", key: state.items[0].key, positionMs: 0, durationMs: 61000 };
  const view = new AudioReelView();
  const rows = 30, width = 100;
  view.render({ state, snapshot, width, height: reelOverlayHeight(rows, 4), theme: null });
  const top = rows - view.layout.height;
  const click = (x, y) => view.mouse(`\x1b[<0;${x + 1};${top + y + 1}M`, width, rows);
  const find = (type) => {
    for (const [y, row] of view.layout.rows.entries()) for (const hit of row.hits) if (hit.action.type === type) return [hit.x0, y];
    return null;
  };
  assert.deepEqual(click(...find("toggle")), { type: "toggle" });
  assert.deepEqual(click(...find("next")), { type: "next" });
  assert.deepEqual(click(...find("repeat")), { type: "repeat" });
  assert.deepEqual(click(...find("close")), { type: "close" });
  const barY = view.layout.rows.findIndex((row) => row.seekBar);
  const bar = view.layout.rows[barY].seekBar;
  assert.deepEqual(click(bar.x0, barY), { type: "seekFraction", fraction: 0 });
  assert.equal(click(bar.x1 - 1, barY).fraction, 1);
  const listY = view.layout.rows.findIndex((row) => row.listIndex === 2);
  assert.deepEqual(click(10, listY), { type: "play", index: 2 });
  assert.deepEqual(view.mouse(`\x1b[<65;3;${top + listY + 1}M`, width, rows), { type: "scroll", delta: 3 });
  assert.deepEqual(view.mouse(`\x1b[<64;${bar.x0 + 3};${top + barY + 1}M`, width, rows), { type: "seekBy", deltaMs: 5000 });
  assert.deepEqual(view.mouse(`\x1b[<0;3;${top + listY + 1}m`, width, rows), { type: "ignored" }, "release ignored");
  assert.deepEqual(view.mouse(`\x1b[<0;3;1M`, width, rows), { type: "ignored" }, "above the overlay");
  assert.equal(view.mouse("j", width, rows), null);
});

function harness({ env: extraEnv = {}, behaviours = { pacat: drainingSink, ffmpeg: (child) => setImmediate(() => { child.stdout.end(); child.finish(0); }) } } = {}) {
  return (async () => {
    const root = await mkdtemp(join(tmpdir(), "audio-reel-ext-"));
    const env = { HOME: root, PATH: process.env.PATH, PI_AGENT_UTILS_STATE_DIR: join(root, "state"), PI_AUDIO_REEL_SCRATCH_DIR: join(root, "scratch"), PULSE_SERVER: "tcp:reel-test:4713", ...extraEnv };
    const spawner = fakeSpawner(behaviours);
    const appended = [];
    const notes = [];
    const widgets = [];
    let api;
    const { pi, tools, commands, handlers } = createStrictMockPi({ appendEntry: (type, data) => appended.push({ type, data }) });
    createAudioReelExtension({ env, spawnImpl: spawner.spawn, execFileImpl: (_c, _a, _o, cb) => cb(null, "2.5\n"), onReady: (value) => { api = value; } })(pi);
    const ctx = {
      cwd: root, hasUI: true, mode: "tui",
      ui: { notify: (message, level) => notes.push({ message, level }), setWidget: (id, factory, options) => widgets.push({ id, factory, options }) },
      sessionManager: { getSessionId: () => "session-1", getBranch: () => [], getSessionFile: () => join(root, "s.jsonl") },
    };
    return { root, env, spawner, appended, notes, widgets, pi, tools, commands, handlers, ctx, api: () => api, cleanup: () => rm(root, { recursive: true, force: true }) };
  })();
}

test("extension registers explicit share/control tools and /audio-* commands without taking /audio", async () => {
  const h = await harness();
  try {
    assert.deepEqual([...h.tools.keys()].sort(), ["audio_reel", "audio_share"]);
    for (const name of ["audio-reel", "audio-player", "audio-play", "audio-pause", "audio-resume", "audio-toggle", "audio-stop", "audio-next", "audio-prev", "audio-seek", "audio-volume", "audio-repeat", "audio-output", "audio-add", "audio-remove", "audio-show", "audio-hide", "audio-clear", "audio-status"]) {
      assert.ok(h.commands.has(name), name);
    }
    assert.ok(!h.commands.has("audio"), "/audio belongs to audio-providers");
    const schema = h.tools.get("audio_share").parameters;
    assert.deepEqual(schema.required, []);
    assert.deepEqual(h.tools.get("audio_reel").parameters.required, ["action"]);
  } finally { await h.cleanup(); }
});

test("audio_share archives raw PCM, plays it natively through routed Pulse, and persists receipts", async () => {
  const h = await harness();
  try {
    const share = h.tools.get("audio_share");
    await assert.rejects(share.execute("t0", {}, null, null, h.ctx), /exactly one of path or data/);
    await assert.rejects(share.execute("t0", { path: "a.wav", data: "AAAA" }, null, null, h.ctx), /exactly one/);
    const result = await share.execute("call-1", { data: pcm(0.25).toString("base64"), pcm: { sampleRate: 24000 }, title: "Beep", play: true }, null, null, h.ctx);
    const text = result.content[0].text;
    assert.match(text, /Shared audio 1\/1: Beep \(0\.3s · wav · 24 kHz · mono/);
    assert.match(text, /Archived as session-session-1\/aud-[0-9a-f]{64}\.wav/);
    assert.match(text, /Playing via pulse · sink default · server tcp:reel-test:4713/);
    const details = result.details;
    assert.equal(details.audioReelState.items.length, 1);
    assert.equal(details.sharedAudio.stored[0].key, details.audioReelState.items[0].key);
    const [sink] = h.spawner.children;
    assert.equal(sink.command, "pacat");
    assert.ok(sink.args.includes("--rate=24000") && sink.args.includes("--channels=1") && sink.args.includes("--stream-name=Beep"));
    assert.equal(sink.options.env.PULSE_SERVER, "tcp:reel-test:4713");
    await until(() => h.api().player.snapshot().status === "ended");
    assert.equal(sink.received, 24000 * 0.25 * 2);
    const files = await readdir(join(h.root, "state", "audio", "session-session-1"));
    assert.equal(files.length, 2);
    assert.ok(h.widgets.some((w) => w.id === "audio-reel" && typeof w.factory === "function" && w.options.placement === "belowEditor"));
    const widget = h.widgets.at(-1).factory({ requestRender() {} }, null);
    assert.match(widget.render(80)[0], /Beep/);
  } finally { await h.cleanup(); }
});

test("incognito shares stay playable locally but write no archive", async () => {
  const h = await harness({ env: { PI_INCOGNITO: "1" } });
  try {
    const result = await h.tools.get("audio_share").execute("call-1", { data: pcm(0.1).toString("base64"), pcm: {} }, null, null, h.ctx);
    assert.match(result.content[0].text, /Archive disabled/);
    assert.equal(result.details.sharedAudio.count, 0);
    assert.equal(h.spawner.children.length, 0, "no autoplay by default");
    await assert.rejects(readdir(join(h.root, "state")), /ENOENT/);
    const control = await h.tools.get("audio_reel").execute("c1", { action: "play" }, null, null, h.ctx);
    assert.match(control.content[0].text, /Playing pcm-/);
  } finally { await h.cleanup(); }
});

test("audio_reel controls seek/volume/output/repeat and repeat=all advances on a natural end", async () => {
  const h = await harness({ behaviours: { pacat() {} } });
  try {
    const share = h.tools.get("audio_share");
    for (const [i, seconds] of [[1, 2], [2, 1]]) {
      const file = join(h.root, `clip-${i}.wav`);
      await writeFile(file, pcmToWav(pcm(seconds, 8000), { sampleRate: 8000 }));
      await share.execute(`s${i}`, { path: file }, null, null, h.ctx);
    }
    const control = (params) => h.tools.get("audio_reel").execute("c", params, null, null, h.ctx);
    let result = await control({ action: "play", index: 0, position: 0.5 });
    assert.equal(h.api().player.snapshot().positionMs >= 500, true);
    result = await control({ action: "volume", volume: 40 });
    assert.match(result.content[0].text, /Volume 40%/);
    assert.equal(h.spawner.children.length, 2, "volume restarts the owned pipeline");
    result = await control({ action: "output", output: { sink: "studio", server: "" } });
    assert.match(result.content[0].text, /Output: pulse · sink studio · server local/);
    const routed = h.spawner.children.at(-1);
    assert.ok(routed.args.includes("--device=studio"));
    assert.equal(routed.options.env.PULSE_SERVER, undefined);
    result = await control({ action: "seek", position: -0.25, relative: true });
    assert.equal(h.spawner.children.length, 4);
    result = await control({ action: "repeat", repeat: "all" });
    assert.match(result.content[0].text, /Repeat all/);
    // Let the current clip end naturally: the reel advances to clip 2.
    h.spawner.children.at(-1).finish(0);
    await until(() => h.api().state().index === 1 && h.api().player.snapshot().status === "playing");
    assert.equal(h.api().state().index, 1);
    assert.equal(h.api().player.snapshot().status, "playing");
    result = await control({ action: "pause" });
    assert.equal(h.api().player.snapshot().status, "paused");
    result = await control({ action: "remove", index: 0 });
    assert.match(result.content[0].text, /archive copy kept/);
    result = await control({ action: "clear" });
    assert.match(result.content[0].text, /Cleared 1 clips/);
    await assert.rejects(control({ action: "play" }), /empty/);
  } finally { await h.cleanup(); }
});

test("session_start restores the branch's latest reel snapshot, archive paths and prunes missing clips", async () => {
  const h = await harness();
  try {
    const kept = join(h.root, "kept.wav");
    const archived = join(h.root, "archived.wav");
    await writeFile(kept, pcmToWav(pcm(0.1), {}));
    await writeFile(archived, pcmToWav(pcm(0.1), {}));
    const snapshot = { version: 1, visible: true, index: 2, config: { volume: 55, repeat: "one", output: { sink: "studio" } }, items: [
      { key: "aaaaaaaaaaaaaaaa", path: kept, label: "kept" },
      { key: "bbbbbbbbbbbbbbbb", path: join(h.root, "scratch-gone.wav"), label: "durable" },
      { key: "cccccccccccccccc", path: join(h.root, "gone.wav"), label: "gone" },
    ] };
    const branch = [
      { type: "message", message: { role: "toolResult", toolName: "audio_share", details: { audioReelState: { ...snapshot, items: [] }, sharedAudio: { stored: [{ key: "bbbbbbbbbbbbbbbb", id: "a/aud-b.wav", path: archived }] } } } },
      { type: "message", message: { role: "toolResult", toolName: "other_tool", details: { audioReelState: { version: 1, items: [{ path: "/ignored" }] } } } },
      { type: "custom", customType: AUDIO_REEL_ENTRY_TYPE, data: snapshot },
    ];
    for (const handler of h.handlers.get("session_start")) await handler({}, { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getBranch: () => branch } });
    const state = h.api().state();
    assert.deepEqual(state.items.map((item) => item.label), ["kept", "durable"]);
    assert.equal(state.items[1].archivePath, archived);
    assert.equal(state.index, 1);
    assert.equal(state.config.volume, 55); assert.equal(state.config.repeat, "one");
    await h.api().playIndex(1);
    assert.ok(h.spawner.children[0].args.includes("--device=studio"));
    for (const handler of h.handlers.get("session_shutdown")) await handler({}, h.ctx);
    assert.equal(h.api().player.snapshot().status, "idle");
  } finally { await h.cleanup(); }
});

test("operator commands add, route and persist; the overlay drives playback by key and mouse", async () => {
  const h = await harness({ behaviours: { pacat() {} } });
  try {
    const file = join(h.root, "my song.wav");
    await writeFile(file, pcmToWav(pcm(3, 8000), { sampleRate: 8000, channels: 1 }));
    await h.commands.get("audio-add").handler(`"${file}" Great take`, h.ctx);
    assert.match(h.notes.at(-1).message, /Shared audio 1\/1: Great take/);
    assert.equal(h.appended.at(-1).type, AUDIO_REEL_ENTRY_TYPE);
    await h.commands.get("audio-output").handler("backend=sox sink=hw:2", h.ctx);
    assert.match(h.notes.at(-1).message, /sox · device hw:2/);
    await h.commands.get("audio-output").handler("bogus", h.ctx);
    assert.equal(h.notes.at(-1).level, "warning");
    await h.commands.get("audio-volume").handler("+10", h.ctx);
    assert.match(h.notes.at(-1).message, /100%|110%/);

    let component, closed = false;
    const ctx = { ...h.ctx, ui: { ...h.ctx.ui, custom: (factory) => new Promise((resolve) => {
      const tui = { mode: "regular", terminal: { columns: 100, rows: 30, writes: [], write(data) { this.writes.push(data); } }, requestRender() {} };
      component = factory(tui, null, null, () => { closed = true; resolve(); });
      component.tui = tui;
    }) } };
    const opened = h.api().openOverlay(ctx);
    await settle(5);
    assert.ok(component.tui.terminal.writes[0].includes("\u001b[?1006h"), "SGR mouse enabled in regular mode");
    component.render(100);
    component.handleInput("\r");
    await until(() => h.spawner.children.length > 0);
    assert.equal(h.spawner.children[0].command, "play", "sox backend selected by /audio-output");
    assert.equal(h.spawner.children[0].options.env.AUDIODEV, "hw:2");
    component.handleInput(" ");
    await until(() => h.api().player.snapshot().status === "paused");
    const lines = component.render(100);
    assert.ok(lines.some((line) => line.includes("[▶ play]")));
    // Click the play button through the SGR mouse path.
    component.render(100);
    const layoutRows = lines.length;
    const toggleRow = lines.findIndex((line) => line.includes("[▶ play]"));
    const x = lines[toggleRow].indexOf("[▶ play]") + 2;
    component.handleInput(`\x1b[<0;${x};${30 - layoutRows + toggleRow + 1}M`);
    await until(() => h.api().player.snapshot().status === "playing");
    component.handleInput("q");
    await opened;
    assert.ok(closed);
    assert.ok(component.tui.terminal.writes.at(-1).includes("\u001b[?1000r"), "mouse mode restored");
    await h.commands.get("audio-status").handler("", h.ctx);
    assert.match(h.notes.at(-1).message, /playing · 1\/1 Great take/);
  } finally { await h.cleanup(); }
});
