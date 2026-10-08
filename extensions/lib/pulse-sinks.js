// Explicit Pulse sink management for /tts focus and /tts solo. No shell, no
// default-sink mutation, and no commands run merely by importing this module.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

export const SOLO_OWNER_PROPERTY = "agent.utils.solo.owner";
const MAX_OUTPUT = 1024 * 1024;
const CREATION_PROPERTY = "agent.utils.sink.creation";

export function pulseServer(server, env = process.env) {
  const value = server === undefined ? env.PULSE_SERVER : server;
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Pulse server must be a bounded address without control characters");
  return value;
}
export function validateSinkName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,127}$/.test(name)) throw new Error("Pulse sink creation requires a name of 1–127 letters, digits, underscores, dots or hyphens");
  return name;
}
function moduleId(value) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 0xffffffff) throw new Error("Pulse returned an invalid module ID");
  return Number(value);
}
export function pulsePropertiesArgument(properties) {
  const entries = Object.entries(properties).map(([key, value]) => {
    if (!/^[a-zA-Z0-9_.-]+$/.test(key) || /[\x00-\x1f\x7f]/.test(String(value))) throw new Error("Invalid Pulse property");
    const quoted = String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${key}="${quoted}"`;
  }).join(" ");
  // Module arguments preserve the RAW property-list value. Escape the outer
  // apostrophe but do not double the property's existing backslashes again.
  // These are literal argv bytes, not shell quotes. Verified with real pactl.
  return `sink_properties='${entries.replace(/'/g, "\\'")}'`;
}

