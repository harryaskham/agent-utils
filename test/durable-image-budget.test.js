// Images in pi-daemon requests (bd-cf6146, bd-968865, bd-dd9e44): they stay until a limit of the
// provider's is met (declared by the model, or refused by the provider); then the newest the
// model has already answered leave, so the request changes only near its end and the provider's
// cache of all before it is kept.
import test from "node:test";
import assert from "node:assert/strict";

import {
  budgetImages,
  createImageBudgetExtension,
  droppedImages,
  imageBudgetDefaultsFromEnv,
  imageBudgetFromEnv,
  isBodyTimeoutError,
  isOversizeError,
  isTooLargeError,
  isTooManyImagesError,
  learnedLimits,
  modelRequestLimits,
  requestWeight,
  statedImageLimit,
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
  assert.equal(droppedImages(messages, {}).size, 0);
});

test("the model's declared limits are kept: images per request and the request's size", async () => {
  const hook = hookOf();
  // Images per request (Anthropic's is 600; 8 here).
  const byCount = fakeApi({ [OPUS]: { images: { maxPerRequest: 8 } } });
  assert.equal(await hook.beforeRequest({ messages: reads(8) }, byCount, {}), undefined, "8 images fit");
  const messages = reads(30);
  const result = await hook.beforeRequest({ messages }, byCount, {});
  const kept = imagesIn(result.messages);
  assert.equal(kept.length, 8, "as many as the model takes");
  // The first seven stay as they were sent, and the one the model has not answered yet is there.
  for (let read = 0; read < 7; read += 1) assert.equal(result.messages[2 + 2 * read], messages[2 + 2 * read], `read ${read}`);
  assert.equal(result.messages.at(-1), messages.at(-1));
  // The ones between say which file to read again.
  for (let read = 7; read < 29; read += 1) {
    assert.equal(result.messages[2 + 2 * read].content[1].type, "text", `read ${read}`);
    assert.match(result.messages[2 + 2 * read].content[1].text, new RegExp(`/tmp/meatvid/frame-${read}\\.png\\. Read the file again`));
  }
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

test("past a limit, reading another image changes the request only from the image before it: all earlier stays as it was sent (bd-dd9e44)", () => {
  const limits = { maxImages: 10, maxBytes: Infinity };
  let previous = budgetImages(reads(1), limits);
  const firstChanged = [];
  for (let count = 2; count <= 61; count += 1) {
    const request = budgetImages(reads(count), limits);
    // The first message the last request already had that is no longer the same: the provider's cache is lost from there on.
    const changed = previous.findIndex((message, index) => JSON.stringify(message) !== JSON.stringify(request[index]));
    firstChanged.push(changed < 0 ? undefined : changed);
    assert.equal(imagesIn(request).length, Math.min(count, 10));
    previous = request;
  }
  // Up to the limit nothing changes. From the 11th read on, only the tool result of the read before (the last
  // message the request before had): the nine images the conversation began with are never touched.
  firstChanged.forEach((changed, index) => {
    const count = index + 2;
    assert.equal(changed, count <= 10 ? undefined : 2 * (count - 1), `at ${count} reads`);
  });
  // What left stays out, and every request of the conversation works out the same.
  assert.deepEqual([...droppedImages(reads(13), limits)], [9, 10, 11]);
  assert.deepEqual([...droppedImages(reads(40), limits)].slice(0, 3), [9, 10, 11]);
  assert.deepEqual([...droppedImages(reads(40), limits)], [...droppedImages(reads(40).map((message) => ({ ...message })), limits)]);
});

test("the images of the round the model has not answered yet are the last to go, and one always stays", () => {
  const call = (i) => ({ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `/tmp/meatvid/frame-${i}.png` } });
  const result = (i, kib = 100) => ({ role: "toolResult", toolCallId: `call-${i}`, toolName: "read", content: [{ type: "text", text: "Read image file [image/png]" }, frame(i, kib)], isError: false });
  const assistant = (...calls) => ({ role: "assistant", content: calls.map(call), stopReason: "toolUse", provider: "github-copilot", model: "gemini-4-neon" });
  // Eight reads, one at a time, then three at once: a limit of ten.
  const messages = reads(8, 100, { provider: "github-copilot", model: "gemini-4-neon" });
  messages.push(assistant(8, 9, 10), result(8), result(9), result(10));
  // The round's three are all there: the newest answered (the eighth read) made room.
  assert.deepEqual([...droppedImages(messages, { maxImages: 10 })], [7]);
  // A round of more than the model takes: its first ten, and nothing of before.
  const many = [{ role: "user", content: "Look" }, ...reads(3, 100).slice(1), assistant(...Array.from({ length: 12 }, (_, i) => 20 + i)), ...Array.from({ length: 12 }, (_, i) => result(20 + i))];
  assert.deepEqual([...droppedImages(many, { maxImages: 10 })].sort((a, b) => a - b), [0, 1, 2, 13, 14]);
  // The size: images of 1 MiB (1.33 MiB encoded) under 4 MiB. Two fit; each further read takes the place of the one before it.
  const big = reads(6, 1024);
  assert.deepEqual([...droppedImages(big, { maxBytes: 4 * MiB })], [1, 2, 3, 4]);
  assert.ok(requestWeight(budgetImages(big, { maxBytes: 4 * MiB })).bytes <= 4 * MiB);
  // The notes that take the images' places are weighed too: small images, so a note is a tenth of one.
  const small = reads(60, 1);
  const whole = requestWeight(small).bytes;
  for (let step = 1; step <= 30; step += 1) {
    const maxBytes = Math.floor((whole * step) / 31);
    const weight = requestWeight(budgetImages(small, { maxBytes }));
    if (weight.images > 1) assert.ok(weight.bytes <= maxBytes, `under ${maxBytes}: ${weight.bytes} with ${weight.images} images`);
  }
  // An image larger than the limit by itself still goes: one always stays.
  assert.deepEqual([...droppedImages(reads(1, 1024), { maxBytes: MiB })], []);
  assert.deepEqual([...droppedImages(reads(3, 1024), { maxBytes: MiB })], [0, 1]);
  // Text that grows past the limit takes the newest answered image out, and then the next newest.
  const grown = [...reads(3, 1024), { role: "assistant", content: [{ type: "text", text: "seen" }], stopReason: "stop", provider: "github-copilot", model: "gemini-4-neon" }];
  assert.deepEqual([...droppedImages(grown, { maxBytes: 4 * MiB + 600 * KiB })], []);
  assert.deepEqual([...droppedImages([...grown, { role: "user", content: "x".repeat(700 * KiB) }], { maxBytes: 4 * MiB + 600 * KiB })], [2]);
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
    // Half of what was refused: a refusal far over a provider's limit says little of where the limit is.
    assert.ok(weight.bytes <= refusedBytes / 2 && weight.images >= 1, `retry weighs ${weight.bytes} of ${refusedBytes}`);
    assert.equal(weight.images, 4);
    // The first images stay as they were sent, and the newest is there.
    assert.equal(retry.messages[2], messages[2]);
    assert.equal(retry.messages.at(-1), messages.at(-1));
  }
  assert.equal(first.memos.size, 0, "a refusal for size is not a per-request shrink");
  const other = reads(12, 1024);
  assert.ok(requestWeight((await hook.beforeRequest({ messages: other }, fakeApi(), {})).messages).bytes < refusedBytes / 2);
  // Another model is not affected.
  const sonnet = reads(10, 1024, { provider: "github-copilot", model: "gpt-6-astra" });
  assert.equal(await hook.beforeRequest({ messages: sonnet }, fakeApi(), {}), undefined);

  // The same for a refusal of too many images.
  const count = hookOf();
  const many = reads(20);
  const api = fakeApi();
  assert.equal(await count.beforeRequest({ messages: many }, api, {}), undefined);
  await count.afterResponse({ role: "assistant", stopReason: "error", provider: "github-copilot", model: "claude-opus-5.5", errorMessage: '400 {"type":"error","error":{"type":"invalid_request_error","message":"too many images and documents: 20 + 0 > 19"}}' }, api, {});
  // The provider named its limit: that many go, in one step.
  assert.equal(imagesIn((await count.beforeRequest({ messages: many }, api, {})).messages).length, 19);
  // Copilot's Gemini models name theirs so: the request after the refusal is within it, however far over the refused one was.
  const neon = { provider: "github-copilot", model: "gemini-4-neon" };
  const named = hookOf();
  const frames19 = reads(19, 100, neon);
  const neonApi = fakeApi();
  assert.equal(await named.beforeRequest({ messages: frames19 }, neonApi, {}), undefined);
  await named.afterResponse({ role: "assistant", stopReason: "error", ...neon, errorMessage: '400: {"message":"too many images: maximum allowed for model gemini-4-neon is 10","code":"invalid_request_body"}' }, neonApi, {});
  assert.equal(imagesIn((await named.beforeRequest({ messages: frames19 }, neonApi, {})).messages).length, 10);
  // A later refusal for size adds to what is known: ten images still, and half the size.
  const large = reads(12, 1024, neon);
  const largeApi = fakeApi();
  const tenLarge = (await named.beforeRequest({ messages: large }, largeApi, {})).messages;
  assert.equal(imagesIn(tenLarge).length, 10);
  await named.afterResponse({ role: "assistant", stopReason: "error", ...neon, errorMessage: "413 Request Entity Too Large" }, largeApi, {});
  assert.equal(imagesIn((await named.beforeRequest({ messages: large }, fakeApi(), {})).messages).length, 4);
  assert.equal(imagesIn((await named.beforeRequest({ messages: frames19 }, fakeApi(), {})).messages).length, 10);
  // One that names nothing: half of what was refused.
  const unnamed = hookOf();
  const unnamedApi = fakeApi();
  await unnamed.beforeRequest({ messages: many }, unnamedApi, {});
  await unnamed.afterResponse({ role: "assistant", stopReason: "error", provider: "github-copilot", model: "claude-opus-5.5", errorMessage: "400 too many images in this request" }, unnamedApi, {});
  assert.equal(imagesIn((await unnamed.beforeRequest({ messages: many }, unnamedApi, {})).messages).length, 10);

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
  // Seven reads, an image the user attached and the model answered, then another read: a limit of eight.
  const messages = [
    ...reads(7),
    { role: "user", content: [{ type: "text", text: "and this one" }, image()] },
    { role: "assistant", content: [{ type: "text", text: "seen" }], stopReason: "stop", provider: "github-copilot", model: "claude-opus-5.5" },
    ...reads(9).slice(-2),
  ];
  const result = budgetImages(messages, { maxImages: 8, maxBytes: Infinity });
  assert.match(result[15].content[1].text, /an image the user attached earlier/);
  assert.equal(imagesIn(result).length, 8);
  // One sent while the model works (after a read it has not answered yet): both stay, and the read before makes room.
  const unanswered = [...reads(8), { role: "user", content: [{ type: "text", text: "and this one" }, image()] }];
  const kept = budgetImages(unanswered, { maxImages: 8, maxBytes: Infinity });
  assert.equal(kept.at(-1), unanswered.at(-1));
  assert.equal(kept[16], unanswered[16]);
  assert.match(kept[14].content[1].text, /frame-6\.png\. Read the file again/);
});

