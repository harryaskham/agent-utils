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


def test_bold_wrapping_inline_code_does_not_stack_code_and_strong():
    # Linear's ProseMirror schema rejects a text node carrying both `code` and `strong`
    # marks at once. Bold-wrapped inline code (**`x`**) must stay code-only.
    doc = markdown_to_prosemirror("never calls **`AddCitableEntity`** here")
    code_nodes = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "text":
                marks = {m.get("type") for m in node.get("marks", [])}
                assert not ("code" in marks and "strong" in marks), node
                if "code" in marks:
                    code_nodes.append(node)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(doc)
    assert any(n["text"] == "AddCitableEntity" for n in code_nodes)


def test_empty_input_yields_empty_paragraph():
    doc = markdown_to_prosemirror("")
    assert doc == {"type": "doc", "content": [{"type": "paragraph"}]}


# --- cookie resolution (settings.cookieFile + default-file fallback) ---

def test_settings_cookie_file_and_default_fallback(tmp_path, monkeypatch):
    import argparse
    import json as _json

    from linear_extra_mcp import server

    for var in ("LINEAR_SESSION_COOKIE", "LINEAR_COOKIE_FILE", "LINEAR_EXTRA_SETTINGS"):
        monkeypatch.delenv(var, raising=False)

    cookie_path = tmp_path / "linear.cookie"
    cookie_path.write_text("session:acct=jwt; uploadsSig:acct=jwt", encoding="utf-8")

    # 1) settings.json -> linear-extra.cookieFile points at the file
    settings = tmp_path / "settings.json"
    settings.write_text(
        _json.dumps({"linear-extra": {"cookieFile": str(cookie_path)}}), encoding="utf-8"
    )
    args = argparse.Namespace(cookie=None, cookie_file=None, settings=str(settings))
    assert server.resolve_cookie(args).startswith("session:acct=")

    # 2) default-file fallback when nothing else is configured
    monkeypatch.setattr(server, "DEFAULT_SETTINGS_PATH", tmp_path / "missing.json")
    monkeypatch.setattr(server, "DEFAULT_COOKIE_PATH", cookie_path)
    args2 = argparse.Namespace(cookie=None, cookie_file=None, settings=None)
    assert server.resolve_cookie(args2).startswith("session:acct=")
