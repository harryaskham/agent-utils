const PATCH_KEY = Symbol.for("agent-utils.piGraphics.compactChatSpacingPatch");
const PENDING_SPACER_KEY = Symbol.for("agent-utils.piGraphics.pendingChatSpacer");

function isSpacerComponent(component) {
  return component?.constructor?.name === "Spacer";
}

function isChatBubbleComponent(component, chatBubbleConstructors) {
  if (!component) return false;
  for (const Ctor of chatBubbleConstructors || []) {
    if (typeof Ctor === "function" && component instanceof Ctor) return true;
  }
  return false;
}

/**
 * Patch a Pi TUI Container-compatible prototype so a Spacer inserted between two
 * chat bubble components is elided. Spacers before non-bubble content are flushed
 * unchanged, so status lines, errors, and non-chat overlays keep their intended
 * separation.
 */
export function installCompactChatSpacingPatch({ basePrototype, chatBubbleConstructors = [] } = {}) {
  if (!basePrototype || typeof basePrototype.addChild !== "function") return { installed: false, restore() {} };
  const existing = basePrototype[PATCH_KEY];
  if (existing) return { installed: false, alreadyInstalled: true, restore: existing.restore };

  const originalAddChild = basePrototype.addChild;
  const originalRender = basePrototype.render;
  const originalClear = basePrototype.clear;

  function flushPendingSpacer(container) {
    const pendingSpacer = container[PENDING_SPACER_KEY];
    if (!pendingSpacer) return;
    container[PENDING_SPACER_KEY] = null;
    originalAddChild.call(container, pendingSpacer);
  }

  const patchState = {
    restore() {
      if (basePrototype[PATCH_KEY] !== patchState) return;
      basePrototype.addChild = originalAddChild;
      if (typeof originalRender === "function") basePrototype.render = originalRender;
      if (typeof originalClear === "function") basePrototype.clear = originalClear;
      delete basePrototype[PATCH_KEY];
    },
  };

  basePrototype.addChild = function compactChatAddChild(component) {
    const pendingSpacer = this[PENDING_SPACER_KEY];
    if (pendingSpacer) {
      this[PENDING_SPACER_KEY] = null;
      if (!isChatBubbleComponent(component, chatBubbleConstructors)) {
        originalAddChild.call(this, pendingSpacer);
      }
    }

    const previous = Array.isArray(this.children) ? this.children.at(-1) : null;
    if (isSpacerComponent(component) && isChatBubbleComponent(previous, chatBubbleConstructors)) {
      this[PENDING_SPACER_KEY] = component;
      return;
    }

    return originalAddChild.call(this, component);
  };

  if (typeof originalRender === "function") {
    basePrototype.render = function compactChatRender(...args) {
      flushPendingSpacer(this);
      return originalRender.apply(this, args);
    };
  }

  if (typeof originalClear === "function") {
    basePrototype.clear = function compactChatClear(...args) {
      this[PENDING_SPACER_KEY] = null;
      return originalClear.apply(this, args);
    };
  }

  basePrototype[PATCH_KEY] = patchState;
  return { installed: true, restore: patchState.restore };
}
