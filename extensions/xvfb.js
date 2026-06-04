// Opt-in Xvfb virtual-display orchestration (bd-a0e836).
//
// Exposes guarded tools to start/stop/inspect an Xvfb virtual display on a
// headless Linux node so display-dependent extensions (tendril capture, android
// screenshots, app-automation browser) can run where there is otherwise no
// DISPLAY. Building blocks (policy, free-display selection, command
// construction, spawn/teardown) live in ./lib/xvfb.js; this file is the thin
// tool + lifecycle surface.
//
// Guard rails: xvfb_ensure never spawns unless the node is genuinely headless
// (unless force=true), refuses if Xvfb is not on PATH, picks a unique :N to
// avoid colliding with other agents, and the spawned process is torn down on
// session_shutdown. On spawn it exports DISPLAY into process.env so subsequently
// launched display-dependent child processes inherit it.

import { ToolSchema as Type } from "./lib/tool-schema.js";

import { detectHeadlessDisplay, headlessDisplaySummary } from "./lib/headless-display.js";
import {
  planXvfb,
  spawnXvfb,
  xvfbPlanSummary,
  DEFAULT_XVFB_SCREEN,
} from "./lib/xvfb.js";

function textContent(lines) {
  return [{ type: "text", text: (Array.isArray(lines) ? lines : [lines]).filter(Boolean).join("\n") }];
}

function publicHandle(handle) {
  if (!handle) return null;
  return {
    display: handle.display,
    displayNumber: handle.displayNumber,
    pid: handle.pid,
    alive: Boolean(handle.child && handle.child.exitCode === null && handle.child.signalCode === null),
  };
}

export default function xvfbExtension(pi) {
  // At most one session-owned Xvfb at a time; keeping it simple avoids leaking
  // virtual displays across an agent's lifetime.
  const state = { handle: null };

  pi.on("session_shutdown", async () => {
    if (state.handle) {
      await state.handle.stop({ forceAfterMs: 2_000 }).catch(() => {});
      state.handle = null;
    }
  });

  pi.registerTool({
    name: "xvfb_ensure",
    label: "Xvfb Ensure",
    description:
      "Opt-in: spawn an Xvfb virtual display on a headless Linux node and export DISPLAY so display-dependent tools can run. Refuses if a display already exists (unless force) or if Xvfb is missing. Torn down on session shutdown.",
    promptSnippet:
      "Use on a headless Linux node to start a virtual X display before display-dependent actions (Tendril capture, Android screenshots, app-automation). Opt-in and guarded; never spawns unprompted.",
    parameters: Type.object({
      force: Type.optional(
        Type.boolean({ description: "Spawn even if a display is already present (native/WSLg). Defaults to false; by default an existing display is never overridden." }),
      ),
      screen: Type.optional(
        Type.string({ description: `Screen geometry WxHxDepth for Xvfb -screen 0. Defaults to ${DEFAULT_XVFB_SCREEN}.` }),
      ),
      command: Type.optional(
        Type.string({ description: "Xvfb binary name or path. Defaults to Xvfb (resolved on PATH)." }),
      ),
      dryRun: Type.optional(
        Type.boolean({ description: "Only report the spawn plan (binary, args, chosen DISPLAY) without spawning. Defaults to false." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // Idempotent: if this session already owns a live display, report it.
      if (state.handle && publicHandle(state.handle)?.alive) {
        const info = publicHandle(state.handle);
        return {
          content: textContent([`Xvfb already running for this session (DISPLAY=${info.display}, pid=${info.pid}).`]),
          details: { xvfb: info, reused: true },
        };
      }

      const plan = planXvfb({
        env: process.env,
        force: Boolean(params.force),
        screen: params.screen || DEFAULT_XVFB_SCREEN,
        command: params.command || "Xvfb",
        alreadySpawned: false,
      });

      if (!plan.ok) {
        return {
          content: textContent([xvfbPlanSummary(plan), headlessDisplaySummary()]),
          details: { xvfb: null, reason: plan.reason, hint: plan.hint },
        };
      }

      if (params.dryRun) {
        return {
          content: textContent([`(dry-run) ${xvfbPlanSummary(plan)}`]),
          details: { xvfb: null, plan: { display: plan.display, command: plan.command, args: plan.args, screen: plan.screen }, dryRun: true },
        };
      }

      const handle = spawnXvfb(plan, { exportEnv: process.env });
      state.handle = handle;
      const info = publicHandle(handle);
      return {
        content: textContent([
          `Spawned Xvfb (DISPLAY=${info.display}, pid=${info.pid}); exported DISPLAY for display-dependent tools.`,
          "It will be stopped automatically on session shutdown, or via xvfb_stop.",
        ]),
        details: { xvfb: info },
      };
    },
  });

  pi.registerTool({
    name: "xvfb_stop",
    label: "Xvfb Stop",
    description: "Stop the session-owned Xvfb virtual display (if any) and unset the exported DISPLAY.",
    promptSnippet: "Tear down the virtual X display started by xvfb_ensure.",
    parameters: Type.object({
      forceAfterMs: Type.optional(
        Type.number({ description: "Milliseconds to wait after SIGTERM before SIGKILL. Defaults to 2000." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!state.handle) {
        return { content: textContent(["No session-owned Xvfb is running."]), details: { xvfb: null } };
      }
      const info = publicHandle(state.handle);
      await state.handle.stop({ forceAfterMs: params.forceAfterMs ?? 2_000 }).catch(() => {});
      state.handle = null;
      return { content: textContent([`Stopped Xvfb (was DISPLAY=${info?.display}, pid=${info?.pid}).`]), details: { xvfb: info, stopped: true } };
    },
  });

  pi.registerTool({
    name: "xvfb_status",
    label: "Xvfb Status",
    description: "Report current display availability and any session-owned Xvfb virtual display.",
    promptSnippet: "Inspect display availability and whether a virtual X display is active for this session.",
    parameters: Type.object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const detection = detectHeadlessDisplay();
      const info = publicHandle(state.handle);
      const lines = [headlessDisplaySummary(detection)];
      lines.push(info && info.alive ? `Session Xvfb: running (DISPLAY=${info.display}, pid=${info.pid}).` : "Session Xvfb: none.");
      return { content: textContent(lines), details: { display: detection, xvfb: info } };
    },
  });
}

export const __xvfbTest = { publicHandle };
