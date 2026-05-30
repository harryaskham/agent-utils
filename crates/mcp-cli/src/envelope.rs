//! JSON envelope + structured error types shared by CLI and MCP surfaces.

use std::io::Write;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::McpCliError;

/// Stable schema version for JSON envelopes shared by CLI and MCP surfaces.
pub const JSON_SCHEMA_VERSION: u32 = 1;

/// Stable categories for structured JSON and MCP errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    Validation,
    UnsupportedCapability,
    MissingPermission,
    TargetNotFound,
    PlatformAdapterFailure,
    ExecutionFailure,
    ConfigError,
    SerializationError,
    /// Operation exceeded a configured deadline (e.g. capture portal/grim hang).
    Timeout,
}

/// Stable metadata attached to every machine-readable response envelope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvelopeMeta {
    pub schema_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

impl Default for EnvelopeMeta {
    fn default() -> Self {
        Self {
            schema_version: JSON_SCHEMA_VERSION,
            command: None,
        }
    }
}

impl EnvelopeMeta {
    #[must_use]
    pub fn for_command(command: impl Into<String>) -> Self {
        Self {
            schema_version: JSON_SCHEMA_VERSION,
            command: Some(command.into()),
        }
    }
}

/// Errors that can be projected into a stable JSON/MCP error payload.
pub trait StructuredError {
    fn category(&self) -> ErrorCategory;

    fn code(&self) -> String;

    fn message(&self) -> String;

    fn details(&self) -> Option<Value> {
        None
    }
}

/// Structured error payload shared by CLI and MCP surfaces.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonError {
    pub category: ErrorCategory,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl JsonError {
    #[must_use]
    pub fn new(
        category: ErrorCategory,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            category,
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    #[must_use]
    pub fn from_error<E>(error: &E) -> Self
    where
        E: StructuredError + ?Sized,
    {
        let mut value = Self::new(error.category(), error.code(), error.message());
        if let Some(details) = error.details() {
            value = value.with_details(details);
        }
        value
    }

    #[must_use]
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl StructuredError for JsonError {
    fn category(&self) -> ErrorCategory {
        self.category
    }

    fn code(&self) -> String {
        self.code.clone()
    }

    fn message(&self) -> String {
        self.message.clone()
    }

    fn details(&self) -> Option<Value> {
        self.details.clone()
    }
}

/// Structured success/error envelope for machine-readable command responses.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum JsonEnvelope<T> {
    Success {
        meta: EnvelopeMeta,
        data: T,
    },
    Error {
        meta: EnvelopeMeta,
        error: JsonError,
    },
}

impl<T> JsonEnvelope<T> {
    #[must_use]
    pub fn success(data: T) -> Self {
        Self::Success {
            meta: EnvelopeMeta::default(),
            data,
        }
    }

    #[must_use]
    pub fn success_for(command: impl Into<String>, data: T) -> Self {
        Self::Success {
            meta: EnvelopeMeta::for_command(command),
            data,
        }
    }

    #[must_use]
    pub fn error(error: JsonError) -> Self {
        Self::Error {
            meta: EnvelopeMeta::default(),
            error,
        }
    }

    #[must_use]
    pub fn error_for(command: impl Into<String>, error: JsonError) -> Self {
        Self::Error {
            meta: EnvelopeMeta::for_command(command),
            error,
        }
    }

    #[must_use]
    pub fn is_error(&self) -> bool {
        matches!(self, Self::Error { .. })
    }
}

/// Convert a command result into a stable JSON envelope.
#[must_use]
pub fn envelope_from_result<T, E>(result: Result<T, E>) -> JsonEnvelope<T>
where
    E: StructuredError,
{
    match result {
        Ok(data) => JsonEnvelope::success(data),
        Err(error) => JsonEnvelope::error(JsonError::from_error(&error)),
    }
}

/// Convert a borrowed command result into a stable JSON envelope.
#[must_use]
pub fn envelope_from_result_ref<'a, T, E>(result: Result<&'a T, &'a E>) -> JsonEnvelope<&'a T>
where
    T: Serialize,
    E: StructuredError,
{
    match result {
        Ok(data) => JsonEnvelope::success(data),
        Err(error) => JsonEnvelope::error(JsonError::from_error(error)),
    }
}

/// Serialize a command result as a JSON envelope followed by a newline.
pub fn write_json_result<W, T, E>(mut writer: W, result: Result<T, E>) -> Result<(), McpCliError>
where
    W: Write,
    T: Serialize,
    E: StructuredError,
{
    serde_json::to_writer(&mut writer, &envelope_from_result(result))?;
    writer.write_all(b"\n")?;
    Ok(())
}

/// Serialize a borrowed command result as a JSON envelope followed by a newline.
pub fn write_json_result_ref<W, T, E>(
    mut writer: W,
    result: &Result<T, E>,
) -> Result<(), McpCliError>
where
    W: Write,
    T: Serialize,
    E: StructuredError,
{
    let envelope = match result {
        Ok(data) => JsonEnvelope::success(data),
        Err(error) => JsonEnvelope::error(JsonError::from_error(error)),
    };
    serde_json::to_writer(&mut writer, &envelope)?;
    writer.write_all(b"\n")?;
    Ok(())
}
