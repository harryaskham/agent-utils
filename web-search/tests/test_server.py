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
        "tools": [{"type": "web_search"}],
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
