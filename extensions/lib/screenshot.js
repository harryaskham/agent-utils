// /screenshot (bd-487820): the person picks a screen region, or takes the whole screen,
// on the machine they sit at, and the image reaches the agent as a user message, sized as Pi
// sizes an image sent with a prompt.
//
// Each platform's own tool does the picking:
//   macOS          screencapture -i (drag a region; Space for a window), screencapture -x (full)
//   Wayland        grim + slurp, gnome-screenshot, spectacle, flameshot
//   X11            maim, flameshot, gnome-screenshot, spectacle, scrot, ImageMagick import
// and settings name a command for anything else (nix-on-droid, WSL, a phone over adb):
//   "agentUtils": { "screenshot": { "region": "cmd writing {file}", "full": "cmd writing {file}" } }

import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runBoundedSubprocess } from "./bounded-exec.js";
import { sniffImageMime } from "./shared-images.js";

export const SCREENSHOT_MODES = Object.freeze(["region", "full"]);
export const SCREENSHOT_SENDS = Object.freeze(["steer", "followUp"]);
export const SCREENSHOT_USAGE =
  "Usage: /screenshot [region|full] [delay=SECONDS] [send=steer|followup] [text for the agent] · /screenshot status";
/** Long enough to pick a region at leisure; the picker is the person's. */
export const REGION_TIMEOUT_MS = 5 * 60_000;
export const FULL_TIMEOUT_MS = 60_000;
export const MAX_DELAY_SECONDS = 60;

const quoteArg = '"$1"';

/**
 * The tools each display server can use, in the order they are tried. `region` and `full` give
 * the command and its arguments for an output file; `needs` are the executables it runs.
 */
export const SCREENSHOT_BACKENDS = Object.freeze([
  {
    name: "macos",
    display: "macos",
    needs: ["screencapture"],
    region: (file) => ["screencapture", ["-i", "-x", file]],
    full: (file) => ["screencapture", ["-x", file]],
  },
  {
    name: "grim",
    display: "wayland",
    needs: ["grim", "slurp"],
    // slurp exits non-zero on Escape: nothing is captured, and that is a cancel.
    region: (file) => ["sh", ["-c", `geometry="$(slurp)" || exit 1; exec grim -g "$geometry" ${quoteArg}`, "sh", file]],
    full: (file) => ["grim", [file]],
  },
  {
    name: "gnome-screenshot",
    display: "any",
    needs: ["gnome-screenshot"],
    region: (file) => ["gnome-screenshot", ["-a", "-f", file]],
    full: (file) => ["gnome-screenshot", ["-f", file]],
  },
  {
    name: "spectacle",
    display: "any",
    needs: ["spectacle"],
    region: (file) => ["spectacle", ["-r", "-b", "-n", "-o", file]],
    full: (file) => ["spectacle", ["-f", "-b", "-n", "-o", file]],
  },
  {
    name: "flameshot",
    display: "any",
    needs: ["flameshot"],
    region: (file) => ["sh", ["-c", `flameshot gui --raw > ${quoteArg}`, "sh", file]],
    full: (file) => ["sh", ["-c", `flameshot full --raw > ${quoteArg}`, "sh", file]],
  },
  {
    name: "maim",
    display: "x11",
    needs: ["maim"],
    region: (file) => ["maim", ["-s", file]],
    full: (file) => ["maim", [file]],
  },
  {
    name: "scrot",
    display: "x11",
    needs: ["scrot"],
    region: (file) => ["scrot", ["-s", file]],
    full: (file) => ["scrot", [file]],
  },
  {
    name: "import",
    display: "x11",
    needs: ["import"],
    region: (file) => ["import", [file]],
    full: (file) => ["import", ["-window", "root", file]],
  },
]);

const BACKEND_NAMES = new Set(SCREENSHOT_BACKENDS.map((backend) => backend.name));

/** Which display this machine shows: macos, wayland, x11, android, or none. */
export function screenshotDisplay({ platform = process.platform, env = process.env } = {}) {
  if (platform === "darwin") return "macos";
  if (platform === "android" || env.ANDROID_ROOT || env.ANDROID_DATA || env.TERMUX_VERSION) return "android";
  if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland") return "wayland";
  if (env.DISPLAY) return "x11";
  return "none";
}

/**
 * Where the system keeps its own tools, searched after PATH: a Nix or Home Manager PATH often
 * leaves out /usr/sbin, where macOS keeps screencapture.
 */
