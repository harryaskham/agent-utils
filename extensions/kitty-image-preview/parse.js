// Pure parsing / param-shaping helpers for the kitty image preview, extracted
// from kitty-image-preview.js (bd-e1914a). No imports, state, or ctx.

// Parse a "provider/model" vision-model spec; throws on malformed input.
export function parseModelSpec(spec) {
  if (!spec) return undefined;
  const slash = String(spec).indexOf("/");
  if (slash <= 0 || slash === String(spec).length - 1) throw new Error(`Vision model must be provider/model, got: ${spec}`);
  return { provider: String(spec).slice(0, slash), modelId: String(spec).slice(slash + 1) };
}

// Strip explicit max-width/height so a describe call uses full resolution.
export function fullResolutionDescribeParams(params = {}) {
  const full = { ...params };
  delete full.maxWidth;
  delete full.maxHeight;
  return full;
}

// Tolerant JSON-envelope parser for CLI stdout: parses the whole string, then
// falls back to the outermost {...} slice before failing.
export function parseJsonEnvelope(stdout, commandName) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) throw new Error(`${commandName} returned no JSON output`);
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`${commandName} returned invalid JSON: ${error.message}`);
  }
}

// Lowercased searchable text for a tendril capture target.
export function targetText(target) {
  return [target.title, target.name, target.app_name, target.id].filter(Boolean).join(" ").toLowerCase();
}
