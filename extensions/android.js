import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ToolSchema as Type } from "./lib/tool-schema.js";

const INSTALL_URL = "https://dl.google.com/android/cli/latest/linux_x86_64/install.sh";
const INSTALL_COMMAND = `curl -fsSL ${INSTALL_URL} | bash`;
const TOOL_PREFIX = "android_cli";
const FALSE_RE = /^(0|false|off|no|disabled)$/i;

function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

function expandHome(inputPath) {
  const text = String(inputPath || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function resolvePath(cwd, inputPath) {
  return path.resolve(cwd || process.cwd(), expandHome(inputPath));
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function androidHome() {
  return env("ANDROID_HOME", "ANDROID_SDK_ROOT") || path.join(os.homedir(), "Android", "Sdk");
}

function pathCandidates(command) {
  const sdk = androidHome();
  const names = command === "android" ? ["android", "sdkmanager"] : [command];
  const dirs = [
    path.join(sdk, "cmdline-tools", "latest", "bin"),
    path.join(sdk, "cmdline-tools", "bin"),
    path.join(sdk, "platform-tools"),
    path.join(sdk, "emulator"),
  ];
  const out = [];
  for (const dir of dirs) for (const name of names) out.push(path.join(dir, name));
  return out;
}

function findCommand(command) {
  const override = env(`ANDROID_${command.toUpperCase()}_BIN`);
  if (override && existsSync(expandHome(override))) return expandHome(override);
  for (const candidate of pathCandidates(command)) if (existsSync(candidate)) return candidate;
  const result = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(command)}`], { encoding: "utf8" });
  const found = String(result.stdout || "").trim().split("\n")[0];
  return result.status === 0 && found ? found : undefined;
}

function runCommand(command, args = [], { timeoutMs = 30_000, cwd = process.cwd(), input, env: extraEnv = {}, encoding = "utf8" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500).unref?.();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, signal: null, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        stdout: encoding ? out.toString(encoding) : out,
        stderr: encoding ? err.toString(encoding) : err,
      });
    });
    if (input) {
      child.stdin.end(input);
    }
  });
}

async function captureAdbPng({ serial, outputPath, timeoutMs = 15_000 } = {}) {
  const adb = findCommand("adb");
  if (!adb) throw new Error(`adb not found. Install Android CLI first: ${INSTALL_COMMAND}`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  const args = [];
  if (serial) args.push("-s", String(serial));
  args.push("exec-out", "screencap", "-p");
  const result = await runCommand(adb, args, { timeoutMs, encoding: null });
  if (!result.ok || !Buffer.isBuffer(result.stdout) || result.stdout.length === 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : String(result.stderr || "");
    throw new Error(`adb screencap failed${result.timedOut ? " (timed out)" : ""}: ${stderr || result.error || `exit ${result.code}`}`);
  }
  await writeFile(outputPath, result.stdout);
  return outputPath;
}

async function imageContent(filePath) {
  return { type: "image", data: (await readFile(filePath)).toString("base64"), mimeType: "image/png" };
}

function defaultScreenshotPath(ctx, prefix = "android-emulator") {
  const root = path.join(os.tmpdir(), "pi-android-cli", String(process.pid));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(root, `${prefix}-${stamp}.png`);
}

function contentText(lines) {
  return [{ type: "text", text: lines.filter(Boolean).join("\n") }];
}

function helpText() {
  return [
    "Android CLI helper extension",
    "",
    "Install/update:",
    `  android_cli_install confirmed=true  # runs: ${INSTALL_COMMAND}`,
    "  android_cli_update confirmed=true   # runs: android update (or sdkmanager --update)",
    "  android_cli_doctor                  # checks android/adb/emulator availability",
    "",
    "Emulator screenshots and previews:",
    "  android_emulator_screenshot serial=<adb-serial?> preview=true",
    "  android_emulator_stream frames=20 intervalMs=500 preview=true",
    "",
    "The screenshot tools save PNGs and return image content so Pi can show them immediately. The saved path can also be passed to kitty_image_preview_add for the persistent preview widget.",
  ].join("\n");
}

async function doctorDetails() {
  const android = findCommand("android");
  const adb = findCommand("adb");
  const emulator = findCommand("emulator");
  const sdkmanager = findCommand("sdkmanager");
  const adbDevices = adb ? await runCommand(adb, ["devices", "-l"], { timeoutMs: 10_000 }) : undefined;
  return { androidHome: androidHome(), android, adb, emulator, sdkmanager, adbDevices };
}

export default function androidCliExtension(pi) {
  pi.registerTool?.({
    name: "android_cli_doctor",
    label: "Android CLI Doctor",
    description: "Check Android CLI, adb, emulator, and SDK manager availability; report install/update commands and usage help.",
    promptSnippet: "Diagnose Android CLI availability and show Android helper usage.",
    parameters: Type.object({}),
    async execute() {
      const details = await doctorDetails();
      const lines = [
        "Android CLI doctor",
        `ANDROID_HOME/SDK_ROOT: ${details.androidHome}`,
        `android: ${details.android || "missing"}`,
        `adb: ${details.adb || "missing"}`,
        `emulator: ${details.emulator || "missing"}`,
        `sdkmanager: ${details.sdkmanager || "missing"}`,
        details.adbDevices ? `adb devices:\n${String(details.adbDevices.stdout || details.adbDevices.stderr || "").trim() || "(no output)"}` : "adb devices: unavailable",
        "",
        helpText(),
      ];
      return { content: contentText(lines), details };
    },
  });

  pi.registerTool?.({
    name: "android_cli_help",
    label: "Android CLI Help",
    description: "Show concise Android CLI helper usage and the underlying install/update commands.",
    promptSnippet: "Show Android CLI helper usage for install, update, screenshots, and streams.",
    parameters: Type.object({}),
    async execute() {
      return { content: contentText([helpText()]), details: { installCommand: INSTALL_COMMAND } };
    },
  });

  pi.registerTool?.({
    name: "android_cli_install",
    label: "Android CLI Install",
    description: "Install Android CLI using Google's install script. Requires confirmed=true; otherwise returns the exact command as dry-run guidance.",
    promptSnippet: "Install Android CLI when adb/android tools are missing, after explicit confirmation.",
    parameters: Type.object({
      confirmed: Type.optional(Type.boolean({ description: "Required true to run the install command." })),
      timeoutMs: Type.optional(Type.number({ description: "Install timeout in milliseconds. Defaults to 120000." })),
    }),
    async execute(_id, params = {}) {
      if (params.confirmed !== true) {
        return { content: contentText(["Dry run only. Re-run with confirmed=true to execute:", INSTALL_COMMAND]), details: { installCommand: INSTALL_COMMAND, dryRun: true } };
      }
      const result = await runCommand("bash", ["-lc", INSTALL_COMMAND], { timeoutMs: clampInteger(params.timeoutMs, 120_000, 1_000, 900_000) });
      return { content: contentText([`android install ${result.ok ? "completed" : "failed"}`, `command: ${INSTALL_COMMAND}`, result.stdout, result.stderr]), details: { ...result, installCommand: INSTALL_COMMAND } };
    },
  });

  pi.registerTool?.({
    name: "android_cli_update",
    label: "Android CLI Update",
    description: "Run Android CLI update. Uses `android update` when available, otherwise `sdkmanager --update`. Requires confirmed=true.",
    promptSnippet: "Update Android CLI/SDK packages after explicit confirmation.",
    parameters: Type.object({
      confirmed: Type.optional(Type.boolean({ description: "Required true to run update." })),
      timeoutMs: Type.optional(Type.number({ description: "Update timeout in milliseconds. Defaults to 120000." })),
    }),
    async execute(_id, params = {}) {
      const android = findCommand("android");
      const sdkmanager = findCommand("sdkmanager");
      const command = android || sdkmanager;
      const args = android ? ["update"] : ["--update"];
      const display = command ? `${command} ${args.join(" ")}` : "android update (missing android; sdkmanager --update fallback also missing)";
      if (params.confirmed !== true) return { content: contentText(["Dry run only. Re-run with confirmed=true to execute:", display]), details: { command: display, dryRun: true } };
      if (!command) throw new Error(`No android or sdkmanager command found. Install Android CLI first: ${INSTALL_COMMAND}`);
      const result = await runCommand(command, args, { timeoutMs: clampInteger(params.timeoutMs, 120_000, 1_000, 900_000) });
      return { content: contentText([`android update ${result.ok ? "completed" : "failed"}`, `command: ${display}`, result.stdout, result.stderr]), details: { ...result, command: display } };
    },
  });

  pi.registerTool?.({
    name: "android_emulator_screenshot",
    label: "Android Emulator Screenshot",
    description: "Capture an adb emulator/device screenshot as PNG, return image content for immediate Pi display, and save the file for kitty_image_preview_add.",
    promptSnippet: "Capture and show an Android emulator screenshot in Pi, then optionally pass its path to kitty_image_preview_add for persistent preview.",
    parameters: Type.object({
      serial: Type.optional(Type.string({ description: "Optional adb serial, e.g. emulator-5554." })),
      outputPath: Type.optional(Type.string({ description: "PNG output path. Defaults to a temp pi-android-cli path." })),
      preview: Type.optional(Type.boolean({ description: "Return image content for immediate Pi display. Defaults to true." })),
      timeoutMs: Type.optional(Type.number({ description: "adb screencap timeout. Defaults to 15000." })),
    }),
    async execute(_id, params = {}, _signal, onUpdate, ctx) {
      const outputPath = resolvePath(ctx?.cwd || process.cwd(), params.outputPath || defaultScreenshotPath(ctx, "android-emulator"));
      onUpdate?.({ content: contentText([`Capturing Android emulator screenshot to ${outputPath}...`]) });
      await captureAdbPng({ serial: params.serial, outputPath, timeoutMs: clampInteger(params.timeoutMs, 15_000, 1_000, 120_000) });
      const info = await stat(outputPath);
      const content = contentText([`Captured Android screenshot: ${outputPath}`, "For persistent Kitty preview, call kitty_image_preview_add with this path."]);
      if (params.preview !== false) content.push(await imageContent(outputPath));
      return { content, details: { path: outputPath, size: info.size, serial: params.serial, preview: params.preview !== false, nextTool: { name: "kitty_image_preview_add", params: { path: outputPath, show: true } } } };
    },
  });

  pi.registerTool?.({
    name: "android_emulator_stream",
    label: "Android Emulator Stream",
    description: "Bounded Android emulator screenshot stream: repeatedly capture adb screencaps and send image updates to Pi without modifying model context beyond the final result.",
    promptSnippet: "Show a short live Android emulator screenshot stream in Pi using repeated adb screencaps.",
    parameters: Type.object({
      serial: Type.optional(Type.string({ description: "Optional adb serial, e.g. emulator-5554." })),
      frames: Type.optional(Type.number({ description: "Number of frames to capture. Defaults to 20, max 240." })),
      intervalMs: Type.optional(Type.number({ description: "Delay between frames. Defaults to 500ms." })),
      outputDir: Type.optional(Type.string({ description: "Directory for latest stream frames. Defaults to temp pi-android-cli." })),
      preview: Type.optional(Type.boolean({ description: "Send each captured frame as image update content. Defaults to true." })),
      timeoutMs: Type.optional(Type.number({ description: "Per-frame adb timeout. Defaults to 15000." })),
    }),
    async execute(_id, params = {}, signal, onUpdate, ctx) {
      const frames = clampInteger(params.frames, 20, 1, 240);
      const intervalMs = clampInteger(params.intervalMs, 500, 50, 10_000);
      const outputDir = resolvePath(ctx?.cwd || process.cwd(), params.outputDir || path.join(os.tmpdir(), "pi-android-cli", String(process.pid), "stream"));
      await mkdir(outputDir, { recursive: true });
      let latestPath;
      let captured = 0;
      for (let i = 0; i < frames; i += 1) {
        if (signal?.aborted) break;
        latestPath = path.join(outputDir, `android-stream-${String(i % 2).padStart(2, "0")}.png`);
        await captureAdbPng({ serial: params.serial, outputPath: latestPath, timeoutMs: clampInteger(params.timeoutMs, 15_000, 1_000, 120_000) });
        captured += 1;
        if (params.preview !== false) onUpdate?.({ content: [{ type: "text", text: `Android emulator stream frame ${captured}/${frames}: ${latestPath}` }, await imageContent(latestPath)] });
        if (i < frames - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      const content = contentText([`Android emulator stream captured ${captured}/${frames} frame(s).`, latestPath ? `Latest frame: ${latestPath}` : "No frame captured.", "For persistent Kitty preview, call kitty_image_preview_add with the latest frame path."]);
      if (latestPath && params.preview !== false) content.push(await imageContent(latestPath));
      return { content, details: { framesRequested: frames, framesCaptured: captured, latestPath, outputDir, nextTool: latestPath ? { name: "kitty_image_preview_add", params: { path: latestPath, show: true } } : undefined } };
    },
  });

  pi.registerCommand?.("android", {
    description: "Android CLI helpers. Usage: /android help|doctor|install|update. Screenshot/stream are available as tools android_emulator_screenshot/android_emulator_stream.",
    handler: async (args, ctx) => {
      const action = String(args || "help").trim().toLowerCase();
      if (action === "doctor" || action === "status") {
        const details = await doctorDetails();
        ctx.ui?.notify?.([`Android CLI doctor`, `android: ${details.android || "missing"}`, `adb: ${details.adb || "missing"}`, `emulator: ${details.emulator || "missing"}`, `sdkmanager: ${details.sdkmanager || "missing"}`, "", helpText()].join("\n"), "info");
        return;
      }
      if (action === "install") {
        ctx.ui?.notify?.(`Install command (run android_cli_install confirmed=true to execute):\n${INSTALL_COMMAND}`, "info");
        return;
      }
      if (action === "update") {
        ctx.ui?.notify?.("Run android_cli_update confirmed=true to execute android update / sdkmanager --update.", "info");
        return;
      }
      ctx.ui?.notify?.(helpText(), "info");
    },
  });
}
