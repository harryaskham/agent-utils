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
  if (!url && step.optional) return { executable: true, internal: "optional.skip", reason: "optional browser.open skipped because no url was supplied" };
  if (!url) return { executable: false, reason: "browser.open requires url or urlParam" };
  return {
    executable: true,
    command: playwrightCliCommand(env),
    args: [...playwrightSessionArgs(params), "open", String(url)],
  };
}

export function buildDomExtractCommand(step = {}, params = {}, paths = {}, env = process.env) {
  const outputPath = paths.outputPath || params.extractionOutputPath || step.outputPath || step.output;
  const scriptPath = paths.scriptPath || step.scriptFile || params.extractorPath || step.script;
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

export async function prepareDomExtractStep(step = {}, params = {}, { snapshotDir, actionId, scripts = {} } = {}) {
  const scriptSource = params.extractorScript || scripts[step.script] || step.script;
  const paths = {};
  let nextStep = { ...step };
  if (scriptSource) {
    const scriptPath = path.join(snapshotDir, `${sanitizeFilenamePart(actionId || "extract")}-extractor.js`);
    await writeFile(scriptPath, `${scriptSource}\n`, "utf8");
    nextStep = { ...nextStep, scriptFile: scriptPath };
    paths.scriptPath = scriptPath;
  }
  const outputName = step.output || step.outputPath || params.extractionOutputPath;
  if (outputName) {
    paths.outputPath = path.isAbsolute(String(outputName)) ? String(outputName) : path.join(snapshotDir, String(outputName));
    nextStep.outputPath = paths.outputPath;
  }
  return { step: nextStep, paths };
}

export function authMissingHint(result = {}) {
  const text = `${result.stdout || ""}\n${result.stderr || ""}`.toLowerCase();
  return /sign in|signin|login|log in|auth|unauthorized|forbidden/.test(text);
}

function redactUrlSecrets(text) {
  return String(text || "").replace(/https?:\/\/[^\s"'<>]+/gi, (match) => {
    try {
      const parsed = new URL(match);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return match;
    }
  });
}

function redactPotentialSecrets(text) {
  return redactUrlSecrets(String(text || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(token|cookie|secret|password)=([^\s&]+)/gi, "$1=[redacted]"))
    .slice(0, 4000);
}

function redactDiagnosticArg(arg) {
  const value = String(arg);
  if (/^-s=.+/.test(value)) return "-s=[redacted-session]";
  return redactPotentialSecrets(value);
}

export function buildAuthRequiredDiagnostic({ app, action, step = {}, result = {}, now = new Date() } = {}) {
  return {
    version: 1,
    status: "auth_required",
    app,
    action,
    step: {
      index: step.index,
      kind: step.kind,
      command: step.command,
      args: Array.isArray(step.args) ? step.args.map(redactDiagnosticArg) : [],
    },
    detectedAt: now.toISOString(),
    hint: "Open or reuse an authenticated browser session, then rerun the app automation action.",
    stdout: redactPotentialSecrets(result.stdout),
    stderr: redactPotentialSecrets(result.stderr),
  };
}
