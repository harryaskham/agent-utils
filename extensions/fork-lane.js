// Fork lanes (bd-fd98a3): `/clone [NAME] [focus=TEXT] [mode=work|qa]` in TUI Pi, and a qa fork's
// refusal of edits. pi-daemon sessions get lanes from pi-git (/git wt fork, /git fork).
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createForkLaneExtension } from "./lib/fork-lane-extension.js";

export default createForkLaneExtension({ SessionManager });
