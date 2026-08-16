import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const runtimeSettingsSurfaces = [
  "extensions/read-aloud.js",
  "extensions/tts-narration.js",
  "extensions/choice.js",
  "extensions/ring-input.js",
  "extensions/realtime-agent.js",
];

const settingsReaders = [
  "extensions/lib/tts-settings.js",
  "extensions/lib/realtime-settings.js",
];

test("Agent Utils command settings are runtime-only by source contract", () => {
  for (const path of runtimeSettingsSurfaces) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /persist(?:Tts|Narrate|Read|Choice|RingInput|Realtime|Cascade|Stt)Setting\s*\(/, `${path} must not write startup settings`);
  }
});

test("speech/realtime settings modules expose immutable readers, not write helpers", () => {
  for (const path of settingsReaders) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /writeFileSync|export function persist[A-Z]/, `${path} must remain read-only`);
  }
});