export const SYSTEM_TOOL_DIRS = Object.freeze(["/usr/sbin", "/usr/bin", "/sbin", "/bin", "/run/current-system/sw/bin"]);

/** PATH with the system's tool directories after it, for finding and running the tools. */
export function screenshotPath(env = process.env) {
  const dirs = String(env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of SYSTEM_TOOL_DIRS) if (!dirs.includes(dir)) dirs.push(dir);
  return dirs.join(path.delimiter);
}

/** An executable on PATH or in the system's tool directories (`which`), as a promise of true or false. */
export async function onPath(name, env = process.env) {
  const dirs = screenshotPath(env).split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      await access(path.join(dir, name), fsConstants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

/** `agentUtils.screenshot` from settings.json, with its fields checked. */
export function screenshotSettings(settings = {}) {
  const raw = settings?.agentUtils?.screenshot;
  const own = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const text = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);
  const backend = text(own.backend);
  const positive = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : undefined);
  return {
    backend: backend === undefined || backend === "auto" ? undefined : backend,
    region: text(own.region),
    full: text(own.full),
    send: normalizeScreenshotSend(own.send) ?? "steer",
    maxWidth: positive(own.maxWidth),
    maxHeight: positive(own.maxHeight),
  };
}

export function normalizeScreenshotSend(value) {
  const send = String(value ?? "").trim().toLowerCase().replace(/[-_\s]/g, "");
  if (send === "steer") return "steer";
  if (send === "followup") return "followUp";
  return undefined;
}

/**
 * `/screenshot` arguments: an optional mode, `delay=`, `send=`, and the rest as the text sent
 * with the image. `status` reports which tool each mode would use.
 */
export function parseScreenshotArgs(args) {
  const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && ["status", "help"].includes(tokens[0].toLowerCase())) return { kind: "status" };
  let mode = "region";
  let delaySeconds = 0;
  let send;
  const words = [];
  let leading = true;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (leading && SCREENSHOT_MODES.includes(lower)) {
      mode = lower;
      continue;
    }
    const assignment = /^(delay|send)=(.*)$/i.exec(token);
    if (leading && assignment) {
      const [, key, value] = assignment;
      if (key.toLowerCase() === "delay") {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DELAY_SECONDS) {
          throw new Error(`/screenshot: delay must be 0–${MAX_DELAY_SECONDS} seconds. ${SCREENSHOT_USAGE}`);
        }
        delaySeconds = seconds;
      } else {
        send = normalizeScreenshotSend(value);
        if (send === undefined) throw new Error(`/screenshot: send must be steer or followup. ${SCREENSHOT_USAGE}`);
      }
      continue;
    }
    leading = false;
    words.push(token);
  }
  return { kind: "capture", mode, delaySeconds, ...(send === undefined ? {} : { send }), text: words.join(" ") };
}

/** A configured command: `{file}` is the output file, also `$PI_SCREENSHOT_FILE`. */
function configuredCommand(command, file) {
  return ["sh", ["-c", command.replaceAll("{file}", quoteArg), "sh", file]];
}

/**
 * The command that takes a `mode` screenshot into `file` on this machine: the configured one,
 * else the configured backend, else the first available tool for this display.
 * Throws an Error that says what to install or configure when there is none.
 */
export async function planScreenshot(mode, file, {
  platform = process.platform,
  env = process.env,
  settings = screenshotSettings(),
  has = (name) => onPath(name, env),
} = {}) {
  if (!SCREENSHOT_MODES.includes(mode)) throw new Error(`/screenshot: unknown mode '${mode}'. ${SCREENSHOT_USAGE}`);
  const configured = settings[mode];
  if (configured) {
    const [command, args] = configuredCommand(configured, file);
    return { backend: "settings", command, args };
  }
  const display = screenshotDisplay({ platform, env });
  const available = async (backend) => {
    for (const need of backend.needs) if (!(await has(need))) return false;
    return true;
  };
  if (settings.backend !== undefined) {
    if (!BACKEND_NAMES.has(settings.backend)) {
      throw new Error(`/screenshot: agentUtils.screenshot.backend '${settings.backend}' is not one of ${[...BACKEND_NAMES].join(", ")}`);
    }
    const backend = SCREENSHOT_BACKENDS.find((candidate) => candidate.name === settings.backend);
    if (!(await available(backend))) throw new Error(`/screenshot: backend ${backend.name} needs ${backend.needs.join(" and ")} on PATH`);
    const [command, args] = backend[mode](file);
    return { backend: backend.name, command, args };
  }
  const candidates = SCREENSHOT_BACKENDS.filter((backend) =>
    display === "macos" ? backend.display === "macos"
      : display === "wayland" ? backend.display === "wayland" || backend.display === "any"
        : display === "x11" ? backend.display === "x11" || backend.display === "any"
          : false);
  for (const backend of candidates) {
    if (!(await available(backend))) continue;
    const [command, args] = backend[mode](file);
    return { backend: backend.name, command, args };
  }
  throw new Error(noBackendMessage(display, mode, candidates));
}

