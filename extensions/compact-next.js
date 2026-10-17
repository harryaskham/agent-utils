// Static imports are required for Pi's compiled host-module mapping (pi-host.js).
// The controller stays dependency-free for deterministic lifecycle tests.
import { SettingsManager, getAgentDir, estimateTokens, generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import compactNext, { summarizeCompactNextBoundary } from "./lib/compact-next.js";

export default function compactNextExtension(pi) {
  const host = { SettingsManager, getAgentDir, estimateTokens, generateSummaryWithUsage };
  compactNext(pi, { summarize: (...args) => summarizeCompactNextBoundary(...args, host) });
}
