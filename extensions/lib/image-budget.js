// Images in model requests, for pi-daemon sessions (bd-cf6146, bd-968865): the Durable
// counterpart of agent-utils' TUI image guard and image-413-recovery.
//
// As TUI Pi does, an image stays in every request until the conversation is compacted: `read`
// already resized it once to the model's `inputLimits.images.resize`, and a request whose
// earlier messages never change keeps the provider's prompt cache. The first version of this
// module kept an allowance of its own (8 images, 6 MB) and turned older images into notes as
// newer ones arrived; every such move changed a message deep in the conversation, so the whole
// prompt after it was written to the cache again (a week of the fleet: one image read in three,
// $6.6k).
//
// Images now leave a request only for a limit that is the provider's:
// - what the model declares (`inputLimits.maxRequestBytes`, `inputLimits.images.maxPerRequest`
//   in Pi's catalog or models.json), which Pi itself does not act on yet;
// - what the provider refused in this process (a 413, or "too many images"): a request that
//   large is not sent to that model again;
// - or what the operator sets (PI_IMAGE_BUDGET_IMAGES, PI_IMAGE_BUDGET_MB).
// When a limit is met, the oldest images become short notes naming their files, down to half
// of the limit, and the cut then stays where it is until a limit is met again: the request's
// earlier messages change once per many images. Where the cut falls depends only on the
// messages and the limits, so every request of a conversation computes the same one.
//
// A 408 ("timed out reading request body", a slow link more than a size) halves the limits
// for the retries of that request only. Only the request changes; the transcript keeps every
// image.

/** Halvings at most after body timeouts: one image always stays. */
export const MAX_SHRINKS = 6;

const SHRINK_MEMO = "agent-utils.image-budget.shrink";
const NO_LIMITS = Object.freeze({ maxImages: Infinity, maxBytes: Infinity });

/**
 * The operator's own limits, if any (`PI_IMAGE_BUDGET_IMAGES`: images in a request;
 * `PI_IMAGE_BUDGET_MB`: the request's size in MiB). Unset means none.
 */
export function imageBudgetFromEnv(env = process.env) {
  const images = Number.parseInt(env.PI_IMAGE_BUDGET_IMAGES ?? "", 10);
  const megabytes = Number.parseFloat(env.PI_IMAGE_BUDGET_MB ?? "");
  return {
    maxImages: Number.isSafeInteger(images) && images > 0 ? images : Infinity,
    maxBytes: Number.isFinite(megabytes) && megabytes > 0 ? Math.round(megabytes * 1024 * 1024) : Infinity,
  };
}

/** The limits a model declares for one request (Pi's `inputLimits`); Infinity where it declares none. */
export function modelRequestLimits(model) {
  const images = model?.inputLimits?.images?.maxPerRequest;
  const bytes = model?.inputLimits?.maxRequestBytes;
  return {
    maxImages: Number.isSafeInteger(images) && images > 0 ? images : Infinity,
    maxBytes: Number.isSafeInteger(bytes) && bytes > 0 ? bytes : Infinity,
  };
}

/** The tighter of two sets of limits. */
export function tighter(a, b) {
  return { maxImages: Math.min(a.maxImages, b.maxImages), maxBytes: Math.min(a.maxBytes, b.maxBytes) };
}

/** A provider's refusal of a request for its size. */
export function isTooLargeError(message) {
  if (message?.stopReason !== "error") return false;
  return /\b413\b|request entity too large|payload too large|request_too_large|request body too large/i.test(String(message.errorMessage ?? ""));
}

/** A provider's refusal of a request for its number of images. */
export function isTooManyImagesError(message) {
  if (message?.stopReason !== "error") return false;
  return /too many images/i.test(String(message.errorMessage ?? ""));
}

/** A request body the provider gave up reading: a slow upload, which a smaller request helps. */
export function isBodyTimeoutError(message) {
  if (message?.stopReason !== "error") return false;
  return /\b408\b|timed out reading request body|user_request_timeout/i.test(String(message.errorMessage ?? ""));
}

