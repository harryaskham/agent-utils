// Canonical strict mock `pi` for extension tests (bd-ca0c46).
//
// Every extension test used to hand-roll its own mock `pi`, so a test could
// pass against the WRONG API shape — the bd-53da92 crash slipped through
// because a test mirrored `registerCommand: (def) => ...` instead of the real
// two-arg `registerCommand(name, def)`. bd-90c02e added a static source guard
// for that one class; this is the complementary RUNTIME contract: a shared
// mock whose registerCommand/registerTool/on assert the real argument shapes,
// so a test can no longer pass by mirroring a wrong assumption.
//
// It stays permissive: unknown `pi.*` methods are Proxy no-ops returning
// undefined, so heavy extensions can still be exercised. Use the returned
// introspection handles (commands/tools/handlers/emit) to drive assertions.

function describe(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/// Build a strict mock `pi`. `overrides` replaces or augments any method on the
/// returned pi (e.g. a real sendUserMessage spy). Returns { pi, commands,
/// tools, handlers, emit } so tests can register-then-introspect.
export function createStrictMockPi(overrides = {}) {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map(); // event -> fn[]

  const base = {
    registerCommand(name, def) {
      if (typeof name !== "string" || name.length === 0) {
        throw new TypeError(
          `pi.registerCommand(name, def): name must be a non-empty string, got ${describe(name)} ` +
            `— the API is registerCommand(name, def); an object name crashes all slash commands (bd-53da92)`,
        );
      }
      if (def == null || (typeof def !== "object" && typeof def !== "function")) {
        throw new TypeError(`pi.registerCommand("${name}", def): def must be an object or function, got ${describe(def)}`);
      }
      commands.set(name, def);
    },
    registerTool(def) {
      if (def == null || typeof def !== "object") {
        throw new TypeError(`pi.registerTool(def): def must be an object, got ${describe(def)}`);
      }
      if (typeof def.name !== "string" || def.name.length === 0) {
        throw new TypeError(`pi.registerTool(def): def.name must be a non-empty string, got ${describe(def.name)}`);
      }
      tools.set(def.name, def);
    },
    on(event, fn) {
      if (typeof event !== "string" || event.length === 0) {
        throw new TypeError(`pi.on(event, fn): event must be a non-empty string, got ${describe(event)}`);
      }
      if (typeof fn !== "function") {
        throw new TypeError(`pi.on("${event}", fn): handler must be a function, got ${describe(fn)}`);
      }
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return () => {
        const arr = handlers.get(event) || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    getCommand: (name) => commands.get(name),
    getAllTools: () => [...tools.values()],
    getActiveTools: () => [...tools.values()],
  };

  // Synchronously dispatch any registered handlers for `event` (test helper).
  const emit = (event, ...args) => {
    for (const fn of handlers.get(event) || []) fn(...args);
  };

  const target = { ...base, ...overrides };
  const pi = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      // Permissive no-op for any other pi.* method so heavy extensions run.
      if (typeof prop === "string") return () => undefined;
      return undefined;
    },
  });

  return { pi, commands, tools, handlers, emit };
}

export default createStrictMockPi;
