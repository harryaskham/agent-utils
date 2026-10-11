import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const enabled = process.env.PI_RUN_PREVIEW_RELOAD_SMOKE === "1";
const fixture = path.resolve(import.meta.dirname, "fixtures/kitty-preview-reload-extension.js");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test("real Pi survives repeated reload with owned preview data and pending hide cleanup", { skip: !enabled, timeout: 60000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-preview-reload-"));
  let child;
  let exited = false;
  let closed;
  let output = "";
  try {
    const agent = path.join(dir, "agent"); await mkdir(agent);
    await writeFile(path.join(agent, "settings.json"), JSON.stringify({ packages: [], defaultProjectTrust: "no" }));
    const image = path.join(dir, "one.png"), receipt = path.join(dir, "receipt.jsonl");
    await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lDL+WQAAAABJRU5ErkJggg==", "base64"));
    const env = Object.fromEntries(["PATH", "TMPDIR", "LANG"].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    Object.assign(env, {
      HOME: dir, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0",
      PI_DISABLE_AHP: "1", DISABLE_PI_CACO: "1", PI_AUTO_UPDATE_ON_STARTUP: "0",
      KITTY_RELOAD_QA_IMAGE: image, KITTY_RELOAD_QA_RECEIPT: receipt,
    });
    child = spawn(process.env.PI_BIN || "pi", ["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-context-files", "--no-themes", "--no-prompt-templates", "-e", fixture], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    const collect = bytes => { output = (output + bytes.toString()).slice(-24000); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.stdin.on("error", () => {});
    closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); }); });
    const starts = async () => (await readFile(receipt, "utf8").catch(() => "")).split("\n").filter(line => line && JSON.parse(line).event === "start").length;
    const waitStart = async count => {
      const deadline = Date.now() + 15000;
      while (await starts() < count) {
        assert.equal(exited, false, output);
        assert.ok(Date.now() < deadline, `Pi did not reload: ${output}`);
        await delay(25);
      }
    };
    await waitStart(1);
    for (const [i, mode] of ["plain", "hide", "side"].entries()) {
      child.stdin.write(`${JSON.stringify({ id: `reload-${i}`, type: "prompt", message: `/qa-preview-reload ${mode}` })}\n`);
      await waitStart(i + 2);
      await delay(250); // longer than both the old 100/120ms cleanup timers
      assert.equal(exited, false, `reload ${mode} killed Pi: ${output}`);
      assert.doesNotMatch(output, /uncaughtException|ctx is stale|UnhandledPromiseRejection|extension_error/);
    }
    child.kill("SIGTERM");
    let shutdownTimer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        shutdownTimer = setTimeout(() => reject(new Error("owned Pi did not shut down")), 5000);
      })]);
    } finally { clearTimeout(shutdownTimer); }
  } finally {
    if (child && !exited) { child.kill("SIGKILL"); await closed.catch(() => {}); }
    await rm(dir, { recursive: true, force: true });
  }
});
