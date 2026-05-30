import test from "node:test";
import assert from "node:assert/strict";

import {
  audioInputBackendLabel,
  audioOutputBackendLabel,
  defaultRecordCommand,
  defaultPlaybackCommand,
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

// Broader env helper covering the command builders' inputs (explicit cmds,
// backend, and device selection) with restore.
const RT_KEYS = [
  "PI_RT_RECORD_CMD",
  "PI_RT_PLAYBACK_CMD",
  "PI_RT_AUDIO_BACKEND",
  "PI_RT_INPUT_DEVICE",
  "PI_RT_MIC_DEVICE",
  "PI_RT_OUTPUT_DEVICE",
  "PI_RT_SPEAKER_DEVICE",
  "PULSE_SERVER",
];
function withCmdEnv(overrides, fn) {
  const orig = Object.fromEntries(RT_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of RT_KEYS) {
      if (overrides[k] === undefined) delete process.env[k];
      else process.env[k] = overrides[k];
    }
    return fn();
  } finally {
    for (const k of RT_KEYS) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  }
}

const PAREC = "parec --raw --format=s16le --rate=24000 --channels=1";
const REC = "rec -q -t raw -b 16 -e signed-integer -r 24000 -c 1 -";
const PACAT = "pacat --playback --raw --format=s16le --rate=24000 --channels=1";
const PLAY = "play -q -t raw -b 16 -e signed-integer -r 24000 -c 1 -";
const FFPLAY = "ffplay -nodisp -autoexit -loglevel error -f s16le -ar 24000 -ch_layout mono -i -";

test("defaultRecordCommand maps explicit cmd, backend, device, and defaults", () => {
  withCmdEnv({ PI_RT_RECORD_CMD: "my-recorder", PI_RT_AUDIO_BACKEND: "sox" }, () => {
    assert.equal(defaultRecordCommand(), "my-recorder");
  });
  for (const backend of ["pulse", "pacat", "parec"]) {
    withCmdEnv({ PI_RT_AUDIO_BACKEND: backend }, () => assert.equal(defaultRecordCommand(), PAREC, backend));
  }
  for (const backend of ["sox", "rec"]) {
    withCmdEnv({ PI_RT_AUDIO_BACKEND: backend }, () => assert.equal(defaultRecordCommand(), REC, backend));
  }
  // avfoundation backends interpolate the input device (default 0).
  withCmdEnv({ PI_RT_AUDIO_BACKEND: "audiotoolbox" }, () => {
    assert.equal(
      defaultRecordCommand(),
      "ffmpeg -hide_banner -loglevel error -f avfoundation -i ':0' -ac 1 -ar 24000 -f s16le -",
    );
  });
  withCmdEnv({ PI_RT_AUDIO_BACKEND: "coreaudio", PI_RT_INPUT_DEVICE: "2" }, () => {
    assert.equal(
      defaultRecordCommand(),
      "ffmpeg -hide_banner -loglevel error -f avfoundation -i ':2' -ac 1 -ar 24000 -f s16le -",
    );
  });
  withCmdEnv({ PULSE_SERVER: "/run/pulse" }, () => assert.equal(defaultRecordCommand(), PAREC));
  withCmdEnv({}, () => assert.equal(defaultRecordCommand(), REC));
});

test("defaultPlaybackCommand maps explicit cmd, backend, device, and defaults", () => {
  withCmdEnv({ PI_RT_PLAYBACK_CMD: "my-player", PI_RT_AUDIO_BACKEND: "pulse" }, () => {
    assert.equal(defaultPlaybackCommand(), "my-player");
  });
  for (const backend of ["pulse", "pacat", "paplay"]) {
    withCmdEnv({ PI_RT_AUDIO_BACKEND: backend }, () => assert.equal(defaultPlaybackCommand(), PACAT, backend));
  }
  for (const backend of ["sox", "play"]) {
    withCmdEnv({ PI_RT_AUDIO_BACKEND: backend }, () => assert.equal(defaultPlaybackCommand(), PLAY, backend));
  }
  // audiotoolbox emits an optional -audio_device_index from the output device.
  withCmdEnv({ PI_RT_AUDIO_BACKEND: "audiotoolbox" }, () => {
    assert.equal(
      defaultPlaybackCommand(),
      "ffmpeg -hide_banner -loglevel error -f s16le -ar 24000 -ac 1 -i - -f audiotoolbox -",
    );
  });
  withCmdEnv({ PI_RT_AUDIO_BACKEND: "audiotoolbox", PI_RT_OUTPUT_DEVICE: "3" }, () => {
    assert.equal(
      defaultPlaybackCommand(),
      "ffmpeg -hide_banner -loglevel error -f s16le -ar 24000 -ac 1 -i - -f audiotoolbox -audio_device_index 3 -",
    );
  });
  for (const backend of ["coreaudio", "ffplay", "ffmpeg"]) {
    withCmdEnv({ PI_RT_AUDIO_BACKEND: backend }, () => assert.equal(defaultPlaybackCommand(), FFPLAY, backend));
  }
  withCmdEnv({ PULSE_SERVER: "/run/pulse" }, () => assert.equal(defaultPlaybackCommand(), PACAT));
  withCmdEnv({}, () => assert.equal(defaultPlaybackCommand(), FFPLAY));
});
