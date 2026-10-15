// Audio reel: explicit agent audio sharing with a terminal player.
//
//   audio_share  — agents share a clip (file path, base64 file bytes, or raw
//                  base64 PCM). It joins this session's reel and, unless
//                  disabled/incognito, is archived for `ag audio` / `ag sync`.
//   audio_reel   — play/pause/seek/volume/output/repeat/reel management.
//   /audio-reel  — interactive overlay (keyboard + mouse); /audio-* commands.
//                  (/audio itself belongs to audio-providers.)
//
// The passive widget shows now-playing/progress and the reel. Playback uses the
// standard output graph (Pulse by default, honouring PULSE_SERVER/PULSE_SINK)
// and can be routed per reel or per play. This is deliberately separate from
// TTS/narration/read/choices speech: it never touches mute policy, the shared
// speech queue, or the speech feed, and never captures speech audio.
import { existsSync } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ToolSchema as Type } from "./lib/tool-schema.js";
import { artifactIdentity, sharedAudioRoot } from "./lib/artifact-state.js";
import { sharedAudioEnabled } from "./lib/privacy.js";
import {
  archiveSharedAudio, decodeInlineAudio, materializeAudio, parseWavHeader, sniffAudio, MAX_SHARED_AUDIO_BYTES, PCM_ENCODINGS,
} from "./lib/shared-audio.js";
import {
  AudioPlayback, AUDIO_BACKENDS, describeAudioOutput, normalizeOutputPatch, probeDurationMs, resolveAudioOutput,
} from "./audio-reel/playback.js";
import {
  REEL_STATE_KEY, REPEAT_MODES, addItem, applyArchiveReceipts, clampIndex, clampVolume, createReelState, findItemIndex,
  formatClock, formatItemDetail, itemName, parseOutputArguments, parseRepeatArgument, parseSeekArgument,
  parseVolumeArgument, reelItemKey, removeItem, restoreReelState, serializeReelState,
} from "./audio-reel/state.js";
import { AudioReelView, REEL_KEY_HELP, agentLabel, playbackView, reelKeyAction, reelOverlayHeight, renderReelWidget } from "./audio-reel/view.js";

export const AUDIO_REEL_WIDGET_ID = "audio-reel";
export const AUDIO_REEL_ENTRY_TYPE = "agent-utils.audio-reel.v1";
const TOOL_NAMES = new Set(["audio_share", "audio_reel"]);
const MOUSE_ON = "\u001b[?1000s\u001b[?1006s\u001b[?1000h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1006r\u001b[?1000r";
const REEL_ACTIONS = ["status", "play", "pause", "resume", "toggle", "stop", "next", "previous", "seek", "volume", "output", "repeat", "show", "hide", "remove", "clear"];

const outputSchema = (description) => Type.Optional(Type.Object({
  backend: Type.Optional(Type.String({ enum: AUDIO_BACKENDS, description: "auto (Pulse when routed or off macOS, else CoreAudio/ffplay), pulse, sox or ffplay." })),
  server: Type.Optional(Type.String({ description: "Pulse server, e.g. tcp:host:4713. Empty string = local default instead of PULSE_SERVER." })),
  sink: Type.Optional(Type.String({ description: "Pulse sink / sox device name. Empty string = default sink instead of PULSE_SINK." })),
}, { description }));

