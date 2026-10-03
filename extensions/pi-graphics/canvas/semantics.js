// Semantic provenance for the Pi pixel canvas.
//
// Pi exposes its conversation data model (session entries, message events,
// each message component's `lastMessage` / `isStreaming`) and a layout tree,
// but the layout stops at the transcript container: the whole transcript is
// one flat line array, so there is no API for "which screen rows show this
// thinking block". This module bridges the two. While the canvas is active it
// wraps the render of Pi's message components (learned from the live tree)
// and prefixes every produced line with a zero-width APC marker:
//
//     ESC _ pi:gfx:@<role>[.<kind>]:<block>:<line>[:<flags>] BEL
//
// role  – user | assistant | thinking | tool | bash | custom | skill | summary
// kind  – optional sub-kind, e.g. the tool name (tool.read, tool.bash)
// block – stable id of the semantic block (message instance + child index)
// line  – line index within the block (survives scrolling and clipping)
// flags – s: the owning message/tool is streaming; e: the tool failed
//
// pi-tui treats APC as zero-width and keeps it through ScrollView clipping,
// overlay compositing and selection; the frame compositor strips markers
// before anything reaches the terminal. Markers are per row, so a block that
// is partly scrolled off still identifies every visible row.

export const SEMANTIC_PREFIX = "\x1b_pi:gfx:@";
const SEMANTIC_RE = /\x1b_pi:gfx:@([a-z]+)(?:\.([A-Za-z0-9_-]+))?:([0-9.]+):(\d+)(?::([se]+))?\x07/;

export const ROLE_BY_CLASS = Object.freeze({
  UserMessageComponent: "user",
  AssistantMessageComponent: "assistant",
  ToolExecutionComponent: "tool",
  BashExecutionComponent: "bash",
  CustomMessageComponent: "custom",
  SkillInvocationMessageComponent: "skill",
  BranchSummaryMessageComponent: "summary",
  CompactionSummaryMessageComponent: "summary",
});

const TAP = Symbol.for("agent-utils.piGraphics.semanticTap");
const BLOCK = Symbol.for("agent-utils.piGraphics.semanticBlock");
let blockCounter = 0;

// streaming: boolean, or { streaming, error, kind } for tools.
function flagsOf(state) {
  if (state && typeof state === "object") return `${state.streaming ? "s" : ""}${state.error ? "e" : ""}`;
  return state ? "s" : "";
}

export function semanticMarker(role, block, line, state = false) {
  const kind = state && typeof state === "object" && state.kind ? `.${String(state.kind).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)}` : "";
  const flags = flagsOf(state);
  return `${SEMANTIC_PREFIX}${role}${kind}:${block}:${line}${flags ? `:${flags}` : ""}\x07`;
}

export function parseSemanticMarker(text) {
  const match = SEMANTIC_RE.exec(text);
  if (!match) return null;
  const flags = match[5] || "";
  return { role: match[1], kind: match[2] || "", block: match[3], line: Number(match[4]), streaming: flags.includes("s"), error: flags.includes("e") };
}

function blockIdOf(component) {
  if (!component[BLOCK]) {
    blockCounter = (blockCounter + 1) % 0xffffff;
    component[BLOCK] = String(blockCounter);
  }
  return component[BLOCK];
}

const tagCache = new WeakMap();
export function tagLines(lines, role, block, state = false) {
  if (!Array.isArray(lines)) return lines;
  const key = `${role}:${block}:${typeof state === "object" && state ? `${state.kind || ""}:${flagsOf(state)}` : flagsOf(state)}`;
  const hit = tagCache.get(lines);
  if (hit && hit.key === key) return hit.tagged;
  const tagged = lines.map((line, index) => (typeof line === "string" && !line.includes(SEMANTIC_PREFIX)
    ? `${semanticMarker(role, block, index, state)}${line}`
    : line));
  tagCache.set(lines, { key, tagged });
  return tagged;
}

function childRole(child) {
  const style = child?.defaultTextStyle;
  if (style && style.italic) return "thinking";
  const text = typeof child?.text === "string" ? child.text : "";
  if (text.startsWith("\x1b[3m") || text.includes("\x1b[3m\x1b[38")) return "thinking";
  return "assistant";
}

// Assistant messages contain thinking and answer Markdown children which Pi
// recreates on every streaming update; tag each child instance with a block id
// derived from the parent and the child's position so identity is stable.
function tapAssistantChildren(component, isActive) {
  const container = component?.contentContainer;
  const children = Array.isArray(container?.children) ? container.children : [];
  const parentBlock = blockIdOf(component);
  children.forEach((child, index) => {
    if (!child || typeof child.render !== "function" || child.constructor?.name === "Spacer") return;
    const role = childRole(child);
    const block = `${parentBlock}.${index}`;
    if (child[TAP]?.block === block && child[TAP]?.role === role) return;
    const original = child[TAP]?.original || child.render;
    child.render = function semanticChildRender(width) {
      const lines = original.call(this, width);
      return isActive() ? tagLines(lines, role, block, Boolean(component.isStreaming)) : lines;
    };
    child[TAP] = { role, block, original };
  });
}

/**
 * Install (idempotently) the render tap on one discovered host class.
 * Returns true when the class is a semantic message class.
 */
export function tapSemanticClass(name, ctor, isActive) {
  const role = ROLE_BY_CLASS[name];
  const proto = ctor?.prototype;
  if (!role || typeof proto?.render !== "function") return false;
  if (proto.render[TAP]) return true;
  const original = proto.render;
  const tapped = function semanticRender(width) {
    if (!isActive()) return original.call(this, width);
    if (role === "assistant") tapAssistantChildren(this, isActive);
    const lines = original.call(this, width);
    let tagState = false;
    if (role === "assistant") tagState = Boolean(this.isStreaming);
    else if (role === "tool") tagState = { kind: this.toolName || "", streaming: Boolean(this.isPartial), error: Boolean(this.result?.isError) };
    else if (role === "bash") tagState = { kind: "bash", streaming: this.status === "running", error: this.status === "error" || (this.exitCode !== undefined && this.exitCode !== 0) };
    return tagLines(lines, role, blockIdOf(this), tagState);
  };
  tapped[TAP] = { original, role };
  proto.render = tapped;
  return true;
}

/** Re-apply taps another patcher may have unwound (cheap; call per frame). */
export function ensureSemanticTaps(classes, isActive) {
  for (const [name, ctor] of classes) {
    const proto = ctor?.prototype;
    if (ROLE_BY_CLASS[name] && proto && !proto.render?.[TAP]) tapSemanticClass(name, ctor, isActive);
  }
}

export function untapSemanticClass(ctor) {
  const proto = ctor?.prototype;
  const tap = proto?.render?.[TAP];
  if (tap && proto.render[TAP].original) proto.render = tap.original;
}
