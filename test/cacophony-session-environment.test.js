import test from "node:test";
import assert from "node:assert/strict";

import {
  clearCacophonyRuntimeIdentity,
  getCacophonyRuntimeIdentity,
  setCacophonyRuntimeIdentity,
} from "../extensions/lib/cacophony-runtime.js";
import { createCacophonyChoiceBridge } from "../extensions/lib/cacophony-choice.js";
import { buildCacophonyMcpRegistration } from "../extensions/lib/cacophony-mcp.js";
import { piGraphicsIdScope } from "../extensions/pi-graphics/id-space.js";

const sessionA = {
  CACO_AGENT_ID: "aur-0",
  CACO_PROJECT: "cacophony",
  CACO_BIN: "caco-a",
};
const sessionB = {
  CACO_AGENT_ID: "msm-0",
  CACO_PROJECT: "agent-utils",
  CACO_BIN: "caco-b",
};

test("managed consumers resolve each logical session environment at use time", () => {
  clearCacophonyRuntimeIdentity();
  // A stale visiting fallback is deliberately present. A complete managed
  // identity from Pi-Daemon's session-scoped process.env must always dominate it.
  assert.equal(setCacophonyRuntimeIdentity({ agentId: "visitor", project: "wrong", visiting: true }), true);

  const identityA = getCacophonyRuntimeIdentity(sessionA);
  const identityB = getCacophonyRuntimeIdentity(sessionB);
  assert.deepEqual(identityA, {
    agentId: "aur-0", project: "cacophony", source: "environment", visiting: false, disabled: false,
  });
  assert.deepEqual(identityB, {
    agentId: "msm-0", project: "agent-utils", source: "environment", visiting: false, disabled: false,
  });

  const mcpA = buildCacophonyMcpRegistration(identityA, sessionA);
  const mcpB = buildCacophonyMcpRegistration(identityB, sessionB);
  assert.deepEqual(mcpA.definition.env, { CACO_AGENT_ID: "aur-0", CACO_PROJECT: "cacophony" });
  assert.deepEqual(mcpB.definition.env, { CACO_AGENT_ID: "msm-0", CACO_PROJECT: "agent-utils" });
  assert.equal(mcpA.definition.command, "caco-a");
  assert.equal(mcpB.definition.command, "caco-b");

  assert.equal(piGraphicsIdScope({ env: sessionA, pid: 10, cwd: "/same" }), "caco-agent:aur-0");
  assert.equal(piGraphicsIdScope({ env: sessionB, pid: 10, cwd: "/same" }), "caco-agent:msm-0");

  const choiceA = createCacophonyChoiceBridge({ env: sessionA, persisted: {} });
  const choiceB = createCacophonyChoiceBridge({ env: sessionB, persisted: {} });
  assert.equal(choiceA.config.agentId, "aur-0");
  assert.equal(choiceA.config.project, "cacophony");
  assert.equal(choiceB.config.agentId, "msm-0");
  assert.equal(choiceB.config.project, "agent-utils");

  clearCacophonyRuntimeIdentity();
});

test("session-local DISABLE_PI_CACO fails closed without disabling another session", () => {
  const disabledA = { ...sessionA, DISABLE_PI_CACO: "1" };
  assert.equal(getCacophonyRuntimeIdentity(disabledA).disabled, true);
  assert.equal(buildCacophonyMcpRegistration(getCacophonyRuntimeIdentity(disabledA), disabledA), null);
  assert.equal(createCacophonyChoiceBridge({ env: disabledA, persisted: {} }).config.enabled, false);

  assert.equal(getCacophonyRuntimeIdentity(sessionB).disabled, false);
  assert.notEqual(buildCacophonyMcpRegistration(getCacophonyRuntimeIdentity(sessionB), sessionB), null);
  assert.equal(createCacophonyChoiceBridge({ env: sessionB, persisted: {} }).config.enabled, true);
});
