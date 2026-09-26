// Isolated opt-in RPC regression fixture; never part of the package manifest.
import selfCompactExtension from "../../extensions/self-compact.js";
export default function fixture(pi) {
  let tool;
  selfCompactExtension({ ...pi, registerTool(definition) { tool = definition; pi.registerTool(definition); } });
  pi.registerCommand("compact-rpc-probe", {
    handler: async (_args, ctx) => {
      let invoked = false;
      const result = await tool.execute("rpc-stale-call", {}, undefined, undefined, {
        ...ctx,
        getContextUsage: () => ({ tokens: 180000, contextWindow: 200000, percent: 90 }),
        compact() { invoked = true; throw new Error("must not abort an RPC run"); },
      });
      pi.sendMessage({ customType: "compact-rpc-probe", content: JSON.stringify({ mode: ctx.mode, invoked, active: pi.getActiveTools().includes("self_compact"), result: result.details }), display: true }, { triggerTurn: false });
    },
  });
}
