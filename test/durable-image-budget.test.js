// Images in pi-daemon requests (bd-cf6146, bd-968865): they stay until a limit of the provider's
// is met (declared by the model, or refused by the provider), then the oldest leave in one far
// step, so the request's earlier messages (and the prompt cache) change rarely.
import test from "node:test";
import assert from "node:assert/strict";

import {
  budgetImages,
  createImageBudgetExtension,
  imageBudgetFromEnv,
  imageCut,
  isBodyTimeoutError,
  isOversizeError,
  isTooLargeError,
  isTooManyImagesError,
  modelRequestLimits,
  requestWeight,
} from "../extensions/lib/image-budget.js";

const KiB = 1024;
const MiB = 1024 * KiB;
const image = (kib = 100) => ({ type: "image", data: Buffer.alloc(kib * KiB, 1).toString("base64"), mimeType: "image/png" });
const frames = new Map();
/** The same image block object for the same frame, as a transcript's entries are the same objects in every request. */
const frame = (index, kib) => {
  const key = `${index}:${kib}`;
  if (!frames.has(key)) frames.set(key, image(kib));
  return frames.get(key);
};

/** A conversation of `count` reads of video frames, each returning an image. */
function reads(count, kib = 100, model = { provider: "github-copilot", model: "claude-opus-5.5" }) {
  const messages = [{ role: "user", content: "Look at the video frames", timestamp: 1 }];
  for (let i = 0; i < count; i += 1) {
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `/tmp/meatvid/frame-${i}.png` } }],
      stopReason: "toolUse",
      ...model,
    });
    messages.push({ role: "toolResult", toolCallId: `call-${i}`, toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, frame(i, kib)], isError: false });
  }
  return messages;
}

const imagesIn = (messages) => messages.flatMap((message) => (Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : []));

/** A hook API whose memos behave as Durable's (first write wins, per task) and whose models declare `limits`. */
function fakeApi(limits = {}) {
  const memos = new Map();
  return {
    memos,
    models: { getModel: (provider, id) => (limits[`${provider}/${id}`] === undefined ? undefined : { provider, id, inputLimits: limits[`${provider}/${id}`] }) },
    async memo(name, ...rest) {
      if (rest.length === 1) return memos.get(name);
      if (!memos.has(name)) memos.set(name, rest[0]);
      return memos.get(name);
    },
  };
}

const OPUS = "github-copilot/claude-opus-5.5";
const hookOf = (operator) => createImageBudgetExtension(operator ?? imageBudgetFromEnv({})).hooks[0].handlers;

test("without a limit every image stays in the request, as in TUI Pi", async () => {
  const extension = createImageBudgetExtension(imageBudgetFromEnv({}));
  assert.equal(extension.name, "agent-utils-image-budget");
  assert.equal(extension.hooks[0].task, "pi.generation");
  const messages = reads(300);
  assert.equal(await extension.hooks[0].handlers.beforeRequest({ messages }, fakeApi(), {}), undefined);
  assert.equal(budgetImages(messages), messages);
  assert.equal(imageCut(messages, {}), 0);
});

test("the model's declared limits are kept: images per request and the request's size", async () => {
  const hook = hookOf();
  // Images per request (Anthropic's is 600; 8 here).
  const byCount = fakeApi({ [OPUS]: { images: { maxPerRequest: 8 } } });
  assert.equal(await hook.beforeRequest({ messages: reads(8) }, byCount, {}), undefined, "8 images fit");
  const messages = reads(30);
  const result = await hook.beforeRequest({ messages }, byCount, {});
  const kept = imagesIn(result.messages);
  assert.ok(kept.length <= 8 && kept.length >= 4, `kept ${kept.length}`);
  // The newest are kept; the oldest say which file to read again.
  assert.equal(result.messages.at(-1).content[1].type, "image");
  assert.equal(result.messages[2].content[1].type, "text");
  assert.match(result.messages[2].content[1].text, /\/tmp\/meatvid\/frame-0\.png\. Read the file again/);
  // The transcript's messages are not modified.
  assert.equal(imagesIn(messages).length, 30);

  // The request's size (Anthropic's is 32 MiB; 8 MiB here, images of 1 MiB, 1.33 MiB encoded).
  const bySize = fakeApi({ [OPUS]: { maxRequestBytes: 8 * MiB } });
  for (const count of [1, 3, 5, 6, 7, 12, 20]) {
    const request = reads(count, 1024);
    const sentMessages = (await hook.beforeRequest({ messages: request }, bySize, {}))?.messages ?? request;
    const weight = requestWeight(sentMessages);
    assert.ok(weight.bytes <= 8 * MiB, `${count} reads weigh ${weight.bytes}`);
    assert.ok(weight.images >= 1);
    if (count <= 5) assert.equal(sentMessages, request, `${count} reads fit whole`);
  }
  assert.deepEqual(modelRequestLimits({ inputLimits: { maxRequestBytes: 33554432, images: { maxPerRequest: 600, resize: {} } } }), { maxImages: 600, maxBytes: 33554432 });
  assert.deepEqual(modelRequestLimits({ inputLimits: { images: { resize: {} } } }), { maxImages: Infinity, maxBytes: Infinity });
  assert.deepEqual(modelRequestLimits(undefined), { maxImages: Infinity, maxBytes: Infinity });
});

