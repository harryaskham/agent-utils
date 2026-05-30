// External screenshot CLI argv/command construction (Tendril + Playwright CLI)
// extracted from kitty-image-preview.js (bd-e1914a). Pure functions of their
// params/target/output path; behavior unchanged from the inline definitions.

import { clampInteger, shellQuote } from "./text-utils.js";

export function buildTendrilCaptureArgs(params, target, outputPath) {
  const args = [
    "capture",
    "--json",
    "--format",
    "png",
    "--output",
    outputPath,
    "--timeout-ms",
    String(clampInteger(params.timeoutMs, 30_000, 1_000, 120_000)),
    target.kind === "window" ? "--window" : "--display",
    String(target.id),
  ];
  if (params.maxWidth !== undefined) args.push("--max-width", String(clampInteger(params.maxWidth, 0, 1, 100_000)));
  if (params.maxHeight !== undefined) args.push("--max-height", String(clampInteger(params.maxHeight, 0, 1, 100_000)));
  if (params.compression !== undefined) args.push("--compression", String(params.compression));
  return args;
}

export function buildPlaywrightCliScreenshotArgs(params = {}, sourcePath) {
  const args = [];
  if (params.session) args.push(`-s=${String(params.session)}`);
  args.push("screenshot");
  if (params.ref) args.push(String(params.ref));
  args.push("--filename", sourcePath);
  if (params.fullPage === true) args.push("--full-page");
  return args;
}

export function buildPlaywrightCliScreenshotCommand(params = {}, sourcePath) {
  const parts = ["playwright-cli"];
  if (params.session) parts.push(`-s=${shellQuote(params.session)}`);
  parts.push("screenshot");
  if (params.ref) parts.push(shellQuote(params.ref));
  parts.push("--filename", shellQuote(sourcePath));
  if (params.fullPage === true) parts.push("--full-page");
  return parts.join(" ");
}
