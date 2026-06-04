"""Minimal Markdown -> Linear ProseMirror document JSON converter.

Linear's internal comment/draft `bodyData` is a ProseMirror document serialized as a JSON string.
This converts the small Markdown subset our agent evidence uses (paragraphs, bullet lists with
nesting, bold, inline code, links, hard line breaks) into the node shapes observed from the Linear
web client network traffic:

    doc > (paragraph | bullet_list)
    bullet_list > list_item > (paragraph [, bullet_list])
    paragraph > (text | hard_break)
    text marks: strong (bold), code (inline code), link (href)

It is intentionally small and deterministic; it is NOT a full CommonMark parser.
"""

from __future__ import annotations

import json
import re
from typing import Any

# Inline patterns, applied in priority order. Each returns (mark_or_node, consumed_text).
_BOLD = re.compile(r"\*\*(.+?)\*\*|__(.+?)__")
_CODE = re.compile(r"`([^`]+)`")
_LINK = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")


def _text_node(text: str, marks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    node: dict[str, Any] = {"type": "text", "text": text}
    if marks:
        node["marks"] = marks
    return node


def _parse_inline(text: str) -> list[dict[str, Any]]:
    """Turn an inline string into a list of ProseMirror inline nodes.

    Handles **bold**/__bold__, `code`, [label](url) links, and literal `\n` -> hard_break.
    Overlapping/ nested inline marks beyond these are treated as plain text.
    """
    nodes: list[dict[str, Any]] = []

    def emit_plain(segment: str) -> None:
        if not segment:
            return
        # split on newlines -> hard_break between text runs
        parts = segment.split("\n")
        for i, part in enumerate(parts):
            if part:
                nodes.append(_text_node(part))
            if i < len(parts) - 1:
                nodes.append({"type": "hard_break"})

    # Find the earliest match among the inline patterns and recurse around it.
    candidates: list[tuple[int, str, re.Match[str]]] = []
    for kind, pat in (("link", _LINK), ("bold", _BOLD), ("code", _CODE)):
        m = pat.search(text)
        if m:
            candidates.append((m.start(), kind, m))

    if not candidates:
        emit_plain(text)
        return nodes

    candidates.sort(key=lambda c: c[0])
    _, kind, m = candidates[0]

    emit_plain(text[: m.start()])

    if kind == "bold":
        inner = m.group(1) if m.group(1) is not None else m.group(2)
        # bold can itself contain inline code/links; recurse and add the strong mark.
        # Linear's ProseMirror schema rejects a text node carrying both `code` and `strong`
        # marks at once (Argument Validation Error / IsProsemirrorDocument), so do NOT stack
        # strong onto a child that already has a code mark — leave inline code un-bolded.
        for child in _parse_inline(inner):
            if child.get("type") == "text":
                existing = child.setdefault("marks", [])
                has_code = any(mark.get("type") == "code" for mark in existing)
                if not has_code:
                    existing.append({"type": "strong"})
            nodes.append(child)
    elif kind == "code":
        nodes.append(_text_node(m.group(1), [{"type": "code"}]))
    elif kind == "link":
        label, href = m.group(1), m.group(2)
        nodes.append(_text_node(label, [{"type": "link", "attrs": {"href": href}}]))

    nodes.extend(_parse_inline(text[m.end():]))
    return nodes


def _paragraph(text: str) -> dict[str, Any]:
    content = _parse_inline(text)
    node: dict[str, Any] = {"type": "paragraph"}
    if content:
        node["content"] = content
    return node


def _bullet_indent(line: str) -> int | None:
    """Return indent level (in 2-space units) if line is a bullet item, else None."""
    m = re.match(r"^(\s*)[-*+]\s+(.*)$", line)
    if not m:
        return None
    return len(m.group(1)) // 2


def markdown_to_prosemirror(markdown: str) -> dict[str, Any]:
    """Convert a Markdown string into a ProseMirror `doc` node (Python dict)."""
    lines = markdown.replace("\r\n", "\n").split("\n")
    content: list[dict[str, Any]] = []

    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i]
        stripped = raw.strip()

        if not stripped:
            i += 1
            continue

        if _bullet_indent(raw) is not None:
            block, i = _consume_bullet_list(lines, i, base_indent=_bullet_indent(raw) or 0)
            content.append(block)
            continue

        # plain paragraph: gather consecutive non-blank, non-bullet lines into one paragraph
        para_lines = [stripped]
        i += 1
        while i < n and lines[i].strip() and _bullet_indent(lines[i]) is None:
            para_lines.append(lines[i].strip())
            i += 1
        content.append(_paragraph("\n".join(para_lines)))

    doc: dict[str, Any] = {"type": "doc"}
    if content:
        doc["content"] = content
    else:
        doc["content"] = [{"type": "paragraph"}]
    return doc


def _consume_bullet_list(
    lines: list[str], start: int, base_indent: int
) -> tuple[dict[str, Any], int]:
    """Consume a bullet_list at base_indent starting at `start`. Returns (node, next_index)."""
    items: list[dict[str, Any]] = []
    i = start
    n = len(lines)

    while i < n:
        raw = lines[i]
        if not raw.strip():
            i += 1
            continue
        indent = _bullet_indent(raw)
        if indent is None or indent < base_indent:
            break
        if indent > base_indent:
            # shouldn't start a list here; let the parent loop handle
            break

        text = re.match(r"^\s*[-*+]\s+(.*)$", raw).group(1)
        item_content: list[dict[str, Any]] = [_paragraph(text)]
        i += 1

        # nested bullets belonging to this item
        while i < n:
            if not lines[i].strip():
                i += 1
                continue
            child_indent = _bullet_indent(lines[i])
            if child_indent is not None and child_indent > base_indent:
                nested, i = _consume_bullet_list(lines, i, base_indent=child_indent)
                item_content.append(nested)
            else:
                break

        items.append({"type": "list_item", "content": item_content})

    return {"type": "bullet_list", "content": items}, i


def markdown_to_body_data(markdown: str) -> str:
    """Convert Markdown into the JSON string Linear expects for `bodyData`."""
    return json.dumps(markdown_to_prosemirror(markdown), ensure_ascii=False)