test("what a refusal teaches: the limit it names, else half of what was refused, never under what the model has taken (bd-dd9e44)", () => {
  const tooMany = (text) => ({ stopReason: "error", errorMessage: text });
  assert.equal(statedImageLimit(tooMany('400: {"message":"too many images: maximum allowed for model gemini-4-neon is 10","code":"invalid_request_body"}')), 10);
  assert.equal(statedImageLimit(tooMany("400 too many images and documents: 601 + 0 > 600")), 600);
  assert.equal(statedImageLimit(tooMany("400 too many images")), undefined);
  assert.equal(statedImageLimit(tooMany("too many images: maximum allowed is 0")), undefined);
  assert.equal(statedImageLimit(undefined), undefined);
  const none = { maxImages: Infinity, maxBytes: Infinity };
  // Images: the named limit; never more than one under what was refused, nor over what is already known.
  assert.deepEqual(learnedLimits(tooMany("too many images: maximum allowed for model x is 10"), { images: 19, bytes: 9 }), { maxImages: 10, maxBytes: Infinity });
  assert.deepEqual(learnedLimits(tooMany("too many images: maximum allowed for model x is 10"), { images: 8, bytes: 9 }), { maxImages: 7, maxBytes: Infinity });
  assert.deepEqual(learnedLimits(tooMany("too many images: maximum allowed for model x is 10"), { images: 19, bytes: 9 }, { maxImages: 6, maxBytes: 5 }), { maxImages: 6, maxBytes: 5 });
  assert.deepEqual(learnedLimits(tooMany("too many images"), { images: 19, bytes: 9 }), { maxImages: 9, maxBytes: Infinity });
  assert.deepEqual(learnedLimits(tooMany("too many images"), { images: 19, bytes: 9 }, none, { images: 14, bytes: 9 }), { maxImages: 14, maxBytes: Infinity });
  assert.deepEqual(learnedLimits(tooMany("too many images"), { images: 1, bytes: 9 }), { maxImages: 1, maxBytes: Infinity });
  // Size: half of what was refused; what the model has taken when that is more; always under what it refused.
  const tooLarge = { stopReason: "error", errorMessage: "413 Request Entity Too Large" };
  assert.deepEqual(learnedLimits(tooLarge, { images: 19, bytes: 16_000_000 }), { maxImages: Infinity, maxBytes: 8_000_000 });
  assert.deepEqual(learnedLimits(tooLarge, { images: 19, bytes: 16_000_000 }, none, { images: 9, bytes: 5_000_000 }), { maxImages: Infinity, maxBytes: 8_000_000 });
  assert.deepEqual(learnedLimits(tooLarge, { images: 9, bytes: 8_000_000 }, { maxImages: 12, maxBytes: 8_000_000 }, { images: 9, bytes: 5_000_000 }), { maxImages: 12, maxBytes: 5_000_000 });
  assert.deepEqual(learnedLimits(tooLarge, { images: 9, bytes: 5_300_000 }, none, { images: 9, bytes: 5_200_000 }), { maxImages: Infinity, maxBytes: 5_200_000 });
  assert.deepEqual(learnedLimits(tooLarge, { images: 9, bytes: 5_300_000 }, none, { images: 9, bytes: 6_000_000 }), { maxImages: Infinity, maxBytes: 5_299_999 });
  assert.deepEqual(learnedLimits(tooLarge, { images: 1, bytes: 1 }), { maxImages: Infinity, maxBytes: 1 });
  assert.deepEqual(learnedLimits(tooLarge, { images: 19, bytes: 16_000_000 }, { maxImages: 10, maxBytes: 3_000_000 }), { maxImages: 10, maxBytes: 3_000_000 });
});

