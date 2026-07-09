// Public surface of the pi-wasm VFS / ExecutionEnv layer (pi-wasm S2).
export {
  BrowserExecutionEnv,
  createBrowserExecutionEnv,
} from "./browser-execution-env";
export type {
  BrowserExecutionEnvOptions,
  CreateBrowserExecutionEnvOptions,
} from "./browser-execution-env";
export { LightningFsVfs } from "./vfs";
export type { Vfs, VfsStat } from "./vfs";
export * as posixPath from "./posix-path";
