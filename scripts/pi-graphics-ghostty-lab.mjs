#!/usr/bin/env node
// Visual lab for Pi graphics: runs a real Ghostty (or kitty) inside a private
// Xvfb display, drives it with xdotool and captures PNG screenshots with PIL.
//
// This is an explicit operator/agent diagnostic, never part of `npm test`:
// terminal rendering is environment dependent. It isolates Pi with a throwaway
// PI_CODING_AGENT_DIR so the real ~/.pi/agent/settings.json is never touched.
//
//   node scripts/pi-graphics-ghostty-lab.mjs --out=/tmp/gfxlab/run \
//     --tui=fullscreen --settings='{"piGraphics":{"mode":"on"}}' \
//     --steps='wait:6000,shot:start,type:hello world,wait:800,shot:typed'
//   burst:COUNT;GAP_MS;NAME takes rapid screenshots (short-lived effects).
//
// Steps: wait:<ms> | shot:<name> | type:<text> | key:<xdotool keysym> |
//        cmd:<slash command, typed then Enter> | resize:<cols>x<rows>
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeLabSessionFixture } from "./pi-graphics-lab-fixture.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const match = /^--([^=]+)(?:=(.*))?$/s.exec(arg);
  return match ? [match[1], match[2] ?? "1"] : [arg, "1"];
}));

const out = resolve(args.out || `/tmp/pi-gfx-lab-${Date.now()}`);
const display = args.display || `:${90 + Math.floor(Math.random() * 9)}`;
const mockPort = 18000 + Math.floor(Math.random() * 900);
const terminal = args.terminal || "ghostty";
const fontSize = Number(args["font-size"] || 12);
const cols = Number(args.cols || 110);
const rows = Number(args.rows || 34);
const screen = args.screen || "1600x1000x24";
mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, DISPLAY: display, LIBGL_ALWAYS_SOFTWARE: "1" };
delete env.TMUX;
delete env.KITTY_WINDOW_ID;

function sh(cmd, argv, extra = {}) {
  return spawnSync(cmd, argv, { env, encoding: "utf8", ...extra });
}

async function screenshot(name) {
  const file = join(out, `${name}.png`);
  const py = `from PIL import ImageGrab\nim=ImageGrab.grab(xdisplay=${JSON.stringify(display)})\nbox=im.getbbox()\nim.crop(box).save(${JSON.stringify(file)}) if box else im.save(${JSON.stringify(file)})`;
  const result = sh("python3", ["-c", py]);
  if (result.status !== 0) throw new Error(`screenshot failed: ${result.stderr}`);
  console.log(`shot ${file}`);
  return file;
}

