import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export function selectAlternateDisplay(displays, focusedBounds) {
  const online = (Array.isArray(displays) ? displays : []).filter((display) =>
    [display?.x, display?.y, display?.width, display?.height].every(Number.isFinite));
  if (online.length < 2) return null;
  const center = focusedBounds && {
    x: focusedBounds.x + focusedBounds.width / 2,
    y: focusedBounds.y + focusedBounds.height / 2,
  };
  const focused = center && online.find((display) =>
    center.x >= display.x && center.x < display.x + display.width
    && center.y >= display.y && center.y < display.y + display.height);
  return online.find((display) => display !== focused) || online[1];
}

const OPEN_ON_ALTERNATE_DISPLAY_JXA = String.raw`
ObjC.import('AppKit');
function run(argv) {
  const appPath = argv[0];
  const se = Application('System Events');
  const front = se.applicationProcesses.whose({frontmost: true})();
  let focused = null;
  try { const p = front[0].windows[0].position(); const s = front[0].windows[0].size(); focused = {x:p[0],y:p[1],width:s[0],height:s[1]}; } catch (_) {}
  const screens = $.NSScreen.screens.js.map(s => {
    const f=s.frame; return {x:Number(f.origin.x),y:Number(f.origin.y),width:Number(f.size.width),height:Number(f.size.height)};
  });
  const primaryHeight = screens.find(s => s.x === 0 && s.y === 0)?.height || Math.max(...screens.map(s => s.height));
  const axScreens = screens.map(s => ({x:s.x,y:primaryHeight-s.y-s.height,width:s.width,height:s.height}));
  if (axScreens.length < 2) throw new Error('A second display is not available');
  let current = null;
  if (focused) { const c={x:focused.x+focused.width/2,y:focused.y+focused.height/2}; current=axScreens.find(s => c.x>=s.x&&c.x<s.x+s.width&&c.y>=s.y&&c.y<s.y+s.height); }
  const target = axScreens.find(s => s !== current) || axScreens[1];
  const app = Application(appPath); const bundle = app.id();
  const task = $.NSTask.alloc.init; task.launchPath='/usr/bin/open'; task.arguments=['-g', appPath]; task.launch; task.waitUntilExit;
  let proc = null, win = null;
  for (let i=0;i<50;i++) {
    delay(0.1);
    const found=se.applicationProcesses.whose({bundleIdentifier:bundle})();
    if (!found.length) continue;
    proc=found[0];
    try { if (proc.windows.length) { win=proc.windows[0]; break; } } catch (_) {}
  }
  if (!win) throw new Error('Application opened but no movable window appeared');
  const margin=24, width=Math.max(320,target.width-margin*2), height=Math.max(240,target.height-margin*2);
  win.position=[target.x+margin,target.y+margin]; win.size=[width,height];
  return JSON.stringify({bundleIdentifier:bundle,target,activated:false});
}`;

export async function openMacosAppOnAlternateDisplay(appPath, { execFileImpl = execFileAsync } = {}) {
  const resolved = path.resolve(String(appPath || ""));
  if (!resolved.toLowerCase().endsWith(".app")) throw new Error("path must point to a .app bundle");
  if (process.platform !== "darwin") throw new Error("open_macos_app is available only on macOS");
  const { stdout } = await execFileImpl("osascript", ["-l", "JavaScript", "-e", OPEN_ON_ALTERNATE_DISPLAY_JXA, resolved], { timeout: 20_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(String(stdout || "{}").trim() || "{}");
}

export async function captureMacosInteractiveScreenshot(outputPath, { execFileImpl = execFileAsync } = {}) {
  if (process.platform !== "darwin") throw new Error("interactive screenshot is available only on macOS");
  await execFileImpl("screencapture", ["-i", "-s", "-x", outputPath], { timeout: 300_000, maxBuffer: 1024 * 1024 });
  return outputPath;
}
