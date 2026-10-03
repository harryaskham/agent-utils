// Key normalisation for Pi Graphics modal windows (no pi-tui import: the
// compiled Pi binary does not expose its key helpers to extensions).

// Key names for the settings window from legacy, xterm-modifier and Kitty
// keyboard-protocol (CSI u / CSI 1;m:e X) sequences; key releases ignored.
export function modalKeyName(data) {
  const s = String(data || "");
  const arrows = { A: "up", B: "down", C: "right", D: "left" };
  if (s === "\t") return "tab";
  if (s === "\x1b[Z") return "shift-tab";
  if (s === "\r" || s === "\n") return "enter";
  if (s === "\x1b") return "escape";
  let m = /^\x1b\[(?:1;(\d+)(?::(\d))?)?([ABCD])$/.exec(s);
  if (m) return m[2] === "3" ? "release" : arrows[m[3]];
  m = /^\x1bO([ABCD])$/.exec(s);
  if (m) return arrows[m[1]];
  m = /^\x1b\[([56])(?:;\d+(?::(\d))?)?~$/.exec(s);
  if (m) return m[2] === "3" ? "release" : m[1] === "5" ? "pageup" : "pagedown";
  m = /^\x1b\[(\d+)(?::\d*)*(?:;(\d+)(?::(\d))?)?u$/.exec(s);
  if (m) {
    if (m[3] === "3") return "release";
    const cp = Number(m[1]); const mods = Math.max(0, Number(m[2] || 1) - 1);
    if (cp === 9) return mods & 1 ? "shift-tab" : "tab";
    if (cp === 13) return "enter";
    if (cp === 27) return "escape";
    if (cp >= 32 && cp < 127 && !(mods & ~1)) return String.fromCharCode(cp);
    return "";
  }
  return s.length === 1 ? s : "";
}
