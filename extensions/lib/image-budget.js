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
// - or what the operator sets: for every model (PI_IMAGE_BUDGET_IMAGES, PI_IMAGE_BUDGET_MB),
//   or for the models that declare none (PI_IMAGE_BUDGET_DEFAULT_IMAGES,
//   PI_IMAGE_BUDGET_DEFAULT_MB). All unset by default.
// A model that declares nothing and has refused nothing then has no limit.
//
// When a limit is met, the images that leave are the newest the model has already answered,
// not the oldest (bd-dd9e44): each becomes a short note naming its file. A provider caches a
// request by its beginning, so a message changed deep in the conversation sends all after it
// again; the newest answered image is in the round before, and only that tail changes. The
// images the conversation began with stay as they were sent, and the ones not answered yet (the
// round the model is about to see) are the last to go. Which images leave depends only on the
// messages and the limits, so every request of a conversation works out the same, and an image
// that left does not come back before the conversation is compacted. (After a compaction the
// request is new in any case; the images of the messages it kept are counted afresh.)
//
// The limits are those of the model the request goes to: the one the host names
// (`request.model`, pi-daemon bd-c397f5), else the one this conversation's last request went
// to, else the one of its last answer. On the first request after a model switch the last two
// are the model before.
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

/**
 * The limits of a model that declares none, if the operator sets any
 * (`PI_IMAGE_BUDGET_DEFAULT_IMAGES`, `PI_IMAGE_BUDGET_DEFAULT_MB`). Each stands in only for
 * the limit of its kind that the model does not declare. Unset means none.
 */
