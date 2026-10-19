// `/cd DIR` (bd-aa5717): continue this conversation in another directory, as a new session there.
// The current session stays as it was. pi-daemon sessions get the same command from pi-client.
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";

import { createCdCommand } from "./lib/cd.js";

export default function cdExtension(pi) {
  pi.registerCommand("cd", createCdCommand({ SessionManager, convertToLlm }));
}
