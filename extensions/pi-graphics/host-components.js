// Host component discovery for the Pi graphics extension.
//
// Pi's compiled binary exposes `@earendil-works/pi-coding-agent` to extensions
// through jiti virtual modules, but that resolution is not reliable for files
// inside an ESM package root (the agent-utils checkout and its git install both
// fail with "Cannot find module"). Even when a bare import succeeds from a
// package-local node_modules, it yields a *different copy* of the classes than
// the running host, so prototype patches silently miss every real instance.
//
// The authoritative classes are the ones the running host actually
// instantiates. This registry therefore learns constructors from:
//   1. an optional imported module (kept for tests / unbundled hosts), and
//   2. the live TUI component tree, and
//   3. `Container.prototype.addChild`, observed once discovered, so classes
//      that only appear later (assistant/tool messages, dialogs) are learned
//      the moment the host mounts them.

export const HOST_COMPONENT_NAMES = Object.freeze([
  "ArminComponent", "AssistantMessageComponent", "BashExecutionComponent", "BorderedLoader",
  "BranchSummaryMessageComponent", "CompactionSummaryMessageComponent", "CustomEditor",
  "CustomMessageComponent", "DaxnutsComponent", "DynamicBorder", "ExtensionEditorComponent",
  "ExtensionInputComponent", "ExtensionSelectorComponent", "FooterComponent", "LoginDialogComponent",
  "ModelSelectorComponent", "OAuthSelectorComponent", "SessionSelectorComponent",
  "SettingsSelectorComponent", "ShowImagesSelectorComponent", "SkillInvocationMessageComponent",
  "ThemeSelectorComponent", "ThinkingSelectorComponent", "ToolExecutionComponent",
  "TreeSelectorComponent", "UserMessageComponent", "UserMessageSelectorComponent",
  "Container", "Spacer", "Editor",
]);

const KNOWN = new Set(HOST_COMPONENT_NAMES);
const OBSERVER_KEY = Symbol.for("agent-utils.piGraphics.hostComponentObserver");

function constructorName(value) {
  const ctor = value?.constructor;
  return typeof ctor === "function" ? ctor.name : "";
}

export function createHostComponentRegistry({ onDiscover = () => {}, maxDepth = 24 } = {}) {
  const classes = new Map();
  const sources = new Map();
  const listeners = new Set([onDiscover]);
  let observed = null;

  function learn(name, ctor, source) {
    if (!KNOWN.has(name) || typeof ctor !== "function") return false;
    const previous = classes.get(name);
    // A live-tree class always wins over an imported copy: it is the class the
    // host really instantiates.
    if (previous === ctor) return false;
    if (previous && sources.get(name) === "live" && source !== "live") return false;
    classes.set(name, ctor);
    sources.set(name, source);
    for (const listener of listeners) {
      try { listener(name, ctor, source); } catch {}
    }
    return true;
  }

  function learnInstance(instance) {
    const name = constructorName(instance);
    if (!name) return false;
    let learned = learn(name, instance.constructor, "live");
    // Subclasses of Container (e.g. TuiAltScreen) still expose Container on the
    // prototype chain; learn it so addChild can be observed.
    if (!classes.has("Container")) {
      let proto = Object.getPrototypeOf(instance);
      while (proto && proto !== Object.prototype) {
        if (proto.constructor?.name === "Container") { learned = learn("Container", proto.constructor, "live") || learned; break; }
        proto = Object.getPrototypeOf(proto);
      }
    }
    return learned;
  }

  const registry = {
    addModule(module) {
      if (!module || typeof module !== "object") return 0;
      let count = 0;
      for (const name of HOST_COMPONENT_NAMES) if (learn(name, module[name], "import")) count += 1;
      return count;
    },
    discover(root) {
      const seen = new Set();
      let count = 0;
      const walk = (node, depth) => {
        if (!node || typeof node !== "object" || depth > maxDepth || seen.has(node)) return;
        seen.add(node);
        if (learnInstance(node)) count += 1;
        const kids = Array.isArray(node.children) ? node.children : [];
        for (const child of kids) walk(child, depth + 1);
        // Fullscreen layout roots and scroll views keep their child elsewhere.
        for (const key of ["layoutRoot", "content", "child", "component"]) {
          const value = node[key];
          if (value && typeof value === "object" && typeof value.render === "function") walk(value, depth + 1);
        }
      };
      walk(root, 0);
      registry.observeContainers();
      return count;
    },
    observeContainers() {
      const Container = classes.get("Container");
      const proto = Container?.prototype;
      if (!proto || typeof proto.addChild !== "function" || observed === proto) return false;
      if (!proto[OBSERVER_KEY]) {
        const original = proto.addChild;
        const observers = new Set();
        const patched = function observedAddChild(component) {
          for (const observer of observers) {
            try { observer(component); } catch {}
          }
          return original.call(this, component);
        };
        proto[OBSERVER_KEY] = { original, patched, observers };
        proto.addChild = patched;
      }
      proto[OBSERVER_KEY].observers.add(learnInstance);
      observed = proto;
      return true;
    },
    get(name) { return classes.get(name); },
    has(name) { return classes.has(name); },
    source(name) { return sources.get(name); },
    names() { return [...classes.keys()]; },
    onDiscover(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      const slot = observed?.[OBSERVER_KEY];
      if (slot) {
        slot.observers.delete(learnInstance);
        if (slot.observers.size === 0 && observed.addChild === slot.patched) {
          observed.addChild = slot.original;
          delete observed[OBSERVER_KEY];
        }
      }
      observed = null;
      listeners.clear();
    },
  };
  return registry;
}

// Obtain the live TUI synchronously through a throwaway widget factory. Pi
// invokes widget factories immediately with (tui, theme) inside setWidget.
export function captureTuiFromUi(ui, key = "pi-graphics-host-probe") {
  if (typeof ui?.setWidget !== "function") return null;
  let captured = null;
  try {
    ui.setWidget(key, (tui) => {
      captured = tui;
      return { render: () => [], invalidate() {}, __piGraphicsNoWrap: true, piGraphics: false };
    }, { piGraphics: false });
  } catch {}
  try { ui.setWidget(key, undefined, { piGraphics: false }); } catch {}
  return captured;
}
