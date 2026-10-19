// An image budget for model requests (bd-cf6146): the Durable counterpart of agent-utils' TUI
// image guard and image-413-recovery, for pi-daemon sessions.
//
// Every image the agent reads stays in its context and is sent again with every request; an
// image-heavy session ends in provider errors (413 Request Entity Too Large, 408 Timed out
// reading request body). Before each request, the newest images are kept within a budget and
// each older image block becomes a short note naming its file, so the agent can read it again.
// After an oversize error the budget halves for the retry. Only the request changes; the
// transcript keeps every image.
//
// The cutoff moves in steps of half the image budget, not one image at a time, so the request's
// prefix (and the provider's prompt cache) stays the same over several turns.

export const DEFAULT_MAX_IMAGES = 8;
export const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;
/** Halvings at most: the budget never drops below one image. */
export const MAX_SHRINKS = 6;

const SHRINK_MEMO = "agent-utils.image-budget.shrink";

/** The budget from the environment (`PI_IMAGE_BUDGET_IMAGES`, `PI_IMAGE_BUDGET_MB`). */
export function imageBudgetFromEnv(env = process.env) {
  const images = Number.parseInt(env.PI_IMAGE_BUDGET_IMAGES ?? "", 10);
  const megabytes = Number.parseFloat(env.PI_IMAGE_BUDGET_MB ?? "");
  return {
    maxImages: Number.isSafeInteger(images) && images > 0 ? images : DEFAULT_MAX_IMAGES,
    maxBytes: Number.isFinite(megabytes) && megabytes > 0 ? Math.round(megabytes * 1024 * 1024) : DEFAULT_MAX_BYTES,
  };
}

/** Whether a provider error says the request was too large or too slow to upload. */
export function isOversizeError(message) {
  if (message?.stopReason !== "error") return false;
  const text = String(message.errorMessage ?? "");
  return /\b413\b|request entity too large|payload too large|request body|request size|user_request_timeout|\b408\b/i.test(text);
}

/**
 * `messages` with older images replaced by notes so at most `maxImages` images and `maxBytes`
 * of image data remain, newest kept. Returns the same array when nothing changes.
 */
export function budgetImages(messages, { maxImages, maxBytes }) {
  const images = [];
  messages.forEach((message, m) => {
    if (!Array.isArray(message?.content)) return;
    message.content.forEach((block, b) => {
      if (block?.type === "image" && typeof block.data === "string") images.push({ m, b, bytes: decodedBytes(block.data) });
    });
  });
  const total = images.length;
  if (total === 0) return messages;
  // Keep from a cutoff that moves in steps, so the prefix is stable for several turns.
  const step = Math.max(1, Math.ceil(maxImages / 2));
  let keepFrom = total <= maxImages ? 0 : (Math.floor((total - maxImages) / step) + 1) * step;
  // Then the byte budget, newest first.
  let bytes = images.slice(keepFrom).reduce((sum, image) => sum + image.bytes, 0);
  while (keepFrom < total - 1 && bytes > maxBytes) {
    bytes -= images[keepFrom].bytes;
    keepFrom += 1;
  }
  if (keepFrom === 0) return messages;
  const paths = toolPaths(messages);
  const dropped = new Set(images.slice(0, keepFrom).map((image) => `${image.m}:${image.b}`));
  return messages.map((message, m) => {
    if (!Array.isArray(message?.content) || !message.content.some((_, b) => dropped.has(`${m}:${b}`))) return message;
    return {
      ...message,
      content: message.content.map((block, b) => (dropped.has(`${m}:${b}`) ? { type: "text", text: note(message, paths) } : block)),
    };
  });
}

/** The Durable extension: generation hooks around every request. */
export function createImageBudgetExtension(budget = imageBudgetFromEnv()) {
  return {
    name: "agent-utils-image-budget",
    hooks: [
      {
        task: "pi.generation",
        handlers: {
          async beforeRequest(request, api, context) {
            const shrinks = await countShrinks(api, context);
            const factor = 2 ** shrinks;
            const messages = budgetImages(request.messages, {
              maxImages: Math.max(1, Math.floor(budget.maxImages / factor)),
              maxBytes: Math.max(256 * 1024, Math.floor(budget.maxBytes / factor)),
            });
            return messages === request.messages ? undefined : { messages };
          },
          async afterResponse(message, api, context) {
            if (!isOversizeError(message)) return;
            // Memos are first-write-wins per task: each oversize error records the next one.
            const shrinks = await countShrinks(api, context);
            if (shrinks < MAX_SHRINKS) await api.memo(`${SHRINK_MEMO}.${shrinks + 1}`, true, context);
          },
        },
      },
    ],
  };
}

async function countShrinks(api, context) {
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

function decodedBytes(data) {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}