test("reading 60 more images changes the request's earlier messages a few times, not at every image", () => {
  const limits = { maxImages: 16, maxBytes: Infinity };
  let previous = budgetImages(reads(1), limits);
  let changes = 0;
  const cuts = [];
  for (let count = 2; count <= 61; count += 1) {
    const request = budgetImages(reads(count), limits);
    // Did any message the last request already had change? Then the provider's cache of it is lost.
    const changed = previous.some((message, index) => JSON.stringify(message) !== JSON.stringify(request[index]));
    if (changed) changes += 1;
    cuts.push(imageCut(reads(count), limits));
    previous = request;
  }
  // A limit of 16 is met at the 17th image and then every 9th: half are cut, eight stay.
  assert.equal(changes, 5, `earlier messages changed ${changes} times`);
  assert.deepEqual([...new Set(cuts)], [0, 9, 18, 27, 36, 45]);
  // The cut only moves forward, and every request of the conversation finds the same one.
  assert.ok(cuts.every((cut, index) => index === 0 || cut >= cuts[index - 1]));
  assert.equal(imageCut(reads(40), limits), imageCut(reads(40).map((message) => ({ ...message })), limits));
});

test("what the provider refused for its size is not sent to that model again", async () => {
  const hook = hookOf();
  const messages = reads(10, 1024);
  const first = fakeApi();
  assert.equal(await hook.beforeRequest({ messages }, first, {}), undefined, "nothing declared: all ten go");
  await hook.afterResponse({ role: "assistant", stopReason: "error", provider: "github-copilot", model: "claude-opus-5.5", errorMessage: '413 {"type":"error","error":{"type":"request_too_large","message":"Request body too large."}}' }, first, {});
  // The retry of that request, and every later request to that model, in this conversation or another.
  const refusedBytes = requestWeight(messages).bytes;
  for (const api of [first, fakeApi()]) {
    const retry = await hook.beforeRequest({ messages }, api, {});
    const weight = requestWeight(retry.messages);
    assert.ok(weight.bytes <= refusedBytes / 2 && weight.images >= 1, `retry weighs ${weight.bytes} of ${refusedBytes}`);
  }
  assert.equal(first.memos.size, 0, "a refusal for size is not a per-request shrink");
  const other = reads(12, 1024);
  assert.ok(requestWeight((await hook.beforeRequest({ messages: other }, fakeApi(), {})).messages).bytes < refusedBytes);
  // Another model is not affected.
  const sonnet = reads(10, 1024, { provider: "github-copilot", model: "gpt-6-astra" });
  assert.equal(await hook.beforeRequest({ messages: sonnet }, fakeApi(), {}), undefined);

  // The same for a refusal of too many images.
  const count = hookOf();
  const many = reads(20);
  const api = fakeApi();
  assert.equal(await count.beforeRequest({ messages: many }, api, {}), undefined);
  await count.afterResponse({ role: "assistant", stopReason: "error", provider: "github-copilot", model: "claude-opus-5.5", errorMessage: '400 {"type":"error","error":{"type":"invalid_request_error","message":"too many images and documents: 20 + 0 > 19"}}' }, api, {});
  const fewer = imagesIn((await count.beforeRequest({ messages: many }, api, {})).messages).length;
  assert.ok(fewer <= 9 && fewer >= 1, `kept ${fewer}`);

  // A refused request without images teaches nothing about images.
  const text = hookOf();
  const plain = [{ role: "user", content: "hello" }, { role: "assistant", content: [{ type: "text", text: "hi" }], provider: "github-copilot", model: "claude-opus-5.5", stopReason: "stop" }];
  const plainApi = fakeApi();
  await text.beforeRequest({ messages: plain }, plainApi, {});
  await text.afterResponse({ role: "assistant", stopReason: "error", provider: "github-copilot", model: "claude-opus-5.5", errorMessage: "413 Request Entity Too Large" }, plainApi, {});
  assert.equal(await text.beforeRequest({ messages: reads(10, 1024) }, fakeApi(), {}), undefined);
});