test("the limits are those of the model the request goes to, on the first request after a model switch too (bd-dd9e44)", async () => {
  const fable = { provider: "github-copilot", model: "claude-fable-5.2" };
  const NEON = "github-copilot/gemini-4-neon";
  const declared = { "github-copilot/claude-fable-5.2": { images: { maxPerRequest: 600 }, maxRequestBytes: 32 * MiB }, [NEON]: { images: { maxPerRequest: 10 }, maxRequestBytes: 4 * MiB } };
  const neonModel = { provider: "github-copilot", id: "gemini-4-neon", inputLimits: declared[NEON] };
  // Nineteen frames read on Claude: the conversation's last answer is Claude's.
  const messages = reads(19, 100, fable);
  const api = (conversationId) => ({ ...fakeApi(declared), conversationId });

  // The host names the model (pi-daemon's request.model): the first request after the switch is within Neon's limits.
  const told = hookOf();
  const first = await told.beforeRequest({ messages, model: neonModel }, api(1), {});
  assert.equal(imagesIn(first.messages).length, 10);
  assert.equal(first.messages[2], messages[2], "the first frames stay as they were sent");
  // Its own limits, not the catalog's entry of that name.
  assert.equal(imagesIn((await told.beforeRequest({ messages, model: { ...neonModel, inputLimits: { images: { maxPerRequest: 4 } } } }, api(1), {})).messages).length, 4);
  // A model named without a provider or an id is no model: the conversation's last answer's, as before.
  assert.equal(await told.beforeRequest({ messages, model: { id: "gemini-4-neon" } }, api(1), {}), undefined);

  // A host that does not name it: the first request goes by the last answer (Claude's limits)...
  const untold = hookOf();
  const one = api(2);
  assert.equal(await untold.beforeRequest({ messages }, one, {}), undefined);
  // ...the provider request is seen to go to Neon, and Neon refuses it...
  assert.equal(untold.beforeProviderRequest({ model: neonModel, payload: {} }, one), undefined);
  await untold.afterResponse({ role: "assistant", stopReason: "error", provider: "github-copilot", model: "gemini-4-neon", errorMessage: '400: {"message":"too many images: maximum allowed for model gemini-4-neon is 10"}' }, one, {});
  // ...and the retry, with no answer of Neon's in the conversation yet, is built to Neon's limits.
  assert.equal(imagesIn((await untold.beforeRequest({ messages }, api(2), {})).messages).length, 10);
  // Another conversation, still on Claude, is not affected.
  assert.equal(await untold.beforeRequest({ messages }, api(3), {}), undefined);
  // The host's word comes first: the conversation moved back to Claude, and it says so.
  const fableModel = { provider: "github-copilot", id: "claude-fable-5.2", inputLimits: declared["github-copilot/claude-fable-5.2"] };
  assert.equal(await untold.beforeRequest({ messages, model: fableModel }, api(2), {}), undefined);
  // Hook APIs without a conversation, or a provider request without a model, change nothing.
  assert.equal(untold.beforeProviderRequest({ payload: {} }, api(3)), undefined);
  assert.equal(untold.beforeProviderRequest({ model: neonModel, payload: {} }, {}), undefined);
  assert.equal(await untold.beforeRequest({ messages }, api(3), {}), undefined);
});

