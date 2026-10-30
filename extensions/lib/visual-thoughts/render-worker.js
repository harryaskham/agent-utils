// Visual thoughts' render thread: the render core behind a message port.
import { parentPort, workerData } from "node:worker_threads";

import { createRenderCore } from "./render-core.js";

const core = createRenderCore(workerData || {});
parentPort.on("message", (message) => {
  const reply = core.handle(message);
  parentPort.postMessage(reply);
});
