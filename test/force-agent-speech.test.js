import test from "node:test";
import assert from "node:assert/strict";

import forceAgentSpeechExtension, {
  isForceSpeechEnabled,
  forceSpeechMaxChars,
  extractAssistantText,
  shortSpokenSummary,
  plannedSpeech,
  __setForceSpeechRunnerForTest,
  DEFAULT_MAX_CHARS,
} from "../extensions/force-agent-speech.js";

// --- isForceSpeechEnabled ---

test("isForceSpeechEnabled reads truthy env tokens, false otherwise (bd-9c9877)", () => {
  for (const v of ["1", "true", "on", "yes", "TRUE", " On "]) {
    assert.equal(isForceSpeechEnabled({ PI_FORCE_AGENT_SPEECH: v }), true, `enabled for ${JSON.stringify(v)}`);
  }
  for (const v of [undefined, "", "0", "false", "off", "no", "nope"]) {
    assert.equal(isForceSpeechEnabled({ PI_FORCE_AGENT_SPEECH: v }), false, `disabled for ${JSON.stringify(v)}`);
  }
});

test("forceSpeechMaxChars defaults, reads env, and ignores junk (bd-9c9877)", () => {
  assert.equal(forceSpeechMaxChars({}), DEFAULT_MAX_CHARS);
  assert.equal(forceSpeechMaxChars({ PI_FORCE_AGENT_SPEECH_MAX_CHARS: "80" }), 80);
  assert.equal(forceSpeechMaxChars({ PI_FORCE_AGENT_SPEECH_MAX_CHARS: "0" }), DEFAULT_MAX_CHARS);
  assert.equal(forceSpeechMaxChars({ PI_FORCE_AGENT_SPEECH_MAX_CHARS: "-5" }), DEFAULT_MAX_CHARS);
  assert.equal(forceSpeechMaxChars({ PI_FORCE_AGENT_SPEECH_MAX_CHARS: "abc" }), DEFAULT_MAX_CHARS);
});

// --- extractAssistantText ---

test("extractAssistantText handles strings, {content}, blocks, and tool-only (bd-9c9877)", () => {
  assert.equal(extractAssistantText("hi"), "hi");
  assert.equal(extractAssistantText({ content: "  hello  " }), "hello");
  assert.equal(
    extractAssistantText({ content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }),
    "one two",
  );
  // tool-only / non-text blocks -> empty
  assert.equal(extractAssistantText({ content: [{ type: "tool_use", id: "x" }] }), "");
  assert.equal(extractAssistantText({ content: [] }), "");
  assert.equal(extractAssistantText(null), "");
  assert.equal(extractAssistantText({ text: "direct" }), "direct");
});

// --- shortSpokenSummary ---

test("shortSpokenSummary returns short text whole and strips markdown/code (bd-9c9877)", () => {
  assert.equal(shortSpokenSummary("Hello there."), "Hello there.");
  assert.equal(shortSpokenSummary("**bold** and `code` and [link](http://x)"), "bold and code and link");
  assert.equal(shortSpokenSummary("# Heading\n- item one\n- item two"), "Heading item one item two");
  // pure code / images collapse to nothing speakable
  assert.equal(shortSpokenSummary("```\nconst x = 1;\n```"), "");
  assert.equal(shortSpokenSummary("![alt](img.png)"), "");
  assert.equal(shortSpokenSummary(""), "");
  assert.equal(shortSpokenSummary(null), "");
});

test("shortSpokenSummary truncates long text at a sentence then word boundary (bd-9c9877)", () => {
  const long = "First sentence is here. Second sentence follows on. " + "word ".repeat(80);
  const out = shortSpokenSummary(long, { maxChars: 40 });
  assert.ok(out.length <= 41, `truncated to ~maxChars (got ${out.length})`);
  // prefers a sentence boundary
  assert.match(out, /First sentence is here\.$/);

  // no sentence boundary in range -> word-boundary truncation with ellipsis
  const noStops = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
  const out2 = shortSpokenSummary(noStops, { maxChars: 20 });
  assert.ok(out2.endsWith("…"), "word-boundary truncation ends with ellipsis");
  assert.ok(!out2.includes("  "), "no doubled spaces");
});

