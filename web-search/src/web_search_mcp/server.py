from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error, request

from mcp.server.fastmcp import FastMCP

DEFAULT_TOKEN_FILE = Path("~/.config/gh-auth-tokens/copilot.token").expanduser()
DEFAULT_MODEL = "gpt-5.2-codex"
DEFAULT_MAX_OUTPUT_TOKENS = 16000
DEFAULT_API_BASE = "https://api.githubcopilot.com/v1"
DEFAULT_EDITOR_VERSION = "vscode/1.103.1"

log = logging.getLogger("web-search-mcp")


@dataclass(frozen=True)
class ServerConfig:
    token_file: Path = DEFAULT_TOKEN_FILE
    model: str = DEFAULT_MODEL
    max_output_tokens: int = DEFAULT_MAX_OUTPUT_TOKENS
    api_base: str = DEFAULT_API_BASE
    editor_version: str = DEFAULT_EDITOR_VERSION


def configure_logging(level: str = "WARNING") -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.WARNING),
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )


def read_token(token_file: Path) -> str:
    try:
        token = token_file.expanduser().read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise RuntimeError(f"Token file not found: {token_file}") from exc

    if not token:
        raise RuntimeError(f"Token file is empty: {token_file}")

    return token


def build_request_payload(query: str, config: ServerConfig) -> dict[str, Any]:
    return {
        "model": config.model,
        "input": query,
        "tool_choice": "required",
        "tools": [{"type": "web_search", "search_context_size": "high"}],
        "max_output_tokens": config.max_output_tokens,
    }


def extract_text_and_citations(response_body: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    texts: list[str] = []
    citations: list[dict[str, Any]] = []

    output = response_body.get("output", [])
    if not isinstance(output, list):
        output = []

    for item in output:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue

        content = item.get("content", [])
        if not isinstance(content, list):
            continue

        for content_item in content:
            if not isinstance(content_item, dict) or content_item.get("type") != "output_text":
                continue

            text = content_item.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text.strip())

            annotations = content_item.get("annotations", [])
            if not isinstance(annotations, list):
                continue

            for annotation in annotations:
                if not isinstance(annotation, dict) or annotation.get("type") != "url_citation":
                    continue
                citations.append(
                    {
                        "url": annotation.get("url"),
                        "title": annotation.get("title"),
                        "start_index": annotation.get("start_index"),
                        "end_index": annotation.get("end_index"),
                    }
                )

    fallback = response_body.get("output_text")
    if isinstance(fallback, str) and fallback.strip() and not texts:
        texts.append(fallback.strip())

    return "\n\n".join(texts), citations


def invoke_web_search(query: str, config: ServerConfig) -> dict[str, Any]:
    token = read_token(config.token_file)
    payload = build_request_payload(query, config)
    body = json.dumps(payload).encode("utf-8")
    url = f"{config.api_base.rstrip('/')}/responses"

    req = request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "editor-version": config.editor_version,
        },
    )

    try:
        with request.urlopen(req, timeout=180) as response:
            raw = response.read().decode("utf-8")
    except error.HTTPError as exc:
        raw_error = exc.read().decode("utf-8", errors="replace")
        try:
            parsed_error = json.loads(raw_error)
        except json.JSONDecodeError:
            parsed_error = {"error": {"message": raw_error}}
        raise RuntimeError(
            f"GitHub Copilot API request failed with HTTP {exc.code}: {json.dumps(parsed_error)}"
        ) from exc
    except error.URLError as exc:
        raise RuntimeError(f"GitHub Copilot API request failed: {exc}") from exc

    response_body = json.loads(raw)
    text, citations = extract_text_and_citations(response_body)
    output = response_body.get("output", [])
    output_types = [item.get("type") for item in output if isinstance(item, dict)]
    web_search_calls = sum(
        1 for item in output if isinstance(item, dict) and item.get("type") == "web_search_call"
    )

    return {
        "response_id": response_body.get("id"),
        "status": response_body.get("status"),
        "model": response_body.get("model", config.model),
        "query": query,
        "text": text,
        "citations": citations,
        "incomplete_details": response_body.get("incomplete_details"),
        "output_types": output_types,
        "web_search_calls": web_search_calls,
        "usage": response_body.get("usage"),
    }


def create_server(config: ServerConfig) -> FastMCP:
    server = FastMCP("web-search")

    @server.tool()
    def search_web(query: str) -> dict[str, Any]:
        """Search the web through GitHub Copilot Responses API.

        The server forces the upstream `web_search` tool on every request and returns
        the final response text plus any extracted URL citations and usage metadata.
        """
        log.info("Running web search for %r", query)
        return invoke_web_search(query=query, config=config)

    return server


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the web-search MCP server over stdio")
    parser.add_argument(
        "--token-file",
        default=os.environ.get("WEB_SEARCH_COPILOT_TOKEN_FILE", str(DEFAULT_TOKEN_FILE)),
        help="Path to the GitHub Copilot bearer token file",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("WEB_SEARCH_MODEL", DEFAULT_MODEL),
        help="Responses API model to use",
    )
    parser.add_argument(
        "--max-output-tokens",
        type=int,
        default=int(os.environ.get("WEB_SEARCH_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS)),
        help="Maximum output tokens for each upstream response",
    )
    parser.add_argument(
        "--api-base",
        default=os.environ.get("WEB_SEARCH_COPILOT_API_BASE", DEFAULT_API_BASE),
        help="Base URL for the GitHub Copilot Responses API",
    )
    parser.add_argument(
        "--editor-version",
        default=os.environ.get("WEB_SEARCH_EDITOR_VERSION", DEFAULT_EDITOR_VERSION),
        help="editor-version header sent to the Copilot API",
    )
    parser.add_argument(
        "--log-level",
        default=os.environ.get("WEB_SEARCH_LOG_LEVEL", "WARNING"),
        help="Python log level written to stderr",
    )
    return parser.parse_args(argv)


def validate_config(config: ServerConfig) -> None:
    if config.max_output_tokens <= 0:
        raise SystemExit("--max-output-tokens must be positive")
    read_token(config.token_file)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    configure_logging(args.log_level)

    config = ServerConfig(
        token_file=Path(args.token_file).expanduser(),
        model=args.model,
        max_output_tokens=args.max_output_tokens,
        api_base=args.api_base,
        editor_version=args.editor_version,
    )
    validate_config(config)

    server = create_server(config)
    server.run(transport="stdio")
