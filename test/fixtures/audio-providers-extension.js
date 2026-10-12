import { appendFileSync } from "node:fs";
import extension from "../../extensions/audio-providers.js";
import { bindAudioProviders, snapshotRuntimeAudioProviders } from "../../extensions/lib/audio-providers.js";
export default function fixture(pi) {
  const receipt = process.env.AUDIO_QA_RECEIPT;
  if (!receipt) throw new Error("isolated audio receipt required");
  extension(pi);
  const binding = bindAudioProviders(pi);
  const note = event => appendFileSync(receipt, JSON.stringify({ pid: process.pid, event, providers: snapshotRuntimeAudioProviders({ audioProviders: binding.providers }) }) + "\n", { mode: 0o600 });
  pi.on("session_start", () => note("ready"));
  pi.on("session_shutdown", () => binding.release());
  pi.registerCommand("qa-audio-snapshot", { description: "Isolated test snapshot", handler: async () => note("snapshot") });
}
