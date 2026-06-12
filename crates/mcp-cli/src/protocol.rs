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
