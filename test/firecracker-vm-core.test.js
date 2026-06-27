import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_KERNEL_ARGS,
  sanitizeId,
  expandHome,
  resolveUserPath,
  clampInteger,
  serializeServices,
  pidAlive,
  buildFirecrackerConfig,
  buildManifest,
  publicVm,
} from "../extensions/lib/firecracker-vm-core.js";

test("sanitizeId: passthrough, charset, dash-strip, length cap, fallback", () => {
  assert.equal(sanitizeId("valid_id.1-2"), "valid_id.1-2");
  assert.equal(sanitizeId("my vm!"), "my-vm"); // space and ! -> dashes, trailing dash stripped
  assert.equal(sanitizeId("--abc--"), "abc"); // leading/trailing dashes stripped
  assert.equal(sanitizeId("a".repeat(100)).length, 80); // capped at 80
  assert.match(sanitizeId(""), /^vm-/); // empty -> generated fallback
  assert.match(sanitizeId("   "), /^vm-/); // all-invalid collapses to empty -> fallback
  assert.match(sanitizeId(null), /^vm-/);
});

test("expandHome: tilde expansion, passthrough", () => {
  assert.equal(expandHome("~/foo/bar"), path.join(os.homedir(), "foo/bar"));
  assert.equal(expandHome("/abs/path"), "/abs/path");
  assert.equal(expandHome("relative/path"), "relative/path");
  assert.equal(expandHome(undefined), undefined);
  assert.equal(expandHome("~notslash"), "~notslash"); // only "~/" expands
});

test("resolveUserPath: cwd-relative resolve, absolute, tilde, falsy passthrough", () => {
  assert.equal(resolveUserPath("/work/project", "sub/dir"), path.resolve("/work/project", "sub/dir"));
  assert.equal(resolveUserPath("/work/project", "/abs"), "/abs");
  assert.equal(resolveUserPath("/work/project", "~/h"), path.join(os.homedir(), "h"));
  assert.equal(resolveUserPath("/work/project", ""), ""); // falsy passthrough
  assert.equal(resolveUserPath("/work/project", undefined), undefined);
});

test("clampInteger: range clamp, NaN/undefined fallback, parse", () => {
  assert.equal(clampInteger(5, 2, 1, 10), 5);
  assert.equal(clampInteger(0, 2, 1, 10), 1); // below min
  assert.equal(clampInteger(100, 2, 1, 10), 10); // above max
  assert.equal(clampInteger("abc", 2, 1, 10), 2); // NaN -> fallback
  assert.equal(clampInteger(undefined, 2, 1, 10), 2);
  assert.equal(clampInteger("7", 2, 1, 10), 7); // numeric string parses
  assert.equal(clampInteger(3.9, 2, 1, 10), 3); // parseInt truncates
});

test("serializeServices: non-array -> [], defaults, urls, screen coercion", () => {
  assert.deepEqual(serializeServices(), []);
  assert.deepEqual(serializeServices("nope"), []);

  const [tcp] = serializeServices([{ name: "ssh", hostPort: 22 }]);
  assert.equal(tcp.protocol, "tcp");
  assert.equal(tcp.host, "127.0.0.1");
  assert.equal(tcp.screen, false);
  assert.equal(tcp.url, "tcp://127.0.0.1:22");

  const [http] = serializeServices([{ name: "novnc", hostPort: 6080, protocol: "http", path: "/vnc.html", host: "0.0.0.0", screen: 1 }]);
  assert.equal(http.url, "http://0.0.0.0:6080/vnc.html"); // http url includes path suffix
  assert.equal(http.screen, true); // truthy coerced to boolean
  assert.equal(http.host, "0.0.0.0");

  const [https] = serializeServices([{ name: "app", hostPort: 443, protocol: "https" }]);
  assert.equal(https.url, "https://127.0.0.1:443");
});

test("pidAlive: live process true, invalid pids false", () => {
  assert.equal(pidAlive(process.pid), true); // the test process is alive
  assert.equal(pidAlive(0), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(Number.NaN), false);
  assert.equal(pidAlive(undefined), false);
});

const PATHS = {
  kernelPath: "/img/vmlinux",
  rootfsPath: "/img/rootfs.ext4",
  firecrackerLogPath: "/work/firecracker.log",
  metricsPath: "/work/metrics.fifo",
  initrdPath: "/img/initrd",
};

