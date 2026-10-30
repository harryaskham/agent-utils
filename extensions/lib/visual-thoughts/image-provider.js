// Visual thoughts: image generation through an OpenAI-compatible images API (LiteLLM by
// default) or Microsoft's MAI image endpoint (Entra or key auth).
//
// Measured on 2026-10-30 (prompt ~30 words, sandbox deployments): gpt-image-2.5-flare at
// 1536x1024 quality=low ~14 s through LiteLLM; MAI-Image-2.5-Flash / 2.6-Flash ~10 s at
// 768x768 and ~13 s at 1344x768 (minimum 768 per side), limited to 2 requests a minute per
// deployment; gpt-image-2 / 2.5-sunburst ~22 s, gpt-image-1.5 ~28 s. 512 px is refused by both.
import { AZURE_SPEECH_TOKEN_RESOURCE, sharedAzureTokenBroker } from "../azure-speech-auth.js";

export class ImageRateLimitError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = "ImageRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** The wait a 429 asks for: Retry-After, else the request-limit reset, else a minute. */
export function retryAfterMs(headers, fallback = 60_000) {
  const get = (name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]);
  for (const name of ["retry-after-ms", "retry-after", "x-ratelimit-reset-requests"]) {
    const raw = String(get(name) ?? "").trim();
    if (!raw) continue;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value) || value < 0) continue;
    return Math.min(10 * 60_000, Math.round(name === "retry-after-ms" ? value : value * 1000));
  }
  return fallback;
}

function parseSize(size) {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(String(size || "").trim());
  return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 1024, height: 1024 };
}

/** MAI's dimensions for a requested size: each side at least 768, aspect kept. */
export function maiDimensions(size) {
  const { width, height } = parseSize(size);
  const scale = Math.max(1, 768 / Math.min(width, height));
  const round16 = (value) => Math.round(value / 16) * 16;
  return { width: round16(width * scale), height: round16(height * scale) };
}

async function readImage(response, fetchImpl, signal) {
  const body = await response.json();
  const item = body?.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item?.url) {
    const download = await fetchImpl(item.url, { signal });
    if (!download.ok) throw new Error(`image download failed: HTTP ${download.status}`);
    return Buffer.from(await download.arrayBuffer());
  }
  throw new Error("image response had no image data");
}

async function failure(response, label) {
  let detail = "";
  try {
    const text = await response.text();
    try { detail = JSON.parse(text)?.error?.message || text; } catch { detail = text; }
  } catch {}
  detail = String(detail).replace(/\s+/g, " ").trim().slice(0, 240);
  if (response.status === 429) return new ImageRateLimitError(`${label}: rate limited${detail ? ` (${detail})` : ""}`, retryAfterMs(response.headers));
  return new Error(`${label}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
}

/**
 * An image generator from the resolved config: `generate(prompt, { signal })` resolves
 * `{ png, model, ms }`. `provider` is `litellm` (OpenAI-compatible `/v1/images/generations`)
 * or `mai` (`<endpoint>/mai/images/generations`).
 */
export function createImageProvider(config, { fetchImpl = globalThis.fetch, env = process.env, tokenBroker, now = () => Date.now() } = {}) {
  const provider = String(config.provider || "litellm").toLowerCase();
  if (provider === "mai") {
    const endpoint = String(config.maiEndpoint || env.PI_VISUAL_THOUGHTS_MAI_ENDPOINT || "").replace(/\/+$/, "");
    const deployment = String(config.imageModel || "MAI-Image-2.5-Flash");
    const auth = String(config.maiAuth || "entra").toLowerCase();
    return {
      describe: () => `mai ${deployment}`,
      async generate(prompt, { signal } = {}) {
        if (!endpoint) throw new Error("visual thoughts: no MAI endpoint (agentUtils.visualThoughts.maiEndpoint)");
        const started = now();
        const headers = { "Content-Type": "application/json" };
        if (auth === "key") {
          const key = String(env[config.maiKeyEnv || "AZURE_MAI_API_KEY"] || "").trim();
          if (!key) throw new Error(`visual thoughts: ${config.maiKeyEnv || "AZURE_MAI_API_KEY"} is not set`);
          headers["api-key"] = key;
        } else {
          const broker = tokenBroker || sharedAzureTokenBroker();
          headers.Authorization = `Bearer ${await broker.getToken({ az: config.az || "az", resource: AZURE_SPEECH_TOKEN_RESOURCE, env, signal })}`;
        }
        const response = await fetchImpl(`${endpoint}/mai/images/generations`, {
          method: "POST", headers, signal,
          body: JSON.stringify({ model: deployment, prompt, n: 1, ...maiDimensions(config.size) }),
        });
        if (!response.ok) throw await failure(response, `MAI ${deployment}`);
        return { png: await readImage(response, fetchImpl, signal), model: deployment, ms: now() - started };
      },
    };
  }
  const baseUrl = String(config.baseUrl || env.LITELLM_BASE_URL || env.LITELLM_PROXY_URL || "http://localhost:4000").replace(/\/+$/, "").replace(/\/v1$/, "");
  const model = String(config.imageModel || "gpt-image-2.5-flare");
  return {
    describe: () => `${model} via ${baseUrl}`,
    async generate(prompt, { signal } = {}) {
      const key = String(env[config.apiKeyEnv || "LITELLM_MASTER_KEY"] || "").trim();
      const started = now();
      const response = await fetchImpl(`${baseUrl}/v1/images/generations`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({
          model, prompt, n: 1, size: config.size || "1536x1024",
          ...(config.quality ? { quality: config.quality } : {}),
        }),
      });
      if (!response.ok) throw await failure(response, model);
      return { png: await readImage(response, fetchImpl, signal), model, ms: now() - started };
    },
  };
}
