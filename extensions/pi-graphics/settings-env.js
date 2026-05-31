// Settings -> PI_GRAPHICS_* env mapping for the pi-graphics extension,
// extracted from pi-graphics.js (bd-e1914a). Self-contained: pure functions
// over a settings object plus the FALSE_RE mode-off regex.

export const FALSE_RE = /^(0|false|off|no|disabled)$/i;

export function modeIsOff(mode) {
  return typeof mode === "string" && FALSE_RE.test(mode.trim());
}

export function settingsEnvFromPiGraphics(settings = {}) {
  const gfx = settings.piGraphics || settings.kittyGraphics || {};
  const off = modeIsOff(gfx.mode);
  const eink = gfx.einkMode === true || String(gfx.mode || "").trim().toLowerCase() === "eink";
  const features = gfx.features || {};
  const editor = gfx.editor || {};
  const env = {
    PI_GRAPHICS_MODE: off ? "off" : "on",
    PI_GRAPHICS_AUTO_THEME: off ? "0" : (gfx.autoApplyTheme ?? true) ? "1" : "0",
    PI_GRAPHICS_AUTO_EDITOR_SURFACE: off ? "0" : (features.editor ?? true) ? "1" : "0",
    PI_GRAPHICS_AUTO_EDITOR_CURSOR: off ? "0" : (features.editorCursor ?? features.cursor ?? editor.cursor ?? true) ? "1" : "0",
    PI_GRAPHICS_AUTO_FOOTER: off ? "0" : (features.footer ?? true) ? "1" : "0",
    PI_GRAPHICS_CELL_WIDTH_PX: gfx.cell?.widthPx != null ? String(gfx.cell.widthPx) : undefined,
    PI_GRAPHICS_CELL_HEIGHT_PX: gfx.cell?.heightPx != null ? String(gfx.cell.heightPx) : undefined,
    PI_GRAPHICS_LINE_HEIGHT_SCALE: gfx.cell?.lineHeightScale != null ? String(gfx.cell.lineHeightScale) : undefined,
    PI_GRAPHICS_EDITOR_VARIANT: editor.variant != null ? String(editor.variant) : undefined,
    PI_GRAPHICS_EDITOR_BORDER_STYLE: editor.borderStyle ?? editor.graphicStyle ?? editor.drawingStyle ?? editor.chromeStyle,
    PI_GRAPHICS_EDITOR_ALPHA: editor.alpha != null ? String(editor.alpha) : undefined,
    PI_GRAPHICS_EDITOR_FRAMES: eink ? "1" : editor.frames != null ? String(editor.frames) : undefined,
    PI_GRAPHICS_EDITOR_DELAY_MS: eink ? "1000" : editor.delayMs != null ? String(editor.delayMs) : undefined,
    PI_GRAPHICS_EDITOR_ANIMATION: eink ? "0" : editor.animation ?? editor.animated ?? editor.animate,
    PI_GRAPHICS_EDITOR_UNICODE_MODE: editor.unicodeMode ?? editor.anchorMode ?? editor.unicode?.mode,
    PI_GRAPHICS_EDITOR_STYLE: editor.style != null ? String(editor.style) : undefined,
    PI_GRAPHICS_EDITOR_TOP_BORDER_HEIGHT: editor.topBorderHeight ?? editor.borderTopHeight ?? editor.borderHeight ?? editor.border?.topHeight ?? editor.border?.height,
    PI_GRAPHICS_EDITOR_BOTTOM_BORDER_HEIGHT: editor.bottomBorderHeight ?? editor.borderBottomHeight ?? editor.borderHeight ?? editor.border?.bottomHeight ?? editor.border?.height,
    PI_GRAPHICS_EDITOR_CURSOR_STYLE: editor.cursorStyle ?? editor.cursorMode ?? editor.cursorEffect ?? editor.cursor?.style ?? editor.cursor?.mode,
    PI_GRAPHICS_EDITOR_TRAILING_WORKSPACE: eink ? "0" : editor.trailingWorkspace ?? editor.workspaceFill ?? features.editorTrailingWorkspace,
    PI_GRAPHICS_EDITOR_ROW_BACKGROUND: eink ? "0" : editor.rowBackground ?? features.editorRowBackground,
    PI_GRAPHICS_EDITOR_TYPING_IMPULSE: eink ? "0" : editor.typingImpulse ?? editor.impulse ?? editor.cursorImpulse ?? features.editorTypingImpulse,
    PI_GRAPHICS_AUTO_BOX_CHROME: off ? "0" : gfx.boxChrome === true ? "1" : "0",
    PI_GRAPHICS_AUTO_BOX_RAILS: off ? "0" : eink ? "0" : gfx.boxRails === true ? "1" : "0",
    PI_GRAPHICS_EXPOSE_RENDER_TOOLS: gfx.exposeRenderTools != null ? String(gfx.exposeRenderTools) : undefined,
    PI_GRAPHICS_BOX_EFFECT: gfx.boxEffect != null ? String(gfx.boxEffect) : undefined,
    PI_GRAPHICS_BOX_MODE: gfx.boxMode != null ? String(gfx.boxMode) : "unicode",
    PI_GRAPHICS_BOX_UNICODE_MODE: gfx.boxUnicodeMode ?? gfx.box?.unicodeMode ?? gfx.boxRailUnicodeMode ?? gfx.boxRailsUnicodeMode ?? gfx.box?.railUnicodeMode,
    PI_GRAPHICS_BOX_RAIL_STYLE: gfx.boxRailStyle ?? gfx.boxRailsStyle ?? gfx.box?.railStyle,
    PI_GRAPHICS_BOX_RAIL_MODE: gfx.boxRailMode ?? gfx.boxRailsMode ?? gfx.boxMode,
    PI_GRAPHICS_BOX_RAIL_UNICODE_MODE: gfx.boxRailUnicodeMode ?? gfx.boxRailsUnicodeMode ?? gfx.box?.railUnicodeMode ?? editor.unicodeMode,
    PI_GRAPHICS_BOX_RAIL_ANIMATION: gfx.boxRailAnimation ?? gfx.boxRailsAnimation ?? gfx.box?.railAnimation,
    PI_GRAPHICS_BOX_RAIL_TOP_HEIGHT: gfx.boxRailTopHeight ?? gfx.boxRailsTopHeight ?? gfx.boxRailHeight ?? gfx.boxRailsHeight ?? gfx.box?.railTopHeight ?? gfx.box?.railHeight,
    PI_GRAPHICS_BOX_RAIL_BOTTOM_HEIGHT: gfx.boxRailBottomHeight ?? gfx.boxRailsBottomHeight ?? gfx.boxRailHeight ?? gfx.boxRailsHeight ?? gfx.box?.railBottomHeight ?? gfx.box?.railHeight,
    PI_GRAPHICS_DEBUG: gfx.debug != null ? String(gfx.debug) : undefined,
    PI_GRAPHICS_DEBUG_PLACEHOLDERS: gfx.debugPlaceholders != null ? String(gfx.debugPlaceholders) : undefined,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}
