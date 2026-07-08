// bd-dddd7a: voice-quickfile — route a committed local-vad utterance to a caco
// DRAFT bead instead of the chat buffer, for hands-free bead capture ("brain-dump
// ideas by voice, land them as drafts for triage"). Reuses the existing local-vad
// pipeline (LocalVadController + VadSegmenter + batch STT); the only new piece is
// this onTurn sink.
//
// Pure/injectable so it is fully unit-testable in the bare `node --test` gate:
//   * deriveQuickfileBead() splits an utterance into a bead title + description
//     (no I/O);
//   * fileQuickfileUtterance() shells out to `caco bd create --status draft`
//     (or `caco bd expand` for a multi-bead brain-dump) via an injectable runner
//     — execFile in production, a mock in tests, so no child process is spawned
//     under test.

import { execFile } from "node:child_process";

const DEFAULT_TITLE_MAX = 72;
const BEAD_ID_RE = /\bbd-[0-9a-f]{6}\b/;

/// Derive a { title, description } from a spoken utterance.
///   title       = the first line, trimmed and bounded to `titleMax` chars
///                 (cut on a word boundary when possible, with an ellipsis).
///   description = the full trimmed utterance.
/// Returns null for empty / whitespace-only input (nothing to file).
export function deriveQuickfileBead(text, { titleMax = DEFAULT_TITLE_MAX } = {}) {
  const full = String(text == null ? "" : text).trim();
  if (!full) return null;
  const firstLine = full.split(/\r?\n/)[0].trim() || full;
  let title = firstLine;
  if (title.length > titleMax) {
    const cut = title.slice(0, titleMax);
    const lastSpace = cut.lastIndexOf(" ");
    title = (lastSpace > titleMax * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
  }
  return { title, description: full };
}

/// Build a caco runner: `(args:string[]) -> Promise<{stdout,stderr,code}>`.
/// Defaults to execFile of CACO_BIN/caco; never throws (errors surface as a
/// non-zero code so callers branch on the result, not exceptions).
export function makeCacoRunner({ cacoBin = process.env.CACO_BIN || "caco", execImpl = execFile, timeoutMs = 15000 } = {}) {
  return (args) =>
    new Promise((resolve) => {
      try {
        execImpl(cacoBin, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          resolve({ stdout: stdout || "", stderr: stderr || "", code: err ? (err.code ?? 1) : 0 });
        });
      } catch (e) {
        resolve({ stdout: "", stderr: e?.message || String(e), code: 1 });
      }
    });
}

/// File one committed utterance as a caco draft bead (or expand it into several).
/// `runCaco` is the injectable runner from makeCacoRunner (mocked in tests).
/// Returns:
///   { ok:true, beadId, title, expand }        on success
///   { ok:false, skipped:true, error }          empty utterance (nothing filed)
///   { ok:false, error, title }                 caco failure
export async function fileQuickfileUtterance(text, { runCaco, project, expand = false, titleMax } = {}) {
  const derived = deriveQuickfileBead(text, { titleMax });
  if (!derived) return { ok: false, skipped: true, error: "empty utterance" };
  const run = typeof runCaco === "function" ? runCaco : makeCacoRunner();
  const projectArgs = project ? ["--project", project] : [];
  const args = expand
    ? ["bd", "expand", ...projectArgs, "--text", derived.description]
    : ["bd", "create", ...projectArgs, "--status", "draft", "--title", derived.title, "--description", derived.description];
  let res;
  try {
    res = await run(args);
  } catch (e) {
    return { ok: false, error: (e?.message || String(e)).slice(0, 300), title: derived.title };
  }
  if (!res || res.code !== 0) {
    const detail = ((res && (res.stderr || res.stdout)) || `caco exited ${res ? res.code : "?"}`).trim();
    return { ok: false, error: detail.slice(0, 300), title: derived.title };
  }
  const beadId = (BEAD_ID_RE.exec(res.stdout || "") || [])[0] || null;
  return { ok: true, beadId, title: derived.title, expand: !!expand };
}
