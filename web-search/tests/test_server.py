from web_search_mcp.server import (
    DEFAULT_MAX_OUTPUT_TOKENS,
    DEFAULT_MODEL,
    ServerConfig,
    build_request_payload,
    extract_text_and_citations,
)


def test_build_request_payload_forces_web_search() -> None:
    payload = build_request_payload("latest AI news", ServerConfig())

    assert payload == {
        "model": DEFAULT_MODEL,
        "input": "latest AI news",
        "tool_choice": "required",
        "tools": [{"type": "web_search", "search_context_size": "high"}],
        "max_output_tokens": DEFAULT_MAX_OUTPUT_TOKENS,
    }


def test_extract_text_and_citations_reads_message_output() -> None:
    response_body = {
        "output": [
            {
                "type": "reasoning",
            },
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": "Top story: Example headline.",
                        "annotations": [
                            {
                                "type": "url_citation",
                                "url": "https://example.com/story",
                                "start_index": 0,
                                "end_index": 11,
                            }
                        ],
                    }
                ],
            },
        ]
    }

    text, citations = extract_text_and_citations(response_body)

    assert text == "Top story: Example headline."
    assert citations == [
        {
            "url": "https://example.com/story",
            "title": None,
            "start_index": 0,
            "end_index": 11,
        }
    ]


def test_extract_falls_back_to_output_text_when_no_message_text() -> None:
    # When the structured message output yields no text, the top-level
    # output_text is used as a fallback.
    response_body = {
        "output": [{"type": "reasoning"}],
        "output_text": "Fallback summary text.",
    }

    text, citations = extract_text_and_citations(response_body)

    assert text == "Fallback summary text."
    assert citations == []


def test_message_text_takes_precedence_over_output_text_fallback() -> None:
    # The fallback must not override real structured message text.
    response_body = {
        "output": [
            {
                "type": "message",
                "content": [{"type": "output_text", "text": "Real message."}],
            }
        ],
        "output_text": "Should be ignored.",
    }

    text, _ = extract_text_and_citations(response_body)

    assert text == "Real message."


def test_multiple_message_texts_are_joined_with_blank_line() -> None:
    response_body = {
        "output": [
            {
                "type": "message",
                "content": [{"type": "output_text", "text": "First."}],
            },
            {
                "type": "message",
                "content": [{"type": "output_text", "text": "Second."}],
            },
        ]
    }

    text, _ = extract_text_and_citations(response_body)

    assert text == "First.\n\nSecond."


def test_malformed_payloads_yield_empty_without_raising() -> None:
    # The parser handles untrusted upstream JSON and must degrade gracefully
    # rather than raise on malformed shapes.
    malformed_bodies = [
        {},  # no output key
        {"output": "not-a-list"},  # output is not a list
        {"output": ["not-a-dict", 42, None]},  # items are not dicts
        {"output": [{"type": "message", "content": "not-a-list"}]},  # content not a list
        {"output": [{"type": "message", "content": ["not-a-dict"]}]},  # content item not a dict
        {"output": [{"type": "message", "content": [{"type": "image"}]}]},  # non-text content
    ]

    for body in malformed_bodies:
        text, citations = extract_text_and_citations(body)
        assert text == "", f"expected empty text for {body!r}, got {text!r}"
        assert citations == [], f"expected no citations for {body!r}, got {citations!r}"


def test_non_url_citation_annotations_are_ignored() -> None:
    response_body = {
        "output": [
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": "Body.",
                        "annotations": [
                            {"type": "file_citation", "url": "ignored"},
                            "not-a-dict",
                        ],
                    }
                ],
            }
        ]
    }

    text, citations = extract_text_and_citations(response_body)

    assert text == "Body."
    assert citations == []
