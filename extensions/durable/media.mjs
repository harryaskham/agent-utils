// Durable adaptor: image_share, audio_share and tendril_capture for pi-daemon
// sessions (bd-647b05).
//
// List this file in a pi-daemon profile's `extensions:`. It exports a Durable
// `extension` whose tools share media with the operator through
// `details.media` (pi-daemon AHP-MEDIA); all behaviour lives in
// ../lib/durable-media.js over the same image/audio archive, Tendril capture and
// audio playback cores the TUI tools use. It never imports Pi TUI APIs.
//
// Configuration comes from the worker's environment: PI_SHARED_IMAGES_*,
// PI_SHARED_AUDIO_*, PI_INCOGNITO, PI_AUDIO_* / PULSE_* for optional host
// playback, and AGENT_UTILS_TENDRIL_* / TENDRIL_SHARE_* for capture. Tendril runs
// through the session's own environment, so profile and session env files apply.

import { readFileSync } from "node:fs";
import { createDurableMedia } from "../lib/durable-media.js";

const INSTANCE = Symbol.for("agent-utils.durable-media.v1");

/** Absolute playback binaries the Nix package records next to this module. */
function packagedExecutables() {
  try {
    const value = JSON.parse(readFileSync(new URL("./runtime-paths.json", import.meta.url), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([, path]) => typeof path === "string" && path.startsWith("/")))
      : {};
  } catch { return {}; }
}

function start() {
  // pi-daemon re-imports an edited module: stop the previous instance's playback.
  globalThis[INSTANCE]?.dispose?.();
  const instance = createDurableMedia({ env: process.env, executables: packagedExecutables() });
  globalThis[INSTANCE] = instance;
  return instance;
}

export const extension = start().extension;