function textContent(lines) {
  return [{ type: "text", text: lines.filter(Boolean).join("\n") }];
}
function argsText(args) {
  return (Array.isArray(args) ? args.join(" ") : String(args ?? "")).trim();
}
/// First token (optionally quoted) plus the remainder.
export function splitFirstArgument(input) {
  const text = String(input ?? "").trim();
  const quoted = /^(["'])(.*?)\1(?:\s+|$)/.exec(text);
  if (quoted) return [quoted[2], text.slice(quoted[0].length).trim()];
  const space = text.search(/\s/);
  return space < 0 ? [text, ""] : [text.slice(0, space), text.slice(space + 1).trim()];
}
function resolveUserPath(cwd, input, env) {
  let value = String(input || "").trim().replace(/^@/, "");
  const home = env.HOME || os.homedir();
  if (value === "~") value = home;
  else if (value.startsWith("~/")) value = path.join(home, value.slice(2));
  return path.resolve(cwd || process.cwd(), value);
}

export function createAudioReelExtension({ env = process.env, spawnImpl, execFileImpl, now, archive = archiveSharedAudio, platform = process.platform, onReady } = {}) {
  return function audioReelExtension(pi) {
    let state = createReelState();
    let activeCtx = null;
    let widgetTui = null;
    let widgetMounted = false;
    let overlay = null;
    let ticker = null;
    let playOutput = null; // one-off output for the clip currently owned by the player
    let muteRestore = 100;
    let autoStarts = [];
    let disposed = false;
    const player = new AudioPlayback({
      ...(spawnImpl ? { spawnImpl } : {}),
      ...(now ? { now } : {}),
      env: () => env,
      onEvent: (event) => { void onPlayerEvent(event); },
    });

    const snapshot = () => player.snapshot();
    const current = () => state.items[state.index];
    const effectiveOutput = (oneOff) => ({ ...state.config.output, ...(oneOff || {}) });
    const resolvedOutput = () => {
      try { return resolveAudioOutput(effectiveOutput(snapshot().key === current()?.key ? playOutput : null), env, platform); }
      catch { return null; }
    };
    const notify = (ctx, message, level = "info") => { try { (ctx || activeCtx)?.ui?.notify?.(message, level); } catch {} };
    const playablePath = (item) => {
      if (!item) return null;
      if (item.path && existsSync(item.path)) return item.path;
      if (item.archivePath && existsSync(item.archivePath)) return item.archivePath;
      return null;
    };
    const scratchDir = (ctx) => {
      let id = `pid-${process.pid}`;
      try {
        const file = ctx?.sessionManager?.getSessionFile?.();
        if (file) id = path.basename(file).replace(/\.jsonl?$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80) || id;
      } catch {}
      const uid = typeof process.getuid === "function" ? process.getuid() : "user";
      return path.join(env.PI_AUDIO_REEL_SCRATCH_DIR || path.join(os.tmpdir(), `pi-audio-reel-${uid}`), id);
    };

    // ---- rendering ---------------------------------------------------------
    const requestRender = () => {
      try { widgetTui?.requestRender?.(); } catch {}
      try { overlay?.requestRender?.(); } catch {}
    };
    const syncTicker = () => {
      const want = !disposed && snapshot().status === "playing" && (widgetMounted || overlay);
      if (want && !ticker) {
        ticker = setInterval(requestRender, 500);
        ticker.unref?.();
      } else if (!want && ticker) { clearInterval(ticker); ticker = null; }
    };
    const syncWidget = (ctx = activeCtx) => {
      if (!ctx?.hasUI || typeof ctx.ui?.setWidget !== "function") { syncTicker(); return; }
      const want = state.visible && state.items.length > 0;
      try {
        if (!want) {
          if (widgetMounted) ctx.ui.setWidget(AUDIO_REEL_WIDGET_ID, undefined);
          widgetMounted = false; widgetTui = null;
        } else if (ctx.mode && ctx.mode !== "tui") {
          // RPC clients receive static text; refreshed on state changes only.
          ctx.ui.setWidget(AUDIO_REEL_WIDGET_ID, renderReelWidget({ state, snapshot: snapshot(), width: 100, theme: null, hint: "audio_reel" }), { placement: env.PI_AUDIO_REEL_PLACEMENT === "aboveEditor" ? "aboveEditor" : "belowEditor" });
          widgetMounted = true;
        } else if (!widgetMounted) {
          ctx.ui.setWidget(AUDIO_REEL_WIDGET_ID, (tui, theme) => {
            widgetTui = tui;
            return {
              render: (width) => renderReelWidget({ state, snapshot: snapshot(), width, theme }),
              invalidate() {},
            };
          }, { placement: env.PI_AUDIO_REEL_PLACEMENT === "aboveEditor" ? "aboveEditor" : "belowEditor" });
          widgetMounted = true;
        }
      } catch {}
      requestRender();
      syncTicker();
    };
    const refresh = (ctx) => { if (ctx) activeCtx = ctx; syncWidget(); };

    const persist = () => {
      try { pi.appendEntry?.(AUDIO_REEL_ENTRY_TYPE, serializeReelState(state)); } catch {}
    };
    const details = (extra = {}) => ({ [REEL_STATE_KEY]: serializeReelState(state), player: snapshot(), ...extra });

    // ---- playback control --------------------------------------------------
    const ensureDuration = (item, filePath) => {
      if (Number.isFinite(item.durationMs) || item.probing) return;
      item.probing = true;
      void probeDurationMs(filePath, execFileImpl ? { execFileImpl } : {}).then((ms) => {
        delete item.probing;
        if (Number.isFinite(ms) && !Number.isFinite(item.durationMs)) { item.durationMs = ms; requestRender(); }
      });
    };

    async function playIndex(index, { positionMs = 0, output, ctx } = {}) {
      const item = state.items[index];
      if (!item) throw new Error(state.items.length ? `No clip ${index + 1}; the reel has ${state.items.length}` : "The audio reel is empty");
      const filePath = playablePath(item);
      if (!filePath) throw new Error(`${itemName(item)} is no longer on disk (scratch and archive copies are both missing)`);
      state.index = index;
      state.visible = true;
      playOutput = output ? normalizeOutputPatch(output) : (snapshot().key === item.key ? playOutput : null);
      ensureDuration(item, filePath);
      try {
        await player.play({ ...item, path: filePath }, { positionMs, volume: state.config.volume / 100, output: effectiveOutput(playOutput), label: itemName(item) });
      } finally { refresh(ctx); }
      return snapshot();
    }
    async function restartAt(positionMs, ctx) {
      // Volume/output/seek changes restart the owned pipeline at the cursor.
      return playIndex(state.index, { positionMs, ctx });
    }
    function pause(ctx) { const result = player.pause(); refresh(ctx); return result; }
    async function resume(ctx) {
      const snap = snapshot();
      if (snap.status === "playing") return snap;
      const item = current();
      const at = item && snap.key === item.key && ["paused", "error"].includes(snap.status) ? snap.positionMs : 0;
      return playIndex(state.index, { positionMs: at, ctx });
    }
    async function toggle(ctx) { return snapshot().status === "playing" && snapshot().key === current()?.key ? pause(ctx) : resume(ctx); }
    function stop(ctx) { const result = player.stop(); refresh(ctx); return result; }
    async function step(delta, ctx) {
      if (!state.items.length) throw new Error("The audio reel is empty");
      const wasPlaying = snapshot().status === "playing";
      const length = state.items.length;
      let next = state.index + delta;
      if (next < 0 || next >= length) next = state.config.repeat === "all" ? (next + length) % length : Math.max(0, Math.min(length - 1, next));
      if (wasPlaying) return playIndex(next, { ctx });
      if (snapshot().key && snapshot().key !== state.items[next]?.key) player.stop();
      state.index = next;
      refresh(ctx);
      return snapshot();
    }
    async function seek(positionMs, ctx) {
      const item = current();
      if (!item) throw new Error("The audio reel is empty");
      const snap = snapshot();
      if (snap.status === "playing" && snap.key === item.key) return restartAt(positionMs, ctx);
      // Cue the paused cursor; the next play/resume starts here.
      player.cue(item, positionMs);
      refresh(ctx);
      return snapshot();
    }
    async function setVolume(volume, ctx) {
      state.config.volume = clampVolume(volume);
      if (state.config.volume > 0) muteRestore = state.config.volume;
      const snap = snapshot();
      if (snap.status === "playing" && snap.key === current()?.key) await restartAt(snap.positionMs, ctx);
      else refresh(ctx);
      return state.config.volume;
    }
    async function setOutput({ patch = {}, inherit = [], reset = false }, ctx) {
      const next = reset ? {} : { ...state.config.output, ...normalizeOutputPatch(patch) };
      for (const key of inherit) delete next[key];
      resolveAudioOutput(next, env, platform); // validate before committing
      state.config.output = next;
      playOutput = null;
      const snap = snapshot();
      if (snap.status === "playing" && snap.key === current()?.key) await restartAt(snap.positionMs, ctx);
      else refresh(ctx);
      return resolveAudioOutput(state.config.output, env, platform);
    }
    function remove(index, ctx) {
      const item = state.items[index];
      if (!item) throw new Error("No such clip");
      if (snapshot().key === item.key) player.stop();
      removeItem(state, index);
      if (!state.items.length) state.visible = false;
      refresh(ctx);
      return item;
    }
    function clear(ctx) {
      player.stop();
      const removed = state.items.length;
      state = { ...createReelState(), config: state.config };
      refresh(ctx);
      return removed;
    }

    async function onPlayerEvent(event) {
      if (disposed) return;
      if (event.type === "error") {
        notify(null, `Audio reel: ${event.error}`, "warning");
        refresh();
        return;
      }
      if (event.type !== "ended") return;
      const index = state.items.findIndex((item) => item.key === event.key);
      const t = Date.now();
      autoStarts = autoStarts.filter((at) => t - at < 2000);
      const runaway = autoStarts.length >= 4; // zero-length clips must not spin
      try {
        if (index >= 0 && !runaway && state.config.repeat === "one") { autoStarts.push(t); await playIndex(index); return; }
        if (index >= 0 && !runaway && state.config.repeat === "all" && state.items.length) { autoStarts.push(t); await playIndex((index + 1) % state.items.length); return; }
      } catch (error) { notify(null, `Audio reel: ${error.message}`, "warning"); }
      refresh();
    }

    // ---- sharing -----------------------------------------------------------
    async function shareAudio(params, ctx, provenance) {
      const hasPath = typeof params.path === "string" && params.path.trim();
      const hasData = typeof params.data === "string" && params.data.trim();
      if (!!hasPath === !!hasData) throw new Error("Provide exactly one of path or data");
      let itemPath, mimeType, info = {}, bytes, inline;
      if (hasPath) {
        itemPath = resolveUserPath(ctx?.cwd, params.path, env);
        const handle = await open(itemPath, "r");
        try {
          const meta = await handle.stat();
          if (!meta.isFile()) throw new Error("Audio path is not a regular file");
          if (!meta.size || meta.size > MAX_SHARED_AUDIO_BYTES) throw new Error("Shared audio must be 1 byte–256 MiB");
          bytes = meta.size;
          const prefix = Buffer.alloc(Math.min(meta.size, 1024 * 1024));
          const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
          mimeType = sniffAudio(prefix.subarray(0, bytesRead), params.mimeType, itemPath).mimeType;
          const wav = mimeType === "audio/wav" ? parseWavHeader(prefix.subarray(0, bytesRead), meta.size) : null;
          if (wav) info = { durationMs: wav.durationMs, sampleRate: wav.sampleRate, channels: wav.channels };
        } finally { await handle.close(); }
      } else {
        inline = decodeInlineAudio({ data: params.data, mimeType: params.mimeType, pcm: params.pcm });
        mimeType = inline.mimeType;
        bytes = inline.bytes.length;
        const wav = mimeType === "audio/wav" ? parseWavHeader(inline.bytes.subarray(0, 1024 * 1024), inline.bytes.length) : null;
        if (wav) info = { durationMs: wav.durationMs, sampleRate: wav.sampleRate, channels: wav.channels };
        itemPath = await materializeAudio(inline.bytes, inline.extension, scratchDir(ctx));
      }
      const identity = artifactIdentity(pi, ctx, env);
      const key = reelItemKey(identity.session, provenance.eventId, itemPath);
      const label = params.label || (hasPath ? path.basename(itemPath) : `${params.pcm ? "pcm" : "clip"}-${key.slice(0, 6)}.${inline.extension}`);
      const meta = {
        label, title: params.title, description: params.description, mimeType,
        durationMs: info.durationMs ?? params.durationMs, sampleRate: info.sampleRate ?? params.pcm?.sampleRate, channels: info.channels ?? params.pcm?.channels,
      };
      const receipts = { root: sharedAudioEnabled(env) ? sharedAudioRoot(env) : null, count: 0, stored: [], errors: [] };
      let archived = null;
      if (sharedAudioEnabled(env)) {
        try {
          archived = await archive({ path: itemPath, ...meta }, { ...identity, kind: provenance.kind, tool: provenance.tool, eventId: provenance.eventId, index: 0, sourcePath: hasPath ? itemPath : undefined }, { env });
          if (archived) { receipts.count = 1; receipts.stored.push({ key, id: archived.id, path: archived.path, sha256: archived.sha256 }); }
        } catch (error) { receipts.errors.push(String(error?.message || error).slice(0, 300)); }
      }
      const index = addItem(state, {
        key, path: itemPath, archivePath: archived?.path, archiveId: archived?.id, ...meta, bytes, agent: identity.agent,
        origin: provenance.kind === "command" ? "operator" : "share", addedAt: Date.now(),
      });
      ensureDuration(state.items[index], itemPath); // compressed formats: ffprobe in the background
      if (params.show !== false || params.play) { state.visible = true; state.index = index; }
      let playback = null, playError = null;
      if (params.play) {
        try { playback = await playIndex(index, { output: params.output, ctx }); }
        catch (error) { playError = error.message; }
      } else refresh(ctx);
      return { item: state.items[index], index, receipts, playback, playError };
    }

    function shareSummary({ item, index, receipts, playback, playError }) {
      const detail = [formatClock(item.durationMs), formatItemDetail(item)].filter((part) => part && part !== "--:--").join(" · ");
      return [
        `Shared audio ${index + 1}/${state.items.length}: ${itemName(item)}${detail ? ` (${detail})` : ""}.`,
        receipts.stored[0] ? `Archived as ${receipts.stored[0].id} (synced by ag audio / ag sync).` : receipts.root === null ? "Archive disabled (incognito or PI_SHARED_AUDIO_ENABLED=0)." : "",
        receipts.errors[0] ? `Archive failed: ${receipts.errors[0]}` : "",
        playError ? `Playback failed: ${playError}` : playback ? `Playing via ${describeAudioOutput(playback.output || resolveAudioOutput(effectiveOutput(playOutput), env, platform))}.` : "Not playing; the operator can use /audio-reel or /audio-play.",
      ];
    }

    function statusLines() {
      if (!state.items.length) return ["Audio reel is empty. Agents add clips with audio_share; operators with /audio-add <path>."];
      const view = playbackView(state, snapshot());
      const output = resolvedOutput();
      return [
        `${view.status} · ${view.index + 1}/${state.items.length} ${itemName(view.item)} · ${formatClock(view.positionMs, view.durationMs)} / ${formatClock(view.durationMs)}${view.error ? ` · ${view.error}` : ""}`,
        `volume ${state.config.volume}% · repeat ${state.config.repeat} · ${output ? describeAudioOutput(output) : "invalid output"}${state.visible ? "" : " · widget hidden"}`,
        ...state.items.map((item, i) => `${i === state.index ? "›" : " "} ${i + 1}. ${itemName(item)} · ${formatClock(item.durationMs)} · ${agentLabel(item)}`),
      ];
    }

    // ---- lifecycle ---------------------------------------------------------
    pi.on("session_start", async (_event, ctx) => {
      disposed = false;
      activeCtx = ctx;
      widgetMounted = false;
      widgetTui = null;
      state = createReelState();
      const receipts = [];
      let entries = [];
      try { entries = ctx.sessionManager?.getBranch?.() || []; } catch {}
      for (const entry of entries) {
        const data = entry?.type === "custom" && entry.customType === AUDIO_REEL_ENTRY_TYPE
          ? entry.data
          : entry?.type === "message" && entry.message?.role === "toolResult" && TOOL_NAMES.has(entry.message.toolName)
            ? entry.message.details?.[REEL_STATE_KEY]
            : null;
        if (data) restoreReelState(state, data);
        const stored = entry?.message?.details?.sharedAudio?.stored;
        if (Array.isArray(stored)) receipts.push(...stored);
      }
      applyArchiveReceipts(state, receipts);
      const before = state.items.length;
      state.items = state.items.filter((item) => playablePath(item));
      if (state.items.length !== before) state.index = clampIndex(state.index, state.items.length);
      if (!state.items.length) state.visible = false;
      syncWidget(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      disposed = true;
      player.dispose();
      if (ticker) { clearInterval(ticker); ticker = null; }
      try { overlay?.done?.(); } catch {}
      overlay = null;
      try { if (widgetMounted && ctx?.hasUI) ctx.ui.setWidget(AUDIO_REEL_WIDGET_ID, undefined); } catch {}
      widgetMounted = false;
      widgetTui = null;
      activeCtx = null;
    });

    // ---- tools -------------------------------------------------------------
    pi.registerTool({
      name: "audio_share",
      label: "Share Audio",
      description: "Intentionally share an audio clip (a song you made, an example sound, a recording) with the operator. Accepts a file path (WAV/MP3/OGG/Opus/FLAC/M4A/AAC/WebM/AIFF/MIDI) or base64 data: encoded file bytes, or raw PCM when pcm is set (wrapped as WAV). Adds it to the session audio reel (terminal player) and archives it for fleet sync (ag audio, ag dash Audio tab). Does not autoplay unless play=true. Not for speech: use TTS tools for talking.",
      promptSnippet: "Share an audio clip (file path or base64/PCM) into the operator's audio reel player and the synced fleet audio archive.",
      promptGuidelines: [
        "Use audio_share only for audio you deliberately want the operator to hear or keep (songs, sound examples, recordings); never for ordinary speech.",
        "Prefer path for existing files. For generated samples, pass base64 data with pcm {sampleRate, channels, encoding} for raw PCM, or mimeType for encoded bytes.",
        "Leave play unset unless the operator asked to hear it now; they control playback with /audio-reel or audio_reel.",
      ],
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Audio file path (~ and leading @ accepted)." })),
        data: Type.Optional(Type.String({ description: "Base64 (or data: URL) audio. Encoded file bytes, or raw PCM when pcm is set." })),
        mimeType: Type.Optional(Type.String({ description: "Declared type for data/path when sniffing is ambiguous, e.g. audio/mpeg. audio/L16 implies raw PCM." })),
        pcm: Type.Optional(Type.Object({
          sampleRate: Type.Optional(Type.Number({ description: "Samples per second. Default 24000." })),
          channels: Type.Optional(Type.Number({ description: "Interleaved channels 1–8. Default 1." })),
          encoding: Type.Optional(Type.String({ enum: PCM_ENCODINGS, description: "Little-endian sample format. Default s16le." })),
        }, { description: "Treat data as raw interleaved PCM and wrap it as WAV." })),
        label: Type.Optional(Type.String({ description: "Short display label. Defaults to the filename." })),
        title: Type.Optional(Type.String({ description: "Optional human title, e.g. a song name." })),
        description: Type.Optional(Type.String({ description: "Optional context shown in the player and archived metadata." })),
        durationMs: Type.Optional(Type.Number({ description: "Known duration when it cannot be probed." })),
        show: Type.Optional(Type.Boolean({ description: "Show the reel widget with this clip selected. Defaults to true." })),
        play: Type.Optional(Type.Boolean({ description: "Start playing immediately. Defaults to false." })),
        output: outputSchema("One-off output routing for play=true; does not change the reel default."),
      }),
      async execute(toolCallId, params, _signal, _onUpdate, ctx) {
        activeCtx = ctx || activeCtx;
        const shared = await shareAudio(params, ctx, { kind: "tool", tool: "audio_share", eventId: toolCallId });
        return {
          content: textContent(shareSummary(shared)),
          details: details({ added: shared.item, sharedAudio: shared.receipts, ...(shared.playError ? { playError: shared.playError } : {}) }),
        };
      },
    });

    pi.registerTool({
      name: "audio_reel",
      label: "Audio Reel",
      description: "Control the session audio reel player: status, play [index], pause, resume, toggle, stop, next, previous, seek (seconds), volume (0–150%), output (backend/server/sink routing), repeat (off/one/all), show/hide the widget, remove [index], clear. index is zero-based. Playback uses the standard output (Pulse by default) and never affects TTS.",
      promptSnippet: "Play, pause, seek, route output and manage clips in the operator's audio reel.",
      promptGuidelines: [
        "Use audio_reel to play or route shared clips only when the operator wants playback; they also control it with /audio-reel.",
      ],
      parameters: Type.Object({
        action: Type.String({ enum: REEL_ACTIONS, description: "Reel action." }),
        index: Type.Optional(Type.Number({ description: "Zero-based clip index for play/remove. Defaults to the current clip." })),
        position: Type.Optional(Type.Number({ description: "seek/play: position in seconds." })),
        relative: Type.Optional(Type.Boolean({ description: "seek: treat position as an offset from the current position." })),
        volume: Type.Optional(Type.Number({ description: "volume: percent 0–150." })),
        repeat: Type.Optional(Type.String({ enum: REPEAT_MODES, description: "repeat: off, one or all." })),
        output: outputSchema("output: new reel default (reset=true clears). play: one-off routing for this clip."),
        reset: Type.Optional(Type.Boolean({ description: "output: clear reel routing overrides." })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        activeCtx = ctx || activeCtx;
        const index = params.index === undefined ? state.index : Math.trunc(Number(params.index));
        const message = [];
        switch (params.action) {
          case "status": break;
          case "play": await playIndex(index, { positionMs: Math.max(0, Number(params.position) || 0) * 1000, output: params.output, ctx }); message.push(`Playing ${itemName(current())}.`); break;
          case "pause": pause(ctx); message.push("Paused."); break;
          case "resume": await resume(ctx); message.push(`Playing ${itemName(current())}.`); break;
          case "toggle": await toggle(ctx); message.push(snapshot().status === "playing" ? "Playing." : "Paused."); break;
          case "stop": stop(ctx); message.push("Stopped."); break;
          case "next": await step(1, ctx); message.push(`Selected ${itemName(current())}.`); break;
          case "previous": await step(-1, ctx); message.push(`Selected ${itemName(current())}.`); break;
          case "seek": {
            if (!Number.isFinite(Number(params.position))) throw new Error("seek requires position (seconds)");
            const base = params.relative ? snapshot().positionMs : 0;
            await seek(Math.max(0, base + Number(params.position) * 1000), ctx);
            message.push(`At ${formatClock(snapshot().positionMs)}.`);
            break;
          }
          case "volume": {
            if (!Number.isFinite(Number(params.volume))) throw new Error("volume requires volume (0–150)");
            message.push(`Volume ${await setVolume(Number(params.volume), ctx)}%.`);
            break;
          }
          case "output": {
            const resolved = await setOutput({ patch: params.output || {}, reset: params.reset === true }, ctx);
            message.push(`Output: ${describeAudioOutput(resolved)}.`);
            break;
          }
          case "repeat": state.config.repeat = parseRepeatArgument(params.repeat, state.config.repeat); refresh(ctx); message.push(`Repeat ${state.config.repeat}.`); break;
          case "show": if (!state.items.length) throw new Error("The audio reel is empty"); state.visible = true; refresh(ctx); break;
          case "hide": state.visible = false; refresh(ctx); break;
          case "remove": message.push(`Removed ${itemName(remove(index, ctx))} from the reel (archive copy kept).`); break;
          case "clear": message.push(`Cleared ${clear(ctx)} clips from the reel (archive copies kept).`); break;
          default: throw new Error(`Unknown audio_reel action '${params.action}'`);
        }
        return { content: textContent([...message, ...statusLines()]), details: details() };
      },
    });

    // ---- overlay -----------------------------------------------------------
    async function runOverlayAction(action, owner, ctx) {
      const view = owner.view;
      try {
        owner.message = "";
        switch (action.type) {
          case "close": owner.done?.(); return;
          case "select": view.select(state, action); break;
          case "scroll": view.listOffset = Math.max(0, view.listOffset + action.delta); break;
          case "playSelected": await playIndex(view.clampSelection(state), { ctx }); break;
          case "play":
            view.selected = action.index;
            if (action.index === state.index && snapshot().key === current()?.key && ["playing", "paused"].includes(snapshot().status)) await toggle(ctx);
            else await playIndex(action.index, { ctx });
            break;
          case "toggle": await toggle(ctx); break;
          case "stop": stop(ctx); break;
          case "next": await step(1, ctx); view.selected = state.index; break;
          case "previous": await step(-1, ctx); view.selected = state.index; break;
          case "seekBy": await seek(Math.max(0, snapshot().positionMs + action.deltaMs), ctx); break;
          case "seekFraction": {
            const duration = playbackView(state, snapshot()).durationMs;
            if (!Number.isFinite(duration)) throw new Error("Duration unknown; seek with ←/→");
            await seek(Math.round(duration * action.fraction), ctx);
            break;
          }
          case "volumeBy": await setVolume(state.config.volume + action.delta, ctx); break;
          case "mute": await setVolume(state.config.volume > 0 ? 0 : muteRestore || 100, ctx); break;
          case "repeat": state.config.repeat = parseRepeatArgument("", state.config.repeat); break;
          case "removeSelected": remove(view.clampSelection(state), ctx); if (!state.items.length) { owner.done?.(); return; } break;
          default: return;
        }
      } catch (error) { owner.message = error?.message || String(error); }
      refresh(ctx);
      owner.requestRender?.();
    }

    async function openOverlay(ctx) {
      activeCtx = ctx || activeCtx;
      if (!state.items.length) return notify(ctx, "Audio reel is empty. Agents share clips with audio_share; add one with /audio-add <path>.", "warning");
      if (!ctx?.hasUI || typeof ctx.ui?.custom !== "function" || (ctx.mode && ctx.mode !== "tui")) return notify(ctx, statusLines().join("\n"), "info");
      if (overlay) { overlay.requestRender?.(); return; }
      const owner = { view: new AudioReelView(), message: "" };
      owner.view.selected = state.index;
      overlay = owner;
      try {
        await ctx.ui.custom((tui, theme, _keybindings, done) => {
          owner.done = () => done(undefined);
          owner.requestRender = () => tui.requestRender();
          const mouse = tui.mode !== "fullscreen" && typeof tui.terminal?.write === "function";
          if (mouse) tui.terminal.write(MOUSE_ON);
          let released = false;
          owner.release = () => { if (released) return; released = true; if (mouse) { try { tui.terminal.write(MOUSE_OFF); } catch {} } };
          const size = () => ({ columns: tui.terminal?.columns || 80, rows: tui.terminal?.rows || 24 });
          syncTicker();
          return {
            render(width) {
              const { rows } = size();
              return owner.view.render({ state, snapshot: snapshot(), output: resolvedOutput(), width, height: reelOverlayHeight(rows, state.items.length), theme, message: owner.message });
            },
            invalidate() {},
            handleInput(data) {
              const { columns, rows } = size();
              const action = /^\u001b\[</.test(String(data ?? "")) ? owner.view.mouse(data, columns, rows) : reelKeyAction(data);
              if (!action || action.type === "ignored") return;
              void runOverlayAction(action, owner, ctx);
            },
            dispose() { owner.release?.(); },
          };
        }, { overlay: true, overlayOptions: { anchor: "bottom-left", col: 0, width: "100%", maxHeight: "100%", margin: 0 } });
      } catch (error) {
        notify(ctx, `Audio reel overlay failed: ${error?.message || String(error)}`, "warning");
      } finally {
        owner.release?.();
        if (overlay === owner) overlay = null;
        persist();
        refresh(ctx);
      }
    }

    // ---- commands ----------------------------------------------------------
    const command = (names, description, handler) => {
      for (const name of names) {
        pi.registerCommand(name, {
          description,
          handler: async (args, ctx) => {
            activeCtx = ctx || activeCtx;
            try { await handler(argsText(args), ctx); }
            catch (error) { notify(ctx, `/${names[0]}: ${error?.message || String(error)}`, "warning"); }
          },
        });
      }
    };
    const nowPlaying = (ctx) => notify(ctx, statusLines().slice(0, 2).join("\n"), "info");

    command(["audio-reel", "audio-player"], `Open the audio reel player (keyboard + mouse). ${REEL_KEY_HELP}`, async (_args, ctx) => openOverlay(ctx));
    command(["audio-play"], "Play the current clip, or a clip by number/name: /audio-play [n|name].", async (args, ctx) => {
      const index = findItemIndex(state, args);
      if (index < 0) throw new Error(`No clip matches '${args}'`);
      if (!args && snapshot().key === current()?.key && snapshot().status === "paused") await resume(ctx);
      else await playIndex(index, { ctx });
      nowPlaying(ctx);
    });
    command(["audio-pause"], "Pause playback (resume with /audio-resume or /audio-toggle).", async (_args, ctx) => { pause(ctx); nowPlaying(ctx); });
    command(["audio-resume"], "Resume the paused clip.", async (_args, ctx) => { await resume(ctx); nowPlaying(ctx); });
    command(["audio-toggle"], "Toggle play/pause for the current clip.", async (_args, ctx) => { await toggle(ctx); nowPlaying(ctx); });
    command(["audio-stop"], "Stop playback.", async (_args, ctx) => { stop(ctx); nowPlaying(ctx); });
    command(["audio-next"], "Select (and keep playing) the next clip.", async (_args, ctx) => { await step(1, ctx); nowPlaying(ctx); });
    command(["audio-prev", "audio-previous"], "Select (and keep playing) the previous clip.", async (_args, ctx) => { await step(-1, ctx); nowPlaying(ctx); });
    command(["audio-seek"], "Seek: /audio-seek 90 | 1:23 | +10 | -5 | 50%.", async (args, ctx) => {
      const view = playbackView(state, snapshot());
      await seek(parseSeekArgument(args, { positionMs: view.positionMs, durationMs: view.durationMs }), ctx);
      nowPlaying(ctx);
    });
    command(["audio-volume", "audio-vol"], "Show or set volume: /audio-volume 80 | +10 | -10 | mute (0–150%).", async (args, ctx) => {
      if (args) { await setVolume(parseVolumeArgument(args, state.config.volume), ctx); persist(); }
      notify(ctx, `Audio reel volume ${state.config.volume}%.`, "info");
    });
    command(["audio-repeat"], "Set repeat: /audio-repeat off | one | all (no argument cycles).", async (args, ctx) => {
      state.config.repeat = parseRepeatArgument(args, state.config.repeat);
      persist(); refresh(ctx);
      notify(ctx, `Audio reel repeat ${state.config.repeat}.`, "info");
    });
    command(["audio-output"], "Show or route reel output: /audio-output backend=pulse|sox|ffplay|auto server=tcp:host:4713 sink=name (default = explicit default, inherit = follow PI_AUDIO_*/PULSE_*), or reset.", async (args, ctx) => {
      const parsed = parseOutputArguments(args);
      if (parsed.show) {
        const output = resolvedOutput();
        return notify(ctx, `Audio reel output: ${output ? describeAudioOutput(output) : "invalid"}${Object.keys(state.config.output).length ? ` (overrides: ${JSON.stringify(state.config.output)})` : " (inherited)"}`, "info");
      }
      const resolved = await setOutput(parsed, ctx);
      persist();
      notify(ctx, `Audio reel output: ${describeAudioOutput(resolved)}.`, "info");
    });
    command(["audio-add"], "Add an audio file to the reel (and archive it): /audio-add <path> [label].", async (args, ctx) => {
      const [file, label] = splitFirstArgument(args);
      if (!file) throw new Error("usage: /audio-add <path> [label]");
      const shared = await shareAudio({ path: file, label: label || undefined }, ctx, { kind: "command", tool: "/audio-add", eventId: `audio-add:${Date.now()}:${Math.random().toString(36).slice(2, 8)}` });
      persist();
      notify(ctx, shareSummary(shared).filter(Boolean).join("\n"), shared.receipts.errors.length ? "warning" : "info");
    });
    command(["audio-remove"], "Remove a clip from the reel (archive kept): /audio-remove [n|name].", async (args, ctx) => {
      const index = findItemIndex(state, args);
      if (index < 0) throw new Error(`No clip matches '${args}'`);
      const item = remove(index, ctx);
      persist();
      notify(ctx, `Removed ${itemName(item)} from the reel.`, "info");
    });
    command(["audio-show"], "Show the audio reel widget.", async (_args, ctx) => {
      if (!state.items.length) throw new Error("The audio reel is empty");
      state.visible = true; persist(); refresh(ctx);
    });
    command(["audio-hide"], "Hide the audio reel widget (playback continues).", async (_args, ctx) => { state.visible = false; persist(); refresh(ctx); });
    command(["audio-clear"], "Stop and clear the reel (archive copies are kept).", async (_args, ctx) => {
      const removed = clear(ctx); persist();
      notify(ctx, `Cleared ${removed} clips from the audio reel.`, "info");
    });
    command(["audio-status"], "Show reel, playback and output status.", async (_args, ctx) => notify(ctx, `${statusLines().join("\n")}\n${REEL_KEY_HELP}`, "info"));

    // Test/introspection seam (not a public API).
    onReady?.({ state: () => state, player, playIndex, pause, resume, toggle, seek, setVolume, setOutput, step, openOverlay, runOverlayAction });
  };
}

export default createAudioReelExtension();