test("buildFirecrackerConfig: defaults", () => {
  const cfg = buildFirecrackerConfig({}, PATHS);
  assert.equal(cfg["boot-source"].kernel_image_path, "/img/vmlinux");
  assert.equal(cfg["boot-source"].boot_args, DEFAULT_KERNEL_ARGS);
  assert.equal(cfg["boot-source"].initrd_path, undefined); // not set without params.initrdPath
  assert.equal(cfg.drives[0].is_root_device, true);
  assert.equal(cfg.drives[0].is_read_only, false);
  assert.equal(cfg["machine-config"].vcpu_count, 2);
  assert.equal(cfg["machine-config"].mem_size_mib, 1024);
  assert.equal(cfg["machine-config"].smt, false);
  assert.equal(cfg["machine-config"].track_dirty_pages, false);
  assert.equal(cfg.logger.level, "Info");
  assert.equal(cfg.metrics, undefined);
  assert.equal(cfg["network-interfaces"], undefined);
});

test("buildFirecrackerConfig: clamping, flags, overrides", () => {
  const cfg = buildFirecrackerConfig({
    cpuCount: 999, memMiB: 1, rootfsReadOnly: true, smt: true, trackDirtyPages: true,
    kernelArgs: "console=ttyS0 custom", logLevel: "Debug",
  }, PATHS);
  assert.equal(cfg["machine-config"].vcpu_count, 32); // clamped to max
  assert.equal(cfg["machine-config"].mem_size_mib, 128); // clamped to min
  assert.equal(cfg.drives[0].is_read_only, true);
  assert.equal(cfg["machine-config"].smt, true);
  assert.equal(cfg["machine-config"].track_dirty_pages, true);
  assert.equal(cfg["boot-source"].boot_args, "console=ttyS0 custom");
  assert.equal(cfg.logger.level, "Debug");

  const low = buildFirecrackerConfig({ cpuCount: 0, memMiB: 9_999_999 }, PATHS);
  assert.equal(low["machine-config"].vcpu_count, 1); // clamped to min
  assert.equal(low["machine-config"].mem_size_mib, 262_144); // clamped to max
});

test("buildFirecrackerConfig: metrics, network, initrd are conditional", () => {
  const metrics = buildFirecrackerConfig({ enableMetrics: true }, PATHS);
  assert.deepEqual(metrics.metrics, { metrics_path: "/work/metrics.fifo" });

  const net = buildFirecrackerConfig({ tapName: "tap0" }, PATHS);
  assert.equal(net["network-interfaces"][0].host_dev_name, "tap0");
  assert.equal(net["network-interfaces"][0].guest_mac, "AA:FC:00:00:00:01"); // default mac

  const mac = buildFirecrackerConfig({ tapName: "tap0", macAddress: "AA:BB:CC:DD:EE:FF" }, PATHS);
  assert.equal(mac["network-interfaces"][0].guest_mac, "AA:BB:CC:DD:EE:FF");

  const initrd = buildFirecrackerConfig({ initrdPath: "/img/initrd" }, PATHS);
  assert.equal(initrd["boot-source"].initrd_path, "/img/initrd");
});

test("buildManifest: shape + tendril control metadata", () => {
  const m = buildManifest({ id: "vm-x", state: "running", pid: 1234, consoleLogPath: "/work/serial.log", services: [] });
  assert.equal(m.version, 1);
  assert.equal(m.id, "vm-x");
  assert.equal(m.state, "running");
  assert.equal(m.pid, 1234);
  assert.equal(m.tendril.controllable, true);
  assert.equal(m.tendril.kind, "firecracker-vm");
  assert.deepEqual(m.tendril.lifecycle, ["start", "status", "screen", "stop", "list"]);
  assert.equal(m.tendril.screen.type, "serial-console-log");
  assert.equal(m.tendril.screen.path, "/work/serial.log");
});

test("publicVm: undefined passthrough, state derivation, alive flag", () => {
  assert.equal(publicVm(undefined), undefined);

  // pid falsy -> alive false; running/starting collapse to exited.
  const starting = publicVm({ id: "a", state: "starting", consoleLogPath: "/c" });
  assert.equal(starting.alive, false);
  assert.equal(starting.state, "exited");

  const running = publicVm({ id: "a", state: "running" });
  assert.equal(running.state, "exited");

  // non-running/starting states are preserved when not alive.
  assert.equal(publicVm({ id: "a", state: "stopped" }).state, "stopped");
  assert.equal(publicVm({ id: "a", state: "prepared" }).state, "prepared");

  // a live pid -> alive true and state running.
  const live = publicVm({ id: "a", state: "starting", pid: process.pid });
  assert.equal(live.alive, true);
  assert.equal(live.state, "running");
  assert.equal(live.version, 1); // carries the manifest shape
});
