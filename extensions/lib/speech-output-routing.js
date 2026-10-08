// One session-scoped routing authority shared by the speech extensions. Modes
// overlay output options only: no provider/voice/default-device/global mute edits.
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createPulseSinks, pulseServer } from "./pulse-sinks.js";

const REGISTRY = Symbol.for("agent-utils.speech-output-routing.fallback.v1");
const DISCOVER = "agent-utils:speech-output-routing.v1";
const own = (value, key) => Object.hasOwn(value || {}, key);
const PULSE = new Set(["pulse", "pulseaudio", "pacat", "paplay"]);

export function soloSinkIdentity({ agent, session, host } = {}, fallback = randomUUID()) {
  const label = String(agent || session || fallback).replace(/[\p{C}]/gu, " ").trim().slice(0, 120) || "session";
  const stem = label.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^[_ .-]+|[_ .-]+$/g, "").slice(0, 70) || "session";
  const suffix = createHash("sha256").update(`${host || ""}\0${session || fallback}\0${label}`).digest("hex").slice(0, 10);
  return { name: `pi_${stem}_${suffix}`, description: `pi - ${label}` };
}

export function focusOutputOptions(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("tts.focus must be an output-routing object");
  const allowed = new Set(["backend", "server", "sink", "device", "pan"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`tts.focus: unsupported output setting '${key}'`);
  if (own(value, "sink") && own(value, "device") && value.sink !== value.device) throw new Error("tts.focus: sink and device must agree");
  const result = { ...value, device: value.device ?? value.sink ?? "vsink_focus" };
  delete result.sink;
  if (typeof result.device !== "string" || !result.device || result.device.length > 255 || /[\x00-\x1f\x7f]/.test(result.device)) throw new Error("tts.focus: invalid sink/device");
  if (result.pan != null && (typeof result.pan !== "number" || !Number.isFinite(result.pan) || result.pan < -1 || result.pan > 1)) throw new Error("tts.focus: pan must be -1..1 or null");
  return result;
}

export function isPulseOutput(options = {}, env = options.env ?? process.env) {
  let backend = String(options.backend || env.PI_TTS_BACKEND || "pulse").toLowerCase();
  if (backend === "auto") backend = options.server || env.PULSE_SERVER || env.PULSE_SINK || process.platform !== "darwin" ? "pulse" : "coreaudio";
  return PULSE.has(backend);
}
function localProvider(options) {
  return options.provider !== "daemon" || options.playback === "local";
}

export function createSpeechOutputRouting({ env = process.env, pulse = createPulseSinks({ env }), cleanupWait = sleep } = {}) {
  let focus = false, solo = false, focusOptions = {}, allocation = null, disposed = false;
  let tail = Promise.resolve(), pendingTransitions = 0;
  const pendingEnsures = new Map();
  const fallbackIdentity = randomUUID();
  let lastError = null;
  const serial = (run) => {
    if (pendingTransitions >= 64) return Promise.reject(new Error("Too many pending speech routing changes"));
    pendingTransitions++;
    const work = tail.then(run);
    tail = work.catch(() => {});
    return work.finally(() => { pendingTransitions--; });
  };
  const target = (options, override = {}) => {
    const base = { ...options, ...override };
    base.server = pulseServer(base.server, options.env ?? env);
    base.device = base.device ?? base.sink ?? (options.env ?? env).PULSE_SINK ?? "@DEFAULT_SINK@";
    return base;
  };
  const assertPulse = (options) => {
    if (!localProvider(options)) throw new Error("Focus/solo requires local Pulse playback; daemon-owned playback is excluded (use playback=local)");
    if (!isPulseOutput(options, options.env ?? env)) throw new Error("Focus/solo requires backend=pulse");
  };
  const effective = (options) => {
    let selected = target(options, focus ? focusOptions : {});
    if (solo && allocation) selected = { ...selected, backend: "pulse", server: allocation.server, device: allocation.name };
    assertPulse(selected);
    return { ...selected, backend: "pulse" };
  };
  const ensure = async (spec) => {
    const key = JSON.stringify([spec.server, spec.name, spec.owner]);
    if (!pendingEnsures.has(key)) {
      const pending = Promise.resolve().then(() => pulse.ensure(spec)).finally(() => pendingEnsures.delete(key));
      pendingEnsures.set(key, pending);
    }
    return pendingEnsures.get(key);
  };
  const cleanup = async () => {
    const item = allocation;
    if (!item || solo || item.users > 0) return;
    if (item.shared || (!item.owned && !item.uncertain)) { allocation = null; return; }
    try {
      let result;
      for (const delay of [0, 75, 150, 300]) {
        if (delay) await cleanupWait(delay);
        result = await pulse.cleanup(item);
        if (result.state !== "busy") break;
      }
      if (["removed", "gone", "not-owned"].includes(result.state)) { allocation = null; lastError = null; }
      else lastError = result.state === "busy" ? "Solo cleanup pending: sink still has playback streams" : "Solo cleanup unconfirmed";
    } catch (error) { lastError = `Solo cleanup pending: ${error.message}`; }
  };
  const snapshot = () => ({
    focus, solo, mode: solo ? "solo" : focus ? "focus" : "normal",
    focusOutput: focus ? { ...focusOptions } : null,
    soloOutput: allocation ? { server: allocation.server, sink: allocation.name, description: allocation.description, moduleId: allocation.moduleId, owned: allocation.owned && !allocation.shared, activeRequests: allocation.users } : null,
    cleanupPending: !!allocation && !solo && !allocation.shared && (allocation.owned || allocation.uncertain),
    error: lastError,
  });

  return {
    snapshot,
    assertPlayable(options) {
      if (disposed) throw new Error("Speech routing session has ended");
      if (focus || solo) effective(options);
    },
    setMode(mode, enabled, { base = {}, focus: configuredFocus = {}, identity = {} } = {}) {
      if (!["focus", "solo"].includes(mode)) return Promise.reject(new Error("Unknown speech routing mode"));
      return serial(async () => {
        if (disposed) throw new Error("Speech routing session has ended");
        const on = enabled === undefined ? !(mode === "focus" ? focus : solo) : !!enabled;
        if (mode === "focus") {
          if (on) {
            const next = focusOutputOptions(configuredFocus);
            const route = target(base, next); assertPulse(route);
            await ensure({ server: route.server, name: route.device, description: "Pi focus" });
            // A solo sink deliberately reused as focus is now shared. Never
            // remove it later merely because this session originally made it.
            if (allocation?.server === route.server && allocation?.name === route.device) allocation.shared = true;
            focusOptions = next;
          }
          focus = on;
        } else if (!on) {
          solo = false;
          await cleanup();
        } else if (!solo) {
          const route = target(base, focus ? focusOptions : {}); assertPulse(route);
          const named = soloSinkIdentity(identity, fallbackIdentity);
          if (allocation && (allocation.name !== named.name || allocation.server !== route.server)) {
            await cleanup();
            if (allocation) throw new Error("Previous solo sink cleanup is still pending; retry /tts solo off before changing its target");
          }
          allocation ||= { ...named, server: route.server, owner: randomUUID(), moduleId: null, owned: false, uncertain: false, users: 0 };
          try {
            const found = await ensure(allocation);
            allocation.moduleId = found.owned ? Number(found.sink.owner_module) : null;
            allocation.owned = found.owned;
            allocation.uncertain = false;
            solo = true;
            lastError = null;
          } catch (error) {
            allocation.uncertain ||= error.creationUnconfirmed === true;
            lastError = error.message;
            throw error;
          }
        }
        return snapshot();
      });
    },
    async acquire(options = {}) {
      await tail;
      if (disposed) throw new Error("Speech routing session has ended");
      options.signal?.throwIfAborted();
      if (!focus && !solo) return { options, mode: "normal", release() {} };
      const mode = solo ? "solo" : "focus";
      const selected = effective(options);
      // Reserve before any await: solo-off cannot remove the selected sink
      // while this request is being prepared, queued or played on a peer.
      const held = solo ? allocation : null;
      if (held) held.users++;
      let released = false;
      const release = async () => {
        if (released) return; released = true;
        if (held) held.users--;
        if (held && !solo) {
          try { await serial(cleanup); } catch (error) { lastError = `Solo cleanup deferred: ${error.message}`; }
        }
      };
      try {
        if (held) {
          const found = await ensure(held);
          held.moduleId = found.owned ? Number(found.sink.owner_module) : null; held.owned = found.owned; held.uncertain = false;
        } else await ensure({ server: selected.server, name: selected.device, description: "Pi focus" });
        options.signal?.throwIfAborted();
        return { options: selected, mode, release };
      } catch (error) { if (held) held.uncertain ||= error.creationUnconfirmed === true; await release(); throw error; }
    },
    shutdown() {
      return serial(async () => { disposed = true; focus = false; solo = false; await cleanup(); return snapshot(); });
    },
  };
}

// Pi gives each extension a DIFFERENT facade over the shared event bus. Discover
// one versioned controller through that bus, never by facade object identity or
// a process-global mode flag. Standalone callers without a bus stay Pi-scoped.
export function bindSpeechOutputRouting(pi, options = {}) {
  const registry = globalThis[REGISTRY] ||= new WeakMap();
  const bus = pi.events;
  const hasBus = typeof bus?.emit === "function" && typeof bus?.on === "function";
  let entry;
  if (hasBus) {
    bus.emit(DISCOVER, { version: 1, accept(candidate) {
      if (!entry && candidate?.version === 1 && !candidate.closed && Number.isSafeInteger(candidate.references) && candidate.references >= 0
          && ["acquire", "setMode", "assertPlayable", "snapshot", "shutdown"].every(name => typeof candidate.routing?.[name] === "function")) entry = candidate;
    } });
  } else entry = registry.get(pi);
  if (!entry) {
    entry = { version: 1, routing: createSpeechOutputRouting(options), references: 0, closed: false };
    if (hasBus) {
      const discover = request => { if (!entry.closed && request?.version === 1 && typeof request.accept === "function") request.accept(entry); };
      const unsubscribe = bus.on(DISCOVER, discover);
      entry.unregister = typeof unsubscribe === "function" ? unsubscribe : () => bus.off?.(DISCOVER, discover);
    } else registry.set(pi, entry);
  }
  entry.references++;
  let released = false;
  return {
    routing: entry.routing,
    async release() {
      if (released) return; released = true;
      if (--entry.references === 0) {
        entry.closed = true;
        entry.unregister?.();
        if (registry.get(pi) === entry) registry.delete(pi);
        return entry.routing.shutdown();
      }
    },
  };
}

export async function withSpeechOutputRouting(routing, options, play) {
  if (!routing) return play(options, { mode: "normal" });
  const lease = await routing.acquire(options);
  try { return await play(lease.options, { mode: lease.mode }); }
  finally { await lease.release(); }
}

export function speechRoutingStatus(state) {
  const target = state.mode === "solo" ? state.soloOutput : state.mode === "focus" ? state.focusOutput : null;
  return `audio:${state.mode} · focus:${state.focus ? "on" : "off"} · solo:${state.solo ? "on" : "off"}${target ? ` · sink:${target.sink || target.device} · server:${own(target, "server") ? target.server || "default" : "inherit"}` : ""}${state.soloOutput && state.solo ? ` · solo-sink:${state.soloOutput.owned ? "created" : "reused"}` : ""}${state.cleanupPending ? ` · solo cleanup pending:${state.soloOutput.sink}` : ""}${state.error ? ` · ${state.error}` : ""}`;
}
