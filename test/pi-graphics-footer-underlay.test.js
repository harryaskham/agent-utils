import test from "node:test";
import assert from "node:assert/strict";

import { settingsEnvFromPiGraphics } from "../extensions/pi-graphics/settings-env.js";

test("footer underlay defaults to on with no explicit settings", () => {
  const env = settingsEnvFromPiGraphics({ piGraphics: {} });
  assert.equal(env.PI_GRAPHICS_FOOTER_UNDERLAY, "1");
  // Token/alpha overrides are omitted when unset so the code defaults apply.
  assert.equal(env.PI_GRAPHICS_FOOTER_UNDERLAY_GLOW_TOKEN, undefined);
  assert.equal(env.PI_GRAPHICS_FOOTER_UNDERLAY_LINE_TOKEN, undefined);
  assert.equal(env.PI_GRAPHICS_FOOTER_UNDERLAY_GLOW_ALPHA, undefined);
  assert.equal(env.PI_GRAPHICS_FOOTER_UNDERLAY_LINE_ALPHA, undefined);
});

test("footer underlay can be disabled via gfx.footer.underlay", () => {
  const env = settingsEnvFromPiGraphics({ piGraphics: { footer: { underlay: false } } });
  assert.equal(env.PI_GRAPHICS_FOOTER_UNDERLAY, "0");
});

test("footer underlay is forced off when graphics mode is off", () => {
  const env = settingsEnvFromPiGraphics({ piGraphics: { mode: "off", footer: { underlay: true } } });
  assert.equal(env.PI_GRAPHICS_FOOTER_UNDERLAY, "0");
});

test("footer underlay token and alpha overrides are threaded into env", () => {
  const env = settingsEnvFromPiGraphics({
    piGraphics: {
      footer: { glowToken: "accent", lineToken: "thinkingXhigh", glowAlpha: 0.2, lineAlpha: 0.55 },
    },
  });
  assert.equal(env.PI_GRAPHICS_FOOTER_UNDERLAY_GLOW_TOKEN, "accent");
  assert.equal(env.PI_GRAPHICS_FOOTER_UNDERLAY_LINE_TOKEN, "thinkingXhigh");
  assert.equal(env.PI_GRAPHICS_FOOTER_UNDERLAY_GLOW_ALPHA, "0.2");
  assert.equal(env.PI_GRAPHICS_FOOTER_UNDERLAY_LINE_ALPHA, "0.55");
});

test("footer underlay honors the features.footerUnderlay fallback flag", () => {
  const on = settingsEnvFromPiGraphics({ piGraphics: { features: { footerUnderlay: true } } });
  assert.equal(on.PI_GRAPHICS_FOOTER_UNDERLAY, "1");
  const off = settingsEnvFromPiGraphics({ piGraphics: { features: { footerUnderlay: false } } });
  assert.equal(off.PI_GRAPHICS_FOOTER_UNDERLAY, "0");
  // Explicit footer.underlay wins over the features fallback.
  const explicit = settingsEnvFromPiGraphics({ piGraphics: { footer: { underlay: true }, features: { footerUnderlay: false } } });
  assert.equal(explicit.PI_GRAPHICS_FOOTER_UNDERLAY, "1");
});
