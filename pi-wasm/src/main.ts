// pi-wasm S1 feasibility spike (epic bd-f76cee, bd-11daa5).
//
// Goal: prove the Pi agent LOOP constructs in a browser with NO Node runtime.
//
// Approach (Path A, per S1 derisk notes pi-wasm:sdk-node-surface-findings +
// pi-wasm-recon): build directly on the import-time browser-clean `.` entries
// of @earendil-works/pi-agent-core (the `Agent` loop) and @earendil-works/pi-ai
// (providers), BYPASSING the node-coupled @earendil-works/pi-coding-agent barrel
// and its createAgentSession()/tools/*. The `Agent` constructor takes injectable
// seams — streamFn (provider call), getApiKey (runtime keys from a settings
// screen), and initialState.tools (reconstructed over a browser ExecutionEnv in
// S2/S4) — so the core loop needs zero node:fs / node:child_process.

import { Agent } from "@earendil-works/pi-agent-core";
import * as piAi from "@earendil-works/pi-ai";

const out = document.getElementById("out") as HTMLPreElement;
const log = (s = "") => {
  out.textContent += s + "\n";
};

log("pi-wasm S1 feasibility spike — in-browser Pi agent loop");
log("=".repeat(56));
log("");

type SpikeResult = { ok: boolean; error?: string; detail?: Record<string, unknown> };
let result: SpikeResult;

try {
  log(`[import] @earendil-works/pi-agent-core   Agent = ${typeof Agent}`);
  const aiKeys = Object.keys(piAi);
  log(`[import] @earendil-works/pi-ai           ${aiKeys.length} named exports`);
  const hasProviderFactory = typeof (piAi as Record<string, unknown>).createProvider === "function";
  const hasModelsFactory = typeof (piAi as Record<string, unknown>).createModels === "function";
  log(`[import] pi-ai.createProvider            ${hasProviderFactory ? "present" : "absent"}`);
  log(`[import] pi-ai.createModels              ${hasModelsFactory ? "present" : "absent"}`);
  log("");

  // Minimal in-browser construct: injectable seams only, no node deps.
  const agent = new Agent({
    // Runtime key resolver — in the real app this reads the settings screen.
    getApiKey: async () => undefined,
  });
  const unsubscribe = agent.subscribe(() => {
    /* no-op: proves the event bus wires up in-browser */
  });

  const stateKeys = Object.keys(agent.state ?? {});
  const messages = (agent.state as { messages?: unknown[] })?.messages ?? [];
  const tools = (agent.state as { tools?: unknown[] })?.tools ?? [];

  log("[construct] new Agent({ getApiKey }) ......... OK");
  log(`[state] keys: ${stateKeys.join(", ")}`);
  log(`[state] messages=${messages.length}  tools=${tools.length}`);
  log(`[events] agent.subscribe(...) ................ OK`);
  unsubscribe();
  log("");
  log("RESULT: the Pi agent loop CONSTRUCTS in-browser on");
  log("        pi-agent-core + pi-ai (barrel bypassed, zero node polyfills). PASS");
  out.classList.add("pass");
  result = { ok: true, detail: { aiExports: aiKeys.length, stateKeys, tools: tools.length } };
} catch (err) {
  const e = err as Error;
  log("");
  log(`RESULT: FAIL — ${e.message}`);
  log(e.stack ?? "");
  out.classList.add("fail");
  result = { ok: false, error: String(e) };
}

// Expose for the Playwright harness (S8) to assert on.
(globalThis as Record<string, unknown>).__PI_WASM_SPIKE__ = result;