function xdo(...argv) {
  const result = sh("xdotool", argv);
  if (result.status !== 0) console.error(`xdotool ${argv.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function isolatedAgentDir() {
  const agentDir = join(out, "agent");
  mkdirSync(agentDir, { recursive: true });
  const realAuth = join(homedir(), ".pi/agent/auth.json");
  if (existsSync(realAuth) && !existsSync(join(agentDir, "auth.json"))) copyFileSync(realAuth, join(agentDir, "auth.json"));
  const base = {
    theme: "kitty-graphics-nord",
    quietStartup: true,
    tuiMode: args.tui || "regular",
    piGraphics: { mode: "on" },
  };
  const overlay = args.settings ? JSON.parse(args.settings) : {};
  const merged = { ...base, ...overlay, piGraphics: { ...base.piGraphics, ...(overlay.piGraphics || {}) } };
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(merged, null, 2)}\n`);
  if (args["mock-model"]) {
    // A local OpenAI-compatible server that streams thinking + markdown, so
    // Pi's real streaming path runs without a model (scripts/lab/mock-openai-stream.mjs).
    writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({
      providers: {
        mock: {
          baseUrl: `http://127.0.0.1:${mockPort}/v1`, api: "openai-completions", apiKey: "mock",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [{ id: "mock-stream", name: "Mock stream", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        },
      },
    }, null, 2)}\n`);
  }
  return agentDir;
}

async function main() {
  const xvfb = spawn("Xvfb", [display, "-screen", "0", screen, "+extension", "GLX"], { env, stdio: "ignore" });
  await sleep(1200);
  const mock = args["mock-model"]
    ? spawn(process.execPath, [join(repo, "scripts/lab/mock-openai-stream.mjs"), String(mockPort)], { env: { ...env, ...(args["mock-env"] ? JSON.parse(args["mock-env"]) : {}) }, stdio: "ignore" })
    : null;
  const agentDir = isolatedAgentDir();
  const extensions = String(args.extensions || "extensions/pi-graphics.js")
    .split(",").filter(Boolean).flatMap((file) => ["-e", resolve(repo, file)]);
  const sessionArgs = args.fixture
    ? ["--session", writeLabSessionFixture(join(out, "fixture-session.jsonl"), { cwd: args.cwd || repo, turns: Number(args.fixture) || 6, image: Boolean(args["fixture-image"]) })]
    : ["--no-session"];
  const piArgs = args.command
    ? ["bash", "-lc", args.command]
    : ["pi", "--offline", "-ne", "-ns", "-np", "-nc", ...(args["mock-model"] ? ["--provider", "mock", "--model", "mock-stream"] : []), ...sessionArgs, "--theme", join(repo, "themes"), ...extensions, ...(args.tui ? ["--tui-mode", args.tui] : [])];
  const termEnv = { ...env, PI_CODING_AGENT_DIR: agentDir, PI_GRAPHICS_ID_NAMESPACE: `lab-${Date.now()}`, ...(args.env ? JSON.parse(args.env) : {}) };
  const termArgv = terminal === "kitty"
    ? ["-o", `font_size=${fontSize}`, "-o", `initial_window_width=${cols}c`, "-o", `initial_window_height=${rows}c`, "-o", "remember_window_size=no", ...piArgs]
    : [`--window-width=${cols}`, `--window-height=${rows}`, `--font-size=${fontSize}`, "--window-decoration=false", "-e", ...piArgs];
  if (args.record && !args.command) {
    // Tee the exact pty byte stream Pi writes so protocol traffic can be audited.
    const quoted = piArgs.map((a) => `'${String(a).replaceAll("'", "'\\''")}'`).join(" ");
    const wrapped = ["script", "-q", "-f", "-c", quoted, join(out, "pty.log")];
    termArgv.splice(termArgv.length - piArgs.length, piArgs.length, ...wrapped);
  }
  const term = spawn(terminal, termArgv, { env: termEnv, stdio: ["ignore", "pipe", "pipe"], cwd: args.cwd || repo });
  let termLog = "";
  term.stdout.on("data", (d) => { termLog += d; });
  term.stderr.on("data", (d) => { termLog += d; });

  const steps = String(args.steps || "wait:6000,shot:start").split(",").filter(Boolean);
  try {
    for (const step of steps) {
      const idx = step.indexOf(":");
      const kind = idx < 0 ? step : step.slice(0, idx);
      const value = idx < 0 ? "" : step.slice(idx + 1);
      if (kind === "wait") await sleep(Number(value) || 500);
      else if (kind === "shot") await screenshot(value || `shot-${Date.now()}`);
      else if (kind === "burst") {
        // burst:COUNT;GAP_MS;NAME — rapid screenshots to catch short effects.
        const [count = "6", gap = "120", name = "burst"] = value.split(";");
        for (let k = 0; k < Number(count); k += 1) { await screenshot(`${name}-${String(k).padStart(2, "0")}`); await sleep(Number(gap)); }
      }
      else if (kind === "type") { xdo("type", "--delay", String(args["type-delay"] || 40), value.replaceAll("\\c", ",")); }
      else if (kind === "key") { for (const key of value.split("+space+")) xdo("key", key); }
      else if (kind === "cmd") { xdo("type", "--delay", "20", value.replaceAll("\\c", ",")); await sleep(250); xdo("key", "Return"); }
      else if (kind === "resize") {
        const [c, r] = value.split("x").map(Number);
        const win = xdo("search", "--onlyvisible", "--class", terminal).trim().split("\n")[0];
        if (win) xdo("windowsize", win, String(Math.round(c * 10 + 20)), String(Math.round(r * 20 + 20)));
      } else if (kind === "mouse") {
        const [x, y, button = "1"] = value.split("x").join(" ").split(/\s+/);
        xdo("mousemove", x, y); if (button !== "0") xdo("click", button);
      } else if (kind === "drag") {
        const [x0, y0, x1, y1] = value.split(/[x;]/).map(Number);
        xdo("mousemove", String(x0), String(y0)); xdo("mousedown", "1");
        for (let i = 1; i <= 8; i += 1) { xdo("mousemove", String(Math.round(x0 + (x1 - x0) * i / 8)), String(Math.round(y0 + (y1 - y0) * i / 8))); await sleep(30); }
        xdo("mouseup", "1");
      } else if (kind === "scroll") {
        const [x, y, dir, n = "3"] = value.split(/[x;]/);
        xdo("mousemove", x, y); for (let i = 0; i < Number(n); i += 1) xdo("click", dir === "up" ? "4" : "5");
      } else console.error(`unknown step ${step}`);
    }
  } finally {
    writeFileSync(join(out, "terminal.log"), termLog);
    try { term.kill("SIGTERM"); } catch {}
    await sleep(300);
    try { xvfb.kill("SIGTERM"); } catch {}
    try { mock?.kill("SIGTERM"); } catch {}
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
