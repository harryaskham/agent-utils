# Pi extension capability boundaries

Practical notes for `agent-utils` extension authors on what a Pi extension can
and cannot intercept, and where extension context (`ctx`) is and is not
available. These boundaries are easy to rediscover the hard way by spelunking
through the Pi runtime in `node_modules`; this page captures them so future
extensions don't have to.

> Status: field notes reverse-engineered while building the `/m` model switcher
> (see [`extensions/m.js`](../extensions/m.js)) and related slash commands. The
> registry-capture and completion details below are pinned to actual extension
> code; the slash-command interception boundary reflects observed Pi TUI
> behavior and may shift as Pi core evolves — verify against the current Pi
> runtime before relying on it for a new builtin.

## Slash commands: builtin vs. extension `input` interception

- **Extensions cannot override a Pi builtin slash command.** The TUI submit
  handler consumes recognized builtins (for example `/model`) before any
  extension `input` event fires. Registering an `input` listener and trying to
  rewrite or swallow `/model` does not work, because the builtin has already
  been routed by the time the extension sees input.
- **Register a differently-named command instead.** This is exactly why
  [`extensions/m.js`](../extensions/m.js) exposes `/m` rather than overriding
  `/model`: `/model` is a builtin coupled to the scoped-models feature
  (`interactive-mode.js` `getModelCandidates` resolves `/model <arg>` against the
  scoped/`enabledModels` set), so an extension that wants to switch to *any*
  model regardless of scope must own its own command surface (`/m`) via
  `pi.registerCommand(...)`.
- **Rule of thumb:** to *augment* builtin behavior, add a new command (or a new
  tool); do not assume an `input` handler can pre-empt a builtin the TUI already
  recognizes.

## `getArgumentCompletions` has no `ctx`

- The `getArgumentCompletions(prefix)` callback on a registered command receives
  **only the argument prefix** — it does **not** receive an extension `ctx`. So
  anything a completion needs from the runtime (for example the model registry)
  must be captured earlier and closed over.
- **Capture runtime state at `session_start`.** `extensions/m.js` does this:

  ```js
  let completionRegistry;
  // getArgumentCompletions receives only the prefix (no ctx), so capture the
  // registry from session_start for completion listing. The handler always has
  // ctx.modelRegistry directly, so switching works even before this is set.
  pi.on?.("session_start", (_event, ctx) => {
    if (ctx?.modelRegistry) completionRegistry = ctx.modelRegistry;
  });

  pi.registerCommand?.("m", {
    getArgumentCompletions: (prefix) => {
      // uses completionRegistry captured above, not a ctx arg
    },
    async execute(_id, args, _signal, _onUpdate, ctx) {
      // execute() DOES get ctx (as the 5th arg), so the live ctx.modelRegistry is used here
    },
  });
  ```

- **`execute()` does get `ctx`.** Only the *completion* path is ctx-less, so the
  command can still function (e.g. switch models) before any `session_start` has
  populated the captured registry; only tab-completion listing depends on the
  captured value.
- **Re-capture on reload.** `session_start` fires again after a session
  replacement/reload, so closing over the latest `ctx` value (rather than a
  one-shot capture) keeps completions valid across reloads.

## Summary

| Surface | Gets `ctx`? | Notes |
| --- | --- | --- |
| `execute(id, args, signal, onUpdate, ctx)` | Yes | `ctx` is the **5th** arg; use `ctx.modelRegistry` etc. directly. |
| `getArgumentCompletions(prefix)` | No | Capture needed state at `session_start`. |
| `pi.on("session_start", (e, ctx) => …)` | Yes | Re-fires after reload; refresh captured state here. |
| Overriding a builtin slash command (e.g. `/model`) | n/a | Not possible; the TUI consumes builtins before the extension `input` event. Register a new command name instead. |
