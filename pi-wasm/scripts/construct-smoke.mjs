// Node-side construct smoke for the S1 spike. This is NOT the browser proof
// (that is the `vite build` + the Playwright harness in S8) — but it validates,
// under plain Node ESM, that the `.` entries of @earendil-works/pi-agent-core
// and @earendil-works/pi-ai import cleanly and that `Agent` constructs with only
// injectable seams. Run: `npm run spike:node`.
import { Agent } from "@earendil-works/pi-agent-core";
import * as piAi from "@earendil-works/pi-ai";

const agent = new Agent({ getApiKey: async () => undefined });
const unsub = agent.subscribe(() => {});

console.log("agent-core Agent:", typeof Agent);
console.log("pi-ai exports:", Object.keys(piAi).length);
console.log("pi-ai.createProvider:", typeof piAi.createProvider, "createModels:", typeof piAi.createModels);
console.log("agent.state keys:", Object.keys(agent.state ?? {}).join(", "));
console.log("messages:", agent.state?.messages?.length, "tools:", agent.state?.tools?.length);
unsub();
console.log("CONSTRUCT-SMOKE: PASS");
