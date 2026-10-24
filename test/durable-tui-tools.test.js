// The Durable adapter for TUI tool extensions (bd-74502e): pi-daemon sessions run agent-utils'
// TUI tools with the call id, the session's directory and signal, a headless UI, and pi.exec
// through the session's own execution environment.
import assert from "node:assert/strict";
import test from "node:test";

import { adaptTuiToolExtension, runExec } from "../extensions/lib/durable-tui-tools.js";

function fakeExtension(seen) {
  return (pi) => {
    pi.registerCommand("ignored", { handler: () => {} });
    pi.on("session_start", () => {});
    pi.registerTool({
      name: "probe",
      description: "Probe the call.",
      promptSnippet: "Probe things.",
      promptGuidelines: ["Use it for tests."],
      parameters: { type: "object", properties: { word: { type: "string" } } },
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        onUpdate({ content: [{ type: "text", text: "working" }] });
        const confirmed = await ctx.ui.confirm("Really?", "dangerous");
        const listing = await pi.exec("echo", [params.word], { timeout: 2500 });
        seen.push({ toolCallId, params, signal, cwd: ctx.cwd, hasUI: ctx.hasUI, confirmed, listing });
        return { content: [{ type: "text", text: `said ${listing.stdout.trim()}` }], details: { ok: true } };
      },
    });
    pi.registerTool({ name: "other", description: "Other.", parameters: { type: "object" }, execute: async () => "plain text" });
  };
}

test("adapted TUI tools run with the call id, the session's directory, signal and environment", async () => {
  const seen = [];
  const tools = await adaptTuiToolExtension(fakeExtension(seen));
  assert.deepEqual(tools.map((tool) => tool.name), ["probe", "other"]);
  assert.equal(tools[0].description, "Probe the call.\n\nProbe things.\n\n- Use it for tests.");

  const execs = [];
  const execEnv = {
    cwd: "/work/session",
    async exec(argv, options, context) {
      execs.push({ argv, options: { cwd: options.cwd, timeout: options.timeout }, context });
      options.onOutput(`${argv.slice(1).join(" ")}\n`, context, { stream: "stdout" });
      options.onOutput("warn\n", context, { stream: "stderr" });
      return { ok: true, value: { exitCode: 0 } };
    },
  };
  const abort = new AbortController();
  const context = { abortSignal: abort.signal, marker: "ctx" };
  const result = await tools[0].execute({ word: "hello" }, { callId: "call-7", env: execEnv, conversationId: 1 }, context);
  // `output` for pi-durable 1.2 and later, `content` for earlier hosts.
  assert.deepEqual(result, { output: [{ type: "text", text: "said hello" }], content: [{ type: "text", text: "said hello" }], details: { ok: true } });
  assert.equal(seen[0].toolCallId, "call-7");
  assert.deepEqual(seen[0].params, { word: "hello" });
  assert.equal(seen[0].signal, abort.signal);
  assert.equal(seen[0].cwd, "/work/session");
  assert.equal(seen[0].hasUI, false);
  assert.equal(seen[0].confirmed, false, "confirmations decline headlessly");
  assert.deepEqual(seen[0].listing, { stdout: "hello\n", stderr: "warn\n", code: 0, killed: false });
  // pi.exec ran through the session's environment, its timeout in seconds.
  assert.deepEqual(execs, [{ argv: ["echo", "hello"], options: { cwd: undefined, timeout: 3 }, context }]);

  // A plain string result becomes text content.
  assert.deepEqual(await tools[1].execute({}, { callId: "c" }, {}), { output: [{ type: "text", text: "plain text" }], content: [{ type: "text", text: "plain text" }] });

  // `only` keeps the named tools.
  assert.deepEqual((await adaptTuiToolExtension(fakeExtension([]), { only: ["other"] })).map((tool) => tool.name), ["other"]);
});

test("without a session environment pi.exec runs locally in the session's directory", async () => {
  const seen = [];
  const tools = await adaptTuiToolExtension(fakeExtension(seen));
  await tools[0].execute({ word: "local" }, { callId: "c1" }, {});
  assert.equal(seen[0].listing.stdout, "local\n");
  assert.equal(seen[0].listing.code, 0);
  const missing = await runExec("/nonexistent/binary", [], {});
  assert.equal(missing.code, 127);
});

test("the Durable tools module adapts agent-utils' TUI tools for pi-daemon sessions", async () => {
  const { extension } = await import("../extensions/durable/tools.mjs");
  const names = extension.tools.map((tool) => tool.name);
  for (const name of ["search_web", "xvfb_status", "firecracker_vm_list", "app_automation_list", "android_cli_doctor", "slack_token_status"]) {
    assert.ok(names.includes(name), `${name} adapted`);
  }
  assert.equal(new Set(names).size, names.length, "no duplicate tool names");
  const search = extension.tools.find((tool) => tool.name === "search_web");
  assert.match(search.description, /Search the live web/);
  assert.equal(search.parameters.type, "object");
  assert.ok(search.parameters.properties.query);
});
