// /fleet models (bd-1da117) for pi-daemon sessions (pi-client, the web view, Culture, AHP
// clients): which sessions across the fleet use which model, `--switch` to move them, and the
// config defaults that still name a model. See docs/fleet-models.md.
//
// List this file in a pi-daemon profile's `extensions:`. It runs on the session's host: hosts come
// from Pi's settings.json `client.hosts` there (this host over PI_DAEMON_URL, or loopback), with the
// bearer in PI_DAEMON_TOKEN_FILE or `client.tokenFile`; Cacophony agents and Cacophony's config go
// through that host's `caco` (CACO_BIN). The report is the command's notices. Needs only Node
// built-ins.

import { FLEET_USAGE, chunkText, enabledModels, fleetCompletions, runFleet } from "../lib/fleet-models.js";

/** pi-daemon keeps 32 notices of 16 KiB from one run: a long report goes in parts, and says what did not fit. */
export const MAX_NOTICES = 32;

/**
 * The report as notices. Clients render notices as Markdown, where `*astra*` is italic and two
 * `~/` paths on a line strike through, so each part is a plain-text block.
 */
export function noticesOf(text) {
  const fence = (chunk) => `\`\`\`text\n${chunk.replace(/^```/gm, "\u200b```")}\n\`\`\``;
  const chunks = chunkText(text, 15_000);
  if (chunks.length <= MAX_NOTICES) return chunks.map(fence);
  const shown = chunks.slice(0, MAX_NOTICES - 1).map(fence);
  const left = chunks.slice(MAX_NOTICES - 1).reduce((lines, chunk) => lines + chunk.split("\n").length, 0);
  return [...shown, `… ${left} more lines did not fit in this session's notices. Narrow it (\`--host\`, \`--since\`, \`--profile\`) or run \`pi-fleet models … --json\` on a shell.`];
}

/** /fleet, with its effects injectable for tests. */
export function createFleetCommand(deps = {}) {
  const env = deps.env ?? process.env;
  const run = deps.runFleet ?? runFleet;
  return {
    description: "Which sessions across the fleet use which model: /fleet models '*astra*', --switch provider/model to move them",
    getArgumentCompletions(prefix) {
      return fleetCompletions(prefix, { models: enabledModels(env) });
    },
    async run(args, ctx) {
      try {
        const result = await run(args, { ...deps, env });
        for (const notice of noticesOf(result.output)) ctx.notify(notice);
      } catch (error) {
        ctx.notify(`/fleet: ${error.message}\n\n\`\`\`text\n${FLEET_USAGE}\n\`\`\``);
      }
    },
  };
}

export const commands = { fleet: createFleetCommand() };
