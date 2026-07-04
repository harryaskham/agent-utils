// Live-transcription editor mirror (bd-0c008d): stream partial transcripts into
// the core input editor so the operator sees their words appear as they speak,
// and can edit them. Clobber-protection ensures a manual edit is never
// overwritten by a later partial (we only write while the editor still matches
// our own last write). On commit, the CURRENT editor text is returned (honoring
// any edits) and the editor is cleared. The `ui` object is injected (ctx.ui) so
// this is unit-testable without a live TUI; all ui calls are guarded.

export function makeEditorTranscriptMirror(ui) {
  // `lastSet` is the exact text we last wrote to the editor. null means we do
  // not currently "own" the editor content (fresh, or the user has taken over).
  let lastSet = null;

  const get = () => {
    try {
      return String(ui?.getEditorText?.() ?? "");
    } catch {
      return "";
    }
  };
  const set = (text) => {
    try {
      ui?.setEditorText?.(String(text ?? ""));
      return true;
    } catch {
      return false;
    }
  };

  return {
    /// Show a live partial in the editor. Writes only when the editor is empty
    /// or still equals our last write, so a manual edit is never clobbered.
    /// Returns true when it wrote, false when it deferred to the user's edit.
    showPartial(text) {
      const t = String(text ?? "");
      const cur = get();
      if (cur === "" || cur === lastSet) {
        set(t);
        lastSet = t;
        return true;
      }
      return false; // user has edited the editor; leave their text intact
    },

    /// Finalize the turn: return the current editor text (honoring user edits),
    /// clear the editor, and relinquish ownership. Falls back to `fallback`
    /// (the raw transcript) only when the editor is empty.
    takeFinal(fallback = "") {
      const cur = get().trim();
      const out = cur || String(fallback ?? "").trim();
      set("");
      lastSet = null;
      return out;
    },

    /// Relinquish ownership without touching the editor (e.g. on stop): whatever
    /// the user is looking at stays put for them to edit/send manually.
    release() {
      lastSet = null;
    },

    /// Whether we currently own the editor content (last write not user-edited).
    owns() {
      return lastSet !== null && get() === lastSet;
    },
  };
}
