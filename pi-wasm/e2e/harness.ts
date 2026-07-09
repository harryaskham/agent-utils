import { expect, type Page } from "@playwright/test";

// pi-wasm S8b (bd-caa275) — reusable browser-E2E harness seam.
//
// Extracted from the S8 full-loop spec so downstream exec-backend E2E specs
// (S14 v86 microVM, S15 remote relay) can drop a scenario into the SAME harness
// instead of duplicating it. The pattern: seed a live key via the S6 settings
// store, drive a scripted prompt through the S7 chat app, and assert a tool
// wrote the expected content to the browser VFS. A downstream backend supplies
// its own `assert` (e.g. v86 asserting `bash -c 'cat /work/<f>'` via a 9p
// bridge, instead of the default VFS readTextFile).

/** Default OpenAI-compatible endpoint (the CORS-enabled LiteLLM proxy). */
export const DEFAULT_BASE_URL = process.env.PIWASM_E2E_BASE_URL || "http://100.83.90.42:4000/v1";
export const DEFAULT_MODEL = process.env.PIWASM_E2E_MODEL || "gpt-4.1";

/** Runtime key from env (never committed). Empty string when absent → gate with test.skip(!resolveKey()). */
export function resolveKey(): string {
  return process.env.PIWASM_E2E_KEY || process.env.OPENAI_API_KEY || "";
}

// The test-only globals the S7 chat app exposes on `window` (see src/main.ts).
export interface SessionMeta {
  id: string;
  name: string;
  createdAt: number;
  modelId?: string;
}

export interface PiWasmGlobals {
  __PI_WASM__?: {
    ready?: boolean;
    send(text: string): Promise<void>;
    getTranscript(): { role: string; text: string }[];
    runToolsSmoke(): Promise<{ ok: boolean; steps: string[]; error?: string }>;
    env: {
      readTextFile(p: string): Promise<{ ok: boolean; value?: string; error?: unknown }>;
      exec(command: string): Promise<{
        ok: boolean;
        value?: { stdout: string; stderr: string; exitCode: number };
        error?: unknown;
      }>;
    };
    session?: { agent: { state: { tools: { name: string }[] } } };
  };
  __PI_WASM_S3__?: { ok: boolean; text?: string; model?: string; chunks?: number; error?: string };
  __PI_WASM_SETTINGS__?: { store: { save(v: unknown): Promise<void> } };
  // S11 keyed multi-session surface (bd-0dc0bc).
  __PI_WASM_SESSIONS__?: {
    list(): Promise<SessionMeta[]>;
    current(): SessionMeta | undefined;
    create(name?: string): Promise<SessionMeta | undefined>;
    switchTo(id: string): Promise<SessionMeta | undefined>;
    rename(id: string, name: string): Promise<void>;
    remove(id: string): Promise<SessionMeta | undefined>;
    setBackend(id: string, backendId: string): Promise<{ id?: string; backendId?: string; notice?: string }>;
    exportSession(id: string): Promise<unknown>;
    importSession(data: unknown): Promise<SessionMeta | undefined>;
  };
}

export interface LiveSettings {
  key: string;
  baseUrl?: string;
  model?: string;
  /** Provider id the key is filed under (default "openai"). */
  provider?: string;
}

/** The chat app's readiness selector. Other entry pages (e.g. /microvm-demo.html) pass their own. */
export const READY_SELECTOR = '#app[data-pi-wasm-ready="true"]';

/**
 * Wait for a page to finish its async boot. Defaults to the chat app's
 * `#app[data-pi-wasm-ready="true"]`; downstream entry pages pass their own
 * selector, e.g. `waitReady(page, '#microvm-app[data-microvm-ready="true"]')`.
 */
export async function waitReady(page: Page, selector: string = READY_SELECTOR): Promise<void> {
  await page.waitForSelector(selector);
}

/**
 * Navigate to an entry page and wait for its readiness selector. The build+serve
 * fixture is provided by playwright.config's webServer, so a scenario just picks
 * its page: `gotoReady(page, '/microvm-demo.html', '#microvm-app[data-microvm-ready="true"]')`.
 */
export async function gotoReady(page: Page, path = "/", selector: string = READY_SELECTOR): Promise<void> {
  await page.goto(path);
  await waitReady(page, selector);
}

/**
 * Put the chat app into LIVE mode: persist S6 settings (key/baseUrl/model) into
 * the IndexedDB settings store, then reload so the fresh boot reads them and
 * constructs a live session. Seeds AFTER the first ready + reloads to avoid the
 * addInitScript/IndexedDB-open race. `query` navigates the reload, e.g.
 * `?autorun=1&prompt=...`.
 */
export async function seedLiveSettings(page: Page, s: LiveSettings, query = ""): Promise<void> {
  const model = s.model ?? DEFAULT_MODEL;
  const provider = s.provider ?? "openai";
  const settings = {
    providerKeys: { [provider]: s.key },
    baseUrl: s.baseUrl ?? DEFAULT_BASE_URL,
    models: [{ id: model, provider }],
    selectedModelId: model,
    settings: {},
  };
  await page.goto("/");
  await waitReady(page);
  await page.evaluate(
    (v) => (window as unknown as PiWasmGlobals).__PI_WASM_SETTINGS__!.store.save(v),
    settings,
  );
  await page.goto(`/${query}`);
  await waitReady(page);
}

