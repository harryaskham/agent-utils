// Visual thoughts: which image the backdrop shows, and when it crossfades to another.
//
// Images arrive in batches, one per agent run (a reply to a prompt). The rotation cycles the
// newest batch's images, each held for `holdMs` and crossfaded over `fadeMs`; while that batch
// has fewer than `minSet` images, the most recent earlier ones fill the cycle, so between runs
// there is always recent imagery and a new run's images take over one by one. A new image is
// shown as soon as the current one has had `minShowMs`. Pure: the caller supplies the time.

export function createRotation({ holdMs = 15_000, fadeMs = 3_000, minShowMs = 4_000, minSet = 3, maxImages = 8 } = {}) {
  const options = { holdMs, fadeMs, minShowMs, minSet, maxImages };
  /** Oldest first: { id, batch }. */
  let images = [];
  let current = null;
  let transition = null; // { from, to, start }
  let shownAt = 0;
  let pending = null; // a new image to show next
  let batch = 0;

  const has = (id) => images.some((image) => image.id === id);

  /** The images the cycle visits, oldest first. */
  function members() {
    const newest = images.filter((image) => image.batch === batch);
    const latest = newest.length ? newest : (() => {
      const top = Math.max(-Infinity, ...images.map((image) => image.batch));
      return images.filter((image) => image.batch === top);
    })();
    if (latest.length >= options.minSet) return latest;
    const earlier = images.filter((image) => !latest.includes(image)).slice(-(options.minSet - latest.length));
    return [...earlier, ...latest];
  }

  function prune() {
    while (images.length > options.maxImages) {
      const index = images.findIndex((image) => image.id !== current && image.id !== transition?.to && image.id !== transition?.from && image.id !== pending);
      if (index < 0) break;
      images.splice(index, 1);
    }
  }

  function start(from, to, now) {
    transition = { from, to, start: now };
  }

  return {
    get options() { return { ...options }; },
    configure(next = {}) {
      for (const key of Object.keys(options)) {
        if (Number.isFinite(next[key]) && next[key] >= 0) options[key] = next[key];
      }
      options.minSet = Math.max(1, Math.trunc(options.minSet));
      options.maxImages = Math.max(1, Math.trunc(options.maxImages));
      prune();
    },
    /** A new agent run: its images form the next batch. */
    newBatch() { batch += 1; return batch; },
    get batch() { return batch; },
    /** An image ready to show, in `image.batch` (default the current one). */
    add(image, now) {
      if (!image?.id || has(image.id)) return;
      images.push({ id: image.id, batch: Number.isFinite(image.batch) ? image.batch : batch });
      pending = image.id;
      prune();
      return this.tick(now);
    },
    /** Show `id` next (after the current image's minimum), as a newly added image would be. */
    focus(id, now) {
      if (!has(id) || id === current) return this.tick(now);
      pending = id;
      return this.tick(now);
    },
    remove(id) {
      images = images.filter((image) => image.id !== id);
      if (pending === id) pending = null;
      if (transition && (transition.to === id || transition.from === id)) transition = null;
      if (current === id) current = null;
    },
    clear() { images = []; current = null; transition = null; pending = null; },
    /** Show the next image in the cycle now (after any crossfade in progress). */
    skip(now) {
      if (transition) return this.tick(now);
      const cycle = members();
      if (cycle.length < 2 && !(cycle.length === 1 && cycle[0].id !== current)) return this.tick(now);
      const at = cycle.findIndex((image) => image.id === current);
      const next = cycle[(at + 1) % cycle.length];
      if (next && next.id !== current) start(current, next.id, now);
      return this.tick(now);
    },
    /**
     * What to draw at `now`: `{ from, to, t }` during a crossfade (`from` null fades in),
     * `{ id }` when holding, or null with nothing to show.
     */
    tick(now) {
      if (transition) {
        if (!has(transition.to)) transition = null;
        else {
          const t = options.fadeMs > 0 ? (now - transition.start) / options.fadeMs : 1;
          if (t < 1) return { from: transition.from && has(transition.from) ? transition.from : null, to: transition.to, t: Math.max(0, t) };
          current = transition.to;
          transition = null;
          shownAt = now;
          if (pending === current) pending = null;
        }
      }
      if (current && !has(current)) current = null;
      if (!current) {
        const first = pending && has(pending) ? pending : members().at(-1)?.id;
        if (!first) return null;
        if (pending === first) pending = null;
        start(null, first, now);
        return this.tick(now);
      }
      const held = now - shownAt;
      if (pending && pending !== current && has(pending) && held >= options.minShowMs) {
        const to = pending;
        pending = null;
        start(current, to, now);
        return this.tick(now);
      }
      if (pending === current) pending = null;
      const cycle = members();
      if (held >= options.holdMs && cycle.length > 1) {
        const at = cycle.findIndex((image) => image.id === current);
        // Not in the cycle any more (an older batch's image): go to the cycle's newest.
        const next = at < 0 ? cycle.at(-1) : cycle[(at + 1) % cycle.length];
        if (next && next.id !== current) {
          start(current, next.id, now);
          return this.tick(now);
        }
      }
      if (held >= options.holdMs && cycle.length === 1 && cycle[0].id !== current) {
        start(current, cycle[0].id, now);
        return this.tick(now);
      }
      return { id: current };
    },
    /** Milliseconds until the picture next changes (Infinity: not until an image arrives). */
    wakeIn(now) {
      if (transition) return 0;
      if (!current) return images.length ? 0 : Infinity;
      const held = now - shownAt;
      let wake = Infinity;
      if (pending && pending !== current) wake = Math.max(0, options.minShowMs - held);
      const cycle = members();
      if (cycle.length > 1 || (cycle.length === 1 && cycle[0].id !== current)) wake = Math.min(wake, Math.max(0, options.holdMs - held));
      return wake;
    },
    status() {
      return {
        images: images.length,
        batch,
        current,
        cycle: members().map((image) => image.id),
        fading: Boolean(transition),
        pending,
      };
    },
    /** Image ids, oldest first. */
    ids() { return images.map((image) => image.id); },
  };
}
