//! Reusable CLI/MCP façade: structured JSON envelopes, a typed tool router,
//! and a minimal MCP stdio server. Split into focused modules (bd-a0ec22);
//! the public API is preserved via the re-exports below.

mod envelope;
mod protocol;
mod server;

pub use envelope::*;
pub use protocol::*;
pub use server::*;

#[cfg(test)]
mod tests {
    use super::{
        EnvelopeMeta, ErrorCategory, JSON_SCHEMA_VERSION, JsonEnvelope, JsonError, McpServer,
        StdioServerConfig, StructuredError, ToolRouter, write_json_result_ref,
    };
    use clap::{Args, Parser, Subcommand};
    use schemars::JsonSchema;
    use serde::{Deserialize, Serialize};
    use serde_json::{Value, json};
    use thiserror::Error;

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Args)]
    struct AddArgs {
        #[arg(long)]
        lhs: i64,
        #[arg(long)]
        rhs: i64,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Args)]
    struct EchoArgs {
        #[arg(long)]
        text: String,

        #[arg(long)]
        uppercase: bool,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, Args)]
    struct ReverseArgs {
        #[arg(long)]
        value: String,
    }

    #[derive(Debug, Error)]
    #[error("{message}")]
    struct SampleError {
        category: ErrorCategory,
        message: String,
    }

    impl SampleError {
        fn validation(message: impl Into<String>) -> Self {
            Self {
                category: ErrorCategory::Validation,
                message: message.into(),
            }
        }
    }

    impl StructuredError for SampleError {
        fn category(&self) -> ErrorCategory {
            self.category
        }

        fn code(&self) -> String {
            "sample_validation".to_owned()
        }

        fn message(&self) -> String {
            self.message.clone()
        }
    }

    fn build_math_router() -> ToolRouter<()> {
        let mut router = ToolRouter::new();
        router.add_typed_tool("math_add", "Add two integers.", |(), args: AddArgs| {
            Ok::<_, SampleError>(json!({ "sum": args.lhs + args.rhs }))
        });
        router.add_typed_tool(
            "text_echo",
            "Echo text with optional uppercasing.",
            |(), args: EchoArgs| {
                let rendered = if args.uppercase {
                    args.text.to_uppercase()
                } else {
                    args.text
                };
                Ok::<_, SampleError>(json!({ "text": rendered }))
            },
        );
        router
    }

    fn build_reverse_router() -> ToolRouter<()> {
        let mut router = ToolRouter::new();
        router.add_typed_tool(
            "text_reverse",
            "Reverse a string.",
            |(), args: ReverseArgs| {
                Ok::<_, SampleError>(json!({
                    "reversed": args.value.chars().rev().collect::<String>()
                }))
            },
        );
        router
    }

    #[derive(Debug, Parser)]
    struct MathCli {
        #[arg(long, global = true)]
        json: bool,

        #[command(subcommand)]
        command: MathCommand,
    }

    #[derive(Debug, Subcommand)]
    enum MathCommand {
        Add(AddArgs),
        Echo(EchoArgs),
    }

    #[derive(Debug, Parser)]
    struct ReverseCli {
        #[arg(long, global = true)]
        json: bool,

        #[command(subcommand)]
        command: ReverseCommand,
    }

    #[derive(Debug, Subcommand)]
    enum ReverseCommand {
        Reverse(ReverseArgs),
    }

    fn run_math_cli(args: &[&str]) -> (Result<Value, SampleError>, String) {
        let cli = MathCli::parse_from(args);
        let result = match cli.command {
            MathCommand::Add(input) => {
                if input.lhs < 0 || input.rhs < 0 {
                    Err(SampleError::validation("operands must be non-negative"))
                } else {
                    Ok(json!({ "sum": input.lhs + input.rhs }))
                }
            }
            MathCommand::Echo(input) => Ok(json!({
                "text": if input.uppercase {
                    input.text.to_uppercase()
                } else {
                    input.text
                }
            })),
        };

        let mut output = Vec::new();
        if cli.json {
            write_json_result_ref(&mut output, &result).expect("json output should serialize");
        }

        (
            result,
            String::from_utf8(output).expect("json output should be utf-8"),
        )
    }

    fn run_reverse_cli(args: &[&str]) -> (Result<Value, SampleError>, String) {
        let cli = ReverseCli::parse_from(args);
        let result = match cli.command {
            ReverseCommand::Reverse(input) => Ok(json!({
                "reversed": input.value.chars().rev().collect::<String>()
            })),
        };

        let mut output = Vec::new();
        if cli.json {
            write_json_result_ref(&mut output, &result).expect("json output should serialize");
        }

        (
            result,
            String::from_utf8(output).expect("json output should be utf-8"),
        )
    }

    #[test]
    fn success_envelope_serializes_with_status_tag_and_meta() {
        let envelope = JsonEnvelope::success_for("list", json!({ "crate": "mcp-cli" }));

        let value = serde_json::to_value(envelope).expect("success envelope serializes");

        assert_eq!(value["status"], "success");
        assert_eq!(value["meta"]["schema_version"], JSON_SCHEMA_VERSION);
        assert_eq!(value["meta"]["command"], "list");
        assert_eq!(value["data"]["crate"], "mcp-cli");
    }

    #[test]
    fn error_envelope_serializes_with_structured_category_and_code() {
        let envelope: JsonEnvelope<()> = JsonEnvelope::error_for(
            "capture",
            JsonError::new(
                ErrorCategory::Validation,
                "invalid_target",
                "placeholder validation failure",
            )
            .with_details(json!({ "field": "window" })),
        );

        let value = serde_json::to_value(envelope).expect("error envelope serializes");

        assert_eq!(value["status"], "error");
        assert_eq!(value["meta"]["command"], "capture");
        assert_eq!(value["error"]["category"], "validation");
        assert_eq!(value["error"]["code"], "invalid_target");
        assert_eq!(value["error"]["details"]["field"], "window");
    }

    #[test]
    fn envelope_meta_defaults_are_stable() {
        let meta = EnvelopeMeta::default();

        assert_eq!(meta.schema_version, JSON_SCHEMA_VERSION);
        assert!(meta.command.is_none());
    }

    #[test]
    fn typed_tool_schema_comes_from_the_input_type() {
        let router = build_math_router();
        let tools = router.tool_metadata();
        let add_tool = tools
            .iter()
            .find(|tool| tool.name == "math_add")
            .expect("add tool is registered");

        assert_eq!(add_tool.input_schema["type"], "object");
        assert_eq!(
            add_tool.input_schema["properties"]["lhs"]["type"],
            "integer"
        );
        assert_eq!(
            add_tool.input_schema["properties"]["rhs"]["type"],
            "integer"
        );
    }

    #[test]
    fn router_returns_structured_validation_errors() {
        let router = build_math_router();

        let envelope = router.call_tool(&(), "math_add", json!({ "lhs": 3 }));

        assert!(envelope.is_error());
        let value = serde_json::to_value(envelope).expect("error envelope serializes");
        assert_eq!(value["error"]["code"], "invalid_tool_arguments");
    }

    #[test]
    fn cli_and_router_match_for_primary_and_secondary_command_surfaces() {
        let (_, math_cli_json) =
            run_math_cli(&["math-cli", "--json", "add", "--lhs", "7", "--rhs", "5"]);
        let math_cli_envelope: Value =
            serde_json::from_str(math_cli_json.trim()).expect("math cli emits valid json");
        let math_router_envelope = serde_json::to_value(build_math_router().call_tool(
            &(),
            "math_add",
            json!({ "lhs": 7, "rhs": 5 }),
        ))
        .expect("math router envelope serializes");

        assert_eq!(math_cli_envelope["status"], math_router_envelope["status"]);
        assert_eq!(math_cli_envelope["data"], math_router_envelope["data"]);

        let (_, reverse_cli_json) =
            run_reverse_cli(&["reverse-cli", "--json", "reverse", "--value", "straw"]);
        let reverse_cli_envelope: Value =
            serde_json::from_str(reverse_cli_json.trim()).expect("reverse cli emits valid json");
        let reverse_router_envelope = serde_json::to_value(build_reverse_router().call_tool(
            &(),
            "text_reverse",
            json!({ "value": "straw" }),
        ))
        .expect("reverse router envelope serializes");

        assert_eq!(
            reverse_cli_envelope["data"],
            reverse_router_envelope["data"]
        );
    }

    #[test]
    fn stdio_server_handles_initialize_list_and_call() {
        let server = McpServer::new(
            StdioServerConfig {
                server_name: "sample-mcp".to_string(),
                server_version: "0.0.1".to_string(),
            },
            build_math_router(),
        );

        let input = [
            frame_request(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {}
            })),
            frame_request(&json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {}
            })),
            frame_request(&json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "text_echo",
                    "arguments": {
                        "text": "hello",
                        "uppercase": true
                    }
                }
            })),
        ]
        .concat();

        let mut output = Vec::new();
        server
            .serve_transport(&(), std::io::Cursor::new(input), &mut output)
            .expect("stdio server should handle framed messages");

        let responses = parse_framed_responses(&output);
        assert_eq!(responses.len(), 3);
        assert_eq!(responses[0]["result"]["serverInfo"]["name"], "sample-mcp");
        assert!(
            responses[1]["result"]["tools"]
                .as_array()
                .expect("tools list should be an array")
                .iter()
                .any(|tool| tool["name"] == "math_add")
        );
        assert_eq!(
            responses[2]["result"]["structuredContent"]["data"]["text"],
            "HELLO"
        );
        assert_eq!(responses[2]["result"]["isError"], false);
    }

    #[test]
    fn stdio_server_handles_ping_notifications_and_error_paths() {
        let server = McpServer::new(
            StdioServerConfig {
                server_name: "sample-mcp".to_string(),
                server_version: "0.0.1".to_string(),
            },
            build_math_router(),
        );

        let input = [
            // ping -> empty result object.
            frame_request(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": {} })),
            // A notification (no id) must NOT produce a response.
            frame_request(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })),
            // Unsupported method -> JSON-RPC method-not-found error.
            frame_request(
                &json!({ "jsonrpc": "2.0", "id": 2, "method": "bogus/method", "params": {} }),
            ),
            // tools/call to a missing tool -> structured error envelope with isError:true.
            frame_request(&json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": { "name": "does_not_exist", "arguments": {} }
            })),
        ]
        .concat();

        let mut output = Vec::new();
        server
            .serve_transport(&(), std::io::Cursor::new(input), &mut output)
            .expect("stdio server should handle framed messages");

        let responses = parse_framed_responses(&output);
        // The notification yields no response, so only 3 of the 4 inputs reply.
        assert_eq!(responses.len(), 3);
        // ping
        assert_eq!(responses[0]["id"], 1);
        assert_eq!(responses[0]["result"], json!({}));
        // unsupported method
        assert_eq!(responses[1]["id"], 2);
        assert_eq!(responses[1]["error"]["code"], -32601);
        // unknown tool surfaces as a structured error, not a transport failure.
        assert_eq!(responses[2]["id"], 3);
        assert_eq!(responses[2]["result"]["isError"], true);
    }

    fn frame_request(value: &Value) -> Vec<u8> {
        let mut message = serde_json::to_vec(value).expect("request should serialize");
        message.push(b'\n');
        message
    }

    fn parse_framed_responses(bytes: &[u8]) -> Vec<Value> {
        let text = std::str::from_utf8(bytes).expect("framed responses should be valid utf-8");
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).expect("response body should be json"))
            .collect()
    }
}
