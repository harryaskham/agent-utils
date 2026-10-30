// Visual thoughts: the main thread's handle on the renderer. Requests are promises; the render
// core runs on a worker thread, or in this thread when workers are unavailable (slower, but the
// same frames).
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { createRenderCore } from "./render-core.js";

/**
 * Where frame files go: the system temp dir itself. Terminals read and delete `t=t` files only
 * from a temp dir whose name says `tty-graphics-protocol`; the frame files are named so.
 */
export function frameDirectory() {
  return tmpdir();
}

export function createRenderer({ transport = "file", useWorker = true, onError = () => {} } = {}) {
  const dir = transport === "file" ? frameDirectory() : tmpdir();
  const pending = new Map();
  let ref = 0;
  let worker = null;
  let local = null;
  let closed = false;

  function settle(reply) {
    const entry = pending.get(reply?.ref);
    if (!entry) return;
    pending.delete(reply.ref);
    if (reply.type === "error") entry.reject(new Error(reply.error));
    else entry.resolve(reply);
  }

  if (useWorker) {
    try {
      worker = new Worker(new URL("./render-worker.js", import.meta.url), { workerData: { dir, transport } });
      worker.unref?.();
      worker.on("message", settle);
      worker.on("error", (error) => {
        onError(error);
        worker = null;
        local = createRenderCore({ dir, transport });
        for (const [, entry] of pending) entry.reject(error);
        pending.clear();
      });
    } catch (error) {
      onError(error);
      worker = null;
    }
  }
  if (!worker) local = createRenderCore({ dir, transport });

  function request(message, transfer = []) {
    if (closed) return Promise.reject(new Error("renderer closed"));
    ref += 1;
    const tagged = { ...message, ref };
    return new Promise((resolve, reject) => {
      pending.set(ref, { resolve, reject });
      if (worker) worker.postMessage(tagged, transfer);
      else setImmediate(() => settle(local.handle(tagged)));
    });
  }

  return {
    get threaded() { return Boolean(worker); },
    transport,
    configure: (options) => request({ type: "configure", ...options }),
    add: (id, png) => {
      const bytes = new Uint8Array(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
      return request({ type: "add", id, png: bytes }, [bytes.buffer]);
    },
    hold: (id) => request({ type: "hold", id }),
    drop: (id) => request({ type: "drop", id }),
    begin: (options) => request({ type: "begin", ...options }),
    frame: (seq, k, t) => request({ type: "frame", seq, k, t }),
    end: (seq) => request({ type: "end", seq }),
    close() {
      closed = true;
      for (const [, entry] of pending) entry.reject(new Error("renderer closed"));
      pending.clear();
      void worker?.terminate();
      worker = null;
      // Frame files the terminal never read.
      if (transport === "file") {
        const prefix = `tty-graphics-protocol-vt-${process.pid}-`;
        try { for (const name of readdirSync(dir)) if (name.startsWith(prefix)) rmSync(join(dir, name), { force: true }); } catch {}
      }
    },
  };
}
