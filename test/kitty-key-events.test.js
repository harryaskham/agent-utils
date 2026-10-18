import test from "node:test";
import assert from "node:assert/strict";

import { isKeyRelease, isKeyRepeat } from "../extensions/lib/kitty-key-events.js";
import { HOST_NOT_INSTALLED, optionalHostModule } from "./helpers/pi-host.js";

const piTui = await optionalHostModule("@earendil-works/pi-tui");

const SAMPLES = [
  ["\x1b[32;5u", "press", "Ctrl-Space press (CSI-u)"],
  ["\x1b[32;5:1u", "press", "explicit press event type"],
  ["\x1b[32;5:2u", "repeat", "Ctrl-Space repeat"],
  ["\x1b[32;5:3u", "release", "Ctrl-Space release"],
  ["\x1b[32;1:3u", "release", "Space release"],
  ["\x1b[3;1:2~", "repeat", "Delete repeat (functional key)"],
  ["\x1b[1;1:3A", "release", "Up release"],
  ["\x1b[1;1:2D", "repeat", "Left repeat"],
  ["\x1b[1;1:3H", "release", "Home release"],
  ["\x1b[1;1:2F", "repeat", "End repeat"],
  ["\x1b[1;5A", "press", "Ctrl-Up press"],
  [" ", "press", "legacy Space"],
  ["\x00", "press", "legacy Ctrl-Space"],
  ["a", "press", "plain text"],
  ["\x1b[200~x:3u\x1b[201~", "press", "bracketed paste containing a release-like suffix"],
  ["\x1b[200~y:2u\x1b[201~", "press", "bracketed paste containing a repeat-like suffix"],
  ["", "press", "empty input"],
];

test("kitty key event predicates classify presses, repeats, releases and pastes", () => {
  for (const [data, kind, label] of SAMPLES) {
    assert.equal(isKeyRepeat(data), kind === "repeat", `${label}: repeat`);
    assert.equal(isKeyRelease(data), kind === "release", `${label}: release`);
  }
  assert.equal(isKeyRepeat(undefined), false);
  assert.equal(isKeyRelease(null), false);
});

test("kitty key event predicates match the Pi TUI host implementation", { skip: !piTui && HOST_NOT_INSTALLED }, () => {
  for (const [data, , label] of SAMPLES) {
    assert.equal(isKeyRepeat(data), piTui.isKeyRepeat(data), `${label}: repeat parity`);
    assert.equal(isKeyRelease(data), piTui.isKeyRelease(data), `${label}: release parity`);
  }
});
