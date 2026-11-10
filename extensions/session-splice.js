// /splice for TUI Pi: copy turns of another agent session (pi-daemon on any configured host,
// or this host's TUI Pi sessions) into this one. See docs/session-splice.md.
//
// A splice is stored as one custom message (customType agent-utils.splice) whose content is
// the spliced text, so the session shows it and any runtime can send it. method=verbatim also
// keeps the copied messages in its details, and this extension's `context` hook sends them in
// its place as real user, assistant and tool-result turns.

import {
  SPLICE_CUSTOM_TYPE,
  SPLICE_USAGE,
  buildSplice,
  describeTurns,
  parseSpliceArgs,
  renderTurnsText,
  resolveRange,
  segmentTurns,
  selectTurns,
  summaryRequest,
} from "./lib/session-splice.js";
import { listSources, loadSource, readClientSettings, agentDirOf, localNodeName } from "./lib/session-splice-sources.js";
import { runPiTextTurn } from "./lib/pi-inference.js";

const METHOD_CHOICES = [
  ["text", "text: one quoted transcript message"],
  ["summary", "summary: one model-written summary"],
  ["verbatim", "verbatim: the turns themselves, tool calls kept"],
];

/** The messages a stored splice stands for in model context. */
export function expandSplices(messages) {
  let changed = false;
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const copied = message?.role === "custom" && message.customType === SPLICE_CUSTOM_TYPE ? message.details?.messages : undefined;
    if (Array.isArray(copied) && copied.length) {
      out.push(...copied);
      changed = true;
    } else {
      out.push(message);
    }
  }
  return changed ? out : undefined;
}

/**
 * The text a splice's custom message carries, and what the model gets where the context hook
 * does not run: the message itself, or for verbatim turns their transcript inside the markers.
 */
export function spliceContent(splice, { method, guard }) {
  const textOf = (message) => message.content.map((block) => block.text ?? "").join("\n");
  if (method !== "verbatim") return textOf(splice.messages[0]);
  const copied = guard ? splice.messages.slice(1, -1) : splice.messages;
  const body = renderTurnsText([{ index: 0, messages: copied }], { thinking: "keep", tools: "keep" });
  return guard ? `${textOf(splice.messages[0])}\n\n${body}\n${textOf(splice.messages.at(-1))}` : body;
}

async function chooseSource(ctx, deps) {
  const local = await deps.listSources({ env: deps.env });
  const other = "Another host…";
  const options = [...local.sources.map((source) => source.label), ...(deps.hosts().length ? [other] : [])];
  if (local.errors.length) ctx.ui.notify(local.errors.join("\n"), "warning");
  if (!options.length) throw new Error("no sessions to splice from");
  const picked = await ctx.ui.select("Splice from which session?", options);
  if (picked === undefined) return undefined;
  if (picked !== other) return local.sources.find((source) => source.label === picked)?.src;
  const hostName = await ctx.ui.select("Which host?", deps.hosts());
  if (hostName === undefined) return undefined;
  const remote = await deps.listSources({ host: hostName, env: deps.env });
  if (remote.errors.length && !remote.sources.length) throw new Error(remote.errors.join("\n"));
  const choice = await ctx.ui.select(`Splice from which ${hostName} session?`, remote.sources.map((source) => source.label));
  return choice === undefined ? undefined : remote.sources.find((source) => source.label === choice)?.src;
}

async function chooseOptions(ctx, turns) {
  const numbered = turns.filter((turn) => turn.index > 0).slice(-60);
  const line = (turn) => `${turn.index} · ${turn.prompt}`;
  const first = await ctx.ui.select("From which turn?", numbered.map(line));
  if (first === undefined) return undefined;
  const from = Number(first.split(" ")[0]);
  const last = await ctx.ui.select("To which turn?", numbered.filter((turn) => turn.index >= from).map(line));
  if (last === undefined) return undefined;
  const to = Number(last.split(" ")[0]);
  const methodLabel = await ctx.ui.select("Splice as", METHOD_CHOICES.map(([, label]) => label));
  if (methodLabel === undefined) return undefined;
  const method = METHOD_CHOICES.find(([, label]) => label === methodLabel)[0];
  let focus = "";
  if (method === "summary") focus = (await ctx.ui.input?.("Focus the summary on (optional)", "")) ?? "";
  return { from, to, method, focus };
}

