import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderFallbackHtml(markdown, { title = "Canvas sync" } = {}) {
  const escaped = escapeHtml(markdown);
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\">",
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    "<pre style=\"white-space: pre-wrap; font-family: system-ui, sans-serif;\">",
    escaped,
    "</pre>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function resolveSourcePath(cwd, sourcePath) {
  if (!sourcePath) throw new Error("canvas sync requires sourcePath");
  const expanded = String(sourcePath).startsWith("~/")
    ? path.join(process.env.HOME || ".", String(sourcePath).slice(2))
    : String(sourcePath);
  return path.resolve(cwd || process.cwd(), expanded);
}

export function buildCanvasPastePlan(params = {}) {
  const targetUrl = params.targetUrl || null;
  const targetSelector = params.targetSelector || null;
  const pasteMode = params.pasteMode || "clipboard-paste";
  const steps = [];
  if (targetUrl) steps.push({ kind: "browser.open", url: targetUrl, reuseSession: true });
  if (targetSelector) steps.push({ kind: "editor.focus", selector: targetSelector });
  if (targetUrl && targetSelector) {
    steps.push({ kind: "editor.replace", selector: targetSelector, inputPath: "paste.txt", pasteMode });
  }
  return { targetUrl, targetSelector, pasteMode, executable: Boolean(targetUrl && targetSelector), steps };
}

export async function syncMarkdownCanvas(params = {}, { snapshotDir, cwd = process.cwd(), now = new Date() } = {}) {
  const sourcePath = resolveSourcePath(cwd, params.sourcePath);
  const markdown = await readFile(sourcePath, "utf8");
  const title = params.title || path.basename(sourcePath);
  const html = renderFallbackHtml(markdown, { title });
  const pasteText = params.exportFormat === "markdown" ? markdown : html;
  const pastePlan = buildCanvasPastePlan(params);
  const paths = {
    markdown: path.join(snapshotDir, "latest.md"),
    html: path.join(snapshotDir, "latest.html"),
    paste: path.join(snapshotDir, "paste.txt"),
    sync: path.join(snapshotDir, "sync.json"),
  };
  const metadata = {
    version: 1,
    app: "canvas",
    kind: "sync-markdown",
    status: pastePlan.executable ? "ready_for_browser_sync" : "exported",
    syncedAt: now.toISOString(),
    sourcePath,
    title,
    exportFormat: params.exportFormat || "html",
    outputs: paths,
    pastePlan,
    note: pastePlan.executable
      ? "Paste/import execution is represented as a deterministic plan for the browser driver follow-up."
      : "Provide targetUrl and targetSelector to produce a browser paste plan.",
  };
  await writeFile(paths.markdown, markdown, "utf8");
  await writeFile(paths.html, html, "utf8");
  await writeFile(paths.paste, pasteText, "utf8");
  await writeFile(paths.sync, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  return metadata;
}
