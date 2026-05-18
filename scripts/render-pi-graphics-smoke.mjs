#!/usr/bin/env node
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { renderTuiSurfaceSceneFrame, renderTuiSurfaceScenePulseApng } from "../extensions/pi-graphics/components.js";

const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.join("=") || "1"];
}));
const out = resolve(args.get("out") || "artifacts/pi-graphics-smoke.png");
const animated = args.get("animated") !== "0" && args.get("animated") !== "false";
const columns = Number(args.get("columns") || 76);
const rows = Number(args.get("rows") || 16);
const frame = animated
  ? renderTuiSurfaceScenePulseApng({ columns, rows, frames: Number(args.get("frames") || 4), delayMs: Number(args.get("delayMs") || 90) })
  : renderTuiSurfaceSceneFrame({ columns, rows, phase: Number(args.get("phase") || 0.33) });
await mkdir(dirname(out), { recursive: true });
await writeFile(out, frame.png);
console.log(JSON.stringify({ out, columns: frame.columns, rows: frame.rows, widthPx: frame.widthPx, heightPx: frame.heightPx, frames: frame.frames || 1, metrics: frame.metrics }, null, 2));
