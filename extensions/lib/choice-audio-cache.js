// RAM-only, per-open-choice PCM cache. No queue, file, archive or export adapter.
export class ChoiceAudioCache {
  constructor({ maxBytes = 16 * 1024 * 1024, maxEntries = 32 } = {}) {
    this.maxBytes = maxBytes; this.maxEntries = maxEntries;
    this.scope = null;
  }
  begin(id) {
    this.end();
    this.scope = { id, abort: new AbortController(), entries: new Map(), bytes: 0 };
  }
  end(id) {
    const scope = this.scope;
    if (!scope || (id !== undefined && scope.id !== id)) return;
    this.scope = null;
    scope.abort.abort(); scope.entries.clear(); scope.bytes = 0;
  }
  snapshot() {
    const scope = this.scope;
    return { active: !!scope, entries: scope?.entries.size || 0, bytes: scope?.bytes || 0,
      pending: scope ? [...scope.entries.values()].filter(entry => !entry.pcm).length : 0 };
  }
  async get(key, produce, signal) {
    const scope = this.scope;
    if (!scope) return produce(signal);
    if (signal?.aborted) return null;
    let entry = scope.entries.get(key);
    if (!entry) {
      entry = { pcm: null, promise: null };
      // Bound admission even if a provider is slow. Ordinary choices have <=9
      // options; excess concurrent requests use the caller's cancellation scope.
      if (scope.entries.size >= this.maxEntries && !this.evict(scope)) return produce(signal);
      scope.entries.set(key, entry);
      entry.promise = Promise.resolve().then(() => produce(scope.abort.signal)).then(pcm => {
        if (this.scope !== scope || scope.abort.signal.aborted || !Buffer.isBuffer(pcm) || pcm.length > this.maxBytes) {
          scope.entries.delete(key); return pcm;
        }
        while (scope.bytes + pcm.length > this.maxBytes && this.evict(scope)) {}
        if (scope.bytes + pcm.length <= this.maxBytes) { entry.pcm = pcm; scope.bytes += pcm.length; }
        else scope.entries.delete(key);
        return pcm;
      }, error => { scope.entries.delete(key); throw error; });
    } else {
      scope.entries.delete(key); scope.entries.set(key, entry);
    }
    // Navigation cancels the waiting/playback call, not a useful in-flight cache
    // fill. Choice close, timeout and master mute still cancel the producer.
    let abort;
    try {
      return await Promise.race([entry.promise, new Promise(resolve => {
        abort = () => resolve(null);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      })]);
    } finally { signal?.removeEventListener("abort", abort); }
  }
  evict(scope) {
    for (const [key, entry] of scope.entries) {
      if (!entry.pcm) continue;
      scope.bytes -= entry.pcm.length; scope.entries.delete(key); return true;
    }
    return false;
  }
}
