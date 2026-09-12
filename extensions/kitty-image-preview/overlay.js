import { containImageBox } from "./layout.js";
import { renderCurrentImageLines } from "./widget.js";
import { truncatePlainText } from "./text-utils.js";

// Legacy, application-cursor, and Kitty CSI-u keys. Release events and pasted
// text must never navigate or dismiss the gallery.
export function imageOverlayKey(data) {
  const key = String(data ?? "");
  if (key.includes("\x1b[200~") || /;\d+:3(?:;[\d:]+)?u$/.test(key)) return null;
  if (key === "\x1b" || /^\x1b\[27(?:;1(?::[12])?)?u$/.test(key)) return "close";
  if (/^\x1b(?:\[D|OD|\[1;1(?::[12])?D|\[57350(?:;1(?::[12])?)?u)$/.test(key)) return "previous";
  if (/^\x1b(?:\[C|OC|\[1;1(?::[12])?C|\[57351(?:;1(?::[12])?)?u)$/.test(key)) return "next";
  return null;
}

// A single-image lightbox: image owns the viewport, with one compact themed
// filename/count rail and keyboard hints. Gallery selection stays in the owner.
export class KittyImageGalleryOverlay {
  constructor(state, { tui, theme, navigate, close }) {
    Object.assign(this, { state, tui, theme, navigate, close });
    this.closed = false;
    this.pending = Promise.resolve();
    this.busy = false;
    this.error = "";
  }

  handleInput(data) {
    if (this.closed) return;
    const action = imageOverlayKey(data);
    if (action === "close") {
      this.closed = true;
      this.close();
    } else if (action && !this.busy) {
      this.busy = true;
      this.error = "";
      this.pending = Promise.resolve().then(() => this.navigate(action === "next" ? 1 : -1))
        .catch(error => { this.error = error.message || String(error); })
        .finally(() => { this.busy = false; if (!this.closed) this.tui.requestRender(); });
    }
  }

  render(width) {
    const cols = Math.max(1, Math.trunc(width));
    const height = Math.max(1, Math.floor((this.tui.terminal?.rows || 24) * 0.9));
    const state = this.state;
    const current = state.items[state.index];
    const line = text => truncatePlainText(text, cols).padEnd(cols);
    const color = (role, text) => this.theme?.fg?.(role, text) ?? text;
    const header = color("accent", line(current ? `${state.index + 1}/${state.items.length}  ${current.label}` : "No images"));
    if (height < 3 || !current) return [header];
    const box = containImageBox(current, cols, height - 2);
    const images = renderCurrentImageLines(state, current, {
      columns: box.imageWidth,
      rows: box.imageRows,
      lineWidth: cols,
      showCaption: false,
      // Virtual placements follow the overlay's cells through compositing,
      // scrolling and resize, including SSH/tmux. No screen coordinates leak.
      useUnicodePlaceholders: true,
    });
    return [header, ...images, color(this.error ? "warning" : "dim", line(this.error || "← →  Browse    Esc  Close"))];
  }

  invalidate() {}
  dispose() { this.closed = true; }
}
