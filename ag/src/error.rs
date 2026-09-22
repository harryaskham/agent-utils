use mcp_cli::{ErrorCategory, StructuredError};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("configuration: {0}")]
    Config(String),
    #[error("{0}")]
    Transport(String),
    #[error("{0}")]
    Limit(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}
impl StructuredError for Error {
    fn category(&self) -> ErrorCategory {
        match self {
            Self::Invalid(_) | Self::Limit(_) => ErrorCategory::Validation,
            Self::Config(_) => ErrorCategory::ConfigError,
            Self::Transport(_) => ErrorCategory::PlatformAdapterFailure,
            Self::Json(_) => ErrorCategory::SerializationError,
            Self::Io(_) => ErrorCategory::ExecutionFailure,
        }
    }
    fn code(&self) -> String {
        match self {
            Self::Invalid(_) => "invalid_input",
            Self::Config(_) => "invalid_config",
            Self::Transport(_) => "node_unavailable",
            Self::Limit(_) => "limit_exceeded",
            Self::Io(_) => "io_error",
            Self::Json(_) => "invalid_json",
        }
        .into()
    }
    fn message(&self) -> String {
        self.to_string()
    }
}
