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

  // Return a semantic action plus whether Pi should consume the terminal input.
  // Ctrl-Space is delivered by terminals as NUL ("\0").
  terminalAction(data, { editorEmpty = false, shortcutsEnabled = true } = {}) {
    const key = String(data ?? "");

    if (this.mode === SPEECH_INPUT_MODES.IDLE) {
      if (!shortcutsEnabled) return { action: "pass", consume: false };
      if (key === " " && editorEmpty) return { action: "start-ptt", consume: true };
      if (key === "\u0000") return { action: "start-vad", consume: true };
      return { action: "pass", consume: false };
    }

    if (this.mode === SPEECH_INPUT_MODES.PTT) {
      if (key === "\u0003") return { action: "cancel", consume: true };
      if (key === "\u001b") return { action: "preserve", consume: true };
      if (key === "\r" || key === "\n" || key === " ") return { action: "commit-send", consume: true };
      return { action: "pass", consume: false };
    }

    if (this.mode === SPEECH_INPUT_MODES.VAD) {
      if (shortcutsEnabled && key === "\u0000") return { action: "stop-vad", consume: true };
      return { action: "pass", consume: false };
    }

    // Full Realtime remains controlled exclusively by /rt. Its existing mic
    // handler owns release/cancel keys; editor-speech shortcuts must pass through.
    return { action: "pass", consume: false };
  }
}