test("a request the model answered is the least a later refusal for size leaves", async () => {
  const neon = { provider: "github-copilot", model: "gemini-4-neon" };
  const hook = hookOf();
  // Five images of 1 MiB go and are answered.
  const five = reads(5, 1024, neon);
  const api = fakeApi();
  assert.equal(await hook.beforeRequest({ messages: five }, api, {}), undefined);
  await hook.afterResponse({ role: "assistant", stopReason: "stop", ...neon, content: [] }, api, {});
  // Six are refused. Half of them would be three; the model has taken the weight of five, so four go with the sixth read's text.
  const six = reads(6, 1024, neon);
  const next = fakeApi();
  assert.equal(await hook.beforeRequest({ messages: six }, next, {}), undefined);
  await hook.afterResponse({ role: "assistant", stopReason: "error", ...neon, errorMessage: "413 Request Entity Too Large" }, next, {});
  const retry = (await hook.beforeRequest({ messages: six }, fakeApi(), {})).messages;
  assert.equal(imagesIn(retry).length, 4);
  assert.ok(requestWeight(retry).bytes <= requestWeight(five).bytes);
  // An error that is not for its size, or an aborted request, is not an answer.
  const other = hookOf();
  for (const stopReason of ["error", "aborted"]) {
    const attempt = fakeApi();
    await other.beforeRequest({ messages: six }, attempt, {});
    await other.afterResponse({ role: "assistant", stopReason, ...neon, errorMessage: "500 internal" }, attempt, {});
  }
  const refusedApi = fakeApi();
  await other.beforeRequest({ messages: six }, refusedApi, {});
  await other.afterResponse({ role: "assistant", stopReason: "error", ...neon, errorMessage: "413 Request Entity Too Large" }, refusedApi, {});
  assert.equal(imagesIn((await other.beforeRequest({ messages: six }, fakeApi(), {})).messages).length, 2);
});

