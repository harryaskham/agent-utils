// Bounded, redacted HTTP primitives shared by native speech providers.
import { combineTimeoutSignal } from "./bounded-exec.js";

export const MAX_SPEECH_AUDIO_BYTES = 64 * 1024 * 1024;
export const MAX_SPEECH_JSON_BYTES = 1024 * 1024;

export function speechUrl(value, suffix) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("speech: invalid HTTP endpoint"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("speech: endpoint must be HTTP(S) without credentials, query or fragment");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith(suffix)) {
    if (!path.endsWith("/v1")) path += "/v1";
    path += suffix;
  }
  url.pathname = path;
  return url.toString();
}

export async function readSpeechBody(response, maxBytes) {
  const length = Number(response.headers?.get?.("content-length"));
  if (length > maxBytes) { await response.body?.cancel?.(); throw new Error("speech: response exceeds size limit"); }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error("speech: response exceeds size limit");
    return bytes;
  }
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("speech: response exceeds size limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

export async function speechHttp(url, {
  fetchImpl = globalThis.fetch, signal, timeoutMs = 30000, label = "speech", json = false,
  maxBytes = json ? MAX_SPEECH_JSON_BYTES : MAX_SPEECH_AUDIO_BYTES, ...init
} = {}) {
  timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) >= 0 ? Number(timeoutMs) : 30000;
  const bound = combineTimeoutSignal(signal, timeoutMs);
  try {
    bound.signal.throwIfAborted();
    const response = await fetchImpl(url, { ...init, signal: bound.signal, redirect: "error" });
    if (!response?.ok) {
      try { await response?.body?.cancel?.(); } catch {}
      // Never echo upstream bodies: they may contain text, URLs or credentials.
      throw new Error(`${label} HTTP ${response?.status ?? "?"}; response body omitted`);
    }
    const bytes = await readSpeechBody(response, maxBytes);
    bound.signal.throwIfAborted();
    if (!json) return bytes;
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new Error(`${label}: invalid JSON response`); }
  } catch (error) {
    if (bound.isTimeout()) throw new Error(`${label} timed out after ${timeoutMs}ms`);
    if (bound.signal.aborted) throw new DOMException("Speech request aborted", "AbortError");
    if (/^(speech[: ]|azure-speech|openai speech|transcribe)/.test(error?.message || "")) throw error;
    throw new Error(`${label}: request failed; no automatic retry`);
  } finally { bound.cleanup(); }
}
