//! MCP wire framing (newline-delimited JSON / NDJSON) and transport error type.

use std::io::{self, BufRead, Write};

use serde_json::Value;
use thiserror::Error;

use crate::ErrorCategory;

/// Errors surfaced by the reusable CLI/MCP façade.
#[derive(Debug, Error)]
pub enum McpCliError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("protocol error: {0}")]
    Protocol(String),
}

impl McpCliError {
    #[must_use]
    pub const fn category(&self) -> ErrorCategory {
        ErrorCategory::SerializationError
    }
}

/// Read one newline-delimited JSON (NDJSON) message from `reader`.
///
/// Each MCP stdio message is a single compact JSON object on its own line,
/// terminated by `\n` (the MCP-spec-correct framing). Blank lines are skipped
/// so spacing / keep-alive newlines between messages are tolerated. Returns
/// `Ok(None)` at end of input.
pub(crate) fn read_protocol_message<R>(reader: &mut R) -> Result<Option<Vec<u8>>, McpCliError>
where
    R: BufRead,
{
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line)?;
        if bytes_read == 0 {
            return Ok(None);
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        return Ok(Some(trimmed.as_bytes().to_vec()));
    }
}

/// Write `value` as a single newline-delimited JSON (NDJSON) message.
///
/// The JSON is serialized compactly (no embedded literal newlines) and
/// terminated with a single `\n`, matching the MCP stdio NDJSON framing.
pub(crate) fn write_protocol_message<W>(writer: &mut W, value: &Value) -> Result<(), McpCliError>
where
    W: Write,
{
    let body = serde_json::to_vec(value)?;
    writer.write_all(&body)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{read_protocol_message, write_protocol_message};
    use serde_json::{Value, json};
    use std::io::Cursor;

    /// The MCP stdio wire contract is newline-delimited JSON (NDJSON): exactly
    /// one compact JSON object per message, `\n`-terminated, with no
    /// `Content-Length` / HTTP-style header framing. This is a deliberate drift
    /// guard: the Content-Length framing regression (bd-dc9438 / bd-6ffb52) only
    /// surfaced in production, so the contract is pinned here to fail CI on any
    /// future reversion. Keep `crates/mcp-cli/README.md` in sync.
    #[test]
    fn write_emits_single_compact_ndjson_line_without_content_length() {
        let value = json!({ "jsonrpc": "2.0", "id": 1, "result": { "nested": [1, 2, 3] } });
        let mut buf = Vec::new();
        write_protocol_message(&mut buf, &value).expect("write should succeed");

        let text = std::str::from_utf8(&buf).expect("framed message is utf-8");

        // Exactly one trailing newline, and it is the only newline.
        assert!(text.ends_with('\n'), "frame must be newline-terminated");
        assert_eq!(text.matches('\n').count(), 1, "frame must be a single line");

        // No Content-Length / HTTP-style header framing.
        assert!(
            !text.contains("Content-Length"),
            "NDJSON framing must not use Content-Length headers"
        );
        assert!(!text.contains('\r'), "NDJSON framing must not use CR/CRLF");

        // The body (sans newline) is compact JSON with no interior newline and
        // round-trips back to the same value.
        let body = text.trim_end_matches('\n');
        assert!(
            !body.contains('\n'),
            "JSON body must be compact (single line)"
        );
        let parsed: Value = serde_json::from_str(body).expect("body is valid json");
        assert_eq!(parsed, value);
    }

    #[test]
    fn write_then_read_round_trips_multiple_messages_in_order() {
        let first = json!({ "id": 1, "method": "initialize" });
        let second = json!({ "id": 2, "method": "tools/list" });

        let mut buf = Vec::new();
        write_protocol_message(&mut buf, &first).expect("first write succeeds");
        write_protocol_message(&mut buf, &second).expect("second write succeeds");

        let mut reader = Cursor::new(buf);

        let raw_first = read_protocol_message(&mut reader)
            .expect("first read succeeds")
            .expect("first message present");
        let raw_second = read_protocol_message(&mut reader)
            .expect("second read succeeds")
            .expect("second message present");

        assert_eq!(
            serde_json::from_slice::<Value>(&raw_first).expect("first is json"),
            first
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&raw_second).expect("second is json"),
            second
        );
        assert_eq!(
            read_protocol_message(&mut reader).expect("third read succeeds"),
            None,
            "EOF yields None after both messages"
        );
    }

    #[test]
    fn read_skips_blank_keepalive_lines() {
        let input = b"\n\n{\"id\":7}\n\n".to_vec();
        let mut reader = Cursor::new(input);

        let message = read_protocol_message(&mut reader)
            .expect("read should succeed")
            .expect("a message is present despite surrounding blank lines");
        let parsed: Value = serde_json::from_slice(&message).expect("message is json");
        assert_eq!(parsed, json!({ "id": 7 }));

        assert_eq!(
            read_protocol_message(&mut reader).expect("trailing read succeeds"),
            None,
            "only blank lines remain after the message"
        );
    }

    #[test]
    fn read_returns_none_at_eof() {
        let mut reader = Cursor::new(Vec::new());
        assert_eq!(
            read_protocol_message(&mut reader).expect("empty read succeeds"),
            None
        );
    }
}
