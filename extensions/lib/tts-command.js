// Operator-configured shell playback. Speech is data ($1 / "$@"), never code.
import { spawn } from "node:child_process";
import { speechKind, withSpeechControl } from "./speech-control.js";

function speechOptions(options) {
  const kind = speechKind(options) || "tts";
  return { ...options, speechKind: kind, streamName: options.streamName || `/${kind}` };
}

export function runTtsCommand(text, options = {}) {
  return withSpeechControl(speechOptions(options), (controlled) => runTtsCommandRaw(text, controlled));
}

function runTtsCommandRaw(text, options) {
  const { command, signal, env = process.env, spawnImpl = spawn, killDelayMs = 250 } = options;
  if (!String(command || "").trim()) return Promise.reject(new Error("tts: provider=command requires command=..."));
  if (signal?.aborted) return Promise.resolve({ interrupted: true });
  const childEnv = { ...env };
  for (const [key, value] of Object.entries({
    SPEED: options.speed, VOICE: options.voice, LANG: options.lang,
    STYLE: options.style, STYLEDEGREE: options.styleDegree,
    EMBEDDING: options.embedding, PAN: options.pan,
    KIND: options.speechKind, STREAM_NAME: options.streamName,
  })) childEnv[`PI_TTS_${key}`] = String(value ?? "");
  // Pulse-aware command clients can inherit the identity without shell-string
  // rewriting. Commands with explicit naming flags should use PI_TTS_STREAM_NAME.
  const pulseName = String(options.streamName).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  childEnv.PULSE_PROP = `${childEnv.PULSE_PROP || ""} application.name="${pulseName}" media.name="${pulseName}"`.trim();
  if (options.server != null) childEnv.PULSE_SERVER = String(options.server);
  if (options.device != null) childEnv.PULSE_SINK = String(options.device);
  return new Promise((resolve, reject) => {
    let proc, timer, stderr = "", interrupted = false;
    const group = process.platform !== "win32";
    const kill = (sig) => {
      try { if (group) process.kill(-proc.pid, sig); else proc.kill(sig); } catch {}
    };
    const abort = () => {
      interrupted = true;
      kill("SIGTERM");
      timer = setTimeout(() => kill("SIGKILL"), killDelayMs);
      timer.unref?.();
    };
    try {
      proc = spawnImpl("sh", ["-c", command, "pi-tts", String(text)], {
        env: childEnv, detached: group, stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) { reject(error); return; }
    proc.stderr?.on("data", (data) => { stderr = (stderr + data.toString()).slice(-4096); });
    const cleanup = () => { signal?.removeEventListener("abort", abort); };
    proc.once("error", (error) => { cleanup(); clearTimeout(timer); reject(error); });
    proc.once("close", (code) => {
      cleanup();
      // Keep the escalation timer after cancellation: a descendant may have
      // closed stdio while ignoring SIGTERM even after its shell exited.
      if (!interrupted) clearTimeout(timer);
      if (interrupted) resolve({ interrupted: true });
      else if (code === 0) resolve({ interrupted: false });
      else reject(new Error(`tts command exited ${code}: ${stderr.trim()}`));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function playTtsCommand(text, options = {}) {
  return withSpeechControl(speechOptions(options), (controlled) => playTtsCommandControlled(text, controlled));
}

async function playTtsCommandControlled(text, options) {
  const queue = globalThis[Symbol.for("agent-utils.tts-queue.v1")];
  if (!queue?.enqueueTask) return runTtsCommand(text, options);
  if (options.signal?.aborted) return { interrupted: true };
  // Closures stay in the originating process; only a scheduling lease is
  // persisted. No shell commands, speech, or inherited environment on disk.
  const pending = queue.enqueueTask((signal) => runTtsCommand(text, { ...options, signal }), {
    streamName: options.streamName,
    speechKind: options.speechKind,
    speechControl: options.speechControl,
  });
  const abort = () => queue.cancel(pending.jobId);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    const result = await pending;
    if (result.error) throw new Error(result.error);
    return result;
  } finally { options.signal?.removeEventListener("abort", abort); }
}