function noBackendMessage(display, mode, candidates) {
  const configure = `or set agentUtils.screenshot.${mode} in settings.json to a command that writes {file}`;
  if (display === "android") {
    return `/screenshot: Android gives this shell no screen to capture; ${configure} (for example a paired machine's "adb exec-out screencap -p > {file}")`;
  }
  if (display === "none") return `/screenshot: no display here (no DISPLAY or WAYLAND_DISPLAY); ${configure}`;
  const tools = [...new Set(candidates.flatMap((backend) => backend.needs))].join(", ");
  return `/screenshot: no screenshot tool found for ${display} (install one of: ${tools}), ${configure}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take a screenshot: `{ cancelled: true }` when the person cancels the picker, else the image's
 * bytes and type. The temporary file is removed either way.
 */
export async function captureScreenshot(mode, {
  delaySeconds = 0,
  platform = process.platform,
  env = process.env,
  settings = screenshotSettings(),
  has,
  run = runBoundedSubprocess,
  wait = sleep,
  tmp = tmpdir(),
} = {}) {
  const dir = await mkdtemp(path.join(tmp, "pi-screenshot-"));
  const file = path.join(dir, "screenshot.png");
  try {
    const plan = await planScreenshot(mode, file, { platform, env, settings, ...(has ? { has } : {}) });
    if (delaySeconds > 0) await wait(delaySeconds * 1000);
    const result = await run({
      command: plan.command,
      args: plan.args,
      stdio: ["ignore", "pipe", "pipe"],
      spawnOptions: { env: { ...env, PATH: screenshotPath(env), PI_SCREENSHOT_FILE: file } },
      timeoutMs: mode === "region" ? REGION_TIMEOUT_MS : FULL_TIMEOUT_MS,
      label: `/screenshot (${plan.backend})`,
    });
    const bytes = await readFile(file).catch(() => undefined);
    if (bytes === undefined || bytes.length === 0) {
      // A picker closed with Escape writes nothing (screencapture exits 0, slurp and maim 1).
      if (mode === "region") return { cancelled: true, backend: plan.backend };
      const stderr = String(result?.stderr ?? "").trim();
      throw new Error(`/screenshot: ${plan.backend} wrote no image${result?.code ? ` (exit ${result.code})` : ""}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
    }
    return { cancelled: false, backend: plan.backend, bytes, mimeType: sniffImageMime(bytes, "image/png", file) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The image as Pi sends one with a prompt: Pi's own `resizeImage` (2000×2000 and 4.5 MB unless
 * settings say less) and its note on the scale, so the agent can map coordinates back. Where Pi's
 * resizer cannot load, the image goes as it is.
 */
export async function prepareScreenshotImage(bytes, mimeType, {
  maxWidth,
  maxHeight,
  loadPi = () => import("@earendil-works/pi-coding-agent"),
} = {}) {
  try {
    const pi = await loadPi();
    if (typeof pi?.resizeImage === "function") {
      const options = { ...(maxWidth ? { maxWidth } : {}), ...(maxHeight ? { maxHeight } : {}) };
      const resized = await pi.resizeImage(bytes, mimeType, options);
      if (resized?.data) {
        return {
          data: resized.data,
          mimeType: resized.mimeType,
          width: resized.width,
          height: resized.height,
          note: typeof pi.formatDimensionNote === "function" ? pi.formatDimensionNote(resized) : undefined,
        };
      }
    }
  } catch {}
  return { data: Buffer.from(bytes).toString("base64"), mimeType };
}

/** The user message: the person's text (or a plain caption), Pi's scale note, then the image. */
export function screenshotContent(image, { mode = "region", text = "" } = {}) {
  const caption = text.trim() || (mode === "full" ? "Screenshot of my screen." : "Screenshot of a screen region I selected.");
  return [
    { type: "text", text: image.note ? `${caption}\n${image.note}` : caption },
    { type: "image", data: image.data, mimeType: image.mimeType },
  ];
}
