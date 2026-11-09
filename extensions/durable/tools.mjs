// Durable adaptor: agent-utils' TUI tool extensions in pi-daemon sessions (bd-74502e).
//
// List this file in a pi-daemon profile's `extensions:`. It runs these TUI
// extensions against a capturing `pi` (../lib/durable-tui-tools.js) and exposes
// the tools they register as one Durable extension, so pi-daemon sessions get the
// same tools as TUI Pi: search_web, xvfb_* and android_* (and the macOS-native
// tools on macOS). Slack's slack_* tools ship with Slick
// (share/slick/pi/pi-daemon/slick.mjs). Their commands, hooks and widgets are TUI
// behaviour and are not carried over; tool calls run in the session's directory,
// `pi.exec` through the session's own environment, and UI prompts are answered
// headlessly (confirmations decline).
//
// Every tool's schema is in each request's context, so rarely used families are
// opt-in: firecracker_vm_* and app_automation_* (the superseded remote-CDP work-app
// snapshots) load only when AGENT_UTILS_DURABLE_TOOLS names them. That variable
// edits the default families: `+name` (or a bare name) adds one and `-name`
// removes one, comma- or space-separated, e.g. `+firecracker-vm,-android`.
//
// Configuration comes from the worker's environment and the files each tool
// already reads (e.g. Pi's auth.json for search_web's Copilot token).

import { adaptTuiToolExtension } from "../lib/durable-tui-tools.js";

/** Every family this module can adapt, by name; loaded only when selected. */
export const TOOL_FAMILIES = {
  "web-search": () => import("../web-search.js"),
  "xvfb": () => import("../xvfb.js"),
  "android": () => import("../android.js"),
  "macos-native": () => import("../macos-native.js"),
  "firecracker-vm": () => import("../firecracker-vm.js"),
  "app-automation": () => import("../app-automation.js"),
};

/** The families pi-daemon sessions get without AGENT_UTILS_DURABLE_TOOLS. */
export function defaultToolFamilies(platform = process.platform) {
  return ["web-search", "xvfb", "android", ...(platform === "darwin" ? ["macos-native"] : [])];
}

/** The selected families, in TOOL_FAMILIES order, and the unknown names `spec` gave. */
export function selectToolFamilies(spec = "", platform = process.platform) {
  const selected = new Set(defaultToolFamilies(platform));
  const unknown = [];
  for (const token of String(spec).split(/[\s,]+/).filter(Boolean)) {
    const remove = token.startsWith("-");
    const name = token.replace(/^[+-]/, "");
    if (!Object.hasOwn(TOOL_FAMILIES, name)) unknown.push(name);
    else if (remove) selected.delete(name);
    else selected.add(name);
  }
  return { families: Object.keys(TOOL_FAMILIES).filter((name) => selected.has(name)), unknown };
}

const { families, unknown } = selectToolFamilies(process.env.AGENT_UTILS_DURABLE_TOOLS);
const tools = [];
const failures = unknown.map((name) => `${name}: unknown tool family`);
for (const name of families) {
  try {
    const { default: factory } = await TOOL_FAMILIES[name]();
    tools.push(...(await adaptTuiToolExtension(factory)));
  } catch (error) {
    // One extension failing to load leaves the others' tools.
    failures.push(`${name}: ${error?.message ?? error}`);
  }
}
if (failures.length) {
  try { process.stderr.write(`agent-utils durable tools: not loaded: ${failures.join("; ")}\n`); } catch {}
}

export const extension = { name: "agent-utils-tools", tools };
