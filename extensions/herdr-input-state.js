// Adapt Pi's standard blocking-UI lifecycle to Herdr's existing state owner.
// Do not publish pane status directly or introduce a choice-specific state path.
export default function herdrInputState(pi) {
  let blocked = false;
  function end() {
    if (!blocked) return;
    blocked = false;
    pi.events.emit("herdr:blocked", { active: false });
  }
  pi.on("ui_prompt_start", (event, ctx) => {
    if (blocked || ctx.mode !== "tui") return;
    blocked = true;
    pi.events.emit("herdr:blocked", { active: true, label: event.title || "Waiting for input" });
  });
  pi.on("ui_prompt_end", end);
  pi.on("session_shutdown", end);
}
