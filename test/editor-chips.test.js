import test from "node:test";
import assert from "node:assert/strict";

import { createEditorChipsExtension } from "../extensions/lib/editor-chips-extension.js";
import {
  buildEditorChipRails,
  collapseDirectoryToWidth,
  directoryCollapseCandidates,
  parseMcpCount,
  replaceEditorRails,
  resolveEditorChipsConfig,
  renderSpeechIndicatorLine,
  stripAnsi,
  visibleCells,
} from "../extensions/lib/editor-chips.js";
import { SPEECH_INDICATOR_EVENT, SPEECH_INDICATOR_REQUEST } from "../extensions/lib/speech-indicator.js";

const COLORS = {
  borderMuted: [76, 86, 106],
  borderAccent: [94, 129, 172],
  thinkingHigh: [180, 142, 173],
  thinkingLow: [136, 192, 208],
  thinkingOff: [76, 86, 106],
  thinkingMinimal: [129, 161, 193],
  thinkingMedium: [143, 188, 187],
  thinkingXhigh: [180, 142, 173],
  thinkingMax: [180, 142, 173],
  success: [163, 190, 140],
  warning: [208, 135, 112],
  error: [191, 97, 106],
  muted: [129, 161, 193],
  text: [236, 239, 244],
};
const theme = {
  getFgAnsi(token) {
    const [r, g, b] = COLORS[token] || COLORS.text;
    return `\x1b[38;2;${r};${g};${b}m`;
  },
};

function values(overrides = {}) {
  return {
    provider: "github-copilot",
    model: "gpt-5.6-sol",
    effort: "low",
    mcpCount: 14,
    cost: 498.893,
    subscription: true,
    contextPct: 12,
    contextMax: 1_100_000,
    directory: "~/.cacophony/agents/agent-utils/ms-mac-agent-utils-agnt-dev-msm-0/checkout",
    branch: "agent/ms-mac/agent-utils/ms-mac-agent-utils-agnt-dev-msm-0",
    inGitRepo: true,
    additions: 27,
    deletions: 13,
    ...overrides,
  };
}

const config = resolveEditorChipsConfig({ agentUtils: { editorChips: { enabled: true } } }, {});

test("editor chip settings resolve the requested immutable startup layout", () => {
  assert.equal(config.enabled, true);
  // The editor's own border labels (working status, scroll markers) join, where not placed.
  assert.deepEqual(config.topRight, ["model", "effort", "scrollUp"]);
  assert.deepEqual(config.topCenter, []);
  assert.deepEqual(config.bottomRight, ["mcp", "cost", "context", "scrollDown"]);
  assert.deepEqual(config.bottomLeft, ["directory"]);
  assert.deepEqual(config.bottomCenter, ["branch", "diff"]);
  assert.equal(config.hideFooter, true);
  assert.equal(resolveEditorChipsConfig({}, {}).enabled, false);
  assert.equal(resolveEditorChipsConfig({ agentUtils: { editorChips: { enabled: true } } }, { PI_EDITOR_CHIPS_ENABLED: "" }).enabled, true, "empty launcher env does not disable settings policy");
  assert.equal(resolveEditorChipsConfig({ agentUtils: { editorChips: { enabled: true } } }, { PI_EDITOR_CHIPS_ENABLED: "0" }).enabled, false);
});

test("directory collapse progressively shortens earlier path components to one cell", () => {
  const full = "~/.cacophony/agents/agent-utils/ms-mac-agent-utils-agnt-dev-msm-0/checkout";
  const candidates = directoryCollapseCandidates(full);
  assert.equal(candidates[0], full);
  assert.ok(candidates.includes("~/./a/a/ms-mac-agent-utils-agnt-dev-msm-0/checkout"));
  assert.equal(candidates.at(-1), "~/./a/a/m/c");
  assert.equal(collapseDirectoryToWidth(full, 48), candidates.find((item) => visibleCells(item) <= 48));
});