export function createPulseSinks({ env = process.env, execFileImpl = execFile, timeoutMs = 5000 } = {}) {
  const invoke = (server, args) => new Promise((resolve, reject) => {
    const selected = pulseServer(server, env);
    const childEnv = { ...env, LC_ALL: "C" }; // Stable diagnostic classifications.
    for (const key of Object.keys(childEnv)) if (/(?:API_KEY|DAEMON_TOKEN|DAMEON_TOKEN)$/.test(key)) delete childEnv[key];
    if (selected === null) delete childEnv.PULSE_SERVER;
    else childEnv.PULSE_SERVER = selected;
    execFileImpl("pactl", [...(selected === null ? [] : ["--server", selected]), ...args], {
      env: childEnv, timeout: timeoutMs, maxBuffer: MAX_OUTPUT, encoding: "utf8", killSignal: "SIGKILL",
    }, (error, stdout = "", stderr = "") => {
      if (error) {
        const detail = String(stderr).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, 300);
        const failure = new Error(`pactl ${args[0]} failed${error.killed ? " (timed out; outcome may be unknown)" : ""}${detail ? `: ${detail}` : ""}`);
        // These are authoritative PA error replies, not a lost connection.
        // A user may retry after repairing the rejected request/server policy.
        failure.rejected = !error.killed && error.code === 1 && /^Failure: (Module initialization failed|Invalid argument|Access denied|No such entity)\s*$/m.test(String(stderr));
        reject(failure);
      } else resolve(String(stdout));
    });
  });
  const list = async (server, kind) => {
    // PulseAudio 17 pactl omits module indices from its JSON objects. The short
    // module table has stable numeric IDs; never guess an index from row order.
    if (kind === "modules") {
      const text = await invoke(server, ["list", "short", "modules"]);
      const rows = text.trim() ? text.trim().split(/\r?\n/) : [];
      if (rows.length > 10000) throw new Error("pactl returned too many modules");
      return rows.map(row => {
        const [index, name] = row.split("\t");
        if (!name) throw new Error("pactl returned an invalid module listing");
        return { index: moduleId(index), name };
      });
    }
    const text = await invoke(server, ["--format=json", "list", kind]);
    let records;
    try { records = JSON.parse(text); } catch { throw new Error(`pactl returned invalid ${kind} JSON`); }
    if (!Array.isArray(records) || records.length > 10000) throw new Error(`pactl returned an invalid ${kind} listing`);
    return records;
  };
  const find = async (server, name) => {
    const sinks = await list(server, "sinks");
    if (name === "@DEFAULT_SINK@") {
      const selected = (await invoke(server, ["get-default-sink"])).trim();
      return sinks.find(s => s.name === selected);
    }
    return sinks.find(s => s.name === name || (/^\d+$/.test(name) && String(s.index) === name));
  };
  const ensure = async ({ server, name, description, owner, uncertain = false }) => {
    const existing = await find(server, name);
    if (existing) {
      const owned = !!owner && existing.properties?.[SOLO_OWNER_PROPERTY] === owner;
      if (owned) moduleId(existing.owner_module);
      return { sink: existing, created: false, owned };
    }
    if (uncertain) throw new Error("Previous solo sink creation is unconfirmed; inspect/reconcile it before retrying");
    validateSinkName(name);
    const creation = randomUUID();
    const properties = { "device.description": description, [CREATION_PROPERTY]: creation, ...(owner ? { [SOLO_OWNER_PROPERTY]: owner } : { "agent.utils.focus": "1" }) };
    let index, loadError;
    try {
      index = moduleId((await invoke(server, ["load-module", "module-null-sink", `sink_name=${name}`, "rate=24000", "channels=2", pulsePropertiesArgument(properties)])).trim());
    } catch (error) { loadError = error; }
    // Reconcile a lost reply or a concurrent creator. Never blindly load twice.
    try {
      const sinks = await list(server, "sinks");
      const sink = sinks.find(s => s.name === name);
      if (!sink) throw loadError || new Error("Pulse sink creation was not confirmed; no retry was made");
      // Pulse can auto-suffix a concurrent duplicate (name.2) instead of
      // rejecting it. Remove only our positively identified losing allocation
      // and borrow the winning exact name. This is not focus-sink cleanup.
      const created = sinks.find(s => s.properties?.[CREATION_PROPERTY] === creation && (index === undefined || Number(s.owner_module) === index));
      if (created && created.name !== name) {
        const removed = await cleanup({ server, name: created.name, owner: creation, marker: CREATION_PROPERTY, moduleId: moduleId(created.owner_module) });
        if (!["removed", "gone"].includes(removed.state)) throw new Error("Duplicate Pulse allocation cleanup is unconfirmed; inspect the server modules");
        return { sink, created: false, owned: !!owner && sink.properties?.[SOLO_OWNER_PROPERTY] === owner };
      }
      const owned = !!owner && sink.properties?.[SOLO_OWNER_PROPERTY] === owner;
      if (index !== undefined && (moduleId(sink.owner_module) !== index || (owner && !owned))) throw new Error("Pulse sink creation returned a mismatched owner; routing was not changed");
      return { sink, created: index !== undefined || owned, owned };
    } catch (error) { error.creationUnconfirmed = !loadError?.rejected; throw error; }
  };
  const cleanup = async (allocation) => {
    if (typeof allocation?.owner !== "string" || !allocation.owner) return { state: "not-owned" };
    // Both marker and module identity must still match. A server restart/reused
    // index or administrator replacement must never unload somebody else's sink.
    const sink = await find(allocation.server, allocation.name);
    if (!sink) return { state: allocation.uncertain && allocation.moduleId == null ? "unconfirmed" : "gone" };
    const marker = allocation.marker === CREATION_PROPERTY ? CREATION_PROPERTY : SOLO_OWNER_PROPERTY;
    if (sink.properties?.[marker] !== allocation.owner) return { state: "not-owned" };
    const index = moduleId(sink.owner_module);
    if (allocation.moduleId != null && index !== allocation.moduleId) return { state: "not-owned" };
    const modules = await list(allocation.server, "modules");
    const module = modules.find(m => Number(m.index) === index);
    if (!module || module.name !== "module-null-sink") return { state: "not-owned" };
    const inputs = await list(allocation.server, "sink-inputs");
    if (inputs.some(input => String(input.sink) === String(sink.index))) return { state: "busy" };
    let unloadError;
    try { await invoke(allocation.server, ["unload-module", String(index)]); } catch (error) { unloadError = error; }
    const remaining = await find(allocation.server, allocation.name);
    if (remaining?.properties?.[marker] === allocation.owner) throw unloadError || new Error("Solo sink removal was not confirmed");
    return { state: "removed" };
  };
  return { ensure, cleanup, list, find };
}
