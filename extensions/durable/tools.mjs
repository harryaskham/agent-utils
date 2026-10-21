// Durable adaptor: agent-utils' TUI tool extensions in pi-daemon sessions (bd-74502e).
//
// List this file in a pi-daemon profile's `extensions:`. It runs these TUI
// extensions against a capturing `pi` (../lib/durable-tui-tools.js) and exposes
// the tools they register as one Durable extension, so pi-daemon sessions get the
// same tools as TUI Pi: search_web, xvfb_*, firecracker_vm_*, app_automation_*,
// android_* and slack_* (and the macOS-native tools on macOS). Their commands,
// hooks and widgets are TUI behaviour and are not carried over; tool calls run in
// the session's directory, `pi.exec` through the session's own environment, and
// UI prompts are answered headlessly (confirmations decline).
//
// Configuration comes from the worker's environment and the files each tool
// already reads (e.g. Pi's auth.json for search_web's Copilot token).

import { adaptTuiToolExtension } from "../lib/durable-tui-tools.js";
import webSearch from "../web-search.js";
import xvfb from "../xvfb.js";
import firecrackerVm from "../firecracker-vm.js";
import appAutomation from "../app-automation.js";
import android from "../android.js";
import slack from "../slack-mcp.js";
import macosNative from "../macos-native.js";

/** The TUI extensions whose tools pi-daemon sessions get, by name. */
export const ADAPTED_EXTENSIONS = [
  ["web-search", webSearch],
  ["xvfb", xvfb],
  ["firecracker-vm", firecrackerVm],
  ["app-automation", appAutomation],
  ["android", android],
  ["slack-mcp", slack],
  ...(process.platform === "darwin" ? [["macos-native", macosNative]] : []),
];

const tools = [];
const failures = [];
for (const [name, factory] of ADAPTED_EXTENSIONS) {
  try {
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
