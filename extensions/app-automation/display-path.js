import path from "node:path";

export function displayPath(value, { root, rootLabel = "[state-root]" } = {}) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (root) {
    const resolvedRoot = path.resolve(String(root));
    const resolved = path.resolve(text);
    if (resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
      const relative = path.relative(resolvedRoot, resolved).split(path.sep).filter(Boolean).join("/");
      return relative ? `${rootLabel}/${relative}` : rootLabel;
    }
  }
  const home = process.env.HOME ? path.resolve(process.env.HOME) : null;
  if (home) {
    const resolved = path.resolve(text);
    if (resolved === home || resolved.startsWith(`${home}${path.sep}`)) {
      const relative = path.relative(home, resolved).split(path.sep).filter(Boolean).join("/");
      return relative ? `~/${relative}` : "~";
    }
  }
  if (path.isAbsolute(text)) return "[local-path]";
  return text;
}
