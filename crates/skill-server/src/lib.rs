use std::env;
use std::ffi::OsString;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use clap::{Args, Parser, Subcommand};
use mcp_cli::{
    ErrorCategory, JsonEnvelope, McpServer, StdioServerConfig, StructuredError, ToolRouter,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;

pub const DEFAULT_CONFIG_PATH: &str = ".config/ss/config.yaml";
pub const ENV_CONFIG_PATH: &str = "SS_CONFIG";

#[derive(Debug, Clone, Parser)]
#[command(
    name = "ss",
    bin_name = "ss",
    about = "Discover local skills and host MCP tools without reloading the agent",
    long_about = "skill-server (ss) provides one CLI and MCP stdio surface for dynamic skill/tool discovery.\n\nExamples:\n  ss list --json\n  ss web query latest Rust MCP crate\n  ss call web --query 'query latest Rust MCP crate' --json\n  ss mcp stdio",
    allow_external_subcommands = true
)]
pub struct SkillServerCli {
    /// Read configuration from this YAML file (default: `SS_CONFIG` or `.config/ss/config.yaml`).
    #[arg(short, long, global = true, value_name = "PATH")]
    pub config: Option<PathBuf>,
    /// Emit mcp-cli JSON envelopes instead of human text.
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Clone, Subcommand)]
pub enum Command {
    /// List discovered skills, domains, and MCP server/tool routes.
    List,
    /// Execute the /ss-style meta request explicitly.
    Call(CallCommand),
    /// Serve the meta-tool over MCP stdio.
    Mcp(McpCommand),
    /// Dynamic /ss shorthand: ss <domain> <query-or-command...>.
    #[command(external_subcommand)]
    External(Vec<OsString>),
}

#[derive(Debug, Clone, Args)]
pub struct CallCommand {
    /// Domain or server/tool name to route to, e.g. web.
    pub domain: String,
    /// Query or command text to pass to the selected route.
    #[arg(short, long, value_name = "TEXT")]
    pub query: Option<String>,
    /// Prefer a specific configured tool name/alias.
    #[arg(short, long)]
    pub tool: Option<String>,
    /// Remaining words form the query when --query is omitted.
    #[arg(trailing_var_arg = true)]
    pub rest: Vec<String>,
}

#[derive(Debug, Clone, Args)]
pub struct McpCommand {
    #[command(subcommand)]
    pub command: McpSubcommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum McpSubcommand {
    /// Run the MCP server using Content-Length framed stdio.
    Stdio,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "snake_case")]
pub struct SkillServerConfig {
    /// Directories that contain Pi/Cacophony/agent skill files to scan.
    pub skill_paths: Vec<PathBuf>,
    /// Host MCP stdio servers that ss can discover and route toward.
    pub mcp_servers: Vec<McpServerDefinition>,
}

impl SkillServerConfig {
    pub fn load(path: &Path) -> Result<Self, SkillServerError> {
        let content = fs::read_to_string(path).map_err(|source| SkillServerError::ConfigIo {
            path: path.to_path_buf(),
            source,
        })?;
        serde_yaml::from_str(&content).map_err(|source| SkillServerError::ConfigParse {
            path: path.to_path_buf(),
            source,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "snake_case")]
pub struct McpServerDefinition {
    pub name: String,
    pub description: Option<String>,
    pub domains: Vec<String>,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<EnvVarDefinition>,
    pub tools: Vec<ToolDefinition>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "snake_case")]
pub struct EnvVarDefinition {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "snake_case")]
pub struct ToolDefinition {
    pub name: String,
    pub description: Option<String>,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct RuntimeContext {
    pub config_path: PathBuf,
    pub config: SkillServerConfig,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "snake_case")]
