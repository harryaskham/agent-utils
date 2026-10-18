// Hermetic contract probe. Imports the selected extension read-only and mocks
// every CLI invocation; it never registers an agent or changes a live session.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("Usage: node visiting-extension-contract.mjs /path/to/extensions/cacophony-runtime.js");
const libraryPath = resolve(dirname(modulePath), "lib/cacophony-runtime.js");
const runtime = await import(pathToFileURL(modulePath).href);
const identities = await import(pathToFileURL(libraryPath).href);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const results = [];
const cliCalls = [];

function fixture(sessionId, env = { CACOPHONY_PROJECT: "tools" }, entries = []) {
  const commands = new Map();
  const notifications = [];
  const appended = [];
  const ctx = {
    cwd: "/fixture/shared-tools-checkout",
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => entries,
      getEntries: () => entries,
    },
    ui: { notify: (message, level) => notifications.push({ message, level }) },
  };
  const execFileImpl = (command, args, options, callback) => {
    cliCalls.push({ command, args: [...args], cwd: options.cwd, sessionId });
    if (args[0] !== "agent" || args[1] !== "register") {
      callback(new Error("Unexpected CLI command in hermetic probe"), "", "");
      return;
    }
    const flag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : "";
    const identityKey = flag("--session-id") || `legacy-root:${options.cwd}`;
    callback(null, JSON.stringify({ data: {
      id: `visiting-${hash(identityKey).slice(0, 12)}`,
      project: flag("--project") || "tools",
      session_id: flag("--session-id") || undefined,
      runtime_agent_id: flag("--runtime-agent-id") || undefined,
    } }), "");
  };
  const pi = {
    registerCommand: (name, spec) => commands.set(name, spec),
    registerMessageRenderer() {},
    on() {},
    appendEntry: (customType, data) => appended.push({ customType, data }),
    sendMessage() {},
    events: { emit() {} },
  };
  runtime.createCacophonyRuntimeExtension({ env, settings: {}, execFileImpl })(pi);
  return {
    register: (args = "") => commands.get("caco-agent-register").handler(args, ctx),
    identity: () => identities.getCacophonyRuntimeIdentity(env),
    notifications,
    appended,
  };
}

async function probe(name, run) {
  identities.clearCacophonyRuntimeIdentity();
  cliCalls.length = 0;
  try {
    const { pass, observed } = await run();
    results.push({ name, pass: Boolean(pass), observed });
  } catch (error) {
    results.push({ name, pass: false, error: String(error?.message || error) });
  } finally {
    identities.clearCacophonyRuntimeIdentity();
  }
}

await probe("explicit project without project environment", async () => {
  const session = fixture("explicit-project-session", {});
  await session.register("project=tools");
  const identity = session.identity();
  return {
    pass: identity.project === "tools" && Boolean(identity.agentId) && cliCalls.length === 1,
    observed: { registered: Boolean(identity.agentId), project: identity.project, cliCalls: cliCalls.length, notifications: session.notifications },
  };
});

await probe("fork does not restore parent receipt", async () => {
  const parent = {
    type: "custom", customType: runtime.CACO_VISITOR_ENTRY_TYPE,
    data: { version: 1, status: "registered", project: "tools", agentId: "parent-visiting-identity", sessionId: "parent-session" },
  };
  const fork = fixture("new-fork-session", { CACOPHONY_PROJECT: "tools" }, [parent]);
  await fork.register();
  return {
    pass: Boolean(fork.identity().agentId) && fork.identity().agentId !== parent.data.agentId && cliCalls.length === 1,
    observed: { agentId: fork.identity().agentId, inheritedParentId: parent.data.agentId, cliCalls: cliCalls.length },
  };
});

await probe("live session ID overrides inherited parent environment", async () => {
  const session = fixture("actual-current-session", { CACOPHONY_PROJECT: "tools", PI_CODING_AGENT_SESSION_ID: "inherited-parent-session" });
  await session.register();
  const args = cliCalls[0]?.args || [];
  const index = args.indexOf("--session-id");
  return {
    pass: index >= 0 && args[index + 1] === "actual-current-session",
    observed: { registrationArgs: args, expectedLiveSession: "actual-current-session" },
  };
});

await probe("four logical sessions in one checkout remain independent", async () => {
  const observed = [];
  for (let index = 0; index < 4; index++) {
    const session = fixture(`logical-session-${index}`);
    await session.register();
    observed.push(session.identity().agentId);
  }
  return {
    pass: observed.every(Boolean) && new Set(observed).size === 4 && cliCalls.length === 4,
    observed: { agentIds: observed, distinctAgentIds: new Set(observed).size, cliCalls: cliCalls.length, cwd: "/fixture/shared-tools-checkout" },
  };
});

await probe("repeated registration of one session is stable", async () => {
  const session = fixture("stable-session");
  await session.register();
  const first = session.identity().agentId;
  await session.register();
  return {
    pass: Boolean(first) && first === session.identity().agentId && cliCalls.length === 1,
    observed: { first, repeated: session.identity().agentId, cliCalls: cliCalls.length },
  };
});

const output = {
  evidence: "Hermetic extension contract with mocked CLI; not live Pi/Pi Daemon/Pocket4 acceptance",
  source: { extensionSha256: hash(await readFile(modulePath)), identityLibrarySha256: hash(await readFile(libraryPath)) },
  results,
  passed: results.filter((result) => result.pass).length,
  failed: results.filter((result) => !result.pass).length,
};
console.log(JSON.stringify(output, null, 2));
if (output.failed) process.exitCode = 1;
