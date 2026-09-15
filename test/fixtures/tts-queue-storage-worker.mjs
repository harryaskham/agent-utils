import { MachineTtsQueue } from "../../extensions/lib/tts-queue.js";

const [root, maxBytes, size] = process.argv.slice(2);
const queue = new MachineTtsQueue({
  root, maxBytes: Number(maxBytes), pollMs: 10,
  player: { interrupt() {}, async play() { throw new Error("test blocker must keep playback occupied"); } },
});
process.on("message", async (message) => {
  if (message === "enqueue") {
    const pending = queue.enqueue(Buffer.alloc(Number(size), 42));
    while (queue.admitting.has(pending.jobId)) await new Promise((resolve) => setTimeout(resolve, 10));
    process.send({ type: "admitted", id: pending.jobId, storage: queue.storage });
  } else if (message === "stop") {
    queue.stop();
    await queue.maintenance?.catch(() => {});
    process.exit(0);
  }
});
process.send({ type: "ready" });
