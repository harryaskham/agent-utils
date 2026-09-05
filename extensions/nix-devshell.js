// On-demand Nix dev shells without direnv startup or persistent project GC roots.

import { createBashTool, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { createNixDevshellExtension } from "./lib/nix-devshell-extension.js";

export default createNixDevshellExtension({
  createBashToolFactory: createBashTool,
  localBashOperations: createLocalBashOperations,
});
