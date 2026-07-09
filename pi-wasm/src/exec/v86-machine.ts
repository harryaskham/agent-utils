// pi-wasm S14 (bd-c6ffc3): the REAL v86-backed MicrovmMachine (browser only).
//
// Implements the MicrovmMachine seam (boot + serial duplex, see
// ./microvm-backend.ts) over copy/v86 (BSD-2, ~2MB wasm; see
// ../../MICROVM-FEASIBILITY.md). MicrovmExecBackend drives this to run real
// bash/coreutils in the tab over the guest's serial console.
//
// v86 is dynamically imported INSIDE boot() so this module stays import-safe in
// Node / vitest: the unit tests (test/microvm-backend.test.ts) use a mock
// machine and must never pull the emulator or its wasm. The vendored guest
// assets (v86.wasm + a Buildroot bzimage + SeaBIOS/VGA BIOS) live under
// public/microvm/ (fetched by scripts/fetch-microvm-assets.mjs), served at
// /microvm/… by vite.
//
// Increment 4a (this file, first landing): boot + serial exec, filesystem:{}
// (an empty in-memory 9p). Increment 4b adds `handle9p` to bridge /work to the
// S2 LightningFsVfs so a guest `cat /work/<f>` sees a tool-written file.

import type { MicrovmMachine } from "./microvm-backend";

/** Minimal shape of the v86 emulator instance we use. */
interface V86Instance {
  add_listener(event: string, listener: (arg: number) => void): void;
  remove_listener(event: string, listener: (arg: number) => void): void;
  serial0_send(data: string): void;
  destroy(): Promise<void> | void;
}
type V86Ctor = new (options: Record<string, unknown>) => V86Instance;

export interface V86MachineOptions {
  /** URL of the v86 wasm artifact (default "/microvm/v86.wasm"). */
  wasmUrl?: string;
  /** SeaBIOS image URL (default "/microvm/seabios.bin"). */
  biosUrl?: string;
  /** VGA BIOS image URL (default "/microvm/vgabios.bin"). */
  vgaBiosUrl?: string;
  /** Buildroot bzimage URL (default "/microvm/buildroot-bzimage68.bin"). */
  bzimageUrl?: string;
  /** Kernel cmdline (default matches v86's serial example). */
  cmdline?: string;
  /** Guest RAM in MiB, power of two (default 256). */
  memoryMb?: number;
  /** Max wait for the serial shell to answer (default 90s; wasm boot is slow). */
  bootTimeoutMs?: number;
  /**
   * 9p bridge handler (S14 4b). When set, backs Virtio9p via filesystem.handle9p
   * so the guest shares a JS-owned filesystem (our LightningFsVfs). Omitted in
   * 4a → an empty in-memory 9p FS.
   */
  handle9p?: (reqbuf: Uint8Array, reply: (replybuf: Uint8Array) => void) => void;
  /** Shell commands to run once the shell is up, before boot() resolves (e.g. mount 9p). */
  postBoot?: string[];
  /** Inject a V86 constructor (tests); defaults to a dynamic import of "v86". */
  loadV86?: () => Promise<V86Ctor>;
}