/** Whether a provider error says the request was too large or too slow to upload. */
export function isOversizeError(message) {
  return isTooLargeError(message) || isTooManyImagesError(message) || isBodyTimeoutError(message);
}

const measured = new WeakMap();

/**
 * What a message weighs in a request: its JSON without image data (`other`, UTF-8 bytes) and
 * each image's encoded data as it is sent. Pi's message JSON carries more than the provider's
 * (usage, diagnostics, timestamps), so the sum does not undercount the body.
 */
function measure(message) {
  if (typeof message !== "object" || message === null) return { other: 0, images: [] };
  const cached = measured.get(message);
  if (cached !== undefined) return cached;
  const images = [];
  let stripped = message;
  if (Array.isArray(message.content)) {
    message.content.forEach((block, b) => {
      if (block?.type === "image" && typeof block.data === "string") images.push({ b, bytes: block.data.length });
    });
    if (images.length > 0) {
      stripped = { ...message, content: message.content.map((block) => (block?.type === "image" && typeof block.data === "string" ? { ...block, data: "" } : block)) };
    }
  }
  let other = 0;
  try { other = Buffer.byteLength(JSON.stringify(stripped) ?? ""); } catch { other = 0; }
  const result = { other, images };
  measured.set(message, result);
  return result;
}

/** The images and bytes of `messages` as one request. */
export function requestWeight(messages) {
  let images = 0;
  let bytes = 0;
  for (const message of messages) {
    const weight = measure(message);
    bytes += weight.other;
    for (const image of weight.images) {
      images += 1;
      bytes += image.bytes;
    }
  }
  return { images, bytes };
}

/**
 * How many of the oldest images of `messages` are left out so each request stays within
 * `maxImages` and `maxBytes`. The messages are walked in order, as the conversation grew: when
 * the request up to a message passes a limit, the oldest images go until half of the limit
 * remains (the newest image always stays), and nothing moves again until a limit is passed
 * again. A longer conversation repeats the same steps, so the cut only ever moves forward.
 */
export function imageCut(messages, { maxImages = Infinity, maxBytes = Infinity } = {}) {
  if (maxImages === Infinity && maxBytes === Infinity) return 0;
  const sizes = [];
  let cut = 0;
  let keptBytes = 0;
  let other = 0;
  for (const message of messages) {
    const weight = measure(message);
    other += weight.other;
    for (const image of weight.images) {
      sizes.push(image.bytes);
      keptBytes += image.bytes;
    }
    if (sizes.length - cut <= maxImages && other + keptBytes <= maxBytes) continue;
    while (cut < sizes.length - 1 && (sizes.length - cut > maxImages / 2 || other + keptBytes > maxBytes / 2)) {
      keptBytes -= sizes[cut];
      cut += 1;
    }
  }
  return cut;
}

/**
 * `messages` with the oldest images replaced by notes so the request stays within the limits
 * (see {@link imageCut}). Returns the same array when nothing changes.
 */
export function budgetImages(messages, limits = NO_LIMITS) {
  const cut = imageCut(messages, limits);
  if (cut === 0) return messages;
  const paths = toolPaths(messages);
  let seen = 0;
  return messages.map((message) => {
    const { images } = measure(message);
    if (images.length === 0) return message;
    const first = seen;
    seen += images.length;
    if (first >= cut) return message;
    const dropped = new Set(images.filter((_, index) => first + index < cut).map((image) => image.b));
    return { ...message, content: message.content.map((block, b) => (dropped.has(b) ? { type: "text", text: note(message, paths) } : block)) };
  });
}

/** The model of the conversation's last answer in `messages`, as `provider/model`, with its parts. */
function lastModel(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string") {
      return { provider: message.provider, id: message.model, key: `${message.provider}/${message.model}` };
    }
  }
  return undefined;
}

