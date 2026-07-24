import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import slackMcpExtension from "../extensions/slack-mcp.js";
import {
  canvasHtmlToMarkdown,
  compactSlackResponse,
  slackMessageText,
} from "../extensions/slack-compact.js";

const messageFixture = JSON.parse(await readFile(new URL("./fixtures/slack-search-messages.json", import.meta.url), "utf8"));
const fileFixture = JSON.parse(await readFile(new URL("./fixtures/slack-search-files.json", import.meta.url), "utf8"));

function createFakePi() {
  const tools = new Map();
  const commands = new Map();
  const systemPrompts = [];
  const pi = {
    appendSystemPromptSection(name, text) { systemPrompts.push({ name, text }); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  slackMcpExtension(pi);
  return { tools, commands, systemPrompts };
}

function responseJson(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("canvasHtmlToMarkdown interprets Slack canvas structure", () => {
  const markdown = canvasHtmlToMarkdown(`
    <div class="quip-canvas-content">
      <h1>Project &amp; rollout</h1>
      <p>Hello <strong>world</strong>. See <a href="https://example.com/plan">the plan</a>.</p>
      <ul><li><input type="checkbox" checked>Shipped</li><li>Measure</li></ul>
      <pre>const answer = 42;</pre>
    </div>
  `);

  assert.match(markdown, /^# Project & rollout/m);
  assert.match(markdown, /Hello \*\*world\*\*\. See \[the plan\]\(https:\/\/example\.com\/plan\)\./);
  assert.match(markdown, /- \[x\] Shipped/);
  assert.match(markdown, /- Measure/);
  assert.match(markdown, /```\nconst answer = 42;\n```/);
  assert.doesNotMatch(markdown, /<\/?(?:div|h1|p|ul|li|pre)>/);
});

test("slackMessageText falls back from empty text to section and rich-text blocks", () => {
  assert.equal(slackMessageText(messageFixture.messages.matches[0]), "*Build notification*: job one completed :white_check_mark:");
  assert.equal(slackMessageText(messageFixture.messages.matches[2]), "Checkpoint gather succeeded for <@U456>");
});

test("message search compaction groups repeated conversation metadata and preserves salient content", async () => {
  const compact = await compactSlackResponse("search.messages", structuredClone(messageFixture));
  const rawSize = JSON.stringify(messageFixture).length;
  const compactSize = JSON.stringify(compact).length;

  assert.equal(compact.ok, true);
  assert.equal(compact.total, 8418);
  assert.equal(compact.returned, 4);
  assert.equal(compact.message_groups.length, 1);
  assert.deepEqual(compact.message_groups[0].conversation, {
    id: "C123",
    name: "build-notifications",
    kind: "channel",
  });
  assert.equal(compact.message_groups[0].messages.length, 4);
  assert.equal(compact.message_groups[0].messages[0].user_id, "U123");
  assert.match(compact.message_groups[0].messages[0].timestamp, /^2026-/);
  assert.match(compact.message_groups[0].messages[0].text, /job one completed/);
  assert.deepEqual(compact.message_groups[0].messages[1].file_ids, ["F123"]);
  assert.deepEqual(compact.message_groups[0].messages[1].attachment_ids, ["A123"]);
  assert.equal(compact.users.U123.username, "build_bot");
  assert.equal(compact.users.U123.real_name, "Build Bot");
  assert.equal(JSON.stringify(compact).includes("pending_shared"), false);
  assert.equal(JSON.stringify(compact).includes("image_72"), false);
  assert.ok(compactSize < rawSize * 0.6, `expected compact ${compactSize} bytes to be <60% of raw ${rawSize}`);
});

test("history compaction resolves DM provenance and author names once", async () => {
  const api = async (method, params) => {
    if (method === "conversations.info") {
      assert.equal(params.channel, "D123");
      return { ok: true, channel: { id: "D123", is_im: true, user: "U_PEER" } };
    }
    if (method === "users.info") {
      const names = {
        U_AUTHOR: { name: "ada", profile: { real_name: "Ada Lovelace", display_name: "Ada" } },
        U_PEER: { name: "grace", profile: { real_name: "Grace Hopper", display_name: "Grace" } },
      };
      return { ok: true, user: { id: params.user, ...names[params.user] } };
    }
    throw new Error(`unexpected method ${method}`);
  };
  const compact = await compactSlackResponse(
    "conversations.history",
    { ok: true, messages: [{ user: "U_AUTHOR", ts: "1784895921.609509", text: "A salient update" }] },
    { channel: "D123" },
    { api },
  );

  assert.equal(compact.message_groups[0].conversation.name, "DM with Grace");
  assert.equal(compact.message_groups[0].conversation.kind, "dm");
  assert.equal(compact.message_groups[0].messages[0].text, "A salient update");
  assert.equal(compact.users.U_AUTHOR.display_name, "Ada");
  assert.equal(compact.users.U_PEER.real_name, "Grace Hopper");
});

test("canvas search compaction emits Markdown, provenance, IDs, and a much smaller payload", async () => {
  const api = async (method, params) => {
    assert.equal(method, "users.info");
    assert.equal(params.user, "U123");
    return { ok: true, user: { id: "U123", name: "owner", profile: { real_name: "Canvas Owner", display_name: "Owner" } } };
  };
  const fetchCanvas = async (file) => {
    assert.equal(file.id, "F123");
    return `<div class="quip-canvas-content"><h1>Convergence Onboarding</h1><p>Welcome to the project.</p><h2>First steps</h2><ul><li>Join the channel</li><li>Read the design</li></ul></div>`;
  };
  const compact = await compactSlackResponse("search.files", structuredClone(fileFixture), {}, { api, fetchCanvas });
  const rawSize = JSON.stringify(fileFixture).length;
  const compactSize = JSON.stringify(compact).length;

  assert.equal(compact.total, 179);
  assert.equal(compact.returned, 1);
  assert.equal(compact.files[0].id, "F123");
  assert.equal(compact.files[0].title, "Convergence Onboarding");
  assert.deepEqual(compact.files[0].provenance, [{ id: "C123", name: "health-convergence-build", kind: "channel" }]);
  assert.match(compact.files[0].content_markdown, /^# Convergence Onboarding/m);
  assert.match(compact.files[0].content_markdown, /## First steps/);
  assert.match(compact.files[0].content_markdown, /- Join the channel/);
  assert.equal(compact.files[0].content_status, "ok");
  assert.equal(compact.users.U123.real_name, "Canvas Owner");
  assert.deepEqual(compact.canvas_content, { fetched: 1, omitted: 0, max_fetches: 5 });
  assert.equal(JSON.stringify(compact).includes("dm_mpdm_users_with_file_access"), false);
  assert.equal(JSON.stringify(compact).includes("title_blocks"), false);
  assert.ok(compactSize < rawSize * 0.6, `expected compact ${compactSize} bytes to be <60% of raw ${rawSize}`);
});

test("large user listings are bounded and report omitted identities", async () => {
  const members = Array.from({ length: 205 }, (_, index) => ({
    id: `U${index}`,
    name: `user_${index}`,
    profile: { real_name: `User ${index}`, display_name: `Display ${index}`, title: "Engineer" },
  }));
  const compact = await compactSlackResponse("users.list", { ok: true, members, count: members.length });
  assert.equal(compact.count, 205);
  assert.equal(compact.returned, 200);
  assert.equal(compact.omitted, 5);
  assert.equal(compact.users.length, 200);
});

test("native Slack tool schemas default raw=false and raw=true restores the original response", async () => {
  const { tools, commands, systemPrompts } = createFakePi();
  const rawTools = [
    "slack_health_check",
    "slack_api",
    "slack_search_messages",
    "slack_search_files",
    "slack_list_conversations",
    "slack_conversations_history",
    "slack_get_thread",
    "slack_channel_info",
    "slack_users_info",
    "slack_list_users",
    "slack_send_message",
  ];
  for (const name of rawTools) {
    assert.equal(tools.get(name)?.parameters?.properties?.raw?.default, false, `${name} exposes raw=false`);
  }
  assert.equal(commands.has("slack-status"), true);
  assert.equal(commands.has("slack-refresh"), true);
  assert.equal(systemPrompts[0].name, "slack-mcp-safety");

  const previousFetch = globalThis.fetch;
  const previousToken = process.env.SLACK_TOKEN;
  const previousCookie = process.env.SLACK_COOKIE;
  process.env.SLACK_TOKEN = "xoxc-test";
  process.env.SLACK_COOKIE = "xoxd-test";
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/search\.messages$/);
    return responseJson(messageFixture);
  };

  try {
    const result = await tools.get("slack_search_messages").execute("call-1", { query: "after:2026-07-20", count: 4, raw: true });
    assert.deepEqual(result.details, messageFixture);
    assert.deepEqual(JSON.parse(result.content[0].text), messageFixture);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.SLACK_TOKEN;
    else process.env.SLACK_TOKEN = previousToken;
    if (previousCookie === undefined) delete process.env.SLACK_COOKIE;
    else process.env.SLACK_COOKIE = previousCookie;
  }
});
