import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
  KITTY_UNICODE_PLACEHOLDER,
  buildAnimationFrameCommand,
  buildAnimationLoopCommand,
  buildAnimationStopCommand,
  buildKittyUnicodePlaceholderCell,
  buildKittyUnicodePlaceholderLines,
  buildPngCursorAnimationUpload,
  buildPngDisplayCommand,
  buildPngVirtualPlacementAnimation,
  buildPngVirtualPlacementCommand,
  buildDeleteByZIndexBandCommand,
  buildDeleteByZIndexCommand,
  buildScopedDeleteCommand,
  serializeKittyGraphicsCommand,
  shouldUseUnicodePlaceholders,
  stableKittyImageId,
  stableKittyPlacementId,
  stableKittyPlaceholderPlacementId,
  viewportHalfRowLimit,
  clampRowsToViewportHalf,
} from "../extensions/kitty-graphics.js";

const ESC = "\x1b";
const D0 = "\u0305";
const D1 = "\u030d";
const D2 = "\u030e";

test("tmux passthrough wraps APC and doubles inner escape bytes", () => {
  const serialized = serializeKittyGraphicsCommand(
    { a: "p", i: 42, q: 2 },
    "",
    { passthrough: "auto", env: { TMUX: "/tmp/tmux-1000/default,1,0" } },
  );

  assert.equal(serialized, `${ESC}Ptmux;${ESC}${ESC}_Ga=p,i=42,q=2${ESC}${ESC}\\${ESC}\\`);
});

test("stable kitty ids use protocol-sized namespaces", () => {
  const imageId = stableKittyImageId("agent-utils.pi-graphics.test");
  const placementId = stableKittyPlacementId("agent-utils.pi-graphics.test");
  const placeholderPlacementId = stableKittyPlaceholderPlacementId("agent-utils.pi-graphics.test");

  assert.equal(stableKittyImageId("agent-utils.pi-graphics.test"), imageId);
  assert.notEqual(stableKittyImageId("agent-utils.pi-graphics.other"), imageId);
  assert.ok(imageId >= 0x01000000 && imageId <= 0xffffffff, "image IDs should force the larger 32-bit placeholder namespace");
  assert.ok(placementId >= 1 && placementId <= 0xffffffff, "real placement IDs use the 32-bit protocol range");
  assert.ok(placeholderPlacementId >= 0x800000 && placeholderPlacementId < 0x1000000, "placeholder placement IDs fit underline truecolor");
});

test("virtual placement command transmits PNG data without cursor placement", () => {
  const serialized = buildPngVirtualPlacementCommand({
    imageId: 42,
    placementId: 9,
    pngBase64: "YWJj",
    columns: 2,
    rows: 3,
    passthrough: "none",
  });

  assert.equal(serialized, `${ESC}_Ga=T,f=100,t=d,i=42,p=9,U=1,c=2,r=3,q=2;YWJj${ESC}\\`);
  assert.doesNotMatch(serialized, /z=/);
});

test("cursor display command suppresses protocol cursor movement", () => {
  const serialized = buildPngDisplayCommand({
    imageId: 42,
    placementId: 9,
    pngBase64: "YWJj",
    columns: 2,
    rows: 3,
    passthrough: "none",
  });

  assert.equal(serialized, `${ESC}_Ga=T,f=100,t=d,i=42,p=9,c=2,r=3,C=1,q=2;YWJj${ESC}\\`);
});

test("virtual placement command serializes zIndex below background threshold", () => {
  const serialized = buildPngVirtualPlacementCommand({
    imageId: 42,
    placementId: 9,
    pngBase64: "YWJj",
    columns: 2,
    rows: 3,
    zIndex: -1073741825,
    passthrough: "none",
  });
  assert.match(serialized, /z=-1073741825/);
});