/**
 * The Durable extension: generation hooks around every request. `operator` are the operator's
 * own limits (the environment's by default; none unless set).
 */
export function createImageBudgetExtension(operator = imageBudgetFromEnv()) {
  /** What a provider refused in this process, by `provider/model`: no request that large goes there again. */
  const refused = new Map();
  /** The request each attempt sent, by the hook API it was sent through. */
  const sent = new WeakMap();
  return {
    name: "agent-utils-image-budget",
    hooks: [
      {
        task: "pi.generation",
        handlers: {
          async beforeRequest(request, api, context) {
            const model = lastModel(request.messages);
            let declared = NO_LIMITS;
            try {
              if (model !== undefined) declared = modelRequestLimits(api?.models?.getModel?.(model.provider, model.id));
            } catch {
              declared = NO_LIMITS;
            }
            let limits = tighter(tighter(declared, operator), refused.get(model?.key) ?? NO_LIMITS);
            const shrinks = await countShrinks(api, context);
            let weight;
            if (shrinks > 0) {
              // A slow upload: this request's retries carry half, a quarter... of what it weighed.
              weight = requestWeight(request.messages);
              const factor = 2 ** shrinks;
              limits = {
                maxImages: Math.max(1, Math.floor(Math.min(limits.maxImages, weight.images) / factor)),
                maxBytes: Math.floor(Math.min(limits.maxBytes, weight.bytes) / factor),
              };
            }
            const messages = budgetImages(request.messages, limits);
            if (typeof api === "object" && api !== null) sent.set(api, { key: model?.key, messages });
            return messages === request.messages ? undefined : { messages };
          },
          async afterResponse(message, api, context) {
            if (!isOversizeError(message)) return;
            if (isBodyTimeoutError(message)) {
              // Memos are first-write-wins per task: each timeout records the next one.
              const shrinks = await countShrinks(api, context);
              if (shrinks < MAX_SHRINKS) await api.memo(`${SHRINK_MEMO}.${shrinks + 1}`, true, context);
              return;
            }
            // A refusal for size is a fact about the provider: remember what it refused.
            const attempt = typeof api === "object" && api !== null ? sent.get(api) : undefined;
            const key = typeof message.provider === "string" && typeof message.model === "string" ? `${message.provider}/${message.model}` : attempt?.key;
            if (attempt === undefined || key === undefined) return;
            const weight = requestWeight(attempt.messages);
            // A refused request without images says nothing that leaving images out could mend.
            if (weight.images === 0) return;
            const known = refused.get(key) ?? NO_LIMITS;
            refused.set(
              key,
              isTooManyImagesError(message)
                ? { maxImages: Math.min(known.maxImages, Math.max(1, weight.images - 1)), maxBytes: known.maxBytes }
                : { maxImages: known.maxImages, maxBytes: Math.min(known.maxBytes, Math.max(1, weight.bytes - 1)) },
            );
          },
        },
      },
    ],
  };
}

async function countShrinks(api, context) {
  if (typeof api?.memo !== "function") return 0;
  let count = 0;
  while (count < MAX_SHRINKS && (await api.memo(`${SHRINK_MEMO}.${count + 1}`, context)) !== undefined) count += 1;
  return count;
}

/** The file each tool call read, by tool call id, for the notes. */
function toolPaths(messages) {
  const paths = new Map();
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const path = block?.type === "toolCall" ? (block.arguments?.path ?? block.arguments?.file_path) : undefined;
      if (typeof path === "string") paths.set(block.id, path);
    }
  }
  return paths;
}

function note(message, paths) {
  const path = message.role === "toolResult" ? paths.get(message.toolCallId) : undefined;
  if (path !== undefined) return `[Image omitted from this request to keep it small: ${path}. Read the file again to see it.]`;
  if (message.role === "user") return "[Image omitted from this request to keep it small: an image the user attached earlier.]";
  return "[Image omitted from this request to keep it small.]";
}
