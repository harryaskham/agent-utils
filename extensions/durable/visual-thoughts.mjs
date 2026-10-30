// Durable adaptor: visual thoughts for pi-daemon sessions (session UI slots, pi-daemon 1.15).
//
// List this file in a pi-daemon profile's `extensions:` (its name, visual-thoughts, owns the
// session's `backdrop` slot). While the agent works, its output is painted once per session,
// server-side, into the backdrop slot, which every client of the session shows: pi-client panes,
// /web and Culture. `/thoughts` (on|off|now|next|clear|status|<setting> <value>) controls a
// session. Behaviour lives in ../lib/durable-visual-thoughts.js; it needs only Node built-ins.
//
// Configuration: `agentUtils.visualThoughts` in Pi's settings.json (enabled, models, look), and
// the worker's LITELLM_BASE_URL / LITELLM_MASTER_KEY for the image and fallback prompt models.
import { createVisualThoughtsModule } from "../lib/durable-visual-thoughts.js";

const INSTANCE = Symbol.for("agent-utils.durable-visual-thoughts.v1");

function start() {
  // pi-daemon re-imports an edited module: stop the previous instance's painting.
  globalThis[INSTANCE]?.dispose?.();
  const instance = createVisualThoughtsModule();
  globalThis[INSTANCE] = instance;
  return instance;
}

const module = start();

export const commands = module.commands;
export function observe(event, info) {
  return module.observe(event, info);
}
