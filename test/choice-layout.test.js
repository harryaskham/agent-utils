import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { ChoiceView, choiceTextWidth, wrapChoiceText, fitChoiceText, choiceViewKey, choicePanelRows } from "../extensions/lib/choice-layout.js";

const choices = Array.from({ length: 9 }, (_, i) => ({ id: `option-${i}`, label: `Choice ${i + 1}`, headline: `Choice ${i + 1}`, summary: Array.from({ length: 11 }, (_, j) => `Description ${i + 1} line ${j + 1} has meaningful readable detail.`).join("\n") }));
const question = Array.from({ length: 12 }, (_, i) => `Question line ${i + 1} is important.`).join("\n");
const model = { question, choices, index: 0 };
const theme = { fg: (_, value) => value, bold: value => value };
const render = (view, width = 80, height = 30, value = model) => view.render(value, width, height, theme);

test("bottom dock leaves transcript space and offsets mouse hit testing", () => {
  for (const rows of [0, 1, 2, 10, 24, 30, 60, 100]) {
    const height = choicePanelRows(rows);
    assert.ok(height <= 18 && height <= rows);
    if (rows > 1) assert.ok(height <= rows / 2);
    assert.equal(choicePanelRows(rows, true), rows);
  }
  const view = new ChoiceView();
  view.render(model, 80, choicePanelRows(30), theme);
  view.layout.rowOffset = 15; view.layout.terminalRows = 30;
  assert.equal(view.mouse("\x1b[<0;20;5M", 80, 30).type, "ignored", "transcript click cannot choose");
  const y = view.layout.rowOffset + view.layout.list.top + 1;
  assert.deepEqual(view.mouse(`\x1b[<0;20;${y}M`, 80, 30), { type: "choose", index: 0 });
  assert.equal(choiceViewKey("f"), "toggle-fullscreen");
  assert.equal(choiceViewKey("\x1b[102;1:1u"), "toggle-fullscreen");
});

test("CHOICE-WRAP-1 wraps prose, explicit lines, wide text and whole graphemes safely", () => {
  assert.deepEqual(wrapChoiceText("one two three four", 9), ["one two", "three", "four"]);
  assert.deepEqual(wrapChoiceText("one\n\ntwo", 20), ["one", "", "two"]);
  assert.equal(choiceTextWidth("界👩🏽‍💻e\u0301"), 5);
  assert.deepEqual(wrapChoiceText("界👩🏽‍💻e\u0301", 2), ["界", "👩🏽‍💻", "e\u0301"]);
  assert.equal(fitChoiceText("界界界", 5), "界界…");
  assert.deepEqual(wrapChoiceText("\x1b]52;c;secret\x07Hello\x1b[2J world", 30), ["Hello world"]);
});

test("CHOICE-SCROLL-1 question and per-option text scroll without selection/list movement", () => {
  const view = new ChoiceView();
  render(view);
  assert.equal(view.layout.question.height, 5);
  assert.equal(view.layout.blocks[0].height, 5);
  const listStart = view.listOffset;
  view.input("question-down");
  const movedQuestion = render(view).join("\n");
  assert.match(movedQuestion, /Question line 6/);
  assert.doesNotMatch(movedQuestion, /Question line 1 is/);
  assert.equal(view.listOffset, listStart);
  assert.equal(view.layout.index, 0);
  view.input("end");
  const movedChoice = render(view).join("\n");
  assert.match(movedChoice, /Description 1 line 11/);
  assert.equal(view.questionOffset, 5);
  assert.equal(view.layout.index, 0);
  view.input("home");
  assert.match(render(view).join("\n"), /◆ 1\. Choice 1/);
  view.input("focus"); view.input("end");
  assert.match(render(view).join("\n"), /Question line 12/);
  assert.equal(view.layout.blocks[0].offset, 0);
});

