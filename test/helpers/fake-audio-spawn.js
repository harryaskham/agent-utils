// Scriptable fake child processes for audio decoder/sink pipelines.
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

/// Fake child processes. Behaviours script decoder/sink lifecycles.
export function fakeSpawner(behaviours = {}) {
  const children = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    Object.assign(child, { command, args, options, signals: [], received: 0, exitCode: null, signalCode: null });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) { child.received += chunk.length; callback(); },
      final(callback) { callback(); child.emit("stdin-end"); },
    });
    child.finish = (code = 0) => {
      if (child.exitCode !== null || child.signalCode) return;
      child.exitCode = code;
      setImmediate(() => { child.emit("exit", code, null); child.emit("close", code, null); });
    };
    child.kill = (signal = "SIGTERM") => {
      child.signals.push(signal);
      if (child.exitCode === null && !child.signalCode) {
        child.signalCode = signal;
        setImmediate(() => { child.emit("exit", null, signal); child.emit("close", null, signal); });
      }
      return true;
    };
    children.push(child);
    (behaviours[command] || (() => {}))(child);
    return child;
  };
  return { spawn, children };
}
export const drainingSink = (child) => child.on("stdin-end", () => child.finish(0));
