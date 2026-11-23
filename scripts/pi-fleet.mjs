#!/usr/bin/env node
// pi-fleet (bd-1da117): /fleet from a shell, for agents and scripts. `pi-fleet models '*astra*'`
// lists the sessions on a model across the fleet and the config defaults naming it;
// `--switch provider/model` moves them; `--json` prints the result as JSON. See
// docs/fleet-models.md. Exit status: 0, 1 for a usage or read error, 3 when a switch failed.

import { FLEET_USAGE, runFleet } from "../extensions/lib/fleet-models.js";

const args = process.argv.slice(2);
if (args.length === 0 || ["-h", "--help", "help"].includes(args[0])) {
  console.log(FLEET_USAGE.replace(/\/fleet /g, "pi-fleet "));
  process.exit(0);
}
try {
  const result = await runFleet(args, { progress: (line) => process.stderr.isTTY && process.stderr.write(`${line}\n`) });
  console.log(result.output.replace(/\/fleet models/g, "pi-fleet models"));
  process.exit(result.failed ? 3 : 0);
} catch (error) {
  console.error(`pi-fleet: ${error.message}`);
  process.exit(1);
}
