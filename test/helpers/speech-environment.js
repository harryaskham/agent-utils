import { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real policy reads/watchers, but never the operator's node-wide mute file.
const root = mkdtempSync(join(tmpdir(), "agent-utils-speech-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
export const speechTestEnv = (env = process.env) => ({ ...env, PI_TTS_MUTE_PATH: join(root, "mute.json") });
export const waitForSpeech = async (predicate) => {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("speech operation did not settle");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
