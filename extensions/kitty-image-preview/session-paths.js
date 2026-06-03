// Session-scoped screenshot/stream/describe path resolvers extracted from
// kitty-image-preview.js (bd-e1914a). These depend only on the read-only `ctx`
// (ctx.cwd, ctx.sessionManager), node:path / node:os, KITTY_IMAGE_PREVIEW_*
// env, and the already-extracted text-utils helpers. No preview/terminal state
// is touched. Extracted as a closure so the internal sessionTempId /
// getSessionScreenshotDir callers stay co-located. Behavior is unchanged from
// the original inline definitions.

import os from "node:os";
import path from "node:path";

import { resolveUserPath, sanitizeFilenamePart, timestampForFilename } from "./text-utils.js";

export function getSessionScreenshotDir(ctx, outputDir) {
  if (outputDir) return resolveUserPath(ctx.cwd, outputDir);
  if (process.env.KITTY_IMAGE_PREVIEW_SCREENSHOT_DIR) {
    return resolveUserPath(ctx.cwd, process.env.KITTY_IMAGE_PREVIEW_SCREENSHOT_DIR);
  }
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (sessionFile) {
    const sessionId = sanitizeFilenamePart(path.basename(sessionFile).replace(/\.jsonl?$/i, ""));
    return path.join(path.dirname(sessionFile), "kitty-image-preview-screenshots", sessionId);
  }
  return path.join(os.tmpdir(), "pi-kitty-image-preview", `pid-${process.pid}`);
}

export function buildScreenshotOutputPath(ctx, params, target, date = new Date()) {
  const dir = getSessionScreenshotDir(ctx, params.outputDir);
  const filename = params.filename
    ? sanitizeFilenamePart(params.filename.replace(/\.png$/i, ""))
    : `${timestampForFilename(date)}-${sanitizeFilenamePart(target.kind)}-${sanitizeFilenamePart(target.id)}`;
  return {
    dir,
    path: path.join(dir, `${filename}.png`),
  };
}

export function sessionTempId(ctx) {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  return sessionFile
    ? sanitizeFilenamePart(path.basename(sessionFile).replace(/\.jsonl?$/i, ""))
    : `pid-${process.pid}`;
}

export function getStreamDir(ctx) {
  return path.join(os.tmpdir(), "pi-kitty-image-preview-stream", sessionTempId(ctx));
}

export function getDescribeTempDir(ctx) {
  return path.join(os.tmpdir(), "pi-kitty-image-preview-describe", sessionTempId(ctx));
}