test("the operator's defaults stand in for what a model does not declare, and for nothing it does", async () => {
  assert.deepEqual(imageBudgetDefaultsFromEnv({}), { maxImages: Infinity, maxBytes: Infinity });
  assert.deepEqual(imageBudgetDefaultsFromEnv({ PI_IMAGE_BUDGET_DEFAULT_IMAGES: "10", PI_IMAGE_BUDGET_DEFAULT_MB: "4", PI_IMAGE_BUDGET_IMAGES: "2" }), { maxImages: 10, maxBytes: 4 * MiB });
  const hook = createImageBudgetExtension(imageBudgetFromEnv({}), { maxImages: 10, maxBytes: 4 * MiB }).hooks[0].handlers;
  const kept = async (messages, limits) => imagesIn((await hook.beforeRequest({ messages }, fakeApi(limits), {}))?.messages ?? messages).length;
  // A model that declares nothing: ten images, and four MiB.
  assert.equal(await kept(reads(30)), 10);
  assert.equal(await kept(reads(6, 1024)), 2);
  // One that declares its images keeps them, and the default size; one that declares both keeps both.
  assert.equal(await kept(reads(30), { [OPUS]: { images: { maxPerRequest: 600 } } }), 30);
  assert.equal(await kept(reads(6, 1024), { [OPUS]: { images: { maxPerRequest: 600 } } }), 2);
  assert.equal(await kept(reads(6, 1024), { [OPUS]: { images: { maxPerRequest: 4 }, maxRequestBytes: 32 * MiB } }), 4);
});

