// The Durable image budget (bd-cf6146): older images leave the request, newest kept, within a
// budget that halves after a provider 413/408.
import test from "node:test";
import assert from "node:assert/strict";

import {
  budgetImages,
  createImageBudgetExtension,
  imageBudgetFromEnv,
  isOversizeError,
} from "../extensions/lib/image-budget.js";

const KiB = 1024;
const image = (kib = 100) => ({ type: "image", data: Buffer.alloc(kib * KiB, 1).toString("base64"), mimeType: "image/png" });

/** A conversation of `count` reads of video frames, each returning an image. */
function reads(count, kib = 100) {
  const messages = [{ role: "user", content: "Look at the video frames", timestamp: 1 }];
  for (let i = 0; i < count; i += 1) {
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `/tmp/meatvid/frame-${i}.png` } }],
      stopReason: "toolUse",
    });
    messages.push({ role: "toolResult", toolCallId: `call-${i}`, toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, image(kib)], isError: false });
  }
  return messages;
}

const imagesIn = (messages) => messages.flatMap((message) => (Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : []));

/** A hook API whose memos behave as Durable's: first write wins, per task. */
function fakeApi() {
  const memos = new Map();
  return {
    memos,
    async memo(name, ...rest) {
      if (rest.length === 1) return memos.get(name);
      if (!memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
  };
}

test("30 image reads: the newest stay within the budget, older ones become notes naming their files", async () => {
  const extension = createImageBudgetExtension({ maxImages: 8, maxBytes: 64 * 1024 * 1024 });
  assert.equal(extension.name, "agent-utils-image-budget");
  const [hook] = extension.hooks;
  assert.equal(hook.task, "pi.generation");
  const messages = reads(30);
  const result = await hook.handlers.beforeRequest({ messages }, fakeApi(), {});
  const kept = imagesIn(result.messages);
  assert.ok(kept.length <= 8 && kept.length >= 4, `kept ${kept.length}`);
  // The newest are kept; the oldest say which file to read again.
  const last = result.messages.at(-1);
  assert.equal(last.content[1].type, "image");
  const first = result.messages[2];
  assert.equal(first.content[1].type, "text");
  assert.match(first.content[1].text, /\/tmp\/meatvid\/frame-0\.png\. Read the file again/);
  // The transcript's messages are not modified.
  assert.equal(imagesIn(messages).length, 30);
  // Below the budget, nothing changes.
  assert.equal(await hook.handlers.beforeRequest({ messages: reads(5) }, fakeApi(), {}), undefined);
});

test("the cutoff moves in steps, so the request prefix stays the same over several turns", () => {
  const budget = { maxImages: 8, maxBytes: 64 * 1024 * 1024 };
  const cutoff = (count) => imagesIn(budgetImages(reads(count), budget)).length;
  // 9 → keep 5; 10, 11, 12 keep the same older cut (6, 7, 4 → the cut moved once at 12).
  const dropped = (count) => count - cutoff(count);
  assert.deepEqual([9, 10, 11, 12, 13, 14, 15, 16].map(dropped), [4, 4, 4, 8, 8, 8, 8, 12]);
});

test("the byte budget applies too, newest first", () => {
  const result = budgetImages(reads(6, 1024), { maxImages: 8, maxBytes: 2.5 * 1024 * 1024 });
  assert.equal(imagesIn(result).length, 2);
});

test("a provider 413 or 408 halves the budget for the retry", async () => {
  const [hook] = createImageBudgetExtension({ maxImages: 8, maxBytes: 64 * 1024 * 1024 }).hooks;
  const api = fakeApi();
  const messages = reads(8);
  assert.equal(await hook.handlers.beforeRequest({ messages }, api, {}), undefined, "8 images fit");
  await hook.handlers.afterResponse(
    { role: "assistant", stopReason: "error", errorMessage: '408 {"error":{"message":"Timed out reading request body. Try again, or use a smaller request size.","code":"user_request_timeout"}}' },
    api,
    {},
  );
  // A budget of N keeps N/2 to N-1 images (the cutoff moves in steps), so after halving to 4: 2 or 3.
  const retry = imagesIn((await hook.handlers.beforeRequest({ messages }, api, {})).messages).length;
  assert.ok(retry >= 2 && retry <= 4, `retry kept ${retry}`);
  await hook.handlers.afterResponse({ role: "assistant", stopReason: "error", errorMessage: "413 Request Entity Too Large" }, api, {});
  const again = imagesIn((await hook.handlers.beforeRequest({ messages }, api, {})).messages).length;
  assert.ok(again >= 1 && again <= 2 && again < retry + 1, `second retry kept ${again}`);
  // Other errors and answers change nothing.
  await hook.handlers.afterResponse({ role: "assistant", stopReason: "error", errorMessage: "429 rate limited" }, api, {});
  await hook.handlers.afterResponse({ role: "assistant", stopReason: "stop", content: [] }, api, {});
  assert.equal(api.memos.size, 2);
});

test("the oversize errors and the environment", () => {
  assert.equal(isOversizeError({ stopReason: "error", errorMessage: "413 Request Entity Too Large" }), true);
  assert.equal(isOversizeError({ stopReason: "error", errorMessage: "Error: 408 Timed out reading request body" }), true);
  assert.equal(isOversizeError({ stopReason: "error", errorMessage: "500 internal" }), false);
  assert.equal(isOversizeError({ stopReason: "stop" }), false);
  assert.deepEqual(imageBudgetFromEnv({ PI_IMAGE_BUDGET_IMAGES: "4", PI_IMAGE_BUDGET_MB: "2" }), { maxImages: 4, maxBytes: 2 * 1024 * 1024 });
  assert.deepEqual(imageBudgetFromEnv({}), { maxImages: 8, maxBytes: 6 * 1024 * 1024 });
});

test("a user's attached images are noted as such", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "old" }, image()] },
    ...reads(9).slice(1),
  ];
  const result = budgetImages(messages, { maxImages: 8, maxBytes: 64 * 1024 * 1024 });
  assert.match(result[0].content[1].text, /an image the user attached earlier/);
});
