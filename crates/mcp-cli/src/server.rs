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
        // Per-message error isolation: a single malformed frame or a single
        // per-request handler error must NOT tear down the whole MCP session.
        // Only a genuine reader EOF (`Ok(None)`) or a broken read/write stream
        // (true IO error) ends serving; transient parse/handler errors are
        // answered with a JSON-RPC error frame and the loop keeps serving so the
        // client connection does not drop (and never needs to "reacknowledge").
        while let Some(message) = read_protocol_message(&mut reader)? {
            // A malformed frame cannot be parsed into a request, so we have no
            // id to correlate: respond with JSON-RPC parse error (-32700) and
            // keep the connection alive.
            let request = match serde_json::from_slice::<Value>(&message) {
                Ok(request) => request,
                Err(error) => {
                    write_protocol_message(&mut writer, &parse_error_response(&error))?;
                    continue;
                }
            };

            // Preserve the request id (if any) so an isolated handler error can
            // still be correlated by the client.
            let request_id = request.get("id").cloned().unwrap_or(Value::Null);
            let response = match self.handle_request_value(ctx, request) {
                Ok(response) => response,
                Err(error) => Some(internal_error_response(&request_id, &error)),
            };

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

/// Build a JSON-RPC parse-error (`-32700`) response for a frame that could not
/// be parsed into a request value. Such a frame carries no usable id, so the
/// error id is `null` per the JSON-RPC spec.
fn parse_error_response(error: &serde_json::Error) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": Value::Null,
        "error": {
            "code": -32700,
            "message": format!("parse error: {error}")
        }
    })
}

/// Build a JSON-RPC internal-error (`-32603`) response for a request that
/// parsed but failed during handling (bad request shape, invalid params,
/// serialization). The original request id is preserved for correlation.
fn internal_error_response(id: &Value, error: &McpCliError) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.clone(),
        "error": {
            "code": -32603,
            "message": format!("internal error: {error}")
        }
    })
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

#[cfg(test)]
mod tests {
    use super::{McpServer, StdioServerConfig, ToolRouter};
    use serde_json::{Value, json};
    use std::io::Cursor;

    fn test_server() -> McpServer<()> {
        McpServer::new(
            StdioServerConfig {
                server_name: "mcp-cli-test".to_string(),
                server_version: "0.0.0".to_string(),
            },
            ToolRouter::<()>::new(),
        )
    }

    fn serve_lines(input: &str) -> Vec<Value> {
        let mut output = Vec::new();
        test_server()
            .serve_transport(&(), Cursor::new(input.as_bytes().to_vec()), &mut output)
            .expect("serve_transport must not fail on isolated per-message errors");
        String::from_utf8(output)
            .expect("responses are utf-8")
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).expect("each response line is valid json"))
            .collect()
    }

    // A single malformed frame must NOT tear down the session: it is answered
    // with a JSON-RPC parse error (-32700, id null) and the loop keeps serving
    // the following valid request. This is the core "erroring MCP no longer
    // drops the connection" contract.
    #[test]
    fn serve_transport_isolates_malformed_frame_and_keeps_serving() {
        let responses = serve_lines(concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n",
            "this is not valid json\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n",
        ));

        assert_eq!(
            responses.len(),
            3,
            "every frame yields a response and the loop survives the bad frame"
        );
        assert_eq!(responses[0]["id"], json!(1));
        assert!(responses[0]["result"]["serverInfo"].is_object());
        assert_eq!(responses[1]["error"]["code"], json!(-32700));
        assert_eq!(responses[1]["id"], Value::Null);
        assert_eq!(responses[2]["id"], json!(2));
        assert!(
            responses[2].get("result").is_some(),
            "ping after the malformed frame still gets a result"
        );
    }

    // A per-request handler error (here: tools/call with params missing the
    // required `name`) must also be isolated: answered with a JSON-RPC error
    // (-32603) that preserves the request id, while the next request is still
    // served.
    #[test]
    fn serve_transport_isolates_handler_error_and_preserves_id() {
        let responses = serve_lines(concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"bogus\":true}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"ping\"}\n",
        ));

        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["id"], json!(5));
        assert_eq!(responses[0]["error"]["code"], json!(-32603));
        assert_eq!(responses[1]["id"], json!(6));
        assert!(
            responses[1].get("result").is_some(),
            "a request after an isolated handler error is still served"
        );
    }

    // Re-initialize from the same connection is idempotent: a second
    // `initialize` is acknowledged again with serverInfo, so a client that
    // reconnects/re-handshakes is cleanly re-acknowledged rather than wedged.
    #[test]
    fn serve_transport_reinitialize_is_idempotent() {
        let responses = serve_lines(concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"initialize\"}\n",
        ));

        // The notification produces no response, so only the two initialize
        // requests answer.
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["id"], json!(1));
        assert!(responses[0]["result"]["serverInfo"].is_object());
        assert_eq!(responses[1]["id"], json!(2));
        assert!(
            responses[1]["result"]["serverInfo"].is_object(),
            "re-initialize is acknowledged again (idempotent re-handshake)"
        );
    }
}
