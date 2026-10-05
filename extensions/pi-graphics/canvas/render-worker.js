// Off-main-thread renderer for the pixel canvas: pure effect frames
// (background loop frames, activity tints) are rendered and PNG-encoded here
// so Pi's input/render thread only uploads finished images. Loaded natively
// (no host packages): effects.js and the PNG encoder are self-contained.
import { parentPort } from "node:worker_threads";

import { encodeRgbaPng } from "../png-renderer.js";
import { renderActivityTint, renderBackground, renderEditorGlow, renderGrainTile, renderPaneBeacon } from "./effects.js";

const RENDERERS = { background: renderBackground, tint: renderActivityTint, glow: renderEditorGlow, beacon: renderPaneBeacon, grain: renderGrainTile };

parentPort.on("message", (msg) => {
  try {
    const render = RENDERERS[msg.kind];
    if (!render) throw new Error(`unknown render kind ${msg.kind}`);
    const img = render(msg.args);
    const png = encodeRgbaPng(img.rgba, img.width, img.height, { level: 1 });
    parentPort.postMessage({ id: msg.id, ok: true, width: img.width, height: img.height, base64: png.toString("base64") });
  } catch (error) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String(error?.message || error) });
  }
});
