// A restart must replace the process. Spawning another interactive Pi while
// leaving the old TUI alive gives two readers the same terminal input stream.
// Node provides execve; bundled Bun currently needs its built-in POSIX FFI.
export async function resolveProcessExecve({
  runtime = process,
  loadFfi = () => import("bun:ffi"),
} = {}) {
  if (typeof runtime.execve === "function") return runtime.execve.bind(runtime);
  if (!runtime.versions?.bun || !["darwin", "linux"].includes(runtime.platform)) {
    throw new Error("/restart requires process replacement (execve); this runtime cannot safely restart an interactive session");
  }
  const { dlopen, ptr } = await loadFfi();
  const library = dlopen(runtime.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    execve: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  });
  const cstring = value => {
    const text = String(value);
    if (text.includes("\0")) throw new Error("/restart: NUL in process arguments or environment");
    return Buffer.from(`${text}\0`);
  };
  const vector = strings => {
    // Keep the buffers strongly reachable until the native call returns. The
    // pointer array is native-endian and terminated with a null pointer.
    const buffers = strings.map(cstring);
    const pointers = new BigUint64Array(buffers.length + 1);
    buffers.forEach((buffer, index) => { pointers[index] = BigInt(ptr(buffer)); });
    return { buffers, pointers };
  };
  return (executable, argv, env) => {
    try {
      const file = cstring(executable);
      const args = vector(argv);
      const environment = vector(Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`));
      const result = library.symbols.execve(ptr(file), ptr(args.pointers), ptr(environment.pointers));
      // Successful execve never returns. No shell quoting/interpolation occurs.
      throw new Error(`/restart: execve failed (${result}) for ${executable}`);
    } finally {
      library.close();
    }
  };
}
