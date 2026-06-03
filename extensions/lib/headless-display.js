// Headless-node display detection (bd-44d94e).
//
// Several agent-utils extensions are display-dependent: tendril-share captures
// windows/displays, android screenshots an emulator, app-automation drives a
// browser, and the kitty/pi-graphics surfaces render into a terminal. On
// headless Linux/WSL nodes these silently fail with no guidance. This helper
// classifies display availability from the environment and returns an
// actionable remediation hint (e.g. start an Xvfb virtual display, or note the
// WSLg path) so diagnostics can point operators at a fix instead of a dead end.
//
// Pure over its `env` / `platform` inputs so it is trivially unit-testable. It
// does NOT spawn Xvfb or mutate the environment; orchestration is a follow-up
// slice.

export const DISPLAY_NATIVE = "native-display";
export const DISPLAY_WSLG = "wslg";
export const DISPLAY_HEADLESS = "headless-no-display";

const XVFB_HINT =
  'No DISPLAY detected. Start a virtual display, e.g. `Xvfb :99 -screen 0 1920x1080x24 &` then `export DISPLAY=:99` before running display-dependent tools.';
const WSLG_HINT =
  "WSLg display detected (WAYLAND_DISPLAY under /mnt/wslg). GUI/capture should work via the WSLg compositor; no Xvfb needed.";
const NATIVE_HINT = "Native display available; no virtual-display setup required.";
const MACOS_HINT = "macOS always has a window server / display; no virtual-display setup required.";

function firstNonEmpty(...values) {
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) return trimmed;
  }
  return "";
}

// Detect a WSLg environment: WSL2 ships a Wayland compositor exposed at
// /mnt/wslg with WAYLAND_DISPLAY set. We treat a Wayland display whose socket
// path points under /mnt/wslg, or an explicit WSL marker plus WAYLAND_DISPLAY,
// as WSLg.
function looksLikeWslg(env) {
  const wayland = firstNonEmpty(env.WAYLAND_DISPLAY);
  if (!wayland) return false;
  const runtimeDir = firstNonEmpty(env.XDG_RUNTIME_DIR);
  if (runtimeDir.includes("/mnt/wslg")) return true;
  // WSL exports WSL_DISTRO_NAME / WSL_INTEROP; combined with a Wayland display
  // this is WSLg rather than a native Wayland session.
  if (firstNonEmpty(env.WSL_DISTRO_NAME, env.WSL_INTEROP)) return true;
  return false;
}

/**
 * Classify display availability for the current (or supplied) environment.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] environment to inspect (defaults to process.env)
 * @param {string} [options.platform] node platform string (defaults to process.platform)
 * @returns {{ kind: string, hasDisplay: boolean, display: string, waylandDisplay: string, isWslg: boolean, hint: string }}
 */
export function detectHeadlessDisplay({ env = process.env, platform = process.platform } = {}) {
  const display = firstNonEmpty(env?.DISPLAY);
  const waylandDisplay = firstNonEmpty(env?.WAYLAND_DISPLAY);

  // macOS (and Windows) use a system window server rather than X11/Wayland env
  // vars; treat them as always having a display for our purposes.
  if (platform === "darwin" || platform === "win32") {
    return {
      kind: DISPLAY_NATIVE,
      hasDisplay: true,
      display,
      waylandDisplay,
      isWslg: false,
      hint: MACOS_HINT,
    };
  }

  const isWslg = looksLikeWslg(env || {});
  if (isWslg) {
    return {
      kind: DISPLAY_WSLG,
      hasDisplay: true,
      display,
      waylandDisplay,
      isWslg: true,
      hint: WSLG_HINT,
    };
  }

  if (display || waylandDisplay) {
    return {
      kind: DISPLAY_NATIVE,
      hasDisplay: true,
      display,
      waylandDisplay,
      isWslg: false,
      hint: NATIVE_HINT,
    };
  }

  return {
    kind: DISPLAY_HEADLESS,
    hasDisplay: false,
    display: "",
    waylandDisplay: "",
    isWslg: false,
    hint: XVFB_HINT,
  };
}

/**
 * One-line, doctor-friendly summary of display availability.
 *
 * @param {ReturnType<typeof detectHeadlessDisplay>} [info]
 * @returns {string}
 */
export function headlessDisplaySummary(info = detectHeadlessDisplay()) {
  const status = info.hasDisplay ? "available" : "MISSING";
  const detail = info.display
    ? `DISPLAY=${info.display}`
    : info.waylandDisplay
      ? `WAYLAND_DISPLAY=${info.waylandDisplay}`
      : "no DISPLAY/WAYLAND_DISPLAY";
  return `display ${status} (${info.kind}; ${detail}) — ${info.hint}`;
}
