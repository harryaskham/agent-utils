// Push-to-talk to the daemon (bd-6ffaf9). realtime-agent.js's Ctrl-Space first offers the press on
// Pi's event bus. pi-client's voice-client.js takes it when the focused session's daemon runs
// voice input (voice.mjs), and sends /ptt talk there; otherwise the press stays local PTT.

export const VOICE_PTT_EVENT = "agent-utils:voice-ptt.v1";

/** Offer a push-to-talk press to a daemon voice target: true when one took it. */
export function offerDaemonPtt(pi) {
  let taken = false;
  try { pi?.events?.emit?.(VOICE_PTT_EVENT, { version: 1, take() { taken = true; } }); } catch {}
  return taken;
}
