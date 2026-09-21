// Operator-configured shell playback. Speech is data ($1 / "$@"), never code.
import { spawn } from "node:child_process";

export function runTtsCommand(text, options = {}) {
  const { command, signal, env = process.env, spawnImpl = spawn, killDelayMs = 250 } = options;
  if (!String(command || "").trim()) return Promise.reject(new Error("tts: provider=command requires command=..."));
  if (signal?.aborted) return Promise.resolve({ interrupted: true });
  const childEnv = { ...env };
  for (const [key, value] of Object.entries({
    SPEED: options.speed, VOICE: options.voice, LANG: options.lang,
    STYLE: options.style, STYLEDEGREE: options.styleDegree,
    EMBEDDING: options.embedding, PAN: options.pan,
  })) childEnv[`PI_TTS_${key}`] = String(value ?? "");
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

export async function playTtsCommand(text, options = {}) {
  const queue = globalThis[Symbol.for("agent-utils.tts-queue.v1")];
  if (!queue?.enqueueTask) return runTtsCommand(text, options);
  if (options.signal?.aborted) return { interrupted: true };
  // Closures stay in the originating process; only a scheduling lease is
  // persisted. No shell commands, speech, or inherited environment on disk.
  const pending = queue.enqueueTask((signal) => runTtsCommand(text, { ...options, signal }), {
    streamName: options.streamName || "/tts",
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
