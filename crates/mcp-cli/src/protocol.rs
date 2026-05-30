//! MCP wire framing (Content-Length headers) and transport error type.

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

pub(crate) fn read_protocol_message<R>(reader: &mut R) -> Result<Option<Vec<u8>>, McpCliError>
where
    R: BufRead,
{
    let mut content_length = None;
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line)?;
        if bytes_read == 0 {
            return if content_length.is_none() {
                Ok(None)
            } else {
                Err(McpCliError::Protocol(
                    "unexpected EOF while reading MCP headers".to_string(),
                ))
            };
        }

        if line == "\r\n" || line == "\n" {
            break;
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);
        if let Some((name, value)) = trimmed.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            let parsed_length = value.trim().parse::<usize>().map_err(|error| {
                McpCliError::Protocol(format!("invalid Content-Length header: {error}"))
            })?;
            content_length = Some(parsed_length);
        }
    }

    let length = content_length.ok_or_else(|| {
        McpCliError::Protocol("missing Content-Length header in MCP message".to_string())
    })?;
    let mut body = vec![0; length];
    std::io::Read::read_exact(reader, &mut body)?;
    Ok(Some(body))
}

pub(crate) fn write_protocol_message<W>(writer: &mut W, value: &Value) -> Result<(), McpCliError>
where
    W: Write,
{
    let body = serde_json::to_vec(value)?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()?;
    Ok(())
}