const DEFAULTS = {
  wasmUrl: "/microvm/v86.wasm",
  biosUrl: "/microvm/seabios.bin",
  vgaBiosUrl: "/microvm/vgabios.bin",
  bzimageUrl: "/microvm/buildroot-bzimage68.bin",
  cmdline: "tsc=reliable mitigations=off random.trust_cpu=on",
  memoryMb: 256,
  bootTimeoutMs: 90_000,
};

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class V86Machine implements MicrovmMachine {
  readonly kind = "v86";
  private readonly wasmUrl: string;
  private readonly biosUrl: string;
  private readonly vgaBiosUrl: string;
  private readonly bzimageUrl: string;
  private readonly cmdline: string;
  private readonly memoryMb: number;
  private readonly bootTimeoutMs: number;
  private readonly handle9p?: V86MachineOptions["handle9p"];
  private readonly postBoot?: string[];
  private readonly loadV86?: () => Promise<V86Ctor>;

  private emulator: V86Instance | undefined;
  private booted = false;
  private readonly listeners = new Set<(chunk: string) => void>();
  private serialBuffer = "";

  constructor(options: V86MachineOptions = {}) {
    this.wasmUrl = options.wasmUrl ?? DEFAULTS.wasmUrl;
    this.biosUrl = options.biosUrl ?? DEFAULTS.biosUrl;
    this.vgaBiosUrl = options.vgaBiosUrl ?? DEFAULTS.vgaBiosUrl;
    this.bzimageUrl = options.bzimageUrl ?? DEFAULTS.bzimageUrl;
    this.cmdline = options.cmdline ?? DEFAULTS.cmdline;
    this.memoryMb = options.memoryMb ?? DEFAULTS.memoryMb;
    this.bootTimeoutMs = options.bootTimeoutMs ?? DEFAULTS.bootTimeoutMs;
    this.handle9p = options.handle9p;
    this.postBoot = options.postBoot;
    this.loadV86 = options.loadV86;
  }

  /** Available wherever WebAssembly exists (i.e. a browser tab). */
  get available(): boolean {
    return typeof WebAssembly !== "undefined";
  }

  async boot(): Promise<void> {
    if (this.booted) return;
    const V86 = this.loadV86
      ? await this.loadV86()
      : ((await import("v86")) as unknown as { V86: V86Ctor }).V86;

    const filesystem = this.handle9p ? { handle9p: this.handle9p } : {};
    const emulator = new V86({
      wasm_path: this.wasmUrl,
      bios: { url: this.biosUrl },
      vga_bios: { url: this.vgaBiosUrl },
      bzimage: { url: this.bzimageUrl },
      cmdline: this.cmdline,
      memory_size: this.memoryMb * 1024 * 1024,
      autostart: true,
      disable_speaker: true,
      filesystem,
    });
    this.emulator = emulator;
    emulator.add_listener("serial0-output-byte", (byte: number) => {
      const ch = String.fromCharCode(byte);
      this.serialBuffer += ch;
      // Bound the readiness buffer (exec parsing uses its own per-call buffer).
      if (this.serialBuffer.length > 1_000_000) this.serialBuffer = this.serialBuffer.slice(-500_000);
      for (const l of [...this.listeners]) l(ch);
    });

    await this.waitForShell();
    for (const cmd of this.postBoot ?? []) await this.runBare(cmd);
    this.booted = true;
  }

  writeSerial(data: string): void {
    if (!this.emulator) throw new Error("v86 machine not booted");
    this.emulator.serial0_send(data);
  }

  onSerialData(listener: (chunk: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    try {
      await this.emulator?.destroy();
    } catch {
      /* best-effort teardown */
    }
    this.emulator = undefined;
    this.booted = false;
  }

  /**
   * Resolve once the guest serial shell answers a probe. The probe passes a
   * unique token as a printf ARGUMENT, so the marker (`V86SHELL_<token>`) only
   * ever appears in command OUTPUT, never in the console echo of the typed line
   * — the same echo-robust trick the exec protocol uses. Retries until the
   * shell is up (buildroot auto-logs-in) or the boot timeout elapses.
   */
  private async waitForShell(): Promise<void> {
    const token = `RDY${Math.random().toString(36).slice(2, 10)}`;
    const marker = `V86SHELL_${token}`;
    const deadline = Date.now() + this.bootTimeoutMs;
    // Give the kernel a head start toward the getty/shell before the first probe.
    await delay(2500);
    while (Date.now() < deadline) {
      this.emulator!.serial0_send(`printf 'V86SHELL_%s\\n' '${token}'\n`);
      const seen = await this.waitFor(() => this.serialBuffer.includes(marker), 1500);
      if (seen) return;
    }
    throw new Error(`v86 serial shell not ready within ${this.bootTimeoutMs}ms`);
  }

  private waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (pred()) return resolve(true);
      const iv = setInterval(() => {
        if (pred()) {
          clearInterval(iv);
          clearTimeout(to);
          resolve(true);
        }
      }, 80);
      const to = setTimeout(() => {
        clearInterval(iv);
        resolve(false);
      }, timeoutMs);
    });
  }

  /** Best-effort fire-and-forget of a boot-time command (e.g. a 9p mount). */
  private async runBare(cmd: string): Promise<void> {
    this.emulator!.serial0_send(cmd + "\n");
    await delay(500);
  }
}
