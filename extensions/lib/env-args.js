// Small env/shell-like argument parser for Pi slash-command UX.
// Parses whitespace-separated positionals and KEY=VALUE assignments with
// single/double quotes and backslash escaping. It is intentionally strict so
// command handlers can report malformed input instead of silently guessing.

export function parseEnvStyleArgs(input) {
  const text = String(input || "");
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaped) current += "\\";
  if (quote) throw new Error(`Unclosed ${quote === '"' ? "double" : "single"} quote in arguments`);
  if (current) tokens.push(current);

  const positionals = [];
  const values = {};
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(0, eq).trim();
    const value = token.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
      throw new Error(`Invalid argument key: ${key}`);
    }
    values[key.toLowerCase()] = value;
  }

  return { tokens, positionals, values };
}
