// RealtimeStateController — single explicit lifecycle state for connection,
// microphone, visible phase, and widget visibility. Runtime config still owns
// tunable settings such as model, voice, and audio enablement; this controller
// owns the session state machine that the UI and commands observe. Extracted
// from realtime-agent.js (bd-e1914a); pure instance state, no ctx/imports.

export class RealtimeStateController {
  constructor() {
    this.connection = "off";             // off|connecting|connected|error
    this.phase = "idle";                 // idle|connecting|thinking|speaking|recording|transcribing(STT-only)|replaying|error
    this.micMode = null;                 // null|ptt|vad|continuous
    this.widgetVisible = false;
  }

  setConnection(connection) {
    this.connection = connection || "off";
    if (this.connection === "connecting") this.phase = "connecting";
    if (this.connection === "off" && this.phase !== "replaying") this.phase = "idle";
    if (this.connection === "error") this.phase = "error";
  }

  setPhase(phase) {
    this.phase = phase || "idle";
    if (this.phase === "connecting") this.connection = "connecting";
    if (this.phase === "error") this.connection = "error";
  }

  setMicMode(mode) { this.micMode = mode || null; }
  setWidgetVisible(visible) { this.widgetVisible = !!visible; }

  get connected() { return this.connection === "connected"; }
  get connecting() { return this.connection === "connecting"; }

  mode({ sttOnly = false } = {}) {
    if (this.connection === "off") return "off";
    if (this.connection === "connecting") return "connecting";
    if (this.connection === "error") return "error";
    if (this.phase === "recording" && this.micMode) return sttOnly ? `stt:${this.micMode}` : `listen:${this.micMode}`;
    if (this.phase === "transcribing") return "transcribing";
    if (this.phase === "thinking") return "responding";
    if (this.phase === "speaking") return "speaking";
    if (this.phase === "replaying") return "replaying";
    return sttOnly ? "stt" : "connected";
  }

  snapshot(extra = {}) {
    return {
      connection: this.connection,
      connected: this.connected,
      connecting: this.connecting,
      phase: this.phase,
      micMode: this.micMode,
      widgetVisible: this.widgetVisible,
      mode: this.mode(extra),
      ...extra,
    };
  }
}