// --- plannedSpeech (pure decision) ---

test("plannedSpeech is empty when disabled, the precis when enabled (bd-9c9877)", () => {
  const ev = { message: { role: "assistant", content: "Done — landed the fix." } };
  assert.equal(plannedSpeech(ev, {}), "");
  assert.equal(plannedSpeech(ev, { PI_FORCE_AGENT_SPEECH: "1" }), "Done — landed the fix.");
  // enabled but tool-only -> empty
  assert.equal(plannedSpeech({ message: { content: [] } }, { PI_FORCE_AGENT_SPEECH: "1" }), "");
});

// --- the turn_end hook + /force-speech command ---

function makePi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    pi: { on: (ev, fn) => handlers.set(ev, fn), registerCommand: (name, def) => commands.set(name, def) },
    handlers,
    commands,
  };
}

test("turn_end speaks the precis only when enabled and there is text (bd-9c9877)", async () => {
  const spoken = [];
  __setForceSpeechRunnerForTest(async (text, opts) => { spoken.push({ text, opts }); return true; });
  const prev = process.env.PI_FORCE_AGENT_SPEECH;
  try {
    const { pi, handlers } = makePi();
    forceAgentSpeechExtension(pi);
    const turnEnd = handlers.get("turn_end");
    assert.ok(turnEnd, "registers a turn_end handler");

    delete process.env.PI_FORCE_AGENT_SPEECH;
    await turnEnd({ message: { role: "assistant", content: "Hello there." } }, {});
    assert.equal(spoken.length, 0, "silent when disabled");

    process.env.PI_FORCE_AGENT_SPEECH = "1";
    await turnEnd({ message: { role: "assistant", content: "Hello there." } }, {});
    assert.equal(spoken.length, 1, "speaks when enabled");
    assert.equal(spoken[0].text, "Hello there.");

    await turnEnd({ message: { role: "assistant", content: [{ type: "tool_use", id: "x" }] } }, {});
    assert.equal(spoken.length, 1, "tool-only turn speaks nothing");
  } finally {
    __setForceSpeechRunnerForTest(null);
    if (prev === undefined) delete process.env.PI_FORCE_AGENT_SPEECH;
    else process.env.PI_FORCE_AGENT_SPEECH = prev;
  }
});

test("/force-speech command overrides env at runtime (bd-9c9877)", async () => {
  const spoken = [];
  __setForceSpeechRunnerForTest(async (text) => { spoken.push(text); return true; });
  const prev = process.env.PI_FORCE_AGENT_SPEECH;
  try {
    delete process.env.PI_FORCE_AGENT_SPEECH; // env says off
    const { pi, handlers, commands } = makePi();
    forceAgentSpeechExtension(pi);
    const cmd = commands.get("force-speech");
    const turnEnd = handlers.get("turn_end");
    assert.ok(cmd, "registers the /force-speech command");

    const notes = [];
    const ctx = { ui: { notify: (m) => notes.push(m) } };

    await cmd.handler("on", ctx); // force on despite env off
    assert.match(notes.at(-1), /force-speech: on \(command\)/);
    await turnEnd({ message: { content: "spoken now" } }, {});
    assert.deepEqual(spoken, ["spoken now"]);

    await cmd.handler("off", ctx);
    assert.match(notes.at(-1), /force-speech: off/);
    await turnEnd({ message: { content: "not spoken" } }, {});
    assert.deepEqual(spoken, ["spoken now"], "off override silences the turn");
  } finally {
    __setForceSpeechRunnerForTest(null);
    if (prev === undefined) delete process.env.PI_FORCE_AGENT_SPEECH;
    else process.env.PI_FORCE_AGENT_SPEECH = prev;
  }
});
