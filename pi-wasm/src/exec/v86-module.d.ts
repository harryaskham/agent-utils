// Ambient module declaration for copy/v86 (npm "v86"). The package ships
// v86.d.ts at its root but declares no "types"/"exports" entry, so TS cannot
// resolve types for `import("v86")` on its own. We only use a tiny slice of the
// API (see V86MachineOptions in ./v86-machine.ts), so declare just that.
declare module "v86" {
  export class V86 {
    constructor(options: Record<string, unknown>);
    add_listener(event: string, listener: (arg: number) => void): void;
    remove_listener(event: string, listener: (arg: number) => void): void;
    serial0_send(data: string): void;
    destroy(): Promise<void>;
  }
}