export function imageBudgetDefaultsFromEnv(env = process.env) {
  return imageBudgetFromEnv({ PI_IMAGE_BUDGET_IMAGES: env.PI_IMAGE_BUDGET_DEFAULT_IMAGES, PI_IMAGE_BUDGET_MB: env.PI_IMAGE_BUDGET_DEFAULT_MB });
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
 * Which images of `messages` are left out so each request stays within `maxImages` and
 * `maxBytes`: their places among the conversation's images, counted from 0. The messages are
 * walked in order, as the conversation grew. When the request up to a message passes a limit,
 * the newest images the model has answered (an assistant message follows them) go first, one at
 * a time, until it fits; then, of the round it has not answered yet, the later ones. One image
 * always stays. A longer conversation repeats the same steps, so what left stays out.
 */
export function droppedImages(messages, { maxImages = Infinity, maxBytes = Infinity } = {}) {
  const dropped = new Set();
  if (maxImages === Infinity && maxBytes === Infinity) return dropped;
  const paths = toolPaths(messages);
  const sizes = [];
  /** The bytes of the note that takes each image's place. */
  const notes = [];
  /** Kept images the model has answered, oldest first; and the ones of the round it has not. */
  const answered = [];
  let fresh = [];
  let kept = 0;
  let keptBytes = 0;
  let other = 0;
  const over = () => kept > maxImages || other + keptBytes > maxBytes;
  const drop = (index) => {
    dropped.add(index);
    kept -= 1;
    keptBytes -= sizes[index];
    other += notes[index];
  };
  for (const message of messages) {
    const weight = measure(message);
    if (message?.role === "assistant" && fresh.length > 0) {
      answered.push(...fresh);
      fresh = [];
    }
    other += weight.other;
    for (const image of weight.images) {
      fresh.push(sizes.length);
      sizes.push(image.bytes);
      notes.push(Buffer.byteLength(note(message, paths)));
      kept += 1;
      keptBytes += image.bytes;
    }
    while (over() && answered.length > 0) drop(answered.pop());
    while (over() && fresh.length > 1) drop(fresh.pop());
  }
  return dropped;
}

/**
 * `messages` with the images a limit leaves no room for replaced by notes (see
 * {@link droppedImages}). Returns the same array when nothing changes.
 */
export function budgetImages(messages, limits = NO_LIMITS) {
  const dropped = droppedImages(messages, limits);
  if (dropped.size === 0) return messages;
  const paths = toolPaths(messages);
  let seen = 0;
  return messages.map((message) => {
    const { images } = measure(message);
    if (images.length === 0) return message;
    const first = seen;
    seen += images.length;
    const out = new Set(images.filter((_, index) => dropped.has(first + index)).map((image) => image.b));
    if (out.size === 0) return message;
    return { ...message, content: message.content.map((block, b) => (out.has(b) ? { type: "text", text: note(message, paths) } : block)) };
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

const modelRef = (provider, id) => (typeof provider === "string" && typeof id === "string" ? { provider, id, key: `${provider}/${id}` } : undefined);

/** The number a provider's refusal names as the most images it takes ("maximum allowed for model x is 10", "601 + 0 > 600"). */
export function statedImageLimit(message) {
  const text = String(message?.errorMessage ?? "");
  const found = /maximum allowed.*?(?:\bis|:)\s*(\d+)/i.exec(text) ?? /\d+\s*\+\s*\d+\s*>\s*(\d+)/.exec(text);
  const limit = found === null ? NaN : Number.parseInt(found[1], 10);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

/**
 * What a refusal of a request of `weight` teaches about a model, given what it was known to
 * refuse (`known`) and the largest it has taken (`accepted`). For too many images: the number
 * the provider names, else half of what was refused. For its size: half of what was refused,
 * since a request refused at three times a provider's limit says little of where the limit is.
 * Never under what the provider has taken, and always under what it refused.
 */
export function learnedLimits(message, weight, known = NO_LIMITS, accepted = { images: 0, bytes: 0 }) {
  if (isTooManyImagesError(message)) {
    const stated = statedImageLimit(message);
    const guess = stated ?? Math.max(accepted.images, Math.floor(weight.images / 2));
    return { maxImages: Math.max(1, Math.min(known.maxImages, weight.images - 1, guess)), maxBytes: known.maxBytes };
  }
  const guess = Math.max(accepted.bytes, Math.floor(weight.bytes / 2));
  return { maxImages: known.maxImages, maxBytes: Math.max(1, Math.min(known.maxBytes, weight.bytes - 1, guess)) };
}

/** Most conversations whose model, and most models whose largest request, are remembered. */
const MAX_REMEMBERED = 256;
function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= MAX_REMEMBERED) break;
    map.delete(oldest);
  }
}

/**
 * The Durable extension: generation hooks around every request. `operator` are the operator's
 * own limits (the environment's by default; none unless set).
 */
export function createImageBudgetExtension(operator = imageBudgetFromEnv(), defaults = imageBudgetDefaultsFromEnv()) {
  /** What a provider refused in this process, by `provider/model`: no request that large goes there again. */
  const refused = new Map();
  /** The largest request with images each model has answered in this process, by `provider/model`. */
  const accepted = new Map();
  /** The model each conversation's last request went to, by conversation. */
  const current = new Map();
  /** The request each attempt sent, by the hook API it was sent through. */
  const sent = new WeakMap();
  const conversationOf = (api) => (typeof api === "object" && api !== null && api.conversationId !== undefined ? api.conversationId : undefined);
  return {
    name: "agent-utils-image-budget",
    hooks: [
      {
        task: "pi.generation",
        handlers: {
          async beforeRequest(request, api, context) {
            const conversation = conversationOf(api);
            // The model the request goes to: the host's word for it, else where this conversation's last request went, else its last answer's.
            const named = modelRef(request.model?.provider, request.model?.id);
            const model = named ?? (conversation === undefined ? undefined : current.get(conversation)) ?? lastModel(request.messages);
            let declared = NO_LIMITS;
            try {
              if (named !== undefined) declared = modelRequestLimits(request.model);
              else if (model !== undefined) declared = modelRequestLimits(api?.models?.getModel?.(model.provider, model.id));
            } catch {
              declared = NO_LIMITS;
            }
            // The operator's defaults stand in for what the model does not declare.
            declared = {
              maxImages: declared.maxImages === Infinity ? defaults.maxImages : declared.maxImages,
              maxBytes: declared.maxBytes === Infinity ? defaults.maxBytes : declared.maxBytes,
            };
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
          beforeProviderRequest(request, api) {
            // Where this conversation's request goes: its next is built to this model's limits, whatever answered last.
            const conversation = conversationOf(api);
            const model = modelRef(request?.model?.provider, request?.model?.id);
            if (conversation !== undefined && model !== undefined) remember(current, conversation, model);
            return undefined;
          },
          async afterResponse(message, api, context) {
            const attempt = typeof api === "object" && api !== null ? sent.get(api) : undefined;
            const key = modelRef(message?.provider, message?.model)?.key ?? attempt?.key;
            if (!isOversizeError(message)) {
              // An answer: the provider takes a request of this many images and bytes.
              if (message?.stopReason === "error" || message?.stopReason === "aborted" || attempt === undefined || key === undefined) return;
              const weight = requestWeight(attempt.messages);
              if (weight.images === 0) return;
              const most = accepted.get(key) ?? { images: 0, bytes: 0 };
              if (weight.images > most.images || weight.bytes > most.bytes) remember(accepted, key, { images: Math.max(most.images, weight.images), bytes: Math.max(most.bytes, weight.bytes) });
              return;
            }
            if (isBodyTimeoutError(message)) {
              // Memos are first-write-wins per task: each timeout records the next one.
              const shrinks = await countShrinks(api, context);
              if (shrinks < MAX_SHRINKS) await api.memo(`${SHRINK_MEMO}.${shrinks + 1}`, true, context);
              return;
            }
            // A refusal for size is a fact about the provider: remember what it refused.
            if (attempt === undefined || key === undefined) return;
            const weight = requestWeight(attempt.messages);
            // A refused request without images says nothing that leaving images out could mend.
            if (weight.images === 0) return;
            refused.set(key, learnedLimits(message, weight, refused.get(key) ?? NO_LIMITS, accepted.get(key)));
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
