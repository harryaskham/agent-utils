import test from "node:test";
import assert from "node:assert/strict";

import { createEditorChipsExtension } from "../extensions/editor-chips.js";
import {
  buildEditorChipRails,
  collapseDirectoryToWidth,
  directoryCollapseCandidates,
  parseMcpCount,
  replaceEditorRails,
  resolveEditorChipsConfig,
  stripAnsi,
  visibleCells,
} from "../extensions/lib/editor-chips.js";

const COLORS = {
  borderMuted: [76, 86, 106],
  borderAccent: [94, 129, 172],
  thinkingHigh: [180, 142, 173],
  thinkingLow: [136, 192, 208],
  thinkingOff: [76, 86, 106],
  thinkingMinimal: [129, 161, 193],
  thinkingMedium: [143, 188, 187],
  thinkingXhigh: [191, 97, 106],
  thinkingMax: [208, 135, 112],
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
    additions: 27,
    deletions: 13,
    ...overrides,
  };
}

const config = resolveEditorChipsConfig({ agentUtils: { editorChips: { enabled: true } } }, {});

test("editor chip settings resolve the requested immutable startup layout", () => {
  assert.equal(config.enabled, true);
  assert.deepEqual(config.topRight, ["model", "effort"]);
  assert.deepEqual(config.bottomRight, ["mcp", "cost", "context"]);
  assert.deepEqual(config.bottomLeft, ["directory"]);
  assert.deepEqual(config.bottomCenter, ["branch", "diff"]);
  assert.equal(config.hideFooter, true);
  assert.equal(resolveEditorChipsConfig({}, {}).enabled, false);
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
  assert.match(bottom, /498\.893 \(sub\)/);
  assert.match(bottom, /12\.0%/);
  assert.match(rails.top, /\x1b\[38;2;136;192;208m─/);
});

test("narrow rails collapse directory before reducing branch to its git icon", () => {
  const rails = buildEditorChipRails({ width: 100, config, values: values(), theme });
  assert.notEqual(rails.values.directory, values().directory);
  assert.equal(rails.values.branchCollapsed, true);
  assert.match(stripAnsi(rails.bottom), //);
  assert.doesNotMatch(stripAnsi(rails.bottom), /agent\/ms-mac\/agent-utils/);
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
  const previous = () => ({
    focused: false,
    render: () => ["gfx-top-placeholder", "editor", "gfx-bottom-placeholder"],
    handleInput: (data) => { delegated = data; },
    getText: () => "preserved editor text",
    invalidate() {},
  });
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
  const pi = {
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
  editor.handleInput("x");
  assert.equal(delegated, "x");
  assert.equal(editor.getText(), "preserved editor text");
  const rendered = editor.render(180);
  assert.match(stripAnsi(rendered[0]), /github-copilot/);
  assert.match(stripAnsi(rendered.at(-1)), /MCP/);
  assert.match(stripAnsi(rendered.at(-1)), /\+3/);
  assert.equal(footer.render(180).length, 0, "moved MCP/footer data is not duplicated below the editor");
});
