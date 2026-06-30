// AssistantMessageEventStream — minimal hand-rolled fallback that matches
// pi-ai's protocol. We avoid importing @earendil-works/pi-ai because it is not
// declared in extensions/package.json; pi's loader resolves it at runtime
// for handler arguments but not for our `import`.  Keeping a local impl is
// also nice for stability. Extracted from realtime-agent.js (bd-e1914a) as a
// self-contained async-iterable event queue (no ctx/module state/imports).

export class AssistantMessageEventStream {
  constructor() {
    this._queue = [];
    this._waiting = [];
    this._done = false;
    this._finalResult = null;
    this._finalResolve = null;
    this._finalPromise = new Promise((r) => (this._finalResolve = r));
  }

  push(event) {
    if (this._done) return;
    if (event.type === "done" || event.type === "error") {
      this._done = true;
      const final = event.type === "done" ? event.message : event.error;
      this._finalResult = final;
      this._finalResolve(final);
    }
    const waiter = this._waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this._queue.push(event);
  }

  end(result) {
    this._done = true;
    if (result !== undefined && this._finalResolve) {
      this._finalResult = result;
      this._finalResolve(result);
    }
    while (this._waiting.length > 0) {
      const w = this._waiting.shift();
      w({ value: undefined, done: true });
    }
  }

  result() { return this._finalPromise; }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this._queue.length > 0) {
        yield this._queue.shift();
      } else if (this._done) {
        return;
      } else {
        const r = await new Promise((resolve) => this._waiting.push(resolve));
        if (r.done) return;
        yield r.value;
      }
    }
  }
}
