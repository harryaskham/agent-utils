// One-shot batch transcription over a PCM buffer for the `/rt stt local-vad`
// mode (bd-9399e7): spawns `stt --stdin --transcription-model <model>` (REST,
// non-streaming), pipes a raw PCM16/24k/mono buffer to stdin, and resolves with
// the transcript. The `stt` CLI's `--stdin` reads exactly this format (see
// realtime-audio.js, the format source of truth).
//
// The arg builder is pure (unit-tested) and `spawnImpl` is injectable so the
// subprocess plumbing can be tested without the `stt` binary or audio.

import { spawn } from "node:child_process";

export const DEFAULT_STT_BATCH_MODEL = "mai-transcribe-1.5";

/// Build the `stt` argv for one-shot stdin transcription. Pure.
export function buildSttBatchArgs({ model = DEFAULT_STT_BATCH_MODEL, language } = {}) {
  const args = ["--stdin", "--transcription-model", String(model)];
  if (language) args.push("--language", String(language));
  return args;
}

/// Transcribe a raw PCM16/24k/mono `buffer` via a one-shot `stt --stdin`
/// subprocess. Resolves with the trimmed transcript; rejects on spawn error or
/// a non-zero exit (carrying stderr). `command`/`spawnImpl` are injectable.
export function transcribePcmBuffer(buffer, { model, language, command = "stt", spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnImpl(command, buildSttBatchArgs({ model, language }), {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = "";
    let stderr = "";
    proc.stdout?.on?.("data", (chunk) => { stdout += String(chunk); });
    proc.stderr?.on?.("data", (chunk) => { stderr += String(chunk); });
    proc.on?.("error", reject);
    proc.on?.("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`stt exited ${code}: ${stderr.trim() || "no stderr"}`));
    });

    try {
      proc.stdin?.end(buffer ?? Buffer.alloc(0));
    } catch (err) {
      reject(err);
    }
  });
}
