// Footer text formatting helpers extracted from pi-graphics.js.
//
// These are pure, self-contained formatters for the status footer: token and
// percentage formatting, path compaction, provider/model abbreviation, and the
// no-op truncate sentinel. They take all inputs as arguments; stateful footer
// helpers that own the extension's footerState (e.g. refreshFooter*) remain in
// pi-graphics.js, which passes footerState fields into these pure helpers.

import { approximateVisibleCells } from "./ansi-width.js";

export function formatFooterTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1_000_000) {
    const scaled = value / 1_000_000;
    return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, "")}m`;
  }
  if (value >= 1_000) {
    const scaled = value / 1_000;
    return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${Math.round(value)}`;
}

export function formatFooterPct(pct) {
  const value = Number.isFinite(Number(pct)) ? Number(pct) : 0;
  return `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

export function compactPathSegment(segment) {
  const chars = Array.from(String(segment || "").replace(/^\.+/, ""));
  return chars[0] || Array.from(String(segment || ""))[0] || "";
}

export function compactFooterPath(path, threshold = 0) {
  const text = String(path || "");
  if (approximateVisibleCells(text) <= threshold) return text;
  const prefix = text.startsWith("~/") ? "~/" : text.startsWith("/") ? "/" : "";
  const body = prefix ? text.slice(prefix.length) : text;
  const parts = body.split("/").filter(Boolean);
  if (parts.length <= 1) return text;
  return `${prefix}${[...parts.slice(0, -1).map(compactPathSegment), parts.at(-1)].join("/")}`;
}

export function prettyFooterCwd(cwd) {
  const home = process.env.HOME;
  const value = String(cwd || process.cwd());
  const display = home && value === home
    ? "~"
    : home && value.startsWith(`${home}/`)
      ? `~/${value.slice(home.length + 1)}`
      : value;
  return compactFooterPath(display);
}

export function compactFooterProvider(provider) {
  const raw = String(provider || "").trim();
  const key = raw.toLowerCase().replace(/[_./]+/g, "-");
  if (!key) return "";
  if (key === "github-copilot") return "ghcp";
  if (key === "openai") return "oai";
  if (key === "anthropic") return "ant";
  if (key === "litellm-openai") return "loai";
  if (key === "litellm-anthropic") return "lant";
  if (key === "openrouter") return "oprt";
  if (key.startsWith("azure-")) return "az";
  return raw;
}

// Compact a model name for the footer. Pure over (model, provider): the
// provider only gates whether the leading `gpt-` prefix is kept (GitHub Copilot
// gpt-5* names stay prefixed to disambiguate from other gpt families). The
// caller passes footerState.provider explicitly.
export function compactFooterModelName(model, provider) {
  let value = String(model || "").trim();
  const providerKey = String(provider || "").toLowerCase().replace(/[_./]+/g, "-");
  value = value.replace(/-1m-internal$/i, "");
  if (providerKey !== "github-copilot" || !/^gpt-5(?:\.|-|$)/i.test(value)) {
    value = value.replace(/^gpt-/i, "");
  }
  value = value.replace(/^claude-/i, "");
  value = value.replace(/^opus-4-7$/i, "opus-4.7");
  return value;
}

export function noEllipsisFooterText(text, _width) {
  return String(text ?? "");
}
