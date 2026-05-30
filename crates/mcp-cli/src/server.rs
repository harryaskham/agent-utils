//! Typed tool, router, and minimal MCP stdio server façade.

use std::io::{self, BufRead, BufReader, Write};
use std::sync::Arc;

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::protocol::{McpCliError, read_protocol_message, write_protocol_message};
use crate::{ErrorCategory, JsonEnvelope, JsonError, StructuredError};

/// Metadata describing the MCP stdio server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StdioServerConfig {
    pub server_name: String,
    pub server_version: String,
}

/// Public MCP tool metadata surfaced to clients.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolMetadata {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

type ToolHandler<Ctx> = dyn Fn(&Ctx, Value) -> JsonEnvelope<Value> + Send + Sync;

/// A typed tool binding that can be exposed over MCP.
pub struct Tool<Ctx> {
    metadata: ToolMetadata,
    handler: Arc<ToolHandler<Ctx>>,
}

impl<Ctx> Tool<Ctx> {
    #[must_use]
    pub fn new_typed<Input, Output, Error, Handler>(
        name: impl Into<String>,
        description: impl Into<String>,
        handler: Handler,
    ) -> Self
    where
        Input: DeserializeOwned + JsonSchema + 'static,
        Output: Serialize + 'static,
        Error: StructuredError + 'static,
        Handler: Fn(&Ctx, Input) -> Result<Output, Error> + Send + Sync + 'static,
    {
        let tool_name = name.into();
        let metadata = ToolMetadata {
            name: tool_name.clone(),
            description: description.into(),
            input_schema: serde_json::to_value(schemars::schema_for!(Input))
                .expect("tool schema should serialize"),
        };

        let erased_handler =
            move |ctx: &Ctx, arguments: Value| match serde_json::from_value(arguments) {
                Ok(input) => match handler(ctx, input) {
                    Ok(output) => match serde_json::to_value(output) {
                        Ok(data) => JsonEnvelope::success_for(tool_name.clone(), data),
                        Err(error) => JsonEnvelope::error_for(
                            tool_name.clone(),
                            JsonError::new(
                                ErrorCategory::SerializationError,
                                "serialization_error",
                                format!("failed to serialize tool result: {error}"),
                            ),
                        ),
                    },
                    Err(error) => {
                        JsonEnvelope::error_for(tool_name.clone(), JsonError::from_error(&error))
                    }
                },
                Err(error) => JsonEnvelope::error_for(
                    tool_name.clone(),
                    JsonError::new(
                        ErrorCategory::Validation,
                        "invalid_tool_arguments",
                        format!("invalid tool arguments: {error}"),
                    ),
                ),
            };

        Self {
            metadata,
            handler: Arc::new(erased_handler),
        }
    }

    #[must_use]
    pub fn metadata(&self) -> &ToolMetadata {
        &self.metadata
    }

    #[must_use]
    pub fn call(&self, ctx: &Ctx, arguments: Value) -> JsonEnvelope<Value> {
        (self.handler)(ctx, arguments)
    }
}

/// A reusable typed tool router that can back both CLI and MCP surfaces.
pub struct ToolRouter<Ctx> {
    tools: Vec<Tool<Ctx>>,
}

impl<Ctx> Default for ToolRouter<Ctx> {
    fn default() -> Self {
        Self::new()
    }
}

impl<Ctx> ToolRouter<Ctx> {
    #[must_use]
    pub fn new() -> Self {
        Self { tools: Vec::new() }
    }

    pub fn add_tool(&mut self, tool: Tool<Ctx>) {
        self.tools.push(tool);
    }

    pub fn add_typed_tool<Input, Output, Error, Handler>(
        &mut self,
        name: impl Into<String>,
        description: impl Into<String>,
        handler: Handler,
    ) where
        Input: DeserializeOwned + JsonSchema + 'static,
        Output: Serialize + 'static,
        Error: StructuredError + 'static,
        Handler: Fn(&Ctx, Input) -> Result<Output, Error> + Send + Sync + 'static,
    {
        self.add_tool(Tool::new_typed::<Input, Output, Error, Handler>(
            name,
            description,
            handler,
        ));
    }