test("full-width rails render top-right and three-way bottom placement with semantic chips", () => {
  const rails = buildEditorChipRails({ width: 260, config, values: values(), theme });
  const top = stripAnsi(rails.top);
  const bottom = stripAnsi(rails.bottom);
  assert.equal(visibleCells(rails.top), 260);
  assert.equal(visibleCells(rails.bottom), 260);
  assert.match(top, /github-copilot/);
  assert.match(top, /gpt-5\.6-sol/);
  assert.match(top, /low/);
  assert.match(bottom, /checkout/);
  assert.match(bottom, /ms-mac-agent-utils-agnt-dev-msm-0/);
  assert.match(bottom, /\+27/);
  assert.match(bottom, /-13/);
  assert.match(bottom, /14/);
  assert.match(bottom, /MCP/);
  assert.match(bottom, /\$498\.89/);
  assert.doesNotMatch(bottom, /\(sub\)/);
  assert.match(bottom, /12\.0%/);
  assert.match(bottom, /\+27▌-13/);
  assert.match(bottom, /12\.0%▌1\.1M/);
  assert.match(rails.bottom, /\x1b\[38;2;163;190;140m\x1b\[48;2;191;97;106m▌/, "half-block uses left background as fg and right background as bg with no spaces");
  assert.match(rails.bottom, /\x1b\[38;2;248;248;248m\x1b\[48;2;/, "money text is white");
  assert.match(bottom, /  macos|  agent/);
  assert.match(rails.top, /\x1b\[38;2;94;129;172m─/);
  assert.match(rails.top, /\x1b\[38;2;52;58;72m\x1b\[48;2;236;239;244m gpt-5\.6-sol/, "model uses dark Nord text on light Nord background");
  assert.match(rails.bottom, /\x1b\[38;2;52;58;72m\x1b\[48;2;129;161;193m1\.1M/, "context total uses the same dark Nord text");
});

test("display aliases rewrite chip text only: any field, one field, hiding, and the real values kept", () => {
  const aliased = resolveEditorChipsConfig({ agentUtils: { editorChips: { enabled: true, aliases: {
    "github-copilot": "ghcp",
    thinking: { low: "lo" },
    model: { "gpt-5.6-sol": "sol", "github-copilot": "not-the-provider" },
    cwd: { "~/x": "home-x" },
    constructor: 7,
    branch: ["ignored"],
  } } } }, {});
  const input = values({ directory: "~/x", branch: "github-copilot" });
  const rails = buildEditorChipRails({ width: 200, config: aliased, values: input, theme });
  const top = stripAnsi(rails.top);
  const bottom = stripAnsi(rails.bottom);
  assert.match(top, / ghcp .* sol /, "the provider and the model are rewritten");
  assert.doesNotMatch(top, /github-copilot|gpt-5\.6-sol/);
  assert.match(top, / lo /);
  assert.match(rails.top, new RegExp(`\\x1b\\[48;2;${COLORS.borderAccent.join(";")}m lo `), "an aliased effort keeps its colour");
  assert.match(bottom, /home-x/);
  assert.match(bottom, / ghcp /, "a string alias applies in any field (here the branch)");
  assert.equal(input.provider, "github-copilot", "view only: the values are not changed");
  assert.equal(input.effort, "low");

  // "" hides the provider half and the effort chip; no aliases: the same output as before.
  const hiding = resolveEditorChipsConfig({ agentUtils: { editorChips: { enabled: true, aliases: { provider: { "github-copilot": "" }, effort: { low: "" } } } } }, {});
  const hidden = stripAnsi(buildEditorChipRails({ width: 200, config: hiding, values: values(), theme }).top);
  assert.doesNotMatch(hidden, /github-copilot| low /);
  assert.match(hidden, /gpt-5\.6-sol/);
  assert.equal(buildEditorChipRails({ width: 200, config, values: values(), theme }).top,
    buildEditorChipRails({ width: 200, config: resolveEditorChipsConfig({ agentUtils: { editorChips: { enabled: true, aliases: {} } } }, {}), values: values(), theme }).top);
});

test("topCenter placement and editorPadding preserve rail cells at both edges", () => {
  const placed = {
    ...config,
    topCenter: ["directory"],
    bottomLeft: [],
    editorPaddingX: 1,
  };
  const rails = buildEditorChipRails({ width: 220, config: placed, values: values(), theme });
  assert.match(stripAnsi(rails.top), /^─.*.*checkout.*low.*─$/);
  assert.equal(visibleCells(rails.top), 220);
  assert.equal(visibleCells(rails.bottom), 220);
});

test("effort colors form distinct blue, yellow, orange, red, pink levels", () => {
  const colors = [];
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    const rail = buildEditorChipRails({ width: 100, config: { ...config, topRight: ["effort"] }, values: values({ effort }), theme }).top;
    colors.push(/\x1b\[48;2;([^m]+)m low|\x1b\[48;2;([^m]+)m medium|\x1b\[48;2;([^m]+)m high|\x1b\[48;2;([^m]+)m xhigh|\x1b\[48;2;([^m]+)m max/.exec(rail)?.slice(1).find(Boolean));
  }
  assert.equal(new Set(colors).size, 5);
});

test("narrow rails collapse directory before reducing branch to its git icon", () => {
  const rails = buildEditorChipRails({ width: 100, config, values: values(), theme });
  assert.notEqual(rails.values.directory, values().directory);
  assert.equal(rails.values.branchCollapsed, true);
  assert.match(stripAnsi(rails.bottom), //);
  assert.doesNotMatch(stripAnsi(rails.bottom), /agent\/ms-mac\/agent-utils/);
});

test("compacted groups reflow to full terminal width without overlap", () => {
  const rails = buildEditorChipRails({ width: 80, config: { ...config, topCenter: ["directory"], bottomLeft: [], editorPaddingX: 1 }, values: values({ cost: 1333.23 }), theme });
  assert.equal(rails.overlapping, false);
  assert.equal(visibleCells(rails.top), 80);
  assert.equal(visibleCells(rails.bottom), 80);
  assert.match(stripAnsi(rails.top), /checkout|~\/\.\/a\/a\/m\/c/);
  assert.match(stripAnsi(rails.top), /─+.*github-copilot/);
});

test("unavoidable narrow layouts report overlap and wrapper replacement remains width-clampable", () => {
  const rails = buildEditorChipRails({ width: 32, config, values: values({ contextPct: 88 }), theme });
  assert.equal(rails.overlapping, true);
  assert.match(rails.bottom, /\x1b\[48;2;236;239;244m/);
  assert.match(rails.bottom, /\x1b\[48;2;191;97;106m/);
  const replaced = replaceEditorRails(["────", "text", "────"], ["TOP", "text", "BOT"], rails);
  assert.equal(replaced[0], rails.top);
  assert.equal(replaced[2], rails.bottom);
});

test("MCP count is recovered from extension footer statuses", () => {
  assert.equal(parseMcpCount(new Map([["mcp", "MCP (14)"]])), 14);
  assert.equal(parseMcpCount(["14 MCP"]), 14);
  assert.equal(parseMcpCount(new Map()), 0);
});

test("editor extension wraps an existing gfx editor and draws chips after its rails", async () => {
  const handlers = new Map();
  const tui = { renders: 0, requestRender() { this.renders += 1; } };
  const footerData = {
    getGitBranch: () => "main",
    getExtensionStatuses: () => new Map([["mcp", "MCP (14)"]]),
    onBranchChange: () => () => {},
  };
  let editorFactory;
  let footer;
  let delegated = "";
  const baseComponent = {
    focused: false,
    wantsKeyRelease: true,
    render: () => ["gfx-top-placeholder", "editor", "gfx-bottom-placeholder"],
    handleInput: (data) => { delegated = data; },
    getText: () => "preserved editor text",
    invalidate() {},
  };
  const previous = () => baseComponent;
  const ctx = {
    mode: "tui",
    cwd: "/tmp/project",
    model: { provider: "github-copilot", id: "gpt-5.6-sol", contextWindow: 1_100_000 },
    thinkingLevel: "low",
    getContextUsage: () => ({ percent: 12, contextWindow: 1_100_000 }),
    sessionManager: { getEntries: () => [{ type: "message", message: { usage: { cost: { total: 1.25 } } } }] },
    ui: {
      getEditorComponent: () => previous,
      setEditorComponent: (factory) => { editorFactory = factory; },
      setFooter: (factory) => { footer = factory(tui, theme, footerData); },
    },
  };
  class FakeCustomEditor {}
  const commands = new Map();
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
    getThinkingLevel: () => "low",
    exec: async (_command, args) => args[0] === "branch"
      ? { code: 0, stdout: "main\n" }
      : { code: 0, stdout: "3\t2\tfile.js\n" },
  };
  await createEditorChipsExtension({
    settings: { agentUtils: { editorChips: { enabled: true } } },
    env: { HOME: "/tmp" },
    host: { CustomEditor: FakeCustomEditor },
  })(pi);
  await handlers.get("session_start")[0]({}, ctx);
  const editor = editorFactory(tui, theme, {});
  assert.equal(editor, baseComponent, "chrome decorates the exact host editor instead of replacing it with a proxy");
  assert.equal(editor.wantsKeyRelease, true);
  editor.handleInput("\u001b");
  assert.equal(delegated, "\u001b");
  editor.handleInput("\u0003");
  assert.equal(delegated, "\u0003");
  editor.handleInput("\u001b[99;5u");
  assert.equal(delegated, "\u001b[99;5u", "Kitty CSI-u Ctrl-C reaches the host editor unchanged");
  editor.handleInput("x");
  assert.equal(delegated, "x");
  assert.equal(editor.getText(), "preserved editor text");
  const rendered = editor.render(180);
  assert.match(stripAnsi(rendered[0]), /github-copilot/);
  assert.match(stripAnsi(rendered.at(-1)), /MCP/);
  assert.match(stripAnsi(rendered.at(-1)), /\+3/);
  assert.equal(footer.render(180).length, 0, "moved MCP/footer data is not duplicated below the editor");
  assert.equal(commands.has("editor-chips"), true);
});

test("footer setter is restored across repeated extension reload lifecycles", async () => {
  let editorFactory;
  let footerFactory;
  const originalSetFooter = (factory) => { footerFactory = factory; };
  const ui = {
    getEditorComponent: () => null,
    setEditorComponent(factory) { editorFactory = factory; },
    setFooter: originalSetFooter,
    setStatus() {},
  };
  class FakeCustomEditor { render() { return ["────", "", "────"]; } invalidate() {} }
  const ctx = { cwd: "/tmp", model: {}, getContextUsage: () => ({}), sessionManager: { getEntries: () => [] }, ui };
  const activate = async () => {
    const handlers = new Map();
    const pi = {
      registerCommand() {},
      on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
      getThinkingLevel: () => "low",
      exec: async () => ({ code: 1, stdout: "" }),
    };
    await createEditorChipsExtension({ settings: { agentUtils: { editorChips: { enabled: true } } }, host: { CustomEditor: FakeCustomEditor } })(pi);
    await handlers.get("session_start")[0]({}, ctx);
    return handlers;
  };
  const first = await activate();
  assert.notEqual(ui.setFooter, originalSetFooter);
  await first.get("session_shutdown")[0]({}, ctx);
  assert.equal(ui.setFooter, originalSetFooter, "shutdown restores exact host setter");
  const second = await activate();
  assert.equal(typeof editorFactory, "function");
  assert.equal(typeof footerFactory, "function");
  await second.get("session_shutdown")[0]({}, ctx);
  assert.equal(ui.setFooter, originalSetFooter);
});

test("editor chips mount without relying on ctx.mode and reassert after a later editor owner", async () => {
  const handlers = new Map();
  const commands = new Map();
  let editorFactory;
  let footerFactory;
  const ui = {
    getEditorComponent: () => null,
    setEditorComponent(factory) { editorFactory = factory; },
    setFooter(factory) { footerFactory = factory; },
    setStatus() {},
  };
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
    getThinkingLevel: () => "low",
    exec: async () => ({ code: 0, stdout: "" }),
  };
  class FakeCustomEditor {
    render() { return ["────────", "", "────────"]; }
    invalidate() {}
  }
  await createEditorChipsExtension({
    settings: { agentUtils: { editorChips: { enabled: true } } },
    env: { HOME: "/tmp" },
    host: { CustomEditor: FakeCustomEditor },
  })(pi);
  const ctx = {
    // Some host/reload paths have historically omitted or renamed mode; the
    // concrete UI capability is the authoritative mount check.
    mode: undefined,
    cwd: "/tmp",
    model: { provider: "p", id: "m", contextWindow: 100 },
    getContextUsage: () => ({ percent: 1, contextWindow: 100 }),
    sessionManager: { getEntries: () => [] },
    ui,
  };
  await handlers.get("session_start")[0]({}, ctx);
  assert.equal(typeof editorFactory, "function");
  assert.equal(typeof footerFactory, "function");
  const later = () => ({ render: () => ["later-top", "", "later-bottom"], invalidate() {} });
  ui.setEditorComponent(later);
  const redundantFooter = () => ({ render: () => ["redundant default footer"], invalidate() {} });
  ui.setFooter(redundantFooter);
  assert.notEqual(footerFactory, redundantFooter, "later footer owners cannot restore redundant footer while chips hide it");
  const rendered = editorFactory({ requestRender() {} }, theme, {}).render(100);
  assert.match(stripAnsi(rendered[0]), /p/);
  assert.match(stripAnsi(rendered.at(-1)), /MCP/);
  await commands.get("editor-chips").handler("repair", { ...ctx, ui: { ...ui, notify() {} } });
  await handlers.get("thinking_level_select")[0]({ level: "high" }, ctx);
  assert.equal(typeof editorFactory, "function");
});

const hostInstalled = await import("@earendil-works/pi-coding-agent").then(() => true, () => false);
test("the Pi entry injects CustomEditor from the host bridge (no reflection)", { skip: !hostInstalled && "Pi host packages not installed (bare node --test)" }, async () => {
  const bridge = await import("../extensions/lib/pi-host.js");
  const host = await import("@earendil-works/pi-coding-agent");
  const { createEditorChipsExtension: createEntry } = await import("../extensions/editor-chips.js");
  // Outside Pi the bridge's static import resolves to the package; inside Pi
  // the extension loader maps the same import to the running Pi's module.
  assert.equal(bridge.CustomEditor, host.CustomEditor);
  const handlers = new Map();
  const commands = new Map();
  const notes = [];
  let factory = null;
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
    getThinkingLevel: () => "low",
    exec: async () => ({ code: 1, stdout: "" }),
  };
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message, level) => notes.push({ message, level }),
      getEditorComponent: () => null,
      setEditorComponent(next) { factory = next; },
      setFooter() {},
      setStatus() {},
    },
  };
  await createEntry({ settings: { agentUtils: { editorChips: { enabled: true } } }, env: { HOME: "/tmp" } })(pi);
  await handlers.get("session_start")[0]({}, ctx);
  assert.equal(typeof factory, "function", "editor surface mounted");
  await commands.get("editor-chips").handler("status", ctx);
  const status = notes.at(-1);
  assert.match(status.message, /CustomEditor=pi-host/);
  assert.equal(status.level, "info");
  assert.doesNotMatch(notes.map((n) => n.message).join("\n"), /could not mount/);
});

test("the core reports an unavailable host instead of mounting without CustomEditor", async () => {
  const handlers = new Map(); const notes = [];
  const pi = { registerCommand() {}, on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); }, getThinkingLevel: () => "low", exec: async () => ({ code: 1, stdout: "" }) };
  const ctx = { hasUI: true, ui: { notify: (message) => notes.push(message), getEditorComponent: () => null, setEditorComponent() { throw new Error("must not mount"); }, setFooter() {}, setStatus() {} } };
  await createEditorChipsExtension({ settings: { agentUtils: { editorChips: { enabled: true } } }, env: { HOME: "/tmp" } })(pi);
  await handlers.get("session_start")[0]({}, ctx);
  assert.match(notes.join("\n"), /could not mount: CustomEditor host API unavailable/);
});

const speechConfig = resolveEditorChipsConfig({ agentUtils: { editorChips: {
  enabled: true, topLeft: ["stt"], bottomLeft: ["meter", "directory"], hiddenStatuses: ["jev", "jev", ""],
} } }, {});

test("speech and meter chips resolve into topLeft/bottomLeft with aliases and hidden statuses", () => {
  assert.deepEqual(speechConfig.topLeft, ["working", "speech"]);
  assert.deepEqual(speechConfig.bottomLeft, ["meter", "directory"]);
  assert.deepEqual(speechConfig.hiddenStatuses, ["jev"]);
  assert.deepEqual(config.topLeft, ["working"], "existing layouts gain only the working chip top-left");
  assert.deepEqual(config.hiddenStatuses, []);
});

test("speech chip is a grey dot when disabled, coloured by phase, and the meter shows only while capturing", () => {
  const disabled = buildEditorChipRails({ width: 200, config: speechConfig, values: values({ speech: { phase: "disabled" } }), theme });
  assert.match(disabled.top, /\x1b\[38;2;129;161;193m\x1b\[48;2;52;58;72m ● /, "grey dot on dark Nord");
  assert.doesNotMatch(stripAnsi(disabled.bottom), /dB/, "no meter unless capturing");
  assert.ok(stripAnsi(disabled.top).indexOf("●") < stripAnsi(disabled.top).indexOf("github-copilot"), "speech sits top-left");

  const live = { phase: "on-air", surface: "PTT", hint: "⌃␣ send", meter: true, level: 0.5, db: -23.6, threshold: 0.2, transcribing: true };
  const rails = buildEditorChipRails({ width: 200, config: speechConfig, values: values({ speech: live }), theme });
  assert.match(stripAnsi(rails.top), /● PTT \S? ⌃␣ send/u);
  assert.match(rails.top, /\x1b\[48;2;191;97;106m ● PTT /, "on air is red");
  assert.match(stripAnsi(rails.bottom), /▁▂▃▄····▌-24dB ✎/);
  assert.equal(visibleCells(rails.top), 200);
  assert.equal(visibleCells(rails.bottom), 200);
  assert.ok(stripAnsi(rails.bottom).indexOf("▁") < stripAnsi(rails.bottom).indexOf("~/"), "meter sits bottom-left before the directory");

  for (const [phase, rgb] of [["armed", "129;161;193"], ["listening", "129;161;193"], ["transcribing", "208;135;112"], ["sent", "163;190;140"], ["error", "191;97;106"]]) {
    const line = renderSpeechIndicatorLine({ speech: { phase, surface: "STT" }, theme });
    assert.match(line, new RegExp(`\\x1b\\[48;2;${rgb}m`), `${phase} colour`);
  }
  assert.equal(renderSpeechIndicatorLine({ speech: { phase: "disabled" }, theme }), "", "fallback line draws nothing when disabled");
  const narrow = buildEditorChipRails({ width: 60, config: speechConfig, values: values({ speech: live }), theme });
  assert.doesNotMatch(stripAnsi(narrow.top), /send/, "narrow rails shed the hint first");
  assert.match(stripAnsi(narrow.top), /●/, "state glyph survives");
  assert.doesNotMatch(stripAnsi(narrow.bottom), /dB/, "narrow meter drops its dB label");
  assert.match(stripAnsi(narrow.bottom), /▁▂▃▄/);
  const wideBottomOnly = buildEditorChipRails({ width: 120, config: { ...speechConfig, bottomRight: ["mcp", "cost", "context"], bottomCenter: ["branch", "diff"] }, values: values({ speech: live }), theme });
  assert.match(stripAnsi(wideBottomOnly.top), /● PTT \S? ⌃␣ send/u, "bottom-row pressure never compacts the top-left speech chip");
  const quiet = buildEditorChipRails({ width: 200, config: speechConfig, values: values({ speech: null }), theme });
  assert.doesNotMatch(stripAnsi(quiet.top), /●/, "no producer: no dot");
});

test("editor chips consume speech indicator events and hide quiet footer statuses", async () => {
  const handlers = new Map();
  const bus = new Map();
  const events = {
    on(name, fn) { (bus.get(name) || bus.set(name, []).get(name)).push(fn); return () => bus.set(name, bus.get(name).filter((item) => item !== fn)); },
    emit(name, payload) { for (const fn of [...(bus.get(name) || [])]) fn(payload); },
  };
  const tui = { renders: 0, requestRender() { this.renders += 1; } };
  const statuses = new Map([["jev", "jev: ready"], ["other", "other: busy"]]);
  const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => statuses, onBranchChange: () => () => {} };
  const notes = [];
  let editorFactory, footer;
  const base = { render: () => ["───", "editor", "───"], invalidate() {} };
  const ctx = {
    cwd: "/tmp/project",
    model: { provider: "github-copilot", id: "gpt-5.6-sol", contextWindow: 1000 },
    getContextUsage: () => ({ percent: 1, contextWindow: 1000 }),
    sessionManager: { getEntries: () => [] },
    ui: {
      notify: (message, level) => notes.push([message, level]),
      getEditorComponent: () => () => base,
      setEditorComponent: (factory) => { editorFactory = factory; },
      setFooter: (factory) => { footer = factory(tui, { ...theme, fg: (_token, text) => text }, footerData); },
      setStatus() {},
    },
  };
  const requests = [];
  events.on(SPEECH_INDICATOR_REQUEST, () => requests.push(1));
  const pi = {
    events,
    registerCommand() {},
    on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
    getThinkingLevel: () => "low",
    exec: async () => ({ code: 1, stdout: "" }),
  };
  await createEditorChipsExtension({
    settings: { agentUtils: { editorChips: { enabled: true, topLeft: ["speech"], bottomLeft: ["meter"], hiddenStatuses: ["jev"] } } },
    env: { HOME: "/tmp" },
    host: { CustomEditor: class {} },
  })(pi);
  await handlers.get("session_start")[0]({}, ctx);
  assert.equal(requests.length, 1, "mounting asks the producer for its current state");
  let accepted = false;
  events.emit(SPEECH_INDICATOR_EVENT, { version: 1, phase: "on-air", surface: "STT", meter: true, level: 0.4, db: -30, accept() { accepted = true; } });
  assert.equal(accepted, true, "configured speech chip claims rendering");
  assert.ok(tui.renders > 0, "state change requests a render");
  const editor = editorFactory(tui, theme, {});
  const rows = editor.render(120);
  assert.match(stripAnsi(rows[0]), /● STT/);
  assert.match(stripAnsi(rows.at(-1)), /-30dB/);

  // pi-client's splits: speech for one session shows in that session's pane only.
  ctx.sessionManager.getSessionId = () => "pane-a";
  events.emit(SPEECH_INDICATOR_EVENT, { version: 1, phase: "on-air", surface: "CALL", sessionId: "pane-b", accept() {} });
  assert.doesNotMatch(stripAnsi(editor.render(120)[0]), /CALL/, "another pane's call is not drawn here");
  events.emit(SPEECH_INDICATOR_EVENT, { version: 1, phase: "on-air", surface: "CALL", sessionId: "pane-a", accept() {} });
  assert.match(stripAnsi(editor.render(120)[0]), /● CALL/, "this pane's call is");
  delete ctx.sessionManager.getSessionId;

  assert.deepEqual(footer.render(120).map(stripAnsi), ["other: busy"], "healthy jev status is hidden");
  statuses.set("jev", "jev: unconfigured");
  footer.render(120); footer.render(120);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notes, [["jev: unconfigured", "warning"]], "hidden failure is reported exactly once");

  for (const handler of handlers.get("session_shutdown")) await handler({}, ctx);
  accepted = false;
  events.emit(SPEECH_INDICATOR_EVENT, { version: 1, phase: "armed", surface: "PTT", accept() { accepted = true; } });
  assert.equal(accepted, false, "shutdown unsubscribes");
});

test("what the editor writes into its borders becomes chips, and top and bottom chips keep their rows", async () => {
  const { buildEditorChipRails, editorBorderInfo, replaceEditorRails, resolveEditorChipsConfig, stripAnsi } = await import("../extensions/lib/editor-chips.js");
  // pi-client's editor while working: its status in the top border, a scroll marker in the bottom.
  const lines = ["── ⠸ Working (escape to interrupt) ───────────────", "first line", "second line", "─── ↓ 23 more ──────────────────"];
  const info = editorBorderInfo(lines);
  assert.deepEqual(info, { top: 0, bottom: 3, working: "⠸ Working (escape to interrupt)", scrollUp: 0, scrollDown: 23 });
  assert.deepEqual(editorBorderInfo(["─── ↑ 4 more ───", "x", "──────"]), { top: 0, bottom: 2, working: "", scrollUp: 4, scrollDown: 0 });

  const config = resolveEditorChipsConfig({ editorChips: { enabled: true } }, {});
  const theme = { fg: (_color, text) => text, getFgAnsi: () => "" };
  const rails = buildEditorChipRails({ width: 120, config, theme, values: { model: "m", provider: "p", effort: "high", directory: "~/x", working: info.working, scrollDown: info.scrollDown } });
  const replaced = replaceEditorRails(lines, lines, rails).map((line) => stripAnsi(line));
  assert.match(replaced[0], /⠸/, "the working chip, top-left: its spinner");
  assert.doesNotMatch(replaced[0], /Working|escape/, "the spinner alone, no text");
  assert.match(replaced[0], /m/);
  assert.match(replaced[3], /↓ 23 more/, "the scroll chip in the bottom row");
  assert.match(replaced[3], /~\/x/, "the bottom chips stay in the bottom row");
  assert.deepEqual(replaced.slice(1, 3), ["first line", "second line"]);

  // Placed explicitly, a border field stays where it was put.
  const placed = resolveEditorChipsConfig({ editorChips: { enabled: true, bottomLeft: ["working", "directory"] } }, {});
  assert.deepEqual(placed.bottomLeft, ["working", "directory"]);
  assert.equal(placed.topLeft.includes("working"), false);
});

test("the working chip is the spinner alone, coloured by activity", async () => {
  const { workingActivity } = await import("../extensions/lib/editor-chips.js");
  assert.deepEqual(workingActivity("⠸ Working (escape to interrupt)"), { glyph: "⠸", kind: "working" });
  assert.deepEqual(workingActivity("⠼ Compacting context"), { glyph: "⠼", kind: "compacting" });
  assert.deepEqual(workingActivity("⠋ Retrying (attempt 2)"), { glyph: "⠋", kind: "retrying" });
  assert.equal(workingActivity(""), undefined);
});

test("each pane's git chip is its own directory's, not the focused pane's (pi-client splits)", async () => {
  const handlers = new Map();
  const tui = { requestRender() {} };
  let editorFactory;
  // pi-client's live ctx: its cwd is the pane being drawn.
  let drawing = "/work/a";
  const ctx = {
    mode: "tui",
    get cwd() { return drawing; },
    model: { provider: "openai", id: "gpt", contextWindow: 100_000 },
    thinkingLevel: "off",
    getContextUsage: () => ({ percent: 1, contextWindow: 100_000 }),
    sessionManager: { getEntries: () => [] },
    ui: {
      getEditorComponent: () => () => ({ render: () => ["top", "editor", "bottom"], handleInput() {}, invalidate() {} }),
      setEditorComponent: (factory) => { editorFactory = factory; },
    },
  };
  const branches = { "/work/a": "main", "/work/b": "feature/b" };
  const execs = [];
  const pi = {
    registerCommand() {},
    on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
    getThinkingLevel: () => "off",
    exec: async (_command, args, options) => {
      execs.push(options?.cwd);
      return args[0] === "branch" ? { code: 0, stdout: `${branches[options.cwd]}\n` } : { code: 0, stdout: "" };
    },
  };
  await createEditorChipsExtension({
    settings: { agentUtils: { editorChips: { enabled: true, bottomCenter: ["branch"] } } },
    env: { HOME: "/home/u" },
    host: { CustomEditor: class {} },
  })(pi);
  await handlers.get("session_start")[0]({}, ctx);
  const editor = editorFactory(tui, { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t }, {});
  const draw = async (cwd) => {
    drawing = cwd;
    editor.render(160);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return stripAnsi(editor.render(160).join("\n"));
  };
  assert.match(await draw("/work/a"), /main/);
  const b = await draw("/work/b");
  assert.match(b, /feature\/b/);
  assert.doesNotMatch(b, /\bmain\b/);
  // Drawing a again shows a's branch, from its own cache: b's refresh did not replace it.
  const a = await draw("/work/a");
  assert.match(a, /main/);
  assert.doesNotMatch(a, /feature\/b/);
  assert.ok(execs.includes("/work/a") && execs.includes("/work/b"), "git ran in each pane's directory");
});

test("the loops chip shows each pane's session's loops: how many and the next one", async () => {
  const { LOOPS_EVENT, LOOPS_REQUEST } = await import("../extensions/lib/loop-indicator.js");
  const handlers = new Map();
  const bus = new Map();
  const events = { on: (name, listener) => { bus.set(name, [...(bus.get(name) ?? []), listener]); return () => {}; }, emit: (name, data) => (bus.get(name) ?? []).forEach((listener) => listener(data)) };
  const requests = [];
  events.on(LOOPS_REQUEST, (data) => requests.push(data.sessionId));
  let editorFactory;
  let drawing = "s1";
  const ctx = {
    mode: "tui",
    cwd: "/work",
    model: { provider: "openai", id: "gpt", contextWindow: 100_000 },
    getContextUsage: () => ({ percent: 1, contextWindow: 100_000 }),
    sessionManager: { getEntries: () => [], getSessionId: () => drawing },
    ui: {
      getEditorComponent: () => () => ({ render: () => ["top", "editor", "bottom"], handleInput() {}, invalidate() {} }),
      setEditorComponent: (factory) => { editorFactory = factory; },
    },
  };
  const pi = {
    registerCommand() {},
    on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
    getThinkingLevel: () => "off",
    events,
    exec: async () => ({ code: 1, stdout: "" }),
  };
  await createEditorChipsExtension({
    settings: { agentUtils: { editorChips: { enabled: true, bottomRight: ["loops", "mcp"] } } },
    env: { HOME: "/home/u" },
    host: { CustomEditor: class {} },
  })(pi);
  await handlers.get("session_start")[0]({}, ctx);
  const editor = editorFactory({ requestRender() {} }, { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t }, {});
  const draw = (session) => {
    drawing = session;
    return stripAnsi(editor.render(160).join("\n"));
  };
  assert.doesNotMatch(draw("s1"), /⟳/, "no loops: no chip");
  assert.deepEqual(requests, ["s1"], "it asks for the drawn session's loops");
  const now = Date.now();
  events.emit(LOOPS_EVENT, { sessionId: "s1", loops: [{ startedAt: now - 60_000, intervalSecs: 3 * 3600 }, { startedAt: now, intervalSecs: 600 }] });
  const s1 = draw("s1");
  assert.match(s1, /⟳ 2/);
  assert.match(s1, /10m/, "the next one: in 10 minutes");
  assert.doesNotMatch(s1, /#\d/, "no loop numbers");
  // Another pane's session has none: no chip there.
  assert.doesNotMatch(draw("s2"), /⟳/);
  assert.ok(requests.includes("s2"));
});

test("the branch and diff chips use the session's git as its host reads it (pi-git), running none here", async () => {
  const { GIT_EVENT, GIT_REQUEST } = await import("../extensions/lib/git-indicator.js");
  const handlers = new Map();
  const bus = new Map();
  const events = { on: (name, listener) => { bus.set(name, [...(bus.get(name) ?? []), listener]); return () => {}; }, emit: (name, data) => (bus.get(name) ?? []).forEach((listener) => listener(data)) };
  const requests = [];
  events.on(GIT_REQUEST, (data) => requests.push(data.sessionId));
  const execs = [];
  let editorFactory;
  const ctx = {
    mode: "tui",
    cwd: "/remote/only",
    model: { provider: "openai", id: "gpt", contextWindow: 100_000 },
    getContextUsage: () => ({ percent: 1, contextWindow: 100_000 }),
    sessionManager: { getEntries: () => [], getSessionId: () => "s1" },
    ui: {
      getEditorComponent: () => () => ({ render: () => ["top", "editor", "bottom"], handleInput() {}, invalidate() {} }),
      setEditorComponent: (factory) => { editorFactory = factory; },
    },
  };
  const pi = {
    registerCommand() {},
    on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
    getThinkingLevel: () => "off",
    events,
    exec: async (command, args) => { execs.push([command, ...args].join(" ")); return { code: 1, stdout: "" }; },
  };
  await createEditorChipsExtension({
    settings: { agentUtils: { editorChips: { enabled: true, bottomCenter: ["branch", "diff"] } } },
    env: { HOME: "/home/u" },
    host: { CustomEditor: class {} },
  })(pi);
  events.emit(GIT_EVENT, { sessionId: "s1", workspace: { repo: true, branch: "feature-remote", additions: 7, deletions: 2 } });
  await handlers.get("session_start")[0]({}, ctx);
  execs.length = 0;
  const editor = editorFactory({ requestRender() {} }, { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t }, {});
  const drawn = stripAnsi(editor.render(160).join("\n"));
  assert.match(drawn, /feature-remote/);
  assert.match(drawn, /\+7/);
  assert.match(drawn, /-2/);
  await handlers.get("turn_end")?.[0]?.({}, ctx);
  assert.deepEqual(execs.filter((line) => line.startsWith("git")), [], "no git run here for a session its host reads");
  assert.ok(requests.includes("s1"));
});

test("the cost chip uses pi-client's ledger of the whole conversation when it has one", async () => {
  const handlers = new Map();
  let editorFactory;
  const ctx = {
    mode: "tui",
    cwd: "/work",
    model: { provider: "openai", id: "gpt", contextWindow: 100_000 },
    getContextUsage: () => ({ percent: 1, contextWindow: 100_000 }),
    // Only the newest entries are loaded (cost 0.10); the ledger has all of it.
    sessionManager: { getEntries: () => [{ type: "message", message: { role: "assistant", usage: { cost: { total: 0.1 } } } }], getSessionId: () => "s1" },
    sessionUsage: () => ({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 12.34 }),
    ui: {
      getEditorComponent: () => () => ({ render: () => ["top", "editor", "bottom"], handleInput() {}, invalidate() {} }),
      setEditorComponent: (factory) => { editorFactory = factory; },
    },
  };
  const pi = {
    registerCommand() {},
    on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 1, stdout: "" }),
  };
  await createEditorChipsExtension({ settings: { agentUtils: { editorChips: { enabled: true, bottomRight: ["cost"] } } }, env: { HOME: "/home/u" }, host: { CustomEditor: class {} } })(pi);
  await handlers.get("session_start")[0]({}, ctx);
  const editor = editorFactory({ requestRender() {} }, { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t }, {});
  assert.match(stripAnsi(editor.render(120).join("\n")), /12\.3/);
});
