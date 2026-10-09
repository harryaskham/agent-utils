// Explicit editor-speech input state machine (bd-24d679 / bd-586f58).
//
// Local batch STT and full Realtime used to share loosely-related command and
// terminal-input branches. That made `/stt` accidentally enter the Realtime
// WebSocket path and left keyboard behavior dependent on whichever callback
// happened to be active. This tiny pure state machine owns the user-visible
// modes and translates terminal input into semantic actions. The extension
// performs the effects (capture, transcribe, send) separately.

export const SPEECH_INPUT_MODES = Object.freeze({
  IDLE: "idle",
  PTT: "ptt",
  VAD: "vad",
  REALTIME: "realtime",
});

const VALID_MODES = new Set(Object.values(SPEECH_INPUT_MODES));

export class SpeechInputStateMachine {
  constructor(mode = SPEECH_INPUT_MODES.IDLE) {
    this.transition(mode);
  }

  transition(mode) {
    const next = String(mode || "").trim().toLowerCase();
    if (!VALID_MODES.has(next)) throw new Error(`unsupported speech input mode: ${mode}`);
    this.mode = next;
    return this.mode;
  }

  snapshot() {
    return { mode: this.mode };
  }

  // Raw input only releases an already-active PTT hold. Starting/toggling PTT
  // belongs to Pi's editor-scoped registerShortcut("ctrl+space") path.
  terminalAction(data) {
    const key = String(data ?? "");

    if (this.mode === SPEECH_INPUT_MODES.PTT) {
      if (key === "\u0003") return { action: "cancel", consume: true };
      if (key === "\u001b") return { action: "preserve", consume: true };
      if (key === "\r" || key === "\n" || key === " ") return { action: "commit-send", consume: true };
      return { action: "pass", consume: false };
    }

    // Idle/VAD must never consume raw Space/Ctrl-Space. Full Realtime remains
    // exclusively controlled by /rt and its own release/cancel handler.
    return { action: "pass", consume: false };
  }
}