test("direct transfer chunks stay within kitty protocol size limits", () => {
  const oversized = buildPngVirtualPlacementCommand({
    imageId: 42,
    placementId: 9,
    pngBase64: "A".repeat(5000),
    columns: 2,
    rows: 3,
    passthrough: "none",
    chunkSize: 8192,
  });
  const oversizedChunks = [...oversized.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
  assert.equal(oversizedChunks.length, 2, "payload above 4096 bytes must be chunked even when config asks for larger chunks");
  assert.match(oversizedChunks[0][1], /m=1/);
  assert.equal(oversizedChunks[0][2].length, 4096);
  assert.match(oversizedChunks[1][1], /m=0/);
  assert.ok(oversizedChunks.every((chunk) => chunk[2].length <= 4096));

  const odd = buildPngVirtualPlacementCommand({
    imageId: 42,
    placementId: 9,
    pngBase64: "A".repeat(1100),
    columns: 2,
    rows: 3,
    passthrough: "none",
    chunkSize: 513,
  });
  const oddChunks = [...odd.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
  assert.equal(oddChunks[0][2].length, 512, "non-final chunks must be rounded to a multiple of 4");
  assert.ok(oddChunks.slice(0, -1).every((chunk) => chunk[2].length % 4 === 0));
});

test("virtual placement animation follows kitty loop semantics", () => {
  const pngHeader = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(pngHeader, 0);
  pngHeader.writeUInt32BE(13, 8);
  pngHeader.write("IHDR", 12, "ascii");
  pngHeader.writeUInt32BE(2, 16);
  pngHeader.writeUInt32BE(1, 20);
  const pngBase = pngHeader.toString("base64");
  const serialized = buildPngVirtualPlacementAnimation({
    imageId: 42,
    placementId: 9,
    pngBases: [pngBase, pngBase],
    delaysMs: 17,
    columns: 2,
    rows: 1,
    zIndex: -5,
    passthrough: "none",
  });

  assert.match(serialized, /_Ga=t,f=100,t=d,i=42,q=2;/);
  assert.doesNotMatch(serialized, /_Ga=t,f=100,t=d,i=42,s=/);
  assert.match(serialized, /_Ga=p,i=42,p=9,U=1,c=2,r=1,z=-5,q=2/);
  assert.equal([...serialized.matchAll(/_Ga=f,f=100,t=d,i=42/g)].length, 1);
  assert.match(serialized, /_Ga=f,f=100,t=d,i=42,z=17,q=2;/);
  assert.doesNotMatch(serialized, /_Ga=f,f=100,t=d,i=42,s=/);
  assert.doesNotMatch(serialized, /_Ga=f,f=100,t=d,i=42,X=/);
  assert.match(serialized, /_Ga=a,i=42,r=1,z=17,q=2/);
  assert.match(serialized, /_Ga=a,i=42,s=3,v=1,q=2/);
  assert.ok(serialized.indexOf("_Ga=p,i=42") < serialized.indexOf("_Ga=f,f=100,t=d,i=42"));
  assert.ok(serialized.indexOf("_Ga=a,i=42,r=1") < serialized.indexOf("_Ga=a,i=42,s=3"));
  assert.doesNotMatch(serialized, /s=3,v=0/);
});

test("cursor animation upload configures frame gaps without client-side frame selection", () => {
  const serialized = buildPngCursorAnimationUpload({
    imageId: 77,
    pngBases: ["YQ==", "Yg==", "Yw=="],
    delaysMs: 33,
    passthrough: "none",
  });

  assert.match(serialized, /_Ga=t,f=100,t=d,i=77,q=2;YQ==/);
  assert.equal([...serialized.matchAll(/_Ga=f,f=100,t=d,i=77,z=33,q=2;/g)].length, 2);
  assert.match(serialized, /_Ga=a,i=77,r=1,z=33,q=2/);
  assert.doesNotMatch(serialized, /_Ga=a,i=77,c=/);
  assert.doesNotMatch(serialized, /s=3/);
});

test("chunked animation frame continuations keep a=f", () => {
  const frame = "A".repeat(1300);
  const serialized = buildPngCursorAnimationUpload({
    imageId: 77,
    pngBases: ["YQ==", frame],
    delaysMs: 33,
    passthrough: "none",
    chunkSize: 512,
  });

  const frameCommands = [...serialized.matchAll(/\x1b_G([^;]*);/g)]
    .map((match) => match[1])
    .filter((control) => control.includes("a=f") || control.includes("m="));
  assert.ok(frameCommands.length >= 3, "test payload should force chunked frame transfer");
  assert.match(frameCommands[0], /a=f,f=100,t=d,i=77,z=33,q=2,m=1/);
  assert.ok(frameCommands.slice(1).every((control) => /(?:^|,)a=f(?:,|$)/.test(control)), "every animation frame continuation must repeat a=f");
  assert.ok(frameCommands.slice(1).every((control) => /(?:^|,)m=[01](?:,|$)/.test(control)), "continuations keep chunk markers");
});

test("animation loop command uses terminal-managed infinite playback", () => {
  const serialized = buildAnimationLoopCommand({ imageId: 77, passthrough: "none" });
  assert.equal(serialized, `${ESC}_Ga=a,i=77,s=3,v=1,q=2${ESC}\\`);
  assert.doesNotMatch(serialized, /c=/);
});

test("manual animation controls select frames and stop native loops", () => {
  assert.equal(buildAnimationFrameCommand({ imageId: 77, frame: 3, passthrough: "none" }), `${ESC}_Ga=a,i=77,c=3,q=2${ESC}\\`);
  assert.equal(buildAnimationFrameCommand({ imageId: 77, frame: 0, passthrough: "none" }), `${ESC}_Ga=a,i=77,c=1,q=2${ESC}\\`);
  assert.equal(buildAnimationStopCommand({ imageId: 77, passthrough: "none" }), `${ESC}_Ga=a,i=77,s=1,q=2${ESC}\\`);
});

test("Unicode placeholder lines encode image id, placement id, rows, and scrollable cells", () => {
  const lines = buildKittyUnicodePlaceholderLines({
    imageId: 42,
    placementId: 9,
    columns: 2,
    rows: 2,
    width: 5,
    caption: "hi",
  });

  assert.deepEqual(lines, [
    `${ESC}[38;2;0;0;42m${ESC}[58;2;0;0;9m${KITTY_UNICODE_PLACEHOLDER}${D0}${KITTY_UNICODE_PLACEHOLDER}${ESC}[39;59m hi`,
    `${ESC}[38;2;0;0;42m${ESC}[58;2;0;0;9m${KITTY_UNICODE_PLACEHOLDER}${D1}${KITTY_UNICODE_PLACEHOLDER}${ESC}[39;59m   `,
  ]);
});

test("placeholder cells include the high image-id byte when ids exceed truecolor", () => {
  assert.equal(
    buildKittyUnicodePlaceholderCell({ imageId: 0x0200002a, row: 0, column: 0, includeColumn: false }),
    `${KITTY_UNICODE_PLACEHOLDER}${D0}${D0}${D2}`,
  );
});

test("auto placement mode uses Unicode placeholders only for tmux passthrough", () => {
  assert.equal(shouldUseUnicodePlaceholders({ env: { TMUX: "1" } }), true);
  assert.equal(shouldUseUnicodePlaceholders({ env: {} }), false);
  assert.equal(shouldUseUnicodePlaceholders({ placementMode: "unicode", env: {} }), true);
  assert.equal(shouldUseUnicodePlaceholders({ placementMode: "cursor", env: { TMUX: "1" } }), false);
});

test("forced anchoring overrides cursor placement for side overlays", () => {
  assert.equal(shouldUseUnicodePlaceholders({ placementMode: "cursor", env: {}, forceAnchored: true }), true);
});

test("viewport row helpers cap image previews to half the terminal height", () => {
  assert.equal(viewportHalfRowLimit(24), 12);
  assert.equal(viewportHalfRowLimit(25), 12);
  assert.equal(viewportHalfRowLimit(1), 1);
  assert.equal(viewportHalfRowLimit(undefined), undefined);
  assert.equal(clampRowsToViewportHalf({ rows: 40, viewportRows: 24 }), 12);
  assert.equal(clampRowsToViewportHalf({ rows: 40, viewportRows: 24, reserveRows: 1 }), 11);
  assert.equal(clampRowsToViewportHalf({ rows: 3, viewportRows: 24, reserveRows: 1 }), 3);
});

test("kitty image preview applies the half-viewport cap to inline and side-panel layouts", async () => {
  const source = await readFile(new URL("../extensions/kitty-image-preview.js", import.meta.url), "utf8");

  assert.match(source, /function currentTerminalRows/);
  assert.match(source, /previewViewportRowLimit\(\)/);
  assert.match(source, /previewImageRowLimit\(\{ includeControls: Boolean\(controls\), protocolMax \}\)/);
  assert.match(source, /lines\.length < widgetRowLimit/);
  assert.match(source, /viewportPanelLimit = previewViewportRowLimit\(terminalHeight\) \?\? terminalHeight/);
  assert.match(source, /Math\.min\(terminalHeight - bottomVisibleRows, viewportPanelLimit\)/);
  assert.match(source, /sideOverlayMaxHeight/);
});

test("kitty image preview advertises a fixed right-side panel with tmux inline fallback", async () => {
  const source = await readFile(new URL("../extensions/kitty-image-preview.js", import.meta.url), "utf8");

  assert.match(source, /SIDE_OVERLAY_PLACEMENT = "rightOverlay"/);
  assert.match(source, /PREVIEW_PLACEMENTS = \[AUTO_PLACEMENT, \.\.\.WIDGET_PLACEMENTS, SIDE_OVERLAY_PLACEMENT\]/);
  assert.match(source, /SIDE_PANEL_MAX_WIDTH_RATIO = 0\.5/);
  assert.match(source, /function renderTuiWithSidePanel/);
  assert.match(source, /function shouldUseInlineRightPlacement/);
  assert.match(source, /function resolvePlacement/);
  assert.match(source, /rightOverlay is inline inside tmux passthrough/);
  assert.match(source, /nonCapturing: true/);
  assert.match(source, /options\.forceSideOverlay !== false && isSideOverlayPlacement\(placement\)/);
});

test("kitty multiviewer registers discoverable image commands, controls, and a cycle tool", async () => {
  const source = await readFile(new URL("../extensions/kitty-image-preview.js", import.meta.url), "utf8");

  assert.match(source, /registerImageCommand\(\["kitty-show-next", "image-next"\]/);
  assert.match(source, /"image-prev", "image-previous"/);
  assert.match(source, /"image-show", "kitty-show"/);
  assert.match(source, /"image-hide", "kitty-hide"/);
  assert.match(source, /"image-clear", "kitty-clear"/);
  assert.match(source, /"kitty-start-cycle", "image-start-cycle", "image-cycle"/);
  assert.match(source, /"kitty-stop-cycle", "image-stop-cycle"/);
  assert.match(source, /function imageControlsLine/);
  assert.match(source, /controls: \$\{imageControlHint/);
  assert.match(source, /name: "kitty_image_preview_cycle"/);
  assert.match(source, /function startCycle/);
  assert.match(source, /function stopCycle/);
});

test("interactive kitty animation smoke stays out of default node test discovery", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["pi-graphics:animation-smoke"], "node scripts/kitty-animation-smoke.mjs");
  await access(new URL("../scripts/kitty-animation-smoke.mjs", import.meta.url));
  await assert.rejects(access(new URL("../scripts/test-kitty-animation.mjs", import.meta.url)), /ENOENT/);
});

test("kitty multiviewer scopes delete commands to images it owns", async () => {
  const previewSource = await readFile(new URL("../extensions/kitty-image-preview.js", import.meta.url), "utf8");
  const graphicsSource = await readFile(new URL("../extensions/kitty-graphics.js", import.meta.url), "utf8");

  // The extension must NEVER use a global "delete all" (d=A) escape sequence,
  // because that erases every kitty image in the terminal — including the
  // surrounding caco UI when this extension runs inside it.
  assert.doesNotMatch(previewSource, /buildDeleteCommand\(\{ deleteMode: "A"/);
  assert.match(previewSource, /buildScopedDeleteCommand/);
  assert.match(previewSource, /ownedImageIds/);
  // Scoped deletion uses per-image-id deletes (d=i with i=<id>) defined in the
  // shared kitty-graphics helper.
  assert.match(graphicsSource, /deleteMode: "i"/);
});

test("buildDeleteByZIndexCommand emits scoped z-index deletes", () => {
  const cmd = buildDeleteByZIndexCommand({ zIndex: -1073741825, passthrough: "none" });
  assert.match(cmd, /a=d,d=z,z=-1073741825,q=2/);
  assert.throws(() => buildDeleteByZIndexCommand({ passthrough: "none" }), /zIndex is required/);
});

test("buildDeleteByZIndexBandCommand deduplicates reserved cleanup indices", () => {
  const cmd = buildDeleteByZIndexBandCommand({ zIndices: [-2, -2, -3], passthrough: "none" });
  assert.equal([...cmd.matchAll(/a=d,d=z/g)].length, 2);
  assert.match(cmd, /z=-2/);
  assert.match(cmd, /z=-3/);
});

test("buildScopedDeleteCommand emits per-image deletes for owned ids only", () => {
  const cmd = buildScopedDeleteCommand({
    ownedImageIds: new Set([42, 43]),
    placementId: 7,
    passthrough: "none",
    excludeIds: [43],
  });
  assert.match(cmd, /a=d,d=i,i=42,p=7/);
  assert.doesNotMatch(cmd, /i=43/);
  assert.doesNotMatch(cmd, /d=A/);
});

test("buildScopedDeleteCommand returns empty string when no images are owned", () => {
  assert.equal(buildScopedDeleteCommand({ ownedImageIds: new Set(), passthrough: "none" }), "");
  assert.equal(buildScopedDeleteCommand({ passthrough: "none" }), "");
});

test("firecracker VM extension is packaged and exposes lifecycle, screen, and Tendril manifest controls", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../extensions/firecracker-vm.js", import.meta.url), "utf8");

  assert.ok(packageJson.pi.extensions.includes("./extensions/firecracker-vm.js"));
  assert.match(source, /name: "firecracker_vm_start"/);
  assert.match(source, /name: "firecracker_vm_status"/);
  assert.match(source, /name: "firecracker_vm_list"/);
  assert.match(source, /name: "firecracker_vm_screen"/);
  assert.match(source, /name: "firecracker_vm_stop"/);
  assert.match(source, /tendril-firecracker-manifest\.json/);
  assert.match(source, /serial-console-log/);
  assert.match(source, /firecracker --api-sock/);
  assert.match(source, /pi\.registerCommand\("firecracker-vms"/);
});
