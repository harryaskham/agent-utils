// pi-wasm — fully in-browser Pi agent loop.
//
// S1 (bd-11daa5): prove the agent loop CONSTRUCTS in the browser (Path A,
//   pi-agent-core + pi-ai, barrel bypassed, zero node polyfills).
// S3 (bd-cbf86f): the browser provider/network layer — a REAL streaming model
//   call end-to-end against a CORS-enabled OpenAI-compatible endpoint (the
//   LiteLLM proxy), rendered live, using a RUNTIME key (never hard-coded).

import { Agent } from "@earendil-works/pi-agent-core";
import * as piAi from "@earendil-works/pi-ai";
import {
  createBrowserAgent,
  currentAssistantText,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL_ID,
} from "./provider.js";

const out = document.getElementById("out") as HTMLPreElement;
const streamOut = document.getElementById("stream") as HTMLPreElement;
const log = (s = "") => {
  out.textContent += s + "\n";
};

// ---------------------------------------------------------------------------
// S1 construct proof (preserved from the S1 spike; sets __PI_WASM_SPIKE__).
// ---------------------------------------------------------------------------
type SpikeResult = { ok: boolean; error?: string; detail?: Record<string, unknown> };
let spike: SpikeResult;
try {
  const aiKeys = Object.keys(piAi);
  const agent = new Agent({ getApiKey: async () => undefined });
  const unsubscribe = agent.subscribe(() => {});
  const stateKeys = Object.keys(agent.state ?? {});
  unsubscribe();
  log("pi-wasm — in-browser Pi agent loop");
  log("=".repeat(48));
  log(`[S1] pi-agent-core Agent = ${typeof Agent}`);
  log(`[S1] pi-ai named exports = ${aiKeys.length}`);
  log(`[S1] new Agent({...}) constructs .......... OK`);
  log(`[S1] state keys: ${stateKeys.join(", ")}`);
  spike = { ok: true, detail: { aiExports: aiKeys.length, stateKeys } };
} catch (err) {
  const e = err as Error;
  log(`[S1] construct FAILED: ${e.message}`);
  out.classList.add("fail");
  spike = { ok: false, error: String(e) };
}
(globalThis as Record<string, unknown>).__PI_WASM_SPIKE__ = spike;

// ---------------------------------------------------------------------------
// S3 streaming provider layer.
// ---------------------------------------------------------------------------
type S3Result = {
  ok: boolean;
  text?: string;
  model?: string;
  baseUrl?: string;
  error?: string;
  chunks?: number;
};

const params = new URLSearchParams(location.search);
const KEY_STORAGE = "pi-wasm-key";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const keyInput = el<HTMLInputElement>("key");
const modelInput = el<HTMLInputElement>("model");
const baseUrlInput = el<HTMLInputElement>("baseUrl");
const promptInput = el<HTMLTextAreaElement>("prompt");
const runBtn = el<HTMLButtonElement>("run");
const status = el<HTMLSpanElement>("status");
const resultEl = el<HTMLPreElement>("result");

/** Mirror the S3 result into the DOM + document.title so headless --dump-dom can read it (never includes the key). */
function publishResult(result: S3Result): void {
  (globalThis as Record<string, unknown>).__PI_WASM_S3__ = result;
  resultEl.textContent = JSON.stringify(result);
  document.title = result.ok ? "pi-wasm S3:ok" : "pi-wasm S3:fail";
}

// Seed defaults (URL params override stored values; nothing is hard-coded in source).
modelInput.value = params.get("model") ?? DEFAULT_MODEL_ID;
baseUrlInput.value = params.get("baseUrl") ?? DEFAULT_BASE_URL;
promptInput.value = params.get("prompt") ?? "Say hello in exactly three words.";

/**
 * Resolve the runtime key WITHOUT hard-coding it: URL `?key=`, a pre-set
 * `window.__PI_WASM_KEY__` global (headless injection), the key input field,
 * or a previously-saved localStorage value. This is the S6 settings-screen seam.
 */
function resolveKey(): string | undefined {
  const fromUrl = params.get("key") ?? undefined;
  const fromGlobal = (globalThis as { __PI_WASM_KEY__?: string }).__PI_WASM_KEY__;
  const fromField = keyInput.value.trim() || undefined;
  const fromStore = localStorage.getItem(KEY_STORAGE) ?? undefined;
  return fromUrl || fromGlobal || fromField || fromStore;
}

// Prefill the (masked) key field from storage so a returning user keeps their key.
{
  const existing = localStorage.getItem(KEY_STORAGE);
  if (existing && !keyInput.value) keyInput.value = existing;
}

let running = false;

async function runStreamingCall(): Promise<void> {
  if (running) return;
  running = true;
  runBtn.disabled = true;
  streamOut.textContent = "";
  streamOut.classList.remove("pass", "fail");

  const key = resolveKey();
  const modelId = modelInput.value.trim() || DEFAULT_MODEL_ID;
  const baseUrl = baseUrlInput.value.trim() || DEFAULT_BASE_URL;
  const prompt = promptInput.value.trim() || "Say hello in exactly three words.";

  if (!key) {
    status.textContent = "no key — enter a runtime API key";
    streamOut.classList.add("fail");
    streamOut.textContent = "No API key provided. Enter one above (kept only in this browser).";
    publishResult({ ok: false, error: "no_api_key" });
    running = false;
    runBtn.disabled = false;
    return;
  }

  // Persist as a runtime key (browser-only), mirroring the future settings screen.
  localStorage.setItem(KEY_STORAGE, key);
  status.textContent = `streaming from ${baseUrl} (${modelId})…`;

  let chunks = 0;
  const render = () => {
    const text = currentAssistantText(agent);
    streamOut.textContent = text;
  };

  const agent = createBrowserAgent({
    modelId,
    baseUrl,
    getApiKey: () => resolveKey(),
    systemPrompt: "You are a concise assistant running fully in the browser via pi-wasm.",
  });
  const unsubscribe = agent.subscribe(() => {
    chunks++;
    render();
  });

  try {
    await agent.prompt(prompt);
    await agent.waitForIdle();
    unsubscribe();
    const text = currentAssistantText(agent);
    const errorMessage = (agent.state as { errorMessage?: string }).errorMessage;
    const ok = !errorMessage && text.trim().length > 0;
    render();
    if (ok) {
      streamOut.classList.add("pass");
      status.textContent = `done — streamed ${chunks} update(s)`;
    } else {
      streamOut.classList.add("fail");
      status.textContent = `failed: ${errorMessage ?? "empty response"}`;
    }
    publishResult({
      ok,
      text,
      model: modelId,
      baseUrl,
      chunks,
      error: ok ? undefined : errorMessage ?? "empty_response",
    });
  } catch (err) {
    unsubscribe();
    const e = err as Error;
    streamOut.classList.add("fail");
    streamOut.textContent = `ERROR: ${e.message}\n${e.stack ?? ""}`;
    status.textContent = "failed (exception)";
    publishResult({ ok: false, model: modelId, baseUrl, chunks, error: String(e) });
  } finally {
    running = false;
    runBtn.disabled = false;
  }
}

runBtn.addEventListener("click", () => void runStreamingCall());

log("");
log("[S3] provider layer ready. Enter a runtime key and press Run,");
log("[S3] or load with ?key=…&autorun=1 for a scripted check.");

// Headless / scripted end-to-end check for S8.
if (params.get("autorun") === "1") {
  void runStreamingCall();
}
