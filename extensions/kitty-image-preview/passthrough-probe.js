// Kitty host passthrough probe (bd-15374a). Diagnoses the failure shape where
// kitty-image-preview Unicode placeholders / pi-graphics primitives render as
// raw glyphs or blank pixels inside caco/tmux: the likely cause is the caco/Pi
// host output path not forwarding raw kitty graphics escape sequences to the
// outer kitty client. This module builds a deterministic probe that emits one
// tiny labeled kitty graphics test cell per available output writer (ctx.ui.write
// / ctx.ui.terminal.write / ctx.terminal.write), so the operator can see which
// path actually reaches the kitty client. Pure over its inputs so the plan is
// unit-testable without a live terminal; the command wiring in
// kitty-image-preview.js performs the writes and reports the summary.

import { buildPngDisplayCommand } from "../kitty-graphics.js";
import { kittyPreviewImageId, kittyPreviewPlacementId } from "./id-space.js";

// A tiny 16x16 solid-magenta PNG used purely as a visible probe payload: small
// enough to embed inline, large enough that a single rendered cell is obvious.
export const PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGP4z/CfJMQwqmFUw/DVAAAg0/4QF5nKuAAAAABJRU5ErkJggg==";

// Per-writer probe ids stay inside the session/pid-scoped preview namespace so
// concurrent agents cannot collide, and each writer gets a distinct id so the
// terminal renders the probes as separate cells rather than overwriting one.
export function probeImageId(writerName) {
  return kittyPreviewImageId(`passthrough-probe.${String(writerName ?? "writer")}`);
}

export function probePlacementId(writerName) {
  return kittyPreviewPlacementId(`passthrough-probe.${String(writerName ?? "writer")}`);
}

// Build a deterministic probe plan: one labeled kitty transmit+display command
// per candidate output-writer name. `mode` is the detected/forced kitty
// passthrough mode (auto/tmux/none) and is threaded into the serializer so the
// probe is wrapped exactly like real preview output on this host. Pure: the
// caller supplies the writer NAMES (not bound writers) so the plan can be
// asserted without a terminal.
export function buildPassthroughProbePlan({
  writerNames = [],
  mode = "auto",
  env = process.env,
  pngBase64 = PROBE_PNG_BASE64,
} = {}) {
  const entries = writerNames.map((name) => ({
    name,
    label: `[kitty-probe ${name}] `,
    command: buildPngDisplayCommand({
      imageId: probeImageId(name),
      placementId: probePlacementId(name),
      pngBase64,
      columns: 2,
      rows: 1,
      passthrough: mode,
      env,
    }),
  }));
  return { mode, entries };
}
