// The session document of pi-daemon voice input (bd-6ffaf9): its settings and live call. Shared
// by the daemon module (durable-voice.js) and its client part (durable/voice-client.js), which
// follows it without loading the STT libraries.

/** The session's voice settings and call (a Durable session document). */
export const VOICE_DOC = {
  definition: {
    kind: "agent-utils.voice",
    version: 1,
    scope: "session",
    initial: () => ({ settings: {}, call: null, last: null, seq: 0 }),
    checkpointWhen: () => false,
  },
};