test("whatever the conversation, the request is within the limits while more than one image is left, and what left stays out", () => {
  // A small generator with a fixed seed: the same conversations every run.
  let seed = 20261124;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const model = { provider: "github-copilot", model: "gemini-4-neon" };
  let made = 0;
  const picture = () => frame(`random-${(made += 1)}`, 20 + random(400));
  for (let trial = 0; trial < 200; trial += 1) {
    const messages = [{ role: "user", content: "Look", timestamp: 1 }];
    const rounds = 1 + random(25);
    for (let round = 0; round < rounds; round += 1) {
      const kind = random(10);
      if (kind === 0) {
        messages.push({ role: "user", content: [{ type: "text", text: "x".repeat(random(50_000)) }, ...(random(2) === 0 ? [picture()] : [])] });
        continue;
      }
      const calls = 1 + (kind === 1 ? random(14) : 0);
      messages.push({ role: "assistant", content: Array.from({ length: calls }, (_, i) => ({ type: "toolCall", id: `c-${trial}-${round}-${i}`, name: "read", arguments: { path: `/tmp/f/${round}-${i}.png` } })), stopReason: "toolUse", ...model });
      for (let i = 0; i < calls; i += 1) {
        const content = [{ type: "text", text: "y".repeat(random(20_000)) }];
        if (random(4) !== 0) content.push(picture());
        if (random(12) === 0) content.push(picture());
        messages.push({ role: "toolResult", toolCallId: `c-${trial}-${round}-${i}`, toolName: "read", content, isError: false });
      }
    }
    const limits = { maxImages: random(3) === 0 ? Infinity : 1 + random(12), maxBytes: random(3) === 0 ? Infinity : (1 + random(40)) * 100 * KiB };
    const request = budgetImages(messages, limits);
    const weight = requestWeight(request);
    const label = `trial ${trial}: ${JSON.stringify(limits)}`;
    assert.ok(weight.images <= limits.maxImages, `${label} keeps ${weight.images} images`);
    if (weight.images > 1) assert.ok(weight.bytes <= limits.maxBytes, `${label} weighs ${weight.bytes}`);
    // Nothing leaves for a limit that is not met.
    if (requestWeight(messages).images <= limits.maxImages && requestWeight(messages).bytes <= limits.maxBytes) assert.equal(request, messages, label);
    // Messages that keep their images are the transcript's own objects, and the transcript is not changed.
    request.forEach((message, index) => {
      if (imagesIn([message]).length === imagesIn([messages[index]]).length) assert.equal(message, messages[index], label);
    });
    // What had left at any earlier point of the conversation is still out.
    const all = droppedImages(messages, limits);
    for (const cut of [random(messages.length) + 1, random(messages.length) + 1]) {
      for (const index of droppedImages(messages.slice(0, cut), limits)) assert.ok(all.has(index), `${label}: image ${index} left at ${cut} messages and came back`);
    }
  }
});
