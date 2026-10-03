// Lab-only Pi extension: simulates a streaming assistant message (thinking,
// then answer) without a model, so canvas stream-in/glow effects can be
// screenshotted in the Xvfb lab. Also fakes agent speech for the glow.
// Usage inside Pi: /lab-stream   (never shipped in package.json pi.extensions)
export default function labStream(pi) {
  let tui = null;
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWidget("lab-probe", (t) => { tui = t; return { render: () => [], invalidate() {} }; });
    ctx.ui.setWidget("lab-probe", undefined);
  });
  const find = (node, predicate, depth = 0) => {
    if (!node || depth > 20) return null;
    if (predicate(node)) return node;
    for (const child of node.children || []) { const hit = find(child, predicate, depth + 1); if (hit) return hit; }
    for (const key of ["layoutRoot", "child"]) if (node[key]) { const hit = find(node[key], predicate, depth + 1); if (hit) return hit; }
    return null;
  };
  pi.registerCommand("lab-stream", {
    description: "lab: stream a fake assistant message",
    handler: async () => {
      const sample = find(tui, (n) => n?.constructor?.name === "AssistantMessageComponent");
      const chat = find(tui, (n) => Array.isArray(n?.children) && n.children.includes(sample));
      if (!sample || !chat) return;
      const Ctor = sample.constructor;
      const thinking = "Considering how the canvas should animate: glyphs drift down from a few rows above and settle into place while a soft glow fades.";
      const answer = "Here is the **streamed** answer. Each new token floats in from above, then bakes into the row strip once it lands. The editor glow pulses while thinking and shimmers while working.";
      const component = new Ctor({ role: "assistant", content: [{ type: "thinking", thinking: "" }], stopReason: "stop", timestamp: Date.now() });
      component.isStreaming = true;
      chat.addChild(component);
      pi.events?.emit?.("agent-utils:speech", { state: "start" });
      let i = 0;
      const step = () => {
        i += 1;
        const t = thinking.slice(0, Math.min(thinking.length, i * 6));
        const a = i * 6 > thinking.length ? answer.slice(0, (i * 6 - thinking.length)) : "";
        const content = [{ type: "thinking", thinking: t }, ...(a ? [{ type: "text", text: a }] : [])];
        component.updateContent({ role: "assistant", content, stopReason: "stop", timestamp: Date.now() }, true);
        tui?.requestRender?.();
        if (i * 6 < thinking.length + answer.length) setTimeout(step, 70);
        else { component.updateContent({ role: "assistant", content, stopReason: "stop", timestamp: Date.now() }, false); pi.events?.emit?.("agent-utils:speech", { state: "end" }); tui?.requestRender?.(); }
      };
      step();
    },
  });
}
