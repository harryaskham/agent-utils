// On-demand Nix dev shells without direnv startup or persistent project GC roots.

import { createBashTool, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { createNixDevshellExtension } from "./lib/nix-devshell-extension.js";
import { shouldRegisterNixDevshell } from "./lib/nix-devshell.js";

const register = createNixDevshellExtension({
  createBashToolFactory: createBashTool,
  localBashOperations: createLocalBashOperations,
});

export default function nixDevshellExtension(pi) {
  // An inherited devshell is already authoritative. Do not replace the Bash
  // tool or register redundant controls; disabling an on-demand layer cannot
  // improve a shell Pi inherited before extension startup.
  if (!shouldRegisterNixDevshell(process.env)) return;
  return register(pi);
}
