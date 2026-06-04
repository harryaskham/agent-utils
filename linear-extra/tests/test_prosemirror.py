"""Tests for the Markdown -> Linear ProseMirror converter."""

from __future__ import annotations

import json

from linear_extra_mcp.prosemirror import markdown_to_body_data, markdown_to_prosemirror


def test_simple_paragraph():
    doc = markdown_to_prosemirror("Testing a new draft")
    assert doc == {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Testing a new draft"}]}
        ],
    }


def test_bold_text():
    doc = markdown_to_prosemirror("makingsome **bold text**")
    para = doc["content"][0]
    assert para["type"] == "paragraph"
    assert para["content"][0] == {"type": "text", "text": "makingsome "}
    assert para["content"][1] == {
        "type": "text",
        "text": "bold text",
        "marks": [{"type": "strong"}],
    }


def test_hard_break_within_paragraph():
    doc = markdown_to_prosemirror("line one\nline two")
    para = doc["content"][0]
    types = [n["type"] for n in para["content"]]
    assert types == ["text", "hard_break", "text"]


def test_bullet_list():
    md = "- first\n- second\n- third"
    doc = markdown_to_prosemirror(md)
    lst = doc["content"][0]
    assert lst["type"] == "bullet_list"
    assert len(lst["content"]) == 3
    for item in lst["content"]:
        assert item["type"] == "list_item"
        assert item["content"][0]["type"] == "paragraph"
    assert lst["content"][0]["content"][0]["content"][0]["text"] == "first"


def test_nested_bullet_list():
    md = "- parent\n  - child a\n  - child b\n- sibling"
    doc = markdown_to_prosemirror(md)
    lst = doc["content"][0]
    assert lst["type"] == "bullet_list"
    # first item has a nested bullet_list after its paragraph
    first = lst["content"][0]
    assert first["content"][0]["type"] == "paragraph"
    nested = first["content"][1]
    assert nested["type"] == "bullet_list"
    assert len(nested["content"]) == 2
    # the sibling is a top-level second item
    assert len(lst["content"]) == 2
    assert lst["content"][1]["content"][0]["content"][0]["text"] == "sibling"


def test_inline_code_and_link():
    doc = markdown_to_prosemirror("see `code` and [label](https://example.com)")
    content = doc["content"][0]["content"]
    code_node = next(n for n in content if n.get("marks") == [{"type": "code"}])
    assert code_node["text"] == "code"
    link_node = next(
        n for n in content if any(m.get("type") == "link" for m in n.get("marks", []))
    )
    assert link_node["text"] == "label"
    assert link_node["marks"][0]["attrs"]["href"] == "https://example.com"


def test_body_data_is_json_string():
    body = markdown_to_body_data("**bold** and plain")
    parsed = json.loads(body)
    assert parsed["type"] == "doc"


def test_empty_input_yields_empty_paragraph():
    doc = markdown_to_prosemirror("")
    assert doc == {"type": "doc", "content": [{"type": "paragraph"}]}
