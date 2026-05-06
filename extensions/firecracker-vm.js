import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { openSync } from "node:fs";

import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

// Tool prefix: firecracker_vm. Spawn form: firecracker --api-sock <socket> --config-file <config>.
const STATUS_ID = "firecracker-vm";
const DEFAULT_WORK_ROOT = path.join(os.tmpdir(), "pi-firecracker-vms");
const DEFAULT_KERNEL_ARGS = "console=ttyS0 reboot=k panic=1 pci=off";

function stringEnum(values, description) {
  return StringEnum(values, { description });
}

function sanitizeId(value) {
  const id = String(value || `vm-${Date.now().toString(36)}`)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return id || `vm-${Date.now().toString(36)}`;
}

function expandHome(inputPath) {
  if (!inputPath?.startsWith("~/")) return inputPath;
  return path.join(os.homedir(), inputPath.slice(2));
}

function resolveUserPath(cwd, inputPath) {
  if (!inputPath) return inputPath;
  return path.resolve(cwd, expandHome(String(inputPath)));
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function serviceSchema() {
  return Type.Object({
    name: Type.String({ description: "Service name, for example browser, vnc, novnc, ssh, or app." }),
    host: Type.Optional(Type.String({ description: "Host interface exposed to the operator. Defaults to 127.0.0.1." })),
    hostPort: Type.Number({ description: "Host TCP port forwarded or bridged to the guest service." }),
    guestPort: Type.Optional(Type.Number({ description: "Guest TCP port for the service." })),
    protocol: Type.Optional(stringEnum(["http", "https", "vnc", "ssh", "tcp"], "Service protocol.")),
    path: Type.Optional(Type.String({ description: "Optional HTTP path, for example /vnc.html for noVNC." })),
    screen: Type.Optional(Type.Boolean({ description: "Whether this service is a screen/display endpoint Tendril can open or capture." })),
  });
}

function serializeServices(services = []) {
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

function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(filePath) {
  if (!filePath) return false;
  return stat(filePath).then(() => true, () => false);
}

async function tailFile(filePath, bytes = 16_384) {
  if (!filePath || !(await pathExists(filePath))) return "";
  const data = await readFile(filePath);
  return data.subarray(Math.max(0, data.length - bytes)).toString("utf8");
}

function buildFirecrackerConfig(params, paths) {
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

function buildManifest(vm) {
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

async function persistManifest(vm) {
  const manifest = buildManifest(vm);
  await writeFile(vm.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function publicVm(vm) {
  if (!vm) return undefined;
  const alive = vm.pid ? pidAlive(vm.pid) : false;
  const state = alive ? "running" : (["running", "starting"].includes(vm.state) ? "exited" : vm.state);
  return {
    ...buildManifest({ ...vm, state }),
    alive,
  };
}

function makeContent(vm, extra = []) {
  const summary = vm
    ? `Firecracker VM ${vm.id}: state=${publicVm(vm).state} pid=${vm.pid || "-"} workDir=${vm.workDir}`
    : "No Firecracker VM selected.";
  return [{ type: "text", text: [summary, ...extra].filter(Boolean).join("\n") }];
}

function updateStatus(ctx, state) {
  if (!ctx?.hasUI) return;
  const running = Array.from(state.vms.values()).filter((vm) => publicVm(vm).alive);
  ctx.ui.setStatus(STATUS_ID, running.length ? `🔥 ${running.length} Firecracker VM${running.length === 1 ? "" : "s"}` : undefined);
}

function listVmResult(state, id) {
  const vms = id ? [state.vms.get(id)].filter(Boolean) : Array.from(state.vms.values());
  if (vms.length === 0) {
    return {
      content: [{ type: "text", text: id ? `No tracked Firecracker VM: ${id}` : "No tracked Firecracker VMs." }],
      details: { firecrackerVms: [] },
    };
  }
  const lines = vms.map((vm) => {
    const pub = publicVm(vm);
    return `${pub.id}: state=${pub.state} alive=${pub.alive} pid=${pub.pid || "-"} manifest=${pub.manifestPath}`;
  });
  return { content: [{ type: "text", text: lines.join("\n") }], details: { firecrackerVms: vms.map(publicVm) } };
}

async function loadPidFile(vm) {
  if (!vm?.pidPath || vm.pid) return vm?.pid;
  const raw = await readFile(vm.pidPath, "utf8").catch(() => "");
  const pid = Number.parseInt(raw.trim(), 10);
  if (Number.isFinite(pid)) vm.pid = pid;
  return vm.pid;
}

async function stopVm(vm, { forceAfterMs = 5_000 } = {}) {
  await loadPidFile(vm);
  if (!vm?.pid || !pidAlive(vm.pid)) {
    if (vm) {
      vm.state = "stopped";
      vm.stoppedAt = vm.stoppedAt || Date.now();
      await persistManifest(vm).catch(() => {});
    }
    return false;
  }
  try { process.kill(vm.pid, "SIGTERM"); } catch {}
  const deadline = Date.now() + Math.max(0, forceAfterMs);
  while (Date.now() < deadline && pidAlive(vm.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (pidAlive(vm.pid)) {
    try { process.kill(vm.pid, "SIGKILL"); } catch {}
  }
  vm.state = "stopped";
  vm.stoppedAt = Date.now();
  await persistManifest(vm).catch(() => {});
  return true;
}

export default function firecrackerVmExtension(pi) {
  const state = { vms: new Map() };

  pi.on("session_shutdown", async () => {
    for (const vm of state.vms.values()) {
      if (vm.autostop !== false) await stopVm(vm, { forceAfterMs: 2_000 }).catch(() => {});
    }
  });

  pi.registerTool({
    name: "firecracker_vm_start",
    label: "Firecracker VM Start",
    description: "Create a Firecracker VM workspace, write a config/manifest, and optionally spawn the firecracker process for Tendril-controllable workloads.",
    promptSnippet: "Spawn and manage Firecracker VMs for browser or service workloads that Tendril agents can control via exposed host endpoints.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Stable VM id. Defaults to vm-<timestamp>." })),
      workDir: Type.Optional(Type.String({ description: "Workspace directory for config, sockets, logs, metrics, and manifest. Defaults under /tmp." })),
      firecrackerPath: Type.Optional(Type.String({ description: "Path to the firecracker binary. Defaults to FIRECRACKER_BIN or firecracker." })),
      kernelPath: Type.String({ description: "Host path to the guest kernel image." }),
      initrdPath: Type.Optional(Type.String({ description: "Optional host path to an initrd image." })),
      rootfsPath: Type.String({ description: "Host path to the root filesystem block image." }),
      rootfsReadOnly: Type.Optional(Type.Boolean({ description: "Mount rootfs read-only. Defaults to false." })),
      kernelArgs: Type.Optional(Type.String({ description: `Guest kernel args. Defaults to '${DEFAULT_KERNEL_ARGS}'.` })),
      cpuCount: Type.Optional(Type.Number({ description: "vCPU count. Defaults to 2." })),
      memMiB: Type.Optional(Type.Number({ description: "Memory in MiB. Defaults to 1024." })),
      smt: Type.Optional(Type.Boolean({ description: "Enable SMT. Defaults to false." })),
      trackDirtyPages: Type.Optional(Type.Boolean({ description: "Enable Firecracker dirty page tracking. Defaults to false." })),
      tapName: Type.Optional(Type.String({ description: "Optional host TAP device to attach as eth0." })),
      macAddress: Type.Optional(Type.String({ description: "Optional guest MAC address for eth0." })),
      services: Type.Optional(Type.Array(serviceSchema(), { description: "Host-exposed services running or expected in the guest, used as Tendril/browser control endpoints." })),
      logLevel: Type.Optional(stringEnum(["Error", "Warning", "Info", "Debug", "Trace"], "Firecracker logger level.")),
      enableMetrics: Type.Optional(Type.Boolean({ description: "Include a Firecracker metrics FIFO path in the generated config. Defaults to false because callers must create the FIFO." })),
      dryRun: Type.Optional(Type.Boolean({ description: "Only write config/manifest; do not spawn firecracker. Useful on hosts without KVM/firecracker." })),
      autostop: Type.Optional(Type.Boolean({ description: "Stop this VM on Pi session shutdown. Defaults to true." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const id = sanitizeId(params.id);
      const workDir = resolveUserPath(ctx.cwd, params.workDir || path.join(DEFAULT_WORK_ROOT, id));
      await mkdir(workDir, { recursive: true });
      const paths = {
        kernelPath: resolveUserPath(ctx.cwd, params.kernelPath),
        initrdPath: params.initrdPath ? resolveUserPath(ctx.cwd, params.initrdPath) : undefined,
        rootfsPath: resolveUserPath(ctx.cwd, params.rootfsPath),
        configPath: path.join(workDir, "firecracker-config.json"),
        manifestPath: path.join(workDir, "tendril-firecracker-manifest.json"),
        apiSocket: path.join(workDir, "firecracker.socket"),
        consoleLogPath: path.join(workDir, "serial-console.log"),
        firecrackerLogPath: path.join(workDir, "firecracker.log"),
        metricsPath: path.join(workDir, "metrics.fifo"),
        pidPath: path.join(workDir, "firecracker.pid"),
      };

      if (!params.dryRun) {
        for (const required of [paths.kernelPath, paths.rootfsPath]) {
          if (!(await pathExists(required))) throw new Error(`Required Firecracker input does not exist: ${required}`);
        }
        if (paths.initrdPath && !(await pathExists(paths.initrdPath))) throw new Error(`initrdPath does not exist: ${paths.initrdPath}`);
      }

      const config = buildFirecrackerConfig(params, paths);
      await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

      const existing = state.vms.get(id);
      if (existing && publicVm(existing).alive) throw new Error(`Firecracker VM ${id} is already running.`);

      const vm = {
        id,
        state: params.dryRun ? "prepared" : "starting",
        pid: undefined,
        startedAt: Date.now(),
        stoppedAt: undefined,
        workDir,
        configPath: paths.configPath,
        manifestPath: paths.manifestPath,
        apiSocket: paths.apiSocket,
        consoleLogPath: paths.consoleLogPath,
        firecrackerLogPath: paths.firecrackerLogPath,
        metricsPath: paths.metricsPath,
        pidPath: paths.pidPath,
        services: serializeServices(params.services),
        autostop: params.autostop !== false,
      };
      state.vms.set(id, vm);

      if (!params.dryRun) {
        const firecrackerPath = params.firecrackerPath || process.env.FIRECRACKER_BIN || "firecracker";
        const out = openSync(paths.consoleLogPath, "a");
        const err = openSync(paths.firecrackerLogPath, "a");
        const child = spawn(firecrackerPath, ["--api-sock", paths.apiSocket, "--config-file", paths.configPath], {
          cwd: workDir,
          detached: true,
          stdio: ["ignore", out, err],
        });
        child.unref();
        vm.pid = child.pid;
        vm.state = "running";
        await writeFile(paths.pidPath, `${child.pid}\n`, "utf8");
      }

      const manifest = await persistManifest(vm);
      updateStatus(ctx, state);
      return {
        content: makeContent(vm, [
          params.dryRun ? "Prepared config and Tendril manifest without spawning firecracker." : "Spawned firecracker with config-file and API socket.",
          `Manifest: ${paths.manifestPath}`,
          vm.services.length ? `Screen/control endpoints: ${vm.services.map((service) => `${service.name}=${service.url}`).join(", ")}` : "No graphical services declared; serial console is available via firecracker_vm_screen.",
        ]),
        details: { firecrackerVm: manifest, config },
      };
    },
  });

  pi.registerTool({
    name: "firecracker_vm_status",
    label: "Firecracker VM Status",
    description: "Report tracked Firecracker VM lifecycle state, manifest paths, services, and console/log locations.",
    promptSnippet: "Inspect Firecracker VM lifecycle and Tendril control metadata.",
    parameters: Type.Object({ id: Type.Optional(Type.String({ description: "VM id. Omit to list all tracked VMs." })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      updateStatus(ctx, state);
      return listVmResult(state, params.id);
    },
  });

  pi.registerTool({
    name: "firecracker_vm_list",
    label: "Firecracker VM List",
    description: "List tracked Firecracker VMs and their lifecycle state.",
    promptSnippet: "List Firecracker VMs tracked by this Pi session.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      updateStatus(ctx, state);
      return listVmResult(state);
    },
  });

  pi.registerTool({
    name: "firecracker_vm_screen",
    label: "Firecracker VM Screen",
    description: "Return the VM serial-console tail and declared graphical service endpoints that Tendril can open/capture.",
    promptSnippet: "Inspect Firecracker VM screen output through serial logs and declared noVNC/VNC/browser endpoints.",
    parameters: Type.Object({
      id: Type.String({ description: "VM id." }),
      bytes: Type.Optional(Type.Number({ description: "Bytes of serial console to return. Defaults to 16384." })),
    }),
    async execute(_toolCallId, params) {
      const vm = state.vms.get(params.id);
      if (!vm) throw new Error(`No tracked Firecracker VM: ${params.id}`);
      const consoleTail = await tailFile(vm.consoleLogPath, clampInteger(params.bytes, 16_384, 512, 1_000_000));
      const endpoints = vm.services.filter((service) => service.screen).map((service) => `${service.name}: ${service.url}`);
      return {
        content: [{ type: "text", text: [
          `Firecracker VM ${vm.id} screen access`,
          endpoints.length ? `Graphical endpoints for Tendril/browser capture:\n${endpoints.join("\n")}` : "No graphical service endpoint declared. Firecracker itself is headless; showing serial console tail.",
          consoleTail ? `Serial console tail (${vm.consoleLogPath}):\n${consoleTail}` : `Serial console log is empty or missing: ${vm.consoleLogPath}`,
        ].join("\n") }],
        details: { firecrackerVm: publicVm(vm), consoleTail, screenEndpoints: vm.services.filter((service) => service.screen) },
      };
    },
  });

  pi.registerTool({
    name: "firecracker_vm_stop",
    label: "Firecracker VM Stop",
    description: "Stop a tracked Firecracker VM process and update lifecycle metadata.",
    promptSnippet: "Stop Firecracker VMs and update lifecycle manifests.",
    parameters: Type.Object({
      id: Type.String({ description: "VM id." }),
      forceAfterMs: Type.Optional(Type.Number({ description: "Milliseconds to wait after SIGTERM before SIGKILL. Defaults to 5000." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const vm = state.vms.get(params.id);
      if (!vm) throw new Error(`No tracked Firecracker VM: ${params.id}`);
      const stopped = await stopVm(vm, { forceAfterMs: clampInteger(params.forceAfterMs, 5_000, 0, 120_000) });
      updateStatus(ctx, state);
      return { content: makeContent(vm, [stopped ? "Stopped VM process." : "VM process was not running."]), details: { firecrackerVm: publicVm(vm), stopped } };
    },
  });

  pi.registerCommand("firecracker-vms", {
    description: "Show tracked Firecracker VMs managed by this Pi session.",
    handler: async (_args, ctx) => {
      updateStatus(ctx, state);
      const vms = Array.from(state.vms.values()).map(publicVm);
      ctx.ui?.notify?.(vms.length ? vms.map((vm) => `${vm.id}: ${vm.state} pid=${vm.pid || "-"}`).join("\n") : "No tracked Firecracker VMs.", "info");
    },
  });
}