    #[must_use]
    pub fn tool_metadata(&self) -> Vec<ToolMetadata> {
        self.tools
            .iter()
            .map(|tool| tool.metadata().clone())
            .collect()
    }

    #[must_use]
    pub fn call_tool(&self, ctx: &Ctx, name: &str, arguments: Value) -> JsonEnvelope<Value> {
        match self.tools.iter().find(|tool| tool.metadata().name == name) {
            Some(tool) => tool.call(ctx, arguments),
            None => JsonEnvelope::error_for(
                name,
                JsonError::new(
                    ErrorCategory::Validation,
                    "unknown_tool",
                    format!("unknown tool `{name}`"),
                ),
            ),
        }
    }
}

/// A minimal reusable MCP stdio server for exposing typed tools.
pub struct McpServer<Ctx> {
    config: StdioServerConfig,
    router: ToolRouter<Ctx>,
}

impl<Ctx> McpServer<Ctx> {
    #[must_use]
    pub fn new(config: StdioServerConfig, router: ToolRouter<Ctx>) -> Self {
        Self { config, router }
    }

    #[must_use]
    pub fn tool_metadata(&self) -> Vec<ToolMetadata> {
        self.router.tool_metadata()
    }

    pub fn handle_request_value(
        &self,
        ctx: &Ctx,
        request: Value,
    ) -> Result<Option<Value>, McpCliError> {
        let request: JsonRpcRequest = serde_json::from_value(request)?;
        self.handle_request(ctx, request)
    }

    pub fn serve_stdio(&self, ctx: &Ctx) -> Result<(), McpCliError> {
        let stdin = io::stdin();
        let stdout = io::stdout();
        let reader = BufReader::new(stdin.lock());
        let writer = stdout.lock();
        self.serve_transport(ctx, reader, writer)
    }

    pub fn serve_transport<R, W>(
        &self,
        ctx: &Ctx,
        mut reader: R,
        mut writer: W,
    ) -> Result<(), McpCliError>
    where
        R: BufRead,
        W: Write,
    {
        while let Some(message) = read_protocol_message(&mut reader)? {
            let response = self.handle_request_value(ctx, serde_json::from_slice(&message)?)?;
            if let Some(response) = response {
                write_protocol_message(&mut writer, &response)?;
            }
        }

        Ok(())
    }

    fn handle_request(
        &self,
        ctx: &Ctx,
        request: JsonRpcRequest,
    ) -> Result<Option<Value>, McpCliError> {
        let response = match request.method.as_str() {
            "initialize" => request.id.map(|id| {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {
                            "tools": {
                                "listChanged": false
                            }
                        },
                        "serverInfo": {
                            "name": self.config.server_name,
                            "version": self.config.server_version
                        }
                    }
                })
            }),
            "notifications/initialized" => None,
            "ping" => request.id.map(|id| {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {}
                })
            }),
            "tools/list" => request.id.map(|id| {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "tools": self.router.tool_metadata()
                    }
                })
            }),
            "tools/call" => {
                let params: ToolCallParams =
                    serde_json::from_value(request.params.unwrap_or_else(|| json!({})))?;
                let envelope = self.router.call_tool(
                    ctx,
                    &params.name,
                    params.arguments.unwrap_or_else(|| json!({})),
                );
                let structured_content = serde_json::to_value(&envelope)?;
                let text_content = serde_json::to_string(&envelope)?;

                request.id.map(|id| {
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {
                            "content": [
                                {
                                    "type": "text",
                                    "text": text_content
                                }
                            ],
                            "structuredContent": structured_content,
                            "isError": envelope.is_error()
                        }
                    })
                })
            }
            method => request.id.map(|id| {
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": -32601,
                        "message": format!("unsupported MCP method `{method}`")
                    }
                })
            }),
        };

        Ok(response)
    }
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    #[serde(default)]
    pub id: Option<Value>,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ToolCallParams {
    pub name: String,
    #[serde(default)]
    pub arguments: Option<Value>,
}