test("CHOICE-SCROLL-2 layout stays bounded at tiny, narrow, standard and wide sizes; last option is reachable", () => {
  for (const width of [0, 1, 2, 5, 12, 30, 40, 80, 120]) for (const height of [0, 1, 2, 5, 10, 20, 40]) {
    const view = new ChoiceView();
    const lines = render(view, width, height);
    assert.ok(lines.length <= height, `${width}x${height} height`);
    for (const line of lines) assert.ok(choiceTextWidth(line) <= width, `${width}x${height}: ${JSON.stringify(line)}`);
    const last = render(view, width, height, { ...model, index: 8 });
    for (const line of last) assert.ok(choiceTextWidth(line) <= width);
    if (width >= 30 && height >= 10) {
      assert.match(last.join("\n"), /◆ 9\./);
      view.input("end");
      assert.match(render(view, width, height, { ...model, index: 8 }).join("\n"), /detail\./);
      assert.equal(view.layout.blocks[8].offset + view.layout.blocks[8].height, view.layout.blocks[8].total);
    }
  }
});

test("expanded descriptions are readable and compact mode is reversible", () => {
  const view = new ChoiceView();
  const value = { question: "Question", index: 0, choices: [{ id: "1", label: "Full stable label with all of the important words", headline: "Short headline", summary: "A description that needs to wrap across multiple lines at the given width." }, { id: "2", label: "Other", headline: "Other" }] };
  const expanded = render(view, 40, 25, value).join("\n");
  assert.match(expanded, /Full stable label/);
  assert.match(expanded, /important words/);
  view.input("end");
  assert.match(render(view, 40, 25, value).join("\n").replace(/\s+/g, " "), /given width/);
  view.setExpanded(false);
  assert.match(render(view, 40, 25, value).join("\n"), /Compact/);
  assert.equal(view.layout.blocks[0].height, 2);
  view.setExpanded(true); view.input("home");
  assert.match(render(view, 40, 25, value).join("\n"), /Short headline/);
});

test("CHOICE-INPUT-1 mouse regions use latest geometry and text scrolling never chooses", () => {
  const view = new ChoiceView(); render(view);
  const qrow = view.layout.question.top + 1;
  assert.equal(view.mouse(`\x1b[<65;20;${qrow}M`, 80, 30).type, "render");
  assert.equal(view.questionOffset, 2);
  assert.equal(view.layout.index, 0);
  render(view);
  const crow = view.layout.list.top + 1;
  view.mouse(`\x1b[<65;20;${crow}M`, 80, 30);
  assert.equal(view.choiceOffsets.get("option-0"), 2);
  assert.equal(view.layout.index, 0);
  assert.equal(view.mouse(`\x1b[<0;20;${crow}M`, 40, 30).type, "ignored", "stale resize hitbox");
  assert.deepEqual(view.mouse(`\x1b[<0;20;${crow}M`, 80, 30), { type: "choose", index: 0 });
  assert.equal(view.mouse(`\x1b[<0;20;${crow}m`, 80, 30).type, "ignored", "release cannot select twice");
  assert.equal(choiceViewKey("v"), "toggle");
  assert.equal(choiceViewKey("\x1b[118;1:1u"), "toggle");
  assert.equal(choiceViewKey("\x1b[118;1:3u"), null, "Kitty key release is not a toggle");
  assert.equal(choiceViewKey("\x1b[6;2:1~"), "question-down");
  assert.equal(choiceViewKey("\x1b[6~"), "page-down");
  assert.equal(choiceViewKey("\x1b[6;2~"), "question-down");
});

test("CHOICE-QA-1 cached redraw is bounded and reuses wrapped text", () => {
  const view = new ChoiceView(); render(view);
  const samples = [];
  for (let i = 0; i < 150; i++) {
    const start = performance.now(); render(view, 80, 30, { ...model, index: i % 9 });
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  assert.ok(samples[Math.floor(samples.length * .95)] < 10, `p95=${samples[Math.floor(samples.length * .95)]}ms`);
  assert.ok(view.cache.size <= 64);
});
