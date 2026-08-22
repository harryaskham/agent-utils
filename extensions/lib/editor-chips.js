import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const DEFAULT_FIELDS = Object.freeze({
  topRight: ["model", "effort"],
  topCenter: [],
  bottomRight: ["mcp", "cost", "context"],
  bottomLeft: ["directory"],
  bottomCenter: ["branch", "diff"],
});
const KNOWN_FIELDS = new Set(["model", "effort", "mcp", "cost", "context", "directory", "branch", "diff"]);
const FIELD_ALIASES = Object.freeze({ cwd: "directory", thinking: "effort" });
const POWERLINE = Object.freeze({ left: "", right: "", chevron: "", vertical: "▌" });

function bool(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  return !/^(0|false|off|no|disabled)$/i.test(String(value).trim());
}

function fields(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  const out = [];
  for (const item of value) {
    const key = FIELD_ALIASES[String(item || "").trim().toLowerCase()] || String(item || "").trim().toLowerCase();
    if (KNOWN_FIELDS.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

export function resolveEditorChipsConfig(settings = {}, env = process.env) {
  const raw = settings?.agentUtils?.editorChips || settings?.editorChips || {};
  const envEnabled = String(env.PI_EDITOR_CHIPS_ENABLED ?? "").trim();
  const enabled = envEnabled === ""
    ? bool(raw.enabled ?? raw.enable, false)
    : bool(envEnabled, false);
  return {
    enabled,
    topRight: fields(raw.topRight, DEFAULT_FIELDS.topRight),
    topCenter: fields(raw.topCenter, DEFAULT_FIELDS.topCenter),
    bottomRight: fields(raw.bottomRight, DEFAULT_FIELDS.bottomRight),
    bottomLeft: fields(raw.bottomLeft, DEFAULT_FIELDS.bottomLeft),
    bottomCenter: fields(raw.bottomCenter, DEFAULT_FIELDS.bottomCenter),
    editorPaddingX: Math.max(0, Math.min(8, Math.trunc(Number(raw.editorPaddingX ?? settings.editorPaddingX ?? 0) || 0))),
    hideFooter: bool(raw.hideFooter, true),
  };
}

export function editorChipFieldSet(config) {
  return new Set([
    ...(config?.topRight || []),
    ...(config?.topCenter || []),
    ...(config?.bottomRight || []),
    ...(config?.bottomLeft || []),
    ...(config?.bottomCenter || []),
  ]);
}

export function stripAnsi(text) {
  return String(text || "").replace(ANSI_RE, "");
}

export function visibleCells(text) {
  return [...stripAnsi(text)].length;
}

export function prettyDirectory(cwd, home = homedir()) {
  const target = resolve(String(cwd || "."));
  const root = resolve(String(home || ""));
  const rel = root ? relative(root, target) : "";
  if (root && (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !resolve(rel).startsWith(`${sep}..`)))) {
    return rel ? `~/${rel.split(sep).join("/")}` : "~";
  }
  return target.split(sep).join("/");
}

export function directoryCollapseCandidates(directory) {
  const text = String(directory || "");
  const absolute = text.startsWith("/");
  const prefix = text.startsWith("~/") ? "~/" : absolute ? "/" : "";
  const body = prefix === "~/" ? text.slice(2) : absolute ? text.slice(1) : text;
  const parts = body.split("/").filter(Boolean);
  if (parts.length === 0) return [text || prefix || "."];
  const candidates = [text];
  const collapsed = [...parts];
  for (let index = 0; index < collapsed.length; index += 1) {
    if (collapsed[index].length <= 1) continue;
    collapsed[index] = collapsed[index][0];
    const next = `${prefix}${collapsed.join("/")}`;
    if (next !== candidates[candidates.length - 1]) candidates.push(next);
  }
  return candidates;
}

export function collapseDirectoryToWidth(directory, maxWidth) {
  const candidates = directoryCollapseCandidates(directory);
  const limit = Math.max(0, Math.trunc(Number(maxWidth) || 0));
  return candidates.find((candidate) => visibleCells(candidate) <= limit) || candidates[candidates.length - 1];
}

export function summarizeUsage(entries = []) {
  let cost = 0;
  for (const entry of entries || []) {
    const usage = entry?.type === "message" ? entry?.message?.usage : entry?.usage;
    const total = Number(usage?.cost?.total ?? usage?.cost ?? 0);
    if (Number.isFinite(total)) cost += total;
  }
  return { cost };
}

export function parseMcpCount(statuses) {
  const values = statuses instanceof Map ? [...statuses.values()] : Array.isArray(statuses) ? statuses : [];
  for (const value of values) {
    const text = stripAnsi(value);
    const match = /\bMCP\s*\(?\s*(\d+)\s*\)?/i.exec(text) || /\b(\d+)\s*\|?\s*MCP\b/i.exec(text);
    if (match) return Number(match[1]);
  }
  return 0;
}

export function formatChipTokens(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0";
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}k`;
  return `${Math.round(number)}`;
}

function rgb(theme, token, fallback) {
  try {
    const ansi = theme?.getFgAnsi?.(token) || "";
    let match = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(ansi);
    if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
    match = /\x1b\[38;5;(\d+)m/.exec(ansi);
    if (match) return ansi256(Number(match[1]));
  } catch {}
  return fallback;
}

function ansi256(index) {
  if (index >= 232) {
    const v = 8 + (index - 232) * 10;
    return [v, v, v];
  }
  if (index >= 16) {
    const c = index - 16;
    const scale = (v) => (v === 0 ? 0 : 55 + v * 40);
    return [scale(Math.floor(c / 36)), scale(Math.floor((c % 36) / 6)), scale(c % 6)];
  }
  const base = [[0,0,0],[205,0,0],[0,205,0],[205,205,0],[0,0,238],[205,0,205],[0,205,205],[229,229,229],[127,127,127],[255,0,0],[0,255,0],[255,255,0],[92,92,255],[255,0,255],[0,255,255],[255,255,255]];
  return base[index] || [127,127,127];
}

function darken(color, factor = 0.62) {
  return color.map((value) => Math.max(0, Math.min(255, Math.round(value * factor))));
}

function fg(color) { return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m`; }
function bg(color) { return `\x1b[48;2;${color[0]};${color[1]};${color[2]}m`; }
function reset() { return "\x1b[0m"; }
function contrast(color) {
  const luminance = (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255;
  return luminance > 0.58 ? [0, 0, 0] : [248, 248, 248];
}

function part(text, background, foreground = contrast(background)) {
  return { text: String(text ?? ""), background, foreground };
}

function renderParts(parts, { divider = "chevron" } = {}) {
  const safe = parts.filter((entry) => entry && entry.text !== "");
  if (safe.length === 0) return "";
  let out = `${fg(safe[0].background)}${POWERLINE.left}`;
  safe.forEach((entry, index) => {
    if (index > 0) {
      if (divider === "vertical") out += `${fg(safe[index - 1].background)}${bg(entry.background)}${POWERLINE.vertical}`;
      else if (divider === "rounded") out += `${fg(safe[index - 1].background)}${bg(entry.background)}${POWERLINE.right}`;
      else out += `${fg(safe[index - 1].background)}${bg(entry.background)}${POWERLINE.chevron}`;
    }
    const leading = index > 0 && divider === "vertical" ? "" : " ";
    const trailing = index < safe.length - 1 && divider === "vertical" ? "" : " ";
    out += `${fg(entry.foreground)}${bg(entry.background)}${leading}${entry.text}${trailing}`;
  });
  out += `${reset()}${fg(safe[safe.length - 1].background)}${POWERLINE.right}${reset()}`;
  return out;
}

function palette(theme, effort, contextPct) {
  const colors = {
    nord3: rgb(theme, "borderMuted", [76, 86, 106]),
    blue: rgb(theme, "borderAccent", [94, 129, 172]),
    magenta: rgb(theme, "thinkingHigh", [180, 142, 173]),
    green: rgb(theme, "success", [163, 190, 140]),
    yellow: rgb(theme, "warning", [235, 203, 139]),
    red: rgb(theme, "error", [191, 97, 106]),
    grey: rgb(theme, "muted", [129, 161, 193]),
    white: rgb(theme, "text", [236, 239, 244]),
    effort: rgb(theme, "thinkingOff", [76, 86, 106]),
  };
  // Deliberately distinct semantic ramp. Pi themes often map several thinking
  // tokens into the same cool family; chips need glanceable level changes.
  if (effort === "minimal") colors.effort = rgb(theme, "thinkingMinimal", colors.grey);
  colors.dark = darken(colors.nord3, 0.68);
  colors.orange = colors.yellow.map((value, index) => Math.round((value + colors.red[index]) / 2));
  if (effort === "low") colors.effort = colors.blue;
  if (effort === "medium") colors.effort = colors.yellow;
  if (effort === "high") colors.effort = colors.orange;
  if (effort === "xhigh") colors.effort = colors.red;
  if (effort === "max") colors.effort = rgb(theme, "thinkingXhigh", colors.magenta);
  const pct = Number(contextPct || 0);
  colors.context = pct < 40 ? darken(colors.green) : pct < 60 ? darken(colors.orange) : pct <= 80 ? colors.orange : colors.red;
  return colors;
}

function chipFor(field, values, theme) {
  const p = palette(theme, values.effort, values.contextPct);
  switch (field) {
    case "model": return renderParts([part(values.provider || "model", p.nord3), part(values.model || "n/a", p.white, p.dark)]);
    case "effort": return renderParts([part(values.effort || "off", p.effort)]);
    case "directory": return renderParts([part("", p.blue), part(values.directory || ".", p.nord3)], { divider: "rounded" });
    case "branch": return values.inGitRepo ? renderParts([part("", p.blue), ...(values.branchCollapsed ? [] : [part(values.branch, p.nord3)])], { divider: "rounded" }) : "";
    case "diff": return values.inGitRepo ? renderParts([part(`+${values.additions || 0}`, p.green), part(`-${values.deletions || 0}`, p.red)], { divider: "vertical" }) : "";
    case "mcp": return renderParts([part(`${values.mcpCount || 0}`, p.magenta), part("MCP", p.nord3)], { divider: "vertical" });
    case "cost": return renderParts([part(`$${Number(values.cost || 0).toFixed(2)}`, darken(p.green), [248, 248, 248])]);
    case "context": {
      const pct = Number(values.contextPct || 0);
      if (pct > 80) return renderParts([
        part(`${pct.toFixed(1)}%`, p.white, darken(p.red, 0.7)),
        part(formatChipTokens(values.contextMax), p.red, [0, 0, 0]),
      ], { divider: "vertical" });
      return renderParts([
        part(`${pct.toFixed(1)}%`, pct < 40 ? p.green : p.context, pct < 40 ? darken(p.green, 0.42) : undefined),
        part(formatChipTokens(values.contextMax), p.grey, p.dark),
      ], { divider: "vertical" });
    }
    default: return "";
  }
}

function groupFor(fieldNames, values, theme, separator) {
  return fieldNames.map((field) => chipFor(field, values, theme)).filter(Boolean).join(separator);
}

function rail(theme, effort, width) {
  if (width <= 0) return "";
  const color = palette(theme, effort, 0).effort;
  return `${fg(color)}${"─".repeat(width)}${reset()}`;
}

function fitValues(width, config, initialValues, theme, separator) {
  const values = { ...initialValues };
  const candidates = directoryCollapseCandidates(values.directory);
  let candidateIndex = 0;
  const totalWidth = (leftFields, centerFields, rightFields) => {
    const left = groupFor(leftFields, values, theme, separator);
    const center = groupFor(centerFields, values, theme, separator);
    const right = groupFor(rightFields, values, theme, separator);
    return visibleCells(left) + visibleCells(center) + visibleCells(right) + 2;
  };
  const exceeds = () => Math.max(
    totalWidth([], config.topCenter, config.topRight),
    totalWidth(config.bottomLeft, config.bottomCenter, config.bottomRight),
  ) > width;
  while (exceeds() && candidateIndex + 1 < candidates.length) {
    candidateIndex += 1;
    values.directory = candidates[candidateIndex];
  }
  if (exceeds()) values.branchCollapsed = true;
  return values;
}

function composeRailRow({ width, padding, left, center, right, theme, effort }) {
  const edge = Math.min(Math.max(0, padding), Math.floor(width / 2));
  const innerWidth = Math.max(0, width - edge * 2);
  const lw = visibleCells(left), cw = visibleCells(center), rw = visibleCells(right);
  const centerStart = Math.max(lw, Math.floor((innerWidth - cw) / 2));
  const rightStart = Math.max(centerStart + cw, innerWidth - rw);
  const overlapping = rightStart + rw > innerWidth;
  const inner = overlapping
    ? `${left}${center}${right}`
    : `${left}${rail(theme, effort, centerStart - lw)}${center}${rail(theme, effort, rightStart - centerStart - cw)}${right}${rail(theme, effort, innerWidth - rightStart - rw)}`;
  return { line: `${rail(theme, effort, edge)}${inner}${rail(theme, effort, edge)}`, overlapping };
}

export function buildEditorChipRails({ width, config, values, theme }) {
  const safeWidth = Math.max(1, Math.trunc(Number(width) || 1));
  const padding = Math.max(0, Math.trunc(Number(config.editorPaddingX) || 0));
  const innerWidth = Math.max(1, safeWidth - padding * 2);
  const separator = rail(theme, values.effort, 1);
  const fittedValues = fitValues(innerWidth, config, values, theme, separator);
  const top = composeRailRow({
    width: safeWidth,
    padding,
    left: "",
    center: groupFor(config.topCenter, fittedValues, theme, separator),
    right: groupFor(config.topRight, fittedValues, theme, separator),
    theme,
    effort: fittedValues.effort,
  });
  const bottom = composeRailRow({
    width: safeWidth,
    padding,
    left: groupFor(config.bottomLeft, fittedValues, theme, separator),
    center: groupFor(config.bottomCenter, fittedValues, theme, separator),
    right: groupFor(config.bottomRight, fittedValues, theme, separator),
    theme,
    effort: fittedValues.effort,
  });
  return { top: top.line, bottom: bottom.line, values: fittedValues, overlapping: top.overlapping || bottom.overlapping };
}

export function replaceEditorRails(baseLines, renderedLines, rails) {
  if (!Array.isArray(baseLines) || !Array.isArray(renderedLines)) return renderedLines;
  const indices = [];
  for (let index = 0; index < baseLines.length; index += 1) {
    const plain = stripAnsi(baseLines[index]).trim();
    if (plain && /^[\s─━═]+$/.test(plain)) indices.push(index);
  }
  // Custom editors may replace Pi's textual dash rails with graphics/placeholder
  // rows. They still preserve the editor contract that the first and last rows
  // are chrome, so chips deliberately become the final rail layer.
  if (indices.length === 0 && renderedLines.length >= 2) indices.push(0, renderedLines.length - 1);
  if (indices.length === 0) return renderedLines;
  const next = [...renderedLines];
  next[indices[0]] = rails.top;
  if (indices.length > 1) next[indices[indices.length - 1]] = rails.bottom;
  return next;
}