test("a 408 body timeout halves that request's retries only", async () => {
  const hook = hookOf();
  const api = fakeApi();
  const messages = reads(8);
  assert.equal(await hook.beforeRequest({ messages }, api, {}), undefined, "8 images go");
  await hook.afterResponse(
    { role: "assistant", stopReason: "error", provider: "github-copilot", model: "claude-opus-5.5", errorMessage: '408 {"error":{"message":"Timed out reading request body. Try again, or use a smaller request size.","code":"user_request_timeout"}}' },
    api,
    {},
  );
  const retry = imagesIn((await hook.beforeRequest({ messages }, api, {})).messages).length;
  assert.ok(retry >= 1 && retry <= 4, `retry kept ${retry}`);
  await hook.afterResponse({ role: "assistant", stopReason: "error", errorMessage: "Error: 408 Timed out reading request body" }, api, {});
  const again = imagesIn((await hook.beforeRequest({ messages }, api, {})).messages).length;
  assert.ok(again >= 1 && again <= 2 && again <= retry, `second retry kept ${again}`);
  // Other errors and answers change nothing.
  await hook.afterResponse({ role: "assistant", stopReason: "error", errorMessage: "429 rate limited" }, api, {});
  await hook.afterResponse({ role: "assistant", stopReason: "stop", content: [] }, api, {});
  assert.equal(api.memos.size, 2);
  // The next request (another task) sends them all again: a slow link is not the provider's limit.
  assert.equal(await hook.beforeRequest({ messages }, fakeApi(), {}), undefined);
});

test("the errors and the operator's own limits", async () => {
  assert.equal(isTooLargeError({ stopReason: "error", errorMessage: "413 Request Entity Too Large" }), true);
  assert.equal(isTooLargeError({ stopReason: "error", errorMessage: '413 {"type":"error","error":{"type":"request_too_large","message":"Request body too large."}}' }), true);
  assert.equal(isTooManyImagesError({ stopReason: "error", errorMessage: "400 too many images and documents: 601 + 0 > 600" }), true);
  assert.equal(isBodyTimeoutError({ stopReason: "error", errorMessage: "Error: 408 Timed out reading request body" }), true);
  assert.equal(isOversizeError({ stopReason: "error", errorMessage: "Error: 408 Timed out reading request body" }), true);
  assert.equal(isOversizeError({ stopReason: "error", errorMessage: "500 internal" }), false);
  assert.equal(isOversizeError({ stopReason: "error", errorMessage: "400 prompt is too long: 1200000 tokens > 1000000 maximum" }), false);
  assert.equal(isOversizeError({ stopReason: "stop" }), false);
  // No allowance of the module's own: nothing unless the operator sets one.
  assert.deepEqual(imageBudgetFromEnv({}), { maxImages: Infinity, maxBytes: Infinity });
  assert.deepEqual(imageBudgetFromEnv({ PI_IMAGE_BUDGET_IMAGES: "4", PI_IMAGE_BUDGET_MB: "2" }), { maxImages: 4, maxBytes: 2 * MiB });
  // The operator's limit and the model's: the tighter of the two.
  const hook = hookOf({ maxImages: 4, maxBytes: Infinity });
  const kept = imagesIn((await hook.beforeRequest({ messages: reads(9) }, fakeApi({ [OPUS]: { images: { maxPerRequest: 600 } } }), {})).messages).length;
  assert.ok(kept >= 2 && kept <= 4, `kept ${kept}`);
});

test("a user's attached images are noted as such", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "old" }, image()] },
    ...reads(9).slice(1),
  ];
  const result = budgetImages(messages, { maxImages: 8, maxBytes: Infinity });
  assert.match(result[0].content[1].text, /an image the user attached earlier/);
});