pub struct MetaRequest {
    /// Domain/server/tool selector, e.g. `web`, `search_web`, `caco`, or `docs`.
    pub domain: String,
    /// Query or command payload after /ss <domain>.
    pub query: String,
    /// Optional explicit tool name/alias preference.
    pub tool: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct MetaResponse {
    pub request: MetaRequest,
    pub status: RouteStatus,
    pub matches: Vec<RouteMatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<RouteMatch>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteStatus {
    Routed,
    Ambiguous,
    NotFound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RouteMatch {
    pub kind: RouteKind,
    pub name: String,
    pub domain: String,
    pub score: u8,
    pub command: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteKind {
    McpServer,
    SkillFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inventory {
    pub config_path: PathBuf,
    pub skill_paths: Vec<PathBuf>,
    pub mcp_servers: Vec<McpServerInventory>,
    pub skills: Vec<SkillInventoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpServerInventory {
    pub name: String,
    pub domains: Vec<String>,
    pub command: Vec<String>,
    pub tools: Vec<ToolDefinition>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillInventoryEntry {
    pub name: String,
    pub path: PathBuf,
    pub domain: String,
}

#[derive(Debug, Error)]
pub enum SkillServerError {
    #[error("failed to read config {path}: {source}")]
    ConfigIo {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse config {path}: {source}")]
    ConfigParse {
        path: PathBuf,
        source: serde_yaml::Error,
    },
    #[error("invalid request: {0}")]
    Validation(String),
    #[error("failed to serialize response: {0}")]
    Serialization(String),
    #[error("MCP stdio error: {0}")]
    Mcp(String),
}

impl StructuredError for SkillServerError {
    fn category(&self) -> ErrorCategory {
        match self {
            Self::ConfigIo { .. } | Self::ConfigParse { .. } => ErrorCategory::ConfigError,
            Self::Validation(_) => ErrorCategory::Validation,
            Self::Serialization(_) | Self::Mcp(_) => ErrorCategory::SerializationError,
        }
    }

    fn code(&self) -> String {
        match self {
            Self::ConfigIo { .. } => "config_io".to_owned(),
            Self::ConfigParse { .. } => "config_parse".to_owned(),
            Self::Validation(_) => "invalid_request".to_owned(),
            Self::Serialization(_) => "serialization_error".to_owned(),
            Self::Mcp(_) => "mcp_stdio_error".to_owned(),
        }
    }

    fn message(&self) -> String {
        self.to_string()
    }

    fn details(&self) -> Option<Value> {
        match self {
            Self::ConfigIo { path, .. } | Self::ConfigParse { path, .. } => {
                Some(json!({ "path": path }))
            }
            Self::Validation(_) | Self::Serialization(_) | Self::Mcp(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandOutput {
    Human(String),
    Json(Value),
    Empty,
}

impl CommandOutput {
    pub fn print(self) {
        match self {
            Self::Human(text) => print!("{text}"),
            Self::Json(value) => println!(
                "{}",
                serde_json::to_string_pretty(&value).expect("JSON command output should serialize")
            ),
            Self::Empty => {}
        }
    }
}

pub fn dispatch(cli: &SkillServerCli) -> Result<CommandOutput, SkillServerError> {
    let config_path = resolve_config_path(cli.config.as_ref());
    let context = RuntimeContext {
        config: SkillServerConfig::load(&config_path)?,
        config_path,
    };

    match &cli.command {
        None => Ok(CommandOutput::Human(help_text())),
        Some(Command::List) => {
            let inventory = discover_inventory(&context);
            render_output("list", cli.json, &inventory, render_inventory_human)
        }
        Some(Command::Call(command)) => {
            let request = meta_request_from_call(command)?;
            let response = execute_meta_request(&context, request);
            render_output("ss", cli.json, &response, render_meta_human)
        }
        Some(Command::External(words)) => {
            let (request, external_json) = meta_request_from_external(words)?;
            let response = execute_meta_request(&context, request);
            render_output(
                "ss",
                cli.json || external_json,
                &response,
                render_meta_human,
            )
        }
        Some(Command::Mcp(command)) => match command.command {
            McpSubcommand::Stdio => {
                build_mcp_server()
                    .serve_stdio(&context)
                    .map_err(|error| SkillServerError::Mcp(error.to_string()))?;
                Ok(CommandOutput::Empty)
            }
        },
    }
}

#[must_use]
pub fn build_mcp_server() -> McpServer<RuntimeContext> {
    McpServer::new(
        StdioServerConfig {
            server_name: "skill-server".to_owned(),
            server_version: env!("CARGO_PKG_VERSION").to_owned(),
        },
        build_tool_router(),
    )
}

fn build_tool_router() -> ToolRouter<RuntimeContext> {
    let mut router = ToolRouter::new();
    router.add_typed_tool(
        "ss",
        "Route a /ss <domain> <query-or-command> meta request to a configured skill or MCP server.",
        |context: &RuntimeContext, request: MetaRequest| {
            Ok::<MetaResponse, SkillServerError>(execute_meta_request(context, request))
        },
    );
    router.add_typed_tool(
        "skill_server_list",
        "List configured skill paths, discovered skill files, and MCP server routes.",
        |context: &RuntimeContext, _request: ListRequest| {
            Ok::<Inventory, SkillServerError>(discover_inventory(context))
        },
    );
    router
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ListRequest {}

#[must_use]
pub fn resolve_config_path(flag_path: Option<&PathBuf>) -> PathBuf {
    flag_path
        .cloned()
        .or_else(|| env::var_os(ENV_CONFIG_PATH).map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from(DEFAULT_CONFIG_PATH))
}

#[must_use]
pub fn discover_inventory(context: &RuntimeContext) -> Inventory {
    Inventory {
        config_path: context.config_path.clone(),
        skill_paths: context.config.skill_paths.clone(),
        mcp_servers: context
            .config
            .mcp_servers
            .iter()
            .map(|server| McpServerInventory {
                name: server.name.clone(),
                domains: server.domains.clone(),
                command: command_vector(server),
                tools: server.tools.clone(),
                description: server.description.clone(),
            })
            .collect(),
        skills: discover_skill_files(&context.config.skill_paths),
    }
}

#[must_use]
pub fn execute_meta_request(context: &RuntimeContext, request: MetaRequest) -> MetaResponse {
    let mut matches = discover_routes(context, &request);
    matches.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then(left.name.cmp(&right.name))
    });
    let top_score = matches.first().map_or(0, |route| route.score);
    let best_count = matches
        .iter()
        .filter(|route| route.score == top_score)
        .count();
    let selected = if top_score > 0 && best_count == 1 {
        matches.first().cloned()
    } else {
        None
    };
    let status = match (top_score, best_count) {
        (0, _) => RouteStatus::NotFound,
        (_, 1) => RouteStatus::Routed,
        _ => RouteStatus::Ambiguous,
    };
    let message = match (&status, &selected) {
        (RouteStatus::Routed, Some(route)) => format!(
            "routed /ss {} to {} `{}`; host should call the listed MCP command/tool with the query payload",
            request.domain,
            route.kind.as_str(),
            route.name
        ),
        (RouteStatus::Ambiguous, _) => format!(
            "multiple equally good routes matched `{}`; pass a more specific domain or tool",
            request.domain
        ),
        (RouteStatus::NotFound, _) => format!(
            "no configured skill or MCP server matched `{}`",
            request.domain
        ),
        (RouteStatus::Routed, None) => "route selected".to_owned(),
    };

    MetaResponse {
        request,
        status,
        matches,
        selected,
        message,
    }
}

fn discover_routes(context: &RuntimeContext, request: &MetaRequest) -> Vec<RouteMatch> {
    let selector = normalize(&request.domain);
    let requested_tool = request.tool.as_ref().map(|tool| normalize(tool));
    let mut routes = Vec::new();

    for server in &context.config.mcp_servers {
        let server_name = normalize(&server.name);
        let domain_match = server
            .domains
            .iter()
            .any(|domain| normalize(domain) == selector);
        let tool_match = server.tools.iter().find(|tool| {
            normalize(&tool.name) == selector
                || requested_tool
                    .as_ref()
                    .is_some_and(|wanted| tool_matches(tool, wanted))
                || tool
                    .aliases
                    .iter()
                    .any(|alias| normalize(alias) == selector)
        });
        let direct_match = server_name == selector || domain_match || tool_match.is_some();
        if direct_match {
            let score = route_score(&selector, requested_tool.as_ref(), server, tool_match);
            routes.push(RouteMatch {
                kind: RouteKind::McpServer,
                name: server.name.clone(),
                domain: if domain_match {
                    request.domain.clone()
                } else {
                    server
                        .domains
                        .first()
                        .cloned()
                        .unwrap_or_else(|| server.name.clone())
                },
                score,
                command: command_vector(server),
                tool: tool_match.map(|tool| tool.name.clone()).or_else(|| {
                    requested_tool
                        .as_ref()
                        .and_then(|wanted| find_tool(server, wanted).map(|tool| tool.name.clone()))
                }),
                description: server.description.clone(),
                path: None,
            });
        }
    }

    for skill in discover_skill_files(&context.config.skill_paths) {
        if normalize(&skill.domain) == selector || normalize(&skill.name) == selector {
            routes.push(RouteMatch {
                kind: RouteKind::SkillFile,
                name: skill.name,
                domain: skill.domain,
                score: 70,
                command: Vec::new(),
                tool: None,
                description: None,
                path: Some(skill.path),
            });
        }
    }

    routes
}

fn route_score(
    selector: &str,
    requested_tool: Option<&String>,
    server: &McpServerDefinition,
    tool_match: Option<&ToolDefinition>,
) -> u8 {
    if requested_tool.is_some_and(|wanted| find_tool(server, wanted).is_some()) {
        return 100;
    }
    if tool_match.is_some() {
        return 95;
    }
    if normalize(&server.name) == selector {
        return 90;
    }
    if server
        .domains
        .iter()
        .any(|domain| normalize(domain) == selector)
    {
        return 80;
    }
    1
}

fn find_tool<'a>(server: &'a McpServerDefinition, wanted: &str) -> Option<&'a ToolDefinition> {
    server.tools.iter().find(|tool| tool_matches(tool, wanted))
}

fn tool_matches(tool: &ToolDefinition, wanted: &str) -> bool {
    normalize(&tool.name) == wanted || tool.aliases.iter().any(|alias| normalize(alias) == wanted)
}

fn command_vector(server: &McpServerDefinition) -> Vec<String> {
    let mut argv = vec![server.command.clone()];
    argv.extend(server.args.clone());
    argv
}

fn discover_skill_files(paths: &[PathBuf]) -> Vec<SkillInventoryEntry> {
    let mut entries = Vec::new();
    for root in paths {
        let Ok(read_dir) = fs::read_dir(root) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_file() || !is_skill_file(&path) {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let name = stem.to_owned();
            let domain = name
                .split(['-', '_', '.'])
                .next()
                .filter(|part| !part.is_empty())
                .unwrap_or(&name)
                .to_owned();
            entries.push(SkillInventoryEntry { name, path, domain });
        }
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    entries
}

fn is_skill_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| matches!(extension, "md" | "json" | "yaml" | "yml"))
}

fn meta_request_from_call(command: &CallCommand) -> Result<MetaRequest, SkillServerError> {
    let query = command
        .query
        .clone()
        .unwrap_or_else(|| command.rest.join(" "))
        .trim()
        .to_owned();
    validate_meta_request(MetaRequest {
        domain: command.domain.clone(),
        query,
        tool: command.tool.clone(),
    })
}

fn meta_request_from_external(words: &[OsString]) -> Result<(MetaRequest, bool), SkillServerError> {
    let Some((domain, rest)) = words.split_first() else {
        return Err(SkillServerError::Validation(
            "expected /ss-style input: ss <domain> <query-or-command>".to_owned(),
        ));
    };
    let domain = domain.to_string_lossy().to_string();
    let mut external_json = false;
    let mut query_words = Vec::new();
    for word in rest {
        if word == "--json" {
            external_json = true;
        } else {
            query_words.push(word.to_string_lossy());
        }
    }
    let query = query_words.join(" ").trim().to_owned();
    validate_meta_request(MetaRequest {
        domain,
        query,
        tool: None,
    })
    .map(|request| (request, external_json))
}

fn validate_meta_request(request: MetaRequest) -> Result<MetaRequest, SkillServerError> {
    if request.domain.trim().is_empty() {
        return Err(SkillServerError::Validation(
            "domain must not be empty".to_owned(),
        ));
    }
    if request.query.trim().is_empty() {
        return Err(SkillServerError::Validation(
            "query must not be empty".to_owned(),
        ));
    }
    Ok(request)
}

fn render_output<T, F>(
    command_name: &str,
    json_mode: bool,
    data: &T,
    render_human: F,
) -> Result<CommandOutput, SkillServerError>
where
    T: Serialize,
    F: FnOnce(&T) -> String,
{
    if json_mode {
        let envelope = JsonEnvelope::success_for(command_name, data);
        serde_json::to_value(envelope)
            .map(CommandOutput::Json)
            .map_err(|error| SkillServerError::Serialization(error.to_string()))
    } else {
        Ok(CommandOutput::Human(render_human(data)))
    }
}

fn render_inventory_human(inventory: &Inventory) -> String {
    let mut output = format!("skill-server config: {}\n", inventory.config_path.display());
    output.push_str("\nMCP servers:\n");
    if inventory.mcp_servers.is_empty() {
        output.push_str("  (none)\n");
    }
    for server in &inventory.mcp_servers {
        let _ = writeln!(
            output,
            "  - {} domains=[{}] command={}",
            server.name,
            server.domains.join(","),
            server.command.join(" ")
        );
        for tool in &server.tools {
            let _ = writeln!(output, "      tool: {}", tool.name);
        }
    }
    output.push_str("\nSkill files:\n");
    if inventory.skills.is_empty() {
        output.push_str("  (none)\n");
    }
    for skill in &inventory.skills {
        let _ = writeln!(
            output,
            "  - {} [{}] {}",
            skill.name,
            skill.domain,
            skill.path.display()
        );
    }
    output
}

fn render_meta_human(response: &MetaResponse) -> String {
    let mut output = format!("{}\n", response.message);
    if let Some(selected) = &response.selected {
        let _ = writeln!(
            output,
            "selected: {} {} domain={} score={}",
            selected.kind.as_str(),
            selected.name,
            selected.domain,
            selected.score
        );
        if !selected.command.is_empty() {
            let _ = writeln!(output, "command: {}", selected.command.join(" "));
        }
        if let Some(tool) = &selected.tool {
            let _ = writeln!(output, "tool: {tool}");
        }
        if let Some(path) = &selected.path {
            let _ = writeln!(output, "path: {}", path.display());
        }
    }
    output
}

fn help_text() -> String {
    "skill-server (ss) dynamic discovery utility\n\nUsage:\n  ss --help\n  ss list [--json]\n  ss call <domain> --query <text> [--tool <tool>] [--json]\n  ss <domain> <query-or-command...>\n  ss mcp stdio\n\nConfiguration defaults to .config/ss/config.yaml, override with --config or SS_CONFIG.\n".to_owned()
}

impl RouteKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::McpServer => "mcp_server",
            Self::SkillFile => "skill_file",
        }
    }
}

fn normalize(value: &str) -> String {
    value.trim().to_ascii_lowercase().replace(['_', '-'], "")
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    const SAMPLE_CONFIG: &str = r"
skill_paths:
  - ./prompts
mcp_servers:
  - name: web-search
    description: Live web search via GitHub Copilot Responses API
    domains: [web, search]
    command: web-search-mcp
    args: []
    tools:
      - name: search_web
        aliases: [query, web_search]
        description: Search the live web
";

    #[test]
    fn cli_help_surface_builds() {
        SkillServerCli::command().debug_assert();
    }

    #[test]
    fn parses_config_with_skill_paths_and_mcp_servers() {
        let config: SkillServerConfig = serde_yaml::from_str(SAMPLE_CONFIG).expect("valid config");
        assert_eq!(config.skill_paths, vec![PathBuf::from("./prompts")]);
        assert_eq!(config.mcp_servers[0].domains, vec!["web", "search"]);
        assert_eq!(config.mcp_servers[0].tools[0].name, "search_web");
    }

    #[test]
    fn meta_request_routes_to_configured_mcp_tool() {
        let config: SkillServerConfig = serde_yaml::from_str(SAMPLE_CONFIG).expect("valid config");
        let context = RuntimeContext {
            config_path: PathBuf::from("test.yaml"),
            config,
        };
        let response = execute_meta_request(
            &context,
            MetaRequest {
                domain: "web".to_owned(),
                query: "query rust mcp".to_owned(),
                tool: Some("query".to_owned()),
            },
        );
        assert_eq!(response.status, RouteStatus::Routed);
        let selected = response.selected.expect("selected route");
        assert_eq!(selected.name, "web-search");
        assert_eq!(selected.tool.as_deref(), Some("search_web"));
    }

    #[test]
    fn mcp_server_exposes_meta_tool() {
        let names: Vec<_> = build_mcp_server()
            .tool_metadata()
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        assert_eq!(names, vec!["ss", "skill_server_list"]);
    }

    #[test]
    fn mcp_tool_call_uses_same_meta_router() {
        let config: SkillServerConfig = serde_yaml::from_str(SAMPLE_CONFIG).expect("valid config");
        let context = RuntimeContext {
            config_path: PathBuf::from("test.yaml"),
            config,
        };
        let response = build_mcp_server()
            .handle_request_value(
                &context,
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": {
                        "name": "ss",
                        "arguments": {
                            "domain": "web",
                            "query": "query rust mcp",
                            "tool": "query"
                        }
                    }
                }),
            )
            .expect("MCP request should be handled")
            .expect("MCP call should return response");

        assert_eq!(response["result"]["isError"], false);
        assert_eq!(
            response["result"]["structuredContent"]["data"]["status"],
            "routed"
        );
        assert_eq!(
            response["result"]["structuredContent"]["data"]["selected"]["tool"],
            "search_web"
        );
    }
}
