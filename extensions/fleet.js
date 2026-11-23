// /fleet models (bd-1da117) for TUI Pi and pi-client: which sessions across the fleet use which
// model, `--switch` to move them, and the config defaults that still name a model. See
// docs/fleet-models.md. The same file is a pi-client client extension (`client.extensions`): it
// registers a command and notifies, nothing agent-side, and runs on the client's machine, reading
// that machine's settings.json `client.hosts`. pi-daemon sessions get /fleet from
// extensions/durable/fleet.mjs.

import { FLEET_USAGE, enabledModels, fleetCompletions, runFleet } from "./lib/fleet-models.js";

const STATUS = "agent-utils-fleet";

/** /fleet's handler, with its effects injectable for tests. */
export function createFleetHandler(deps = {}) {
  const run = deps.runFleet ?? runFleet;
  return async function handleFleet(args, ctx) {
    const notify = (text, level = "info") => ctx.ui?.notify?.(text, level);
    const status = (text) => {
      try {
        ctx.ui?.setStatus?.(STATUS, text);
      } catch {}
    };
    try {
      const result = await run(args, { ...deps, progress: (line) => status(`⇄ ${line}`) });
      notify(result.output, result.failed ? "warning" : "info");
    } catch (error) {
      notify(`/fleet: ${error.message}\n\n${FLEET_USAGE}`, "error");
    } finally {
      status(undefined);
    }
  };
}

export default function fleetExtension(pi, deps = {}) {
  const env = deps.env ?? process.env;
  pi.registerCommand("fleet", {
    description: "Which sessions across the fleet use which model: /fleet models '*astra*', --switch provider/model to move them",
    getArgumentCompletions: (prefix) => fleetCompletions(prefix, { models: enabledModels(env) }),
    handler: createFleetHandler(deps),
  });
}
