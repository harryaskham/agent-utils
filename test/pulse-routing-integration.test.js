// Explicit opt-in: a private, hardware-free Pulse server on a unique Unix
// socket. Never connects to the operator's Pulse server or changes its graph.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm, realpath, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPulseSinks, SOLO_OWNER_PROPERTY } from "../extensions/lib/pulse-sinks.js";
import { createSpeechOutputRouting } from "../extensions/lib/speech-output-routing.js";

const enabled = process.env.PI_RUN_PULSE_ROUTING_SMOKE === "1";
test("real pactl creates, reuses and cleans owned solo sinks without removing shared focus or borrowed sinks", { skip: !enabled, timeout: 20000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-pulse-routing-")));
  let daemon, logs = "";
  try {
    for (const name of ["run", "config", "state"]) await mkdir(join(root, name), { mode: 0o700 });
    const socket = join(root, "run", "native"), server = `unix:${socket}`;
    const config = join(root, "pulse.pa");
    await writeFile(config, `load-module module-native-protocol-unix socket=${socket} auth-anonymous=1\n`, { mode: 0o600 });
    const env = { ...process.env, HOME: root, PULSE_SERVER: server, PULSE_RUNTIME_PATH: join(root, "run"), PULSE_STATE_PATH: join(root, "state"), XDG_RUNTIME_DIR: join(root, "run"), XDG_CONFIG_HOME: join(root, "config") };
    delete env.PULSE_COOKIE;
    for (const key of Object.keys(env)) if (/(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)) delete env[key];
    daemon = spawn("pulseaudio", ["-n", "--daemonize=no", "--use-pid-file=no", "--exit-idle-time=-1", "--log-target=stderr", "--file", config], { env, stdio: ["ignore", "ignore", "pipe"] });
    daemon.stderr.on("data", bytes => { logs = (logs + bytes).slice(-4000); });
    let spawnError;
    daemon.on("error", error => { spawnError = error; });
    const deadline = Date.now() + 5000;
    for (;;) {
      if (spawnError) throw spawnError;
      if (daemon.exitCode != null) throw new Error(`isolated Pulse exited: ${logs}`);
      try { await access(socket); break; } catch {}
      assert.ok(Date.now() < deadline, `isolated Pulse startup timed out: ${logs}`);
      await new Promise(r => setTimeout(r, 20));
    }
    const pulse = createPulseSinks({ env });
    const routing = createSpeechOutputRouting({ env, pulse });
    const base = { backend: "pulse", server };
    await routing.setMode("focus", true, { base, focus: { sink: "vsink_focus" } });
    const solo = await routing.setMode("solo", true, { base, identity: { agent: 'Ågent O\'Brien "quoted" \\ $(echo nope)', session: "fixture", host: "fixture" } });
    const sink = await pulse.find(server, solo.soloOutput.sink);
    // Pulse 17's JSON encoder rejects non-ASCII strings and emits '(null)'.
    // Ownership uses ASCII IDs/markers; verify the real Unicode display label
    // via the text listing, not that lossy JSON description field.
    const detail = await promisify(execFile)("pactl", ["--server", server, "list", "sinks"], { env: { ...env, LC_ALL: "C" }, timeout: 5000, maxBuffer: 1024 * 1024 });
    assert.ok(detail.stdout.includes('Description: pi - Ågent O\'Brien "quoted" \\ $(echo nope)'));
    assert.ok(sink.properties[SOLO_OWNER_PROPERTY]);
    const lease = await routing.acquire(base);
    await routing.setMode("solo", false);
    assert.ok(await pulse.find(server, solo.soloOutput.sink), "held playback lease defers cleanup");
    await lease.release();
    assert.equal(routing.snapshot().cleanupPending, false, JSON.stringify(routing.snapshot()));
    assert.equal(await pulse.find(server, solo.soloOutput.sink), undefined);
    await routing.shutdown();
    assert.ok(await pulse.find(server, "vsink_focus"), "focus sink survives client teardown");

    const borrowed = await pulse.ensure({ server, name: "pi_preexisting", description: "Existing shared sink" });
    const result = await pulse.ensure({ server, name: "pi_preexisting", description: "Must not replace", owner: "not-the-owner" });
    assert.equal(result.owned, false); assert.equal(result.sink.owner_module, borrowed.sink.owner_module);
    assert.equal((await pulse.cleanup({ server, name: "pi_preexisting", moduleId: result.sink.owner_module, owner: "not-the-owner" })).state, "not-owned");
    assert.ok(await pulse.find(server, "pi_preexisting"));

    const peers = [createSpeechOutputRouting({ env, pulse }), createSpeechOutputRouting({ env, pulse })];
    await Promise.all(peers.map(peer => peer.setMode("focus", true, { base, focus: { sink: "vsink_focus_race" } })));
    assert.equal((await pulse.list(server, "sinks")).filter(s => s.name.startsWith("vsink_focus_race")).length, 1, "concurrent focus creators never allocate suffixed duplicate sinks");
    await Promise.all(peers.map(peer => peer.shutdown()));
    assert.ok(await pulse.find(server, "vsink_focus_race"));
  } catch (error) {
    error.message += `\nIsolated Pulse log: ${logs}`;
    throw error;
  } finally {
    if (daemon && daemon.exitCode == null && daemon.signalCode == null) {
      const closed = once(daemon, "close"); daemon.kill("SIGTERM");
      const timer = setTimeout(() => daemon.kill("SIGKILL"), 3000);
      try { await closed; } finally { clearTimeout(timer); }
    }
    await rm(root, { recursive: true, force: true });
  }
});
