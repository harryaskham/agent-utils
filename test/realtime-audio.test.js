import test from "node:test";
import assert from "node:assert/strict";

import {
  audioInputBackendLabel,
  audioOutputBackendLabel,
} from "../extensions/lib/realtime-audio.js";

// Drive PI_RT_AUDIO_BACKEND / PULSE_SERVER to known values (or clear them) with
// restore, so the env-coupled backend selection is deterministic regardless of
// the host's real audio environment.
function withAudioEnv({ PI_RT_AUDIO_BACKEND, PULSE_SERVER } = {}, fn) {
  const keys = ["PI_RT_AUDIO_BACKEND", "PULSE_SERVER"];
  const orig = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const next = { PI_RT_AUDIO_BACKEND, PULSE_SERVER };
  try {
    for (const k of keys) {
      if (next[k] === undefined) delete process.env[k];
      else process.env[k] = next[k];
    }
    return fn();
  } finally {
    for (const k of keys) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  }
}

test("audioInputBackendLabel short-circuits on a custom record command", () => {
  withAudioEnv({ PI_RT_AUDIO_BACKEND: "pulse" }, () => {
    assert.equal(audioInputBackendLabel({ recordCommand: "rec.sh" }), "in:custom");
  });
});

test("audioInputBackendLabel maps backend aliases and env", () => {
  for (const backend of ["pulse", "pulseaudio", "pacat", "parec"]) {
    withAudioEnv({ PI_RT_AUDIO_BACKEND: backend }, () => {
      assert.equal(audioInputBackendLabel({}), "in:pulse", backend);
    });
  }
  // coreaudio/audiotoolbox are output-only; input still uses avfoundation.
  for (const backend of ["coreaudio", "audiotoolbox", "ffmpeg"]) {
    withAudioEnv({ PI_RT_AUDIO_BACKEND: backend }, () => {
      assert.equal(audioInputBackendLabel({}), "in:avfoundation", backend);
    });
  }
  for (const backend of ["sox", "rec", "play"]) {
    withAudioEnv({ PI_RT_AUDIO_BACKEND: backend }, () => {
      assert.equal(audioInputBackendLabel({}), "in:sox", backend);
    });
  }
  // PULSE_SERVER falls back to pulse when no explicit backend matched.
  withAudioEnv({ PULSE_SERVER: "/run/pulse" }, () => {
    assert.equal(audioInputBackendLabel({}), "in:pulse");
  });
  // default with nothing set.
  withAudioEnv({}, () => {
    assert.equal(audioInputBackendLabel({}), "in:sox");
  });
});

test("audioOutputBackendLabel short-circuits on a custom playback command", () => {
  withAudioEnv({ PI_RT_AUDIO_BACKEND: "sox" }, () => {
    assert.equal(audioOutputBackendLabel({ playbackCommand: "play.sh" }), "out:custom");
  });
});

test("audioOutputBackendLabel maps backend aliases and env", () => {
  for (const backend of ["pulse", "pulseaudio", "pacat", "paplay"]) {
    withAudioEnv({ PI_RT_AUDIO_BACKEND: backend }, () => {
      assert.equal(audioOutputBackendLabel({}), "out:pulse", backend);
    });
  }
  for (const backend of ["sox", "play"]) {
    withAudioEnv({ PI_RT_AUDIO_BACKEND: backend }, () => {
      assert.equal(audioOutputBackendLabel({}), "out:sox", backend);
    });
  }
  // output keeps the macOS-native backends distinct (asymmetric with input).
  withAudioEnv({ PI_RT_AUDIO_BACKEND: "audiotoolbox" }, () => {
    assert.equal(audioOutputBackendLabel({}), "out:audiotoolbox");
  });
  withAudioEnv({ PI_RT_AUDIO_BACKEND: "coreaudio" }, () => {
    assert.equal(audioOutputBackendLabel({}), "out:coreaudio");
  });
  // ffplay / ffmpeg pass through with their own name.
  withAudioEnv({ PI_RT_AUDIO_BACKEND: "ffplay" }, () => {
    assert.equal(audioOutputBackendLabel({}), "out:ffplay");
  });
  withAudioEnv({ PI_RT_AUDIO_BACKEND: "ffmpeg" }, () => {
    assert.equal(audioOutputBackendLabel({}), "out:ffmpeg");
  });
  withAudioEnv({ PULSE_SERVER: "/run/pulse" }, () => {
    assert.equal(audioOutputBackendLabel({}), "out:pulse");
  });
  withAudioEnv({}, () => {
    assert.equal(audioOutputBackendLabel({}), "out:ffplay");
  });
});
