// Pure RGB/hex color-mix helpers for the pi-graphics extension, extracted from
// pi-graphics.js (bd-e1914a). Self-contained: no module/closure state — pure
// math over numeric channels and hex strings. mixHexColor composes
// mixRgbChannel internally.

export function mixRgbChannel(a, b, t) {
  return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}

export function mixHexColor(fromHex, toHex, t) {
  const parse = (hex, fallback) => {
    const text = String(hex || "").replace(/^#/, "");
    if (!/^[0-9a-f]{6}$/i.test(text)) return fallback;
    return [parseInt(text.slice(0, 2), 16), parseInt(text.slice(2, 4), 16), parseInt(text.slice(4, 6), 16)];
  };
  const from = parse(fromHex, [136, 192, 208]);
  const to = parse(toHex, [255, 255, 255]);
  return `#${from.map((c, i) => mixRgbChannel(c, to[i], t).toString(16).padStart(2, "0")).join("")}`;
}