/** Drive one prompt through the chat app; resolves after the full turn (waitForIdle). */
export async function sendPrompt(page: Page, prompt: string): Promise<void> {
  await page.evaluate((p) => (window as unknown as PiWasmGlobals).__PI_WASM__!.send(p), prompt);
}

export async function getTranscript(page: Page): Promise<{ role: string; text: string }[]> {
  return page.evaluate(() => (window as unknown as PiWasmGlobals).__PI_WASM__!.getTranscript());
}

/** Assert an in-browser VFS file exists (via the app's exposed env) and contains a substring. */
export async function assertVfsFile(page: Page, path: string, expectedSubstring: string): Promise<void> {
  const read = await page.evaluate(
    (p) => (window as unknown as PiWasmGlobals).__PI_WASM__!.env.readTextFile(p),
    path,
  );
  expect(read.ok, `expected ${path} to exist in the VFS`).toBe(true);
  expect(read.value ?? "").toContain(expectedSubstring);
}

/** Assert at least one non-empty assistant message is in the transcript. */
export async function expectAssistantReply(page: Page): Promise<void> {
  const transcript = await getTranscript(page);
  expect(
    transcript.some((m) => m.role === "assistant" && m.text.trim().length > 0),
    "expected a non-empty assistant reply",
  ).toBe(true);
}

// ---- S11 keyed multi-session helpers (bd-0dc0bc surface) -------------------

export async function listSessions(page: Page): Promise<SessionMeta[]> {
  return page.evaluate(() => (window as unknown as PiWasmGlobals).__PI_WASM_SESSIONS__!.list());
}

export async function createSession(page: Page, name?: string): Promise<SessionMeta> {
  const meta = await page.evaluate(
    (n) => (window as unknown as PiWasmGlobals).__PI_WASM_SESSIONS__!.create(n),
    name,
  );
  if (!meta) throw new Error("createSession returned no meta");
  return meta;
}

export async function switchSession(page: Page, id: string): Promise<void> {
  await page.evaluate((i) => (window as unknown as PiWasmGlobals).__PI_WASM_SESSIONS__!.switchTo(i), id);
}

export async function removeSession(page: Page, id: string): Promise<void> {
  await page.evaluate((i) => (window as unknown as PiWasmGlobals).__PI_WASM_SESSIONS__!.remove(i), id);
}

/** Active session id (via the S11 sessions surface). */
export async function currentSessionId(page: Page): Promise<string> {
  const id = await page.evaluate(() => (window as unknown as PiWasmGlobals).__PI_WASM_SESSIONS__!.current()?.id);
  if (!id) throw new Error("no current session id");
  return id;
}

// ---- S11.1 per-session exec-backend helpers (bd-36c379 surface) ------------

export async function setSessionBackend(
  page: Page,
  id: string,
  backendId: string,
): Promise<{ id?: string; backendId?: string; notice?: string }> {
  return page.evaluate(
    ([i, b]) => (window as unknown as PiWasmGlobals).__PI_WASM_SESSIONS__!.setBackend(i, b),
    [id, backendId] as const,
  );
}

/** Run a shell command through the active session's exec backend (returns the Result). */
export async function execInSession(
  page: Page,
  command: string,
): Promise<{ ok: boolean; value?: { stdout: string; stderr: string; exitCode: number }; error?: unknown }> {
  return page.evaluate((cmd) => (window as unknown as PiWasmGlobals).__PI_WASM__!.env.exec(cmd), command);
}

/** Tool names on the active session's agent (e.g. to check whether "bash" is present). */
export async function sessionToolNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tools = (window as unknown as PiWasmGlobals).__PI_WASM__!.session?.agent.state.tools ?? [];
    return tools.map((t) => t.name);
  });
}

export interface ToolLoopScenario {
  /** Runtime key (live mode). */
  key: string;
  /** Scripted prompt that should make the agent call a tool. */
  prompt: string;
  /**
   * Backend-specific assertion that the tool actually did its work. Defaults to
   * a VFS file check when `assertFile` is given. A downstream exec-backend
   * (v86 microVM, remote relay) can pass a custom `assert` instead.
   */
  assert?: (page: Page) => Promise<void>;
  /** Convenience: assert this VFS file contains this substring (used when `assert` is omitted). */
  assertFile?: { path: string; contains: string };
  baseUrl?: string;
  model?: string;
  provider?: string;
}

/**
 * The pluggable full-loop scenario: seed live settings → run a scripted prompt →
 * assert a tool did its work → assert a streamed assistant reply. Downstream
 * exec-backend specs (S14/S15) import this and supply their own `assert`.
 */
export async function runToolLoopScenario(page: Page, s: ToolLoopScenario): Promise<void> {
  await seedLiveSettings(page, { key: s.key, baseUrl: s.baseUrl, model: s.model, provider: s.provider });
  await sendPrompt(page, s.prompt);
  if (s.assert) {
    await s.assert(page);
  } else if (s.assertFile) {
    await assertVfsFile(page, s.assertFile.path, s.assertFile.contains);
  } else {
    throw new Error("runToolLoopScenario requires either `assert` or `assertFile`");
  }
  await expectAssistantReply(page);
}
