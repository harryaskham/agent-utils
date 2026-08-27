import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as FsConstants, accessSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.PI_RUN_ISOLATED_EXTENSION_SMOKE === "1";
const root = resolve(import.meta.dirname, "..");

const cases = [
  ["extensions/editor-chips.js", "editor-chips", { PI_EDITOR_CHIPS_ENABLED: "1" }],
  ["extensions/image-413-recovery.js", "image-413-recovery", {}],
  ["extensions/choice.js", "choice", { PI_CHOICE_CACO_ENABLED: "0" }],
  ["extensions/after.js", "after", {}],
  ["extensions/cacophony-mcp.js", "caco-mcp", { DISABLE_PI_CACO: "1" }],
];

function sessionSnapshot(base) {
  const rows = [];
  const visit = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".jsonl")) {
        const info = statSync(path);
        rows.push(`${path}:${info.size}:${info.mtimeMs}`);
      }
    }
  };
  visit(base);
  return rows.sort();
}

function realPiBinary() {
  if (process.env.PI_BIN) return process.env.PI_BIN;
  for (const dir of String(process.env.PATH || "").split(":")) {
    if (!dir || /node_modules/.test(dir)) continue;
    const candidate = join(dir, "pi");
    try { accessSync(candidate, FsConstants.X_OK); return candidate; } catch {}
  }
  const profile = join(homedir(), ".nix-profile", "bin", "pi");
  try { accessSync(profile, FsConstants.X_OK); return profile; } catch {}
  return "pi";
}

function runIsolatedExtensions(specs, sessionDir) {
  return new Promise((resolvePromise, reject) => {
    const expected = new Map(specs.map(([relativePath, command]) => [command, resolve(root, relativePath)]));
    const args = [
      "--mode", "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      ...specs.flatMap(([relativePath]) => ["-e", resolve(root, relativePath)]),
    ];
    const child = spawn(realPiBinary(), args, {
      cwd: root,
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        DISABLE_PI_CACO: "1",
        PI_EDITOR_CHIPS_ENABLED: "1",
        PI_CHOICE_CACO_ENABLED: "0",
        PI_CODING_AGENT_SESSION_DIR: sessionDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let poll;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      try { child.kill("SIGTERM"); } catch {}
      if (error) reject(error); else resolvePromise(value);
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.command !== "get_commands") continue;
        const commands = message?.data?.commands || [];
        for (const [expectedCommand, extensionPath] of expected) {
          const exact = commands.find((command) => command.name === expectedCommand);
          if (!exact) {
            finish(new Error(`expected /${expectedCommand}; got ${commands.map((c) => c.name).join(", ")}\nstderr=${stderr}`));
            return;
          }
          assert.equal(exact.source, "extension");
          assert.equal(resolve(exact.sourceInfo?.path || exact.path), extensionPath);
        }
        if (/Extension .* error:|Cannot find package|Cannot find module/i.test(`${stdout}\n${stderr}`)) {
          finish(new Error(`real Pi reported an extension/module error\n${stdout}\n${stderr}`));
          return;
        }
        finish(null, { stdout, stderr, commands });
        return;
      }
    });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled) finish(new Error(`Pi exited before get_commands (${code ?? signal})\n${stdout}\n${stderr}`));
    });
    const request = `${JSON.stringify({ type: "get_commands" })}\n`;
    poll = setInterval(() => { if (!settled && child.stdin.writable) child.stdin.write(request); }, 2_000);
    poll.unref?.();
    timer = setTimeout(() => finish(new Error(`timed out waiting for real Pi RPC get_commands\n${stdout}\n${stderr}`)), 90_000);
    timer.unref?.();
    child.stdin.write(request);
  });
}

test("real Pi loads only explicit Agent Utils extensions and registers their commands", { skip: !enabled, timeout: 120_000 }, async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), "agent-utils-pi-no-session-"));
  try {
    const before = sessionSnapshot(sessionDir);
    await runIsolatedExtensions(cases, sessionDir);
    assert.deepEqual(sessionSnapshot(sessionDir), before, "--no-session must not create or mutate session JSONL files");
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});
