---
description: Search the live web using the web-search MCP server
---
Use the `search_web` MCP tool to search the live web for: $@

Requirements:
- If no arguments were supplied, ask the user what they want searched.
- Prefer one focused `search_web` call unless follow-up searches are clearly needed.
- Summarize the answer clearly and concisely.
- Include relevant source URLs from the tool result's `citations` field when available.
- If the tool returns no useful result, say so plainly and suggest a narrower query.
