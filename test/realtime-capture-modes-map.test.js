import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// bd-e3e410: the capture-mode map is a block comment in realtime-agent.js. This
// test binds it to the source so it cannot silently drift — every entry
// function / trigger symbol the map cites must still exist as a real token in
// the code (outside the map comment), so renaming e.g. startLocalVad without
// updating the map fails here.

const src = readFileSync(
  fileURLToPath(new URL("../extensions/realtime-agent.js", import.meta.url)),
  "utf8",
);
const lines = src.split("\n");

const markerIdx = lines.findIndex((l) => l.includes("Capture-mode map (bd-e3e410)"));

function extractMapBlock() {
  assert.notEqual(markerIdx, -1, "capture-mode map marker not found in realtime-agent.js");
  const isRule = (l) => /^\/\/ ={10,}\s*$/.test(l);
  let start = markerIdx;
  while (start > 0 && !isRule(lines[start - 1])) start -= 1;
  let end = markerIdx;
  while (end < lines.length - 1 && !isRule(lines[end + 1])) end += 1;
  // include the enclosing rule lines
  return { start: start - 1, end: end + 1 };
}

test("capture-mode map block is present exactly once", () => {
  const count = lines.filter((l) => l.includes("Capture-mode map (bd-e3e410)")).length;
  assert.equal(count, 1, "expected exactly one capture-mode map block");
});

test("map documents all four capture modes", () => {
  const { start, end } = extractMapBlock();
  const mapText = lines.slice(start, end + 1).join("\n");
  for (const mode of ["WSS server-VAD", "WSS PTT", "local-vad batch-STT", "cascade group chat"]) {
    assert.ok(mapText.includes(mode), `map missing mode: ${mode}`);
  }
});

test("every symbol cited by the map still exists in the code (no drift)", () => {
  const { start, end } = extractMapBlock();
  const mapText = lines.slice(start, end + 1).join("\n");
  const codeText = [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n");

  const citedSymbols = [
    "startMic",
    "startLocalVad",
    "startCascadeMic",
    "ensureCascadeController",
    "LocalVadController",
    "CascadeController",
    "input_audio_buffer.append",
    "handleHumanUtterance",
    "labelUntrustedTranscript",
    "terminalInputUnsub",
    "releaseUnsub",
    "sendUserMessage",
  ];

  for (const sym of citedSymbols) {
    assert.ok(mapText.includes(sym), `map does not cite expected symbol: ${sym}`);
    assert.ok(codeText.includes(sym), `map cites ${sym} but it no longer exists in the code — update the capture-mode map`);
  }
});