/** /splice's handler, with its I/O injectable for tests. */
export function createSpliceHandler(pi, deps = {}) {
  const env = deps.env ?? process.env;
  const resolved = {
    env,
    listSources: deps.listSources ?? listSources,
    loadSource: deps.loadSource ?? loadSource,
    hosts: deps.hosts ?? (() => readClientSettings(agentDirOf(env)).hosts.map((host) => host.name).filter((name) => name !== localNodeName(env))),
    summarize: deps.summarize ?? (async (ctx, request) => {
      if (!ctx.model) throw new Error("no model is selected to write the summary");
      return (await runPiTextTurn(ctx, { model: ctx.model, ...request, maxTokens: 4_000 })).text;
    }),
  };
  return async function handleSplice(args, ctx) {
    let options;
    try {
      options = parseSpliceArgs(args);
    } catch (error) {
      ctx.ui.notify(`/splice: ${error.message}\n\n${SPLICE_USAGE}`, "warning");
      return;
    }
    try {
      if (options.action === "help") {
        ctx.ui.notify(SPLICE_USAGE, "info");
        return;
      }
      if (options.action === "list") {
        const listed = await resolved.listSources({ host: options.host, env });
        const lines = listed.sources.map((source) => `${source.src}\n    ${source.label}`);
        ctx.ui.notify([`Sessions on ${listed.host}:`, ...lines, ...listed.errors].join("\n") || "No sessions found.", listed.errors.length ? "warning" : "info");
        return;
      }
      let src = options.src;
      let interactive;
      if (src === undefined) {
        if (options.action === "show" || !ctx.hasUI) {
          ctx.ui.notify(`/splice: give a source session.\n\n${SPLICE_USAGE}`, "warning");
          return;
        }
        src = await chooseSource(ctx, resolved);
        if (src === undefined) return;
        interactive = true;
      }
      const source = await resolved.loadSource(src, { conversation: options.conversation, env });
      const turns = segmentTurns(source.messages);
      const count = turns.filter((turn) => turn.index > 0).length;
      if (options.action === "show") {
        ctx.ui.notify(`${source.host}/${source.sessionId} (${source.title}): ${count} turns\n${describeTurns(turns)}`, "info");
        return;
      }
      if (interactive) {
        const chosen = await chooseOptions(ctx, turns);
        if (chosen === undefined) return;
        const verbatim = chosen.method === "verbatim";
        options = { ...options, range: { from: chosen.from, to: chosen.to }, method: chosen.method, as: verbatim ? "turns" : "one", tools: verbatim ? "keep" : "collapse", ...(chosen.focus ? { focus: chosen.focus } : {}) };
      }
      const range = resolveRange(options.range, count);
      const selected = selectTurns(turns, range);
      const summaryText = options.method === "summary" ? await resolved.summarize(ctx, summaryRequest(selected, { focus: options.focus })) : undefined;
      const splice = buildSplice({ source, turns: selected, range, turnCount: count, options, summaryText });
      if (interactive && !(await ctx.ui.confirm("Splice into this session?", `${splice.label}\n${splice.messages.length} message(s), ${splice.chars} characters`))) return;
      pi.sendMessage({
        customType: SPLICE_CUSTOM_TYPE,
        content: spliceContent(splice, options),
        display: true,
        details: {
          label: splice.label,
          provenance: splice.provenance,
          ...(options.method === "verbatim" ? { messages: splice.messages } : {}),
        },
      }, { triggerTurn: false });
      ctx.ui.notify(`Spliced ${splice.label}: ${splice.messages.length} message(s), ${splice.chars} characters.`, "info");
    } catch (error) {
      ctx.ui.notify(`/splice: ${error.message}`, "error");
    }
  };
}

export default function sessionSpliceExtension(pi, deps = {}) {
  pi.registerCommand("splice", {
    description: "Copy turns of another session (pi-daemon on any host, or TUI Pi) into this one: /splice, /splice list, /splice SRC last=2 method=summary",
    getArgumentCompletions: (prefix) => {
      const words = ["list", "show", "help", "last=", "turns=", "method=text", "method=summary", "method=verbatim", "tools=collapse", "tools=keep", "tools=drop", "thinking=keep", "guard=off", "focus=", "max=", "host="];
      const last = String(prefix ?? "").split(/\s+/).pop() ?? "";
      const head = String(prefix ?? "").slice(0, String(prefix ?? "").length - last.length);
      const matches = words.filter((word) => word.startsWith(last)).map((word) => ({ value: `${head}${word}`, label: word }));
      return matches.length ? matches : null;
    },
    handler: createSpliceHandler(pi, deps),
  });
  pi.on("context", (event) => {
    const messages = expandSplices(event.messages);
    return messages ? { messages } : undefined;
  });
}
