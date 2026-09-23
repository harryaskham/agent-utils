// Explicit operator privacy policy. Read at use time for logical-session hosts.
const truthy = (value) => ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
const disabled = (value) => ["0", "false", "no", "off", "disabled"].includes(String(value ?? "").trim().toLowerCase());
export function isIncognito(env = process.env) { return truthy(env.PI_INCOGNITO); }
export function sharedTtsQueueEnabled(env = process.env) { return !isIncognito(env) && !disabled(env.PI_TTS_QUEUE_ENABLED); }
export function ttsFeedEnabled(env = process.env) { return !isIncognito(env) && !disabled(env.PI_TTS_FEED_ENABLED); }
export function sharedImagesEnabled(env = process.env) { return !isIncognito(env) && !disabled(env.PI_SHARED_IMAGES_ENABLED); }
