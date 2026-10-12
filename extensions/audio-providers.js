// Provider edits are session-only. Never edit settings.json, capture audio,
// acquire credentials or test providers as a side effect of opening settings.
import { parseEnvStyleArgs } from "./lib/env-args.js";
import { createSessionRuntimeSettings } from "./lib/session-runtime-settings.js";
import {
  bindAudioProviders, audioProviderNames, audioProviderType, describeAudioProviders,
  resetRuntimeAudioProviders, restoreRuntimeAudioProviders, setRuntimeAudioProvider,
  snapshotRuntimeAudioProviders, inspectAudioConnection,
} from "./lib/audio-providers.js";
const USAGE = "Usage: /audio [status] · /audio settings [name] · /audio <name> type=azure|openai|daemon|command endpoint=... auth=entra az=az-token · /audio [name] reset. OpenAI keys: api_key_env=OPENAI_API_KEY. tts.<field> / stt.<field> scopes a connection field. none removes an override. Select with /tts|/read|/narrate|/stt provider=<name>.";
const FIELDS = {
  azure: ["endpoint", "auth", "az", "api_key_env", "resource", "tenant", "subscription", "tts.resource_id", "stt.deployment", "tts.endpoint", "stt.endpoint"],
  openai: ["endpoint", "api_key_env", "tts.endpoint", "stt.endpoint"],
  daemon: ["tts.daemon_url", "stt.daemon_url", "daemon_provider", "token_file"],
  command: ["command"],
};
export default function audioProvidersExtension(pi) {
  const binding = bindAudioProviders(pi), options = { audioProviders: binding.providers };
  // Own entry type: never clobber another extension's runtime-settings snapshot.
  const durable = createSessionRuntimeSettings(pi, { customType: "audio-runtime-settings", flushMs: 0 });
  let active = true, epoch = 0;
  const persist = () => durable.merge("audio", { providers: snapshotRuntimeAudioProviders(options) });
  const status = () => describeAudioProviders(options).join("\n");
  pi.on("session_start", (_event, ctx) => {
    epoch++; active = true;
    const saved = durable.restore(ctx);
    restoreRuntimeAudioProviders(saved.audio?.providers ?? {}, options);
  });
  pi.on("session_shutdown", () => { active = false; epoch++; durable.flush(); binding.release(); });

  async function interactive(ctx, initialName, current) {
    const name = initialName || await ctx.ui.select("Audio provider", [...audioProviderNames(options), "+ new provider"]);
    if (!current() || !name) return;
    let provider = name, patch = {}, type;
    if (name === "+ new provider") {
      provider = (await ctx.ui.input("Provider name", "azure-work"))?.trim();
      if (!current() || !provider) return;
      type = await ctx.ui.select("Type", ["azure", "openai", "daemon", "command"]);
      if (!current() || !type) return;
      patch.type = type;
    } else type = audioProviderType(provider, options);
    const field = await ctx.ui.select(`${provider} (${type})`, [...FIELDS[type], "reset"]);
    if (!current() || !field) return;
    if (field === "reset") resetRuntimeAudioProviders(provider, options);
    else {
      const connection = patch.type ? {} : inspectAudioConnection(provider, { ...options, kind: field.startsWith("stt.") ? "stt" : "tts" }) || {};
      const key = field.replace(/^(?:tts|stt)\./, "").replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      const value = field === "auth" ? await ctx.ui.select("Authentication", ["entra", "key"]) : await ctx.ui.input(`${provider} · ${field} (none unsets)`, connection[key] ?? "");
      if (!current() || value == null) return;
      setRuntimeAudioProvider(provider, { ...patch, [field]: value }, options);
    }
    persist(); ctx.ui.notify(status(), "info");
  }
  pi.registerCommand("audio", {
    description: "Configure named audio connections shared by speech surfaces. " + USAGE,
    handler: async (args, ctx) => {
      const generation = epoch, current = () => active && epoch === generation;
      try {
        const { positionals, values } = parseEnvStyleArgs(String(args || ""));
        const [first, second] = positionals.map(v => String(v).toLowerCase());
        const hasValues = Object.keys(values).length > 0;
        if (!current()) return;
        if (positionals.length > 2) throw new Error(USAGE);
        if (first === "settings" && !hasValues) { await interactive(ctx, second, current); return; }
        if ((!first || first === "status") && !second && !hasValues) { ctx.ui.notify(status(), "info"); return; }
        if (first === "help" && !second && !hasValues) { ctx.ui.notify(USAGE, "info"); return; }
        if ((first === "reset" && !second || first && second === "reset") && !hasValues) {
          resetRuntimeAudioProviders(second ? first : undefined, options); persist(); ctx.ui.notify(status(), "info"); return;
        }
        if (!first || second) throw new Error(USAGE);
        if (hasValues) { setRuntimeAudioProvider(first, values, options); persist(); }
        else audioProviderType(first, options); // unknown names are errors, not success
        ctx.ui.notify(describeAudioProviders(options).find(row => row.startsWith(first + ":")) || status(), "info");
      } catch (error) { if (current()) ctx.ui.notify(error?.message || String(error), "warning"); }
    },
  });
}
