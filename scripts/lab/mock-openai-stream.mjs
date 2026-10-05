#!/usr/bin/env node
// Lab-only OpenAI-compatible streaming server: answers every chat completion
// with streamed reasoning_content (thinking) then markdown content, at a
// realistic token cadence, so Pi's real streaming path can be exercised and
// screenshotted without a model. Usage: node mock-openai-stream.mjs <port>
import { createServer } from "node:http";

const port = Number(process.argv[2] || 18089);
const tokenMs = Number(process.env.MOCK_TOKEN_MS || 35);
const thinking = process.env.MOCK_THINKING || [
  "The user wants to see how streamed text lands on the canvas. ",
  "I should produce a few paragraphs so the transcript scrolls while tokens arrive, ",
  "including a list and a code block, so wrapping and block changes are exercised. ",
  "Long thinking lines wrap across several rows, which is exactly the case that looked messy before.",
].join("");
const answer = process.env.MOCK_ANSWER || [
  "Here is a **streamed** answer that arrives token by token.\n\n",
  "- Each glyph should float in from a little above and settle.\n",
  "- Wrapped words must not re-animate when they move to the next row.\n",
  "- The editor glow keeps animating while this streams.\n\n",
  "```js\nconst canvas = createFullCanvas({ stream: \"float\" });\ncanvas.start();\n```\n\n",
  "That paragraph is followed by a longer one so the transcript has to scroll while the stream is still running, ",
  "which moves rows underneath any in-flight overlays and checks that they follow their glyphs rather than their screen row. ",
  "Finally a closing sentence ends the message.",
].join("");

function tokens(text) { return text.match(/\s*\S+|\s+/g) || []; }

createServer((req, res) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "mock-stream", object: "model" }] })); return; }
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", async () => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const id = `chatcmpl-${Date.now()}`;
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch {}
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    const last = messages[messages.length - 1];
    // First turn of a prompt containing "tool": call bash, then answer after the result.
    const wantsTool = process.env.MOCK_TOOL !== "0" && last?.role === "user" && JSON.stringify(last.content || "").includes("tool");
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock-stream", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    send({ role: "assistant", content: "" });
    if (wantsTool) {
      for (const t of tokens("I will run a quick command to list the canvas modules.")) { send({ reasoning_content: t }); await sleep(tokenMs); }
      const useRead = JSON.stringify(last.content || "").includes("read");
      const name = useRead ? "read" : "bash";
      const args = JSON.stringify(useRead ? { path: "extensions/pi-graphics/canvas/semantics.js", limit: 12 } : { command: `for f in extensions/pi-graphics/canvas/*.js; do echo "$f"; sleep ${Number(process.env.MOCK_TOOL_SLEEP || 0.4)}; done; echo done` });
      send({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "" } }] });
      for (let i = 0; i < args.length; i += 6) { send({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 6) } }] }); await sleep(tokenMs); }
      send({}, "tool_calls");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    for (const t of tokens(thinking)) { send({ reasoning_content: t }); await sleep(tokenMs); }
    for (const t of tokens(answer)) { send({ content: t }); await sleep(tokenMs); }
    send({}, "stop");
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 200, total_tokens: 210 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
}).listen(port, "127.0.0.1", () => console.log(`mock-openai-stream on ${port}`));
