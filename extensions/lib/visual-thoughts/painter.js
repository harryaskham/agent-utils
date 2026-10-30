// Visual thoughts: the painter. While the agent works, its output feeds a digest; when enough is
// new (and the last image is old enough), a fast model writes an image prompt from it and an
// image model paints it. Each painting goes to `onImage`: the local display (TUI Pi, pi-client),
// or the session's backdrop slot (the pi-daemon module). It never blocks the agent; every failure
// is a warning at most, rate limits wait for the provider's reset, other failures back off.
import { ImageRateLimitError } from "./image-provider.js";
import { buildImagePromptRequest, createDigest, normalizeImagePrompt } from "./prompter.js";

/**
 * `config` is live (runtime changes mutate it). `promptTurn(request, signal)` resolves the prompt
 * model's reply; `provider.generate(prompt, { signal })` paints; `onImage(record, png)` takes each
 * painting (`record`: id, prompt, model, batch, at, ms) and may be async.
 */
export function createPainter({
  config,
  promptTurn,
  provider,
  onImage,
  now = () => Date.now(),
  timers = { setTimeout, clearTimeout },
  warn = () => {},
  onChange = () => {},
}) {
  const digest = createDigest();
  const inflight = new Set();
  const recentPrompts = [];
  let enabled = false;
  let disposed = false;
  let inRun = false;
  let flushAfterRun = false;
  let runCount = 0;
  let batch = 0;
  let nextAllowedAt = 0;
  let failures = 0;
  let wakeTimer = null;
  let seq = 0;
  let activity = "idle"; // idle | prompting | painting
  let lastError = "";
  let generated = 0;
  let lastMs = 0;
  let currentProvider = provider;

  function setActivity(next) {
    if (activity === next) return;
    activity = next;
    try { onChange(status()); } catch {}
  }

  function scheduleWake(at) {
    if (wakeTimer) return;
    wakeTimer = timers.setTimeout(() => { wakeTimer = null; maybePaint(); }, Math.max(50, at - now()));
    wakeTimer?.unref?.();
  }

  function maybePaint({ force = false } = {}) {
    if (!enabled || disposed) return false;
    if (inflight.size >= config.maxConcurrent) return false;
    if (!force) {
      if (!inRun && !flushAfterRun) return false;
      if (runCount >= config.maxPerRun) return false;
      const threshold = runCount === 0 ? config.firstChars : config.minChars;
      if (digest.pending < Math.max(1, threshold)) return false;
    }
    if (now() < nextAllowedAt) { scheduleWake(nextAllowedAt); return false; }
    flushAfterRun = false;
    void paint();
    return true;
  }

  async function paint() {
    const snapshot = digest.snapshot();
    digest.mark();
    runCount += 1;
    nextAllowedAt = now() + config.minIntervalMs;
    const ofBatch = batch;
    const controller = new AbortController();
    inflight.add(controller);
    try {
      setActivity("prompting");
      const request = buildImagePromptRequest({ digest: snapshot, recentPrompts, style: config.style });
      const reply = await promptTurn(request, controller.signal);
      if (controller.signal.aborted) return;
      const prompt = normalizeImagePrompt(reply, { style: config.style });
      if (!prompt) throw new Error("the prompt model returned no prompt");
      remember(prompt);
      setActivity("painting");
      const result = await currentProvider.generate(prompt, { signal: controller.signal });
      if (controller.signal.aborted || disposed) return;
      seq += 1;
      const record = { id: `vt-${now().toString(36)}-${seq}`, prompt, model: result.model, batch: ofBatch, at: now(), ms: result.ms };
      generated += 1;
      lastMs = result.ms;
      failures = 0;
      lastError = "";
      if (enabled) await onImage(record, result.png);
    } catch (error) {
      if (controller.signal.aborted || disposed) return;
      if (error instanceof ImageRateLimitError) {
        nextAllowedAt = Math.max(nextAllowedAt, now() + error.retryAfterMs);
        lastError = error.message;
      } else {
        failures += 1;
        nextAllowedAt = Math.max(nextAllowedAt, now() + Math.min(300_000, 15_000 * 2 ** (failures - 1)));
        lastError = error?.message || String(error);
        warn(`visual thoughts: ${lastError}`);
      }
    } finally {
      inflight.delete(controller);
      if (!inflight.size) setActivity("idle");
      else try { onChange(status()); } catch {}
      maybePaint();
    }
  }

  function remember(prompt) {
    if (!prompt) return;
    recentPrompts.push(prompt);
    if (recentPrompts.length > 5) recentPrompts.shift();
  }

  function status() {
    return {
      enabled,
      activity,
      inRun,
      runCount,
      generated,
      lastMs,
      lastError,
      provider: currentProvider?.describe?.() || "",
      waitMs: Math.max(0, nextAllowedAt - now()),
      prompt: recentPrompts.at(-1) || "",
    };
  }

  return {
    status,
    get batch() { return batch; },
    /** Output while the agent works: `kind` thinking | text | tool | result | user. */
    output(kind, text) {
      if (!enabled || disposed) return;
      digest.add(kind, text);
      maybePaint();
    },
    /** An agent run begins (a prompt): its paintings form a new batch. */
    runStart() {
      inRun = true;
      flushAfterRun = false;
      runCount = 0;
      batch += 1;
      return batch;
    },
    /** The run ended: one last painting from what is left, if enough. */
    runEnd() {
      inRun = false;
      if (enabled && runCount < config.maxPerRun && digest.pending >= Math.max(1, config.firstChars)) {
        flushAfterRun = true;
        maybePaint();
      }
    },
    setEnabled(next) {
      if (disposed) return;
      enabled = Boolean(next);
      if (enabled) { maybePaint(); return; }
      for (const controller of inflight) controller.abort();
      if (wakeTimer) timers.clearTimeout(wakeTimer);
      wakeTimer = null;
      setActivity("idle");
    },
    get enabled() { return enabled; },
    /** Paint from the current output now, regardless of thresholds (not of rate limits). */
    paintNow() { return maybePaint({ force: true }); },
    /** Earlier prompts (a restored session's), so new ones vary from them. */
    remember,
    setProvider(next) { if (next) currentProvider = next; },
    dispose() {
      if (disposed) return;
      this.setEnabled(false);
      disposed = true;
    },
  };
}
