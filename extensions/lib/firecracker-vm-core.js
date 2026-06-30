// Pure, peer-dependency-free core helpers for the Firecracker VM extension.
//
// extensions/firecracker-vm.js imports @sinclair/typebox and @earendil-works/pi-ai
// at module load, which are peerDependencies that are not resolvable under
// `node --test` (ERR_MODULE_NOT_FOUND) — so the extension cannot be imported in
// unit tests. These helpers are pure and runtime-agnostic (no typebox, no
// pi-ai, no Pi runtime), so they live here as the single source of truth and
// are exercised directly by test/firecracker-vm-core.test.js. The extension
// imports them from this module. (Same rationale as lib/tool-schema.js.)

import os from "node:os";
import path from "node:path";

export const DEFAULT_KERNEL_ARGS = "console=ttyS0 reboot=k panic=1 pci=off";

export function sanitizeId(value) {
  const id = String(value || `vm-${Date.now().toString(36)}`)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return id || `vm-${Date.now().toString(36)}`;
}

export function expandHome(inputPath) {
  if (!inputPath?.startsWith("~/")) return inputPath;
  return path.join(os.homedir(), inputPath.slice(2));
}

export function resolveUserPath(cwd, inputPath) {
  if (!inputPath) return inputPath;
  return path.resolve(cwd, expandHome(String(inputPath)));
}

export function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function serializeServices(services = []) {
  return (Array.isArray(services) ? services : []).map((service) => {
    const protocol = service.protocol || "tcp";
    const host = service.host || "127.0.0.1";
    const suffix = service.path || "";
    return {
      name: service.name,
      host,
      hostPort: service.hostPort,
      guestPort: service.guestPort,
      protocol,
      path: service.path,
      screen: Boolean(service.screen),
      url: ["http", "https"].includes(protocol) ? `${protocol}://${host}:${service.hostPort}${suffix}` : `${protocol}://${host}:${service.hostPort}`,
    };
  });
}

export function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function buildFirecrackerConfig(params, paths) {
  const kernelArgs = params.kernelArgs || DEFAULT_KERNEL_ARGS;
  const config = {
    "boot-source": {
      kernel_image_path: paths.kernelPath,
      boot_args: kernelArgs,
    },
    drives: [{
      drive_id: "rootfs",
      path_on_host: paths.rootfsPath,
      is_root_device: true,
      is_read_only: params.rootfsReadOnly === true,
    }],
    "machine-config": {
      vcpu_count: clampInteger(params.cpuCount, 2, 1, 32),
      mem_size_mib: clampInteger(params.memMiB, 1024, 128, 262_144),
      smt: params.smt === true,
      track_dirty_pages: params.trackDirtyPages === true,
    },
    logger: {
      log_path: paths.firecrackerLogPath,
      level: params.logLevel || "Info",
      show_level: true,
      show_log_origin: true,
    },
  };

  if (params.enableMetrics) {
    config.metrics = { metrics_path: paths.metricsPath };
  }

  if (params.tapName) {
    config["network-interfaces"] = [{
      iface_id: "eth0",
      host_dev_name: params.tapName,
      guest_mac: params.macAddress || "AA:FC:00:00:00:01",
    }];
  }

  if (params.initrdPath) config["boot-source"].initrd_path = paths.initrdPath;
  return config;
}

export function buildManifest(vm) {
  return {
    version: 1,
    id: vm.id,
    state: vm.state,
    pid: vm.pid,
    startedAt: vm.startedAt,
    stoppedAt: vm.stoppedAt,
    workDir: vm.workDir,
    configPath: vm.configPath,
    manifestPath: vm.manifestPath,
    apiSocket: vm.apiSocket,
    consoleLogPath: vm.consoleLogPath,
    firecrackerLogPath: vm.firecrackerLogPath,
    metricsPath: vm.metricsPath,
    services: vm.services,
    tendril: {
      controllable: true,
      kind: "firecracker-vm",
      id: vm.id,
      screen: {
        type: "serial-console-log",
        path: vm.consoleLogPath,
        note: "Firecracker is headless; graphical workloads should expose VNC/noVNC/browser services listed in services[]. Tendril can open/capture those host endpoints.",
      },
      lifecycle: ["start", "status", "screen", "stop", "list"],
    },
  };
}

export function publicVm(vm) {
  if (!vm) return undefined;
  const alive = vm.pid ? pidAlive(vm.pid) : false;
  const state = alive ? "running" : (["running", "starting"].includes(vm.state) ? "exited" : vm.state);
  return {
    ...buildManifest({ ...vm, state }),
    alive,
  };
}
