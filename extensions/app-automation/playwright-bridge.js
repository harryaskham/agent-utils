import { writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_PLAYWRIGHT_CLI = "playwright-cli";

function sanitizeFilenamePart(value) {
  return String(value || "item")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

export function playwrightCliCommand(env = process.env) {
  return env.APP_AUTOMATION_PLAYWRIGHT_CLI || DEFAULT_PLAYWRIGHT_CLI;
}

export function playwrightSessionArgs(params = {}) {
  const session = params.session || params.playwrightSession || process.env.APP_AUTOMATION_PLAYWRIGHT_SESSION;
  return session ? [`-s=${String(session)}`] : [];
}

export function buildBrowserOpenCommand(step = {}, params = {}, env = process.env) {
  const url = step.url || (step.urlParam ? params[step.urlParam] : undefined) || params.targetUrl;
  if (!url) return { executable: false, reason: "browser.open requires url or urlParam" };
  return {
    executable: true,
    command: playwrightCliCommand(env),
    args: [...playwrightSessionArgs(params), "open", String(url)],
  };
}

export function buildDomExtractCommand(step = {}, params = {}, paths = {}, env = process.env) {
  const outputPath = paths.outputPath || params.extractionOutputPath;
  const scriptPath = paths.scriptPath || step.scriptFile || params.extractorPath;
  if (!scriptPath) return { executable: false, reason: "dom.extract requires a scriptFile, extractorPath, or generated script" };
  if (!outputPath) return { executable: false, reason: "dom.extract requires an extraction output path" };
  return {
    executable: true,
    command: playwrightCliCommand(env),
    args: [...playwrightSessionArgs(params), "evaluate", "--script-file", String(scriptPath), "--output", String(outputPath)],
    outputPath,
    scriptPath,
  };
}

export async function prepareDomExtractStep(step = {}, params = {}, { snapshotDir, actionId } = {}) {
  if (!step.script && !params.extractorScript) return { step, paths: {} };
  const script = String(params.extractorScript || step.script);
  const scriptPath = path.join(snapshotDir, `${sanitizeFilenamePart(actionId || "extract")}-extractor.js`);
  await writeFile(scriptPath, `${script}\n`, "utf8");
  return { step: { ...step, scriptFile: scriptPath }, paths: { scriptPath } };
}

export function authMissingHint(result = {}) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}`.toLowerCase();
  return /sign in|signin|login|log in|auth|unauthorized|forbidden/.test(text);
}
