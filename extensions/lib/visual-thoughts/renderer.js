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

/**
 * The renderer thread (or in-thread core) for one transport, shared: every backdrop gets a
 * context of its own on it. Kept while any context is open.
 */
function createRendererProcess({ transport, useWorker, onError }) {
  const dir = frameDirectory();
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

  return {
    get threaded() { return Boolean(worker); },
    request(message, transfer = []) {
      if (closed) return Promise.reject(new Error("renderer closed"));
      ref += 1;
      const tagged = { ...message, ref };
      return new Promise((resolve, reject) => {
        pending.set(ref, { resolve, reject });
        if (worker) worker.postMessage(tagged, transfer);
        else setImmediate(() => settle(local.handle(tagged)));
      });
    },
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

const shared = new Map(); // `${transport}:${worker}` → { process, users }
let contextSeq = 0;

/**
 * A renderer for one backdrop: a context on the shared renderer thread for its transport.
 * `close()` releases the context; the thread stops with the last one.
 */
export function createRenderer({ transport = "file", useWorker = true, onError = () => {} } = {}) {
  const key = `${transport}:${useWorker ? "worker" : "inline"}`;
  let entry = shared.get(key);
  if (!entry) {
    entry = { process: createRendererProcess({ transport, useWorker, onError }), users: 0 };
    shared.set(key, entry);
  }
  entry.users += 1;
  contextSeq += 1;
  const ctx = `c${contextSeq}`;
  const owner = entry;
  let closed = false;
  const request = (message, transfer) => (closed ? Promise.reject(new Error("renderer closed")) : owner.process.request({ ...message, ctx }, transfer));
  return {
    get threaded() { return owner.process.threaded; },
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
    /** The PNG `png`, scaled down until it is at most `maxBytes` (on the renderer thread). */
    fitPng: (png, maxBytes) => {
      const bytes = new Uint8Array(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
      return request({ type: "fitPng", png: bytes, maxBytes }, [bytes.buffer]);
    },
    close() {
      if (closed) return;
      void owner.process.request({ type: "release", ctx }).catch(() => {});
      closed = true;
      owner.users -= 1;
      if (owner.users <= 0) {
        owner.process.close();
        if (shared.get(key) === owner) shared.delete(key);
      }
    },
  };
}
