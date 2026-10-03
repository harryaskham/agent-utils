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
//     ESC _ pi:gfx:@<role>:<block>:<line>[:s] BEL
//
// role  – user | assistant | thinking | tool | bash | custom | skill | summary
// block – stable id of the semantic block (message instance + child index)
// line  – line index within the block (survives scrolling and clipping)
// s     – the owning message is streaming
//
// pi-tui treats APC as zero-width and keeps it through ScrollView clipping,
// overlay compositing and selection; the frame compositor strips markers
// before anything reaches the terminal. Markers are per row, so a block that
// is partly scrolled off still identifies every visible row.

export const SEMANTIC_PREFIX = "\x1b_pi:gfx:@";
const SEMANTIC_RE = /\x1b_pi:gfx:@([a-z]+):([0-9.]+):(\d+)(:s)?\x07/;

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

export function semanticMarker(role, block, line, streaming = false) {
  return `${SEMANTIC_PREFIX}${role}:${block}:${line}${streaming ? ":s" : ""}\x07`;
}

export function parseSemanticMarker(text) {
  const match = SEMANTIC_RE.exec(text);
  return match ? { role: match[1], block: match[2], line: Number(match[3]), streaming: Boolean(match[4]) } : null;
}

function blockIdOf(component) {
  if (!component[BLOCK]) {
    blockCounter = (blockCounter + 1) % 0xffffff;
    component[BLOCK] = String(blockCounter);
  }
  return component[BLOCK];
}

const tagCache = new WeakMap();
export function tagLines(lines, role, block, streaming = false) {
  if (!Array.isArray(lines)) return lines;
  const key = `${role}:${block}:${streaming ? 1 : 0}`;
  const hit = tagCache.get(lines);
  if (hit && hit.key === key) return hit.tagged;
  const tagged = lines.map((line, index) => (typeof line === "string" && !line.includes(SEMANTIC_PREFIX)
    ? `${semanticMarker(role, block, index, streaming)}${line}`
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
    const streaming = role === "assistant" ? Boolean(this.isStreaming) : role === "tool" ? Boolean(this.isPartial) : false;
    return tagLines(lines, role, blockIdOf(this), streaming);
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
