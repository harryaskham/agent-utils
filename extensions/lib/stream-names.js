// Pulse client and stream names for agent speech and voice input, so a mixer shows who speaks and
// who listens: `/tts:mac-utils`, `/narrate:mac-utils`, `/choices:mac-utils`, `/call:mac-utils`,
// `/stt:…`, `/ptt:…`. The label is the session's name when it has one, else a short session id.

const MAX_LABEL = 48;

/** A session's label: its name, else the first 8 characters of its id (without chord-), else "". */
export function sessionLabel({ name, sessionId } = {}) {
  const named = String(name ?? "").trim();
  if (named) return named;
  const id = String(sessionId ?? "").trim().replace(/^chord-/, "");
  return id ? id.slice(0, 8) : "";
}

/** `/KIND:LABEL` (or `/KIND` without a label), safe as a Pulse client or stream name. */
export function speechStreamName(kind, label) {
  const base = `/${String(kind ?? "").replace(/^\/+/, "")}`;
  const clean = String(label ?? "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, MAX_LABEL);
  return clean ? `${base}:${clean}` : base;
}
