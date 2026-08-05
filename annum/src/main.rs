#![forbid(unsafe_code)]

use std::path::PathBuf;

use annum::cache::CacheStore;
use annum::query;
use annum::ui::{self, Page, RunOptions};
use anyhow::{Result, bail};
use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(
    name = "annum",
    version,
    about = "Outlook + Teams deterministic CLI, MCP server, daemon, and Kittui client"
)]
struct Cli {
    /// Config file (default: `$ANNUM_CONFIG` or `~/.config/annum/config.yaml`).
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    /// Cache JSON path.
    #[arg(long, global = true)]
    cache: Option<PathBuf>,
    /// `WorkIQ` cached account override.
    #[arg(long, global = true)]
    account: Option<String>,
    /// Emit stable JSON envelopes for terse commands.
    #[arg(long, global = true)]
    json: bool,
    /// Disable Kittui graphics.
    #[arg(long, global = true)]
    no_graphics: bool,
    /// Disable durable cache reads/writes.
    #[arg(long, global = true)]
    no_cache: bool,
    /// Disable daemon snapshot/SSE access.
    #[arg(long, global = true)]
    no_daemon: bool,
    /// Disable embedded fallback collection.
    #[arg(long, global = true)]
    no_fallback: bool,
    /// Daemon HTTP(S) URL or `unix:///path` socket.
    #[arg(long, global = true)]
    daemon_url: Option<String>,
    /// Client/daemon bearer-token file.
    #[arg(long, global = true)]
    token_file: Option<PathBuf>,
    /// Use deterministic offline sample data.
    #[arg(long, global = true)]
    demo: bool,
    /// Clear cache before the requested operation.
    #[arg(long, global = true)]
    clear_cache: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Open the live smart Kittui client (also the default command).
    Client,
    /// Outlook email commands.
    Email {
        #[command(subcommand)]
        command: EmailCommand,
    },
    /// Outlook calendar commands.
    Calendar {
        #[command(subcommand)]
        command: CalendarCommand,
    },
    /// Teams chat commands.
    Chat {
        #[command(subcommand)]
        command: ChatCommand,
    },
    /// Teams/channel commands.
    Teams {
        #[command(subcommand)]
        command: TeamsCommand,
    },
    /// Deterministic local-cache search, or explicit `WorkIQ` semantic retrieval.
    Search(SearchArgs),
    /// Explicit Microsoft 365 Copilot operations (never used by background sync).
    Copilot {
        #[command(subcommand)]
        command: CopilotCommand,
    },
    /// Run one bounded `WorkIQ` synchronization and exit.
    Sync,
    /// Print source/cache/collector status.
    Status,
    /// Render a deterministic TUI snapshot and exit.
    Snapshot {
        #[arg(long, default_value_t = 120)]
        width: u16,
        #[arg(long, default_value_t = 38)]
        height: u16,
        #[arg(long, default_value = "email")]
        page: String,
    },
    /// Run the central `WorkIQ` collector and authenticated snapshot/SSE server.
    Daemon {
        #[arg(long, value_name = "ADDR")]
        bind: Option<String>,
        #[arg(long, value_name = "PATH")]
        unix_socket: Option<PathBuf>,
        #[arg(long, value_name = "PATH")]
        token_file: Option<PathBuf>,
    },
    /// Inspect, initialize, validate, import, export, or schema-check config.yaml.
    Config {
        #[command(subcommand)]
        command: Option<configurable_cli::ConfigCommand>,
    },
    /// Serve the same typed commands as MCP tools.
    Mcp {
        #[command(subcommand)]
        command: McpCommand,
    },
}

#[derive(Clone, Debug, Subcommand)]
enum EmailCommand {
    List(ListArgs),
    Get(GetArgs),
    Send(SendMailArgs),
    Reply(ReplyMailArgs),
    MarkRead(MarkReadArgs),
}

#[derive(Clone, Debug, Subcommand)]
enum CalendarCommand {
    List(ListArgs),
    Get(GetArgs),
    Create(CreateEventArgs),
    Respond(RespondEventArgs),
}

#[derive(Clone, Debug, Subcommand)]
enum ChatCommand {
    List(ListArgs),
    Get(GetArgs),
    Send(SendChatArgs),
}

#[derive(Clone, Debug, Subcommand)]
enum TeamsCommand {
    List(ListArgs),
    Channels(ChannelListArgs),
    Get(ChannelGetArgs),
}
#[derive(Clone, Debug, Subcommand)]
enum CopilotCommand {
    Ask {
        question: String,
        #[arg(long)]
        conversation_id: Option<String>,
    },
}
#[derive(Clone, Debug, Subcommand)]
enum McpCommand {
    Stdio,
}

#[derive(Clone, Debug, Default, Args)]
struct ListArgs {
    #[arg(long)]
    limit: Option<usize>,
    #[arg(long)]
    query: Option<String>,
    #[arg(long)]
    unread: bool,
}
impl From<&ListArgs> for query::ListInput {
    fn from(value: &ListArgs) -> Self {
        Self {
            limit: value.limit,
            query: value.query.clone(),
            unread_only: Some(value.unread),
        }
    }
}

#[derive(Clone, Debug, Args)]
struct GetArgs {
    #[arg(long)]
    id: String,
}
impl From<&GetArgs> for query::GetInput {
    fn from(value: &GetArgs) -> Self {
        Self {
            id: value.id.clone(),
        }
    }
}

#[derive(Clone, Debug, Args)]
struct ChannelListArgs {
    #[arg(long)]
    team_id: String,
    #[arg(long)]
    limit: Option<usize>,
}

#[derive(Clone, Debug, Args)]
struct ChannelGetArgs {
    #[arg(long)]
    team_id: String,
    #[arg(long)]
    channel_id: String,
}

#[derive(Clone, Debug, Args)]
struct SearchArgs {
    query: String,
    /// Use explicit `WorkIQ` semantic retrieval instead of deterministic cache search.
    #[arg(long)]
    semantic: bool,
    #[arg(long)]
    limit: Option<usize>,
}

#[derive(Clone, Debug, Args)]
struct SendMailArgs {
    #[arg(long, required = true)]
    to: Vec<String>,
    #[arg(long)]
    subject: String,
    #[arg(long)]
    body: String,
    #[arg(long)]
    confirm: bool,
}
#[derive(Clone, Debug, Args)]
struct ReplyMailArgs {
    #[arg(long)]
    id: String,
    #[arg(long)]
    body: String,
    #[arg(long)]
    reply_all: bool,
    #[arg(long)]
    confirm: bool,
}
#[derive(Clone, Debug, Args)]
struct MarkReadArgs {
    #[arg(long)]
    id: String,
    #[arg(long)]
    unread: bool,
    #[arg(long)]
    confirm: bool,
}
#[derive(Clone, Debug, Args)]
struct CreateEventArgs {
    #[arg(long)]
    subject: String,
    #[arg(long)]
    start: String,
    #[arg(long)]
    end: String,
    #[arg(long, default_value = "UTC")]
    timezone: String,
    #[arg(long)]
    attendee: Vec<String>,
    #[arg(long)]
    body: Option<String>,
    #[arg(long)]
    confirm: bool,
}
#[derive(Clone, Debug, Args)]
struct RespondEventArgs {
    #[arg(long)]
    id: String,
    #[arg(long)]
    response: String,
    #[arg(long)]
    comment: Option<String>,
    #[arg(long, default_value_t = true)]
    send_response: bool,
    #[arg(long)]
    confirm: bool,
}
#[derive(Clone, Debug, Args)]
struct SendChatArgs {
    #[arg(long)]
    chat_id: String,
    #[arg(long)]
    body: String,
    #[arg(long)]
    confirm: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if let Some(Command::Config { command }) = &cli.command {
        let output = annum::config::manager().execute(
            cli.config.as_deref(),
            command
                .clone()
                .unwrap_or(configurable_cli::ConfigCommand::Show),
        )?;
        output.print(cli.json)?;
        return Ok(());
    }
    let config_path = cli
        .config
        .clone()
        .unwrap_or_else(annum::Config::default_path);
    let mut config = annum::Config::load(&config_path)?;
    if let Some(account) = &cli.account {
        config.workiq.account = Some(account.clone());
    }
    let cache = CacheStore::new(cli.cache.clone().unwrap_or_else(CacheStore::default_path));
    if cli.clear_cache {
        cache.clear()?;
    }

    if let Some(Command::Daemon {
        bind,
        unix_socket,
        token_file,
    }) = &cli.command
    {
        if cli.demo
            || cli.json
            || cli.no_cache
            || cli.no_daemon
            || cli.no_fallback
            || cli.daemon_url.is_some()
        {
            bail!("annum daemon cannot be combined with client/demo/source-selection options");
        }
        return annum::daemon::run(annum::daemon::DaemonOptions {
            cache_store: cache,
            bind: bind.clone().unwrap_or_else(|| config.daemon.bind.clone()),
            unix_socket: unix_socket
                .clone()
                .or_else(|| config.daemon.unix_socket.clone()),
            token_path: token_file
                .clone()
                .or(cli.token_file.clone())
                .unwrap_or_else(|| config.daemon_token_path(&config_path)),
            min_refresh_secs: config.daemon.min_refresh_secs,
            workiq: config.workiq,
            collector: config.collector,
        });
    }

    if cli.demo {
        cache.save(&annum::demo_state())?;
    }
    if matches!(cli.command, Some(Command::Sync)) {
        let state = annum::daemon::sync_once(&cache, &config.workiq, &config.collector)?;
        println!(
            "annum sync: {} email, {} events, {} chats, {} teams",
            state.mail.len(),
            state.events.len(),
            state.chats.len(),
            state.teams.len()
        );
        return Ok(());
    }
    if let Some(Command::Snapshot {
        width,
        height,
        page,
    }) = &cli.command
    {
        let state = if cli.demo {
            annum::demo_state()
        } else {
            cache.load().unwrap_or_default()
        };
        let page = match page.as_str() {
            "calendar" => Page::Calendar,
            "chats" => Page::Chats,
            "teams" => Page::Teams,
            "search" => Page::Search,
            _ => Page::Email,
        };
        print!(
            "{}",
            ui::snapshot(state, (*width).max(60), (*height).max(20), page, config)
        );
        return Ok(());
    }

    let runtime = query::QueryRuntime::new(
        cache.clone(),
        config.client.cache && !cli.no_cache,
        config.client.daemon && !cli.no_daemon,
        cli.daemon_url
            .clone()
            .unwrap_or_else(|| config.client.daemon_url.clone()),
        cli.token_file
            .clone()
            .unwrap_or_else(|| config.client_token_path(&config_path)),
        config.client.fallback && !cli.no_fallback,
        config.fallback_lease_path(&config_path),
        config.workiq.clone(),
        config.collector.clone(),
    );

    if let Some(command) = &cli.command {
        match command {
            Command::Email { command } => return run_email(&runtime, command, cli.json),
            Command::Calendar { command } => return run_calendar(&runtime, command, cli.json),
            Command::Chat { command } => return run_chat(&runtime, command, cli.json),
            Command::Teams { command } => return run_teams(&runtime, command, cli.json),
            Command::Search(args) if args.semantic => {
                let output = query::semantic_search(
                    &runtime,
                    &query::SemanticSearchInput {
                        query: vec![args.query.clone()],
                    },
                )?;
                return emit("annum_semantic_search", cli.json, &output, |value| {
                    format!(
                        "{}\n",
                        serde_json::to_string_pretty(value).unwrap_or_default()
                    )
                });
            }
            Command::Search(args) => {
                let output = query::search(
                    &runtime,
                    &query::SearchInput {
                        query: args.query.clone(),
                        limit: args.limit,
                    },
                )?;
                return emit("annum_search", cli.json, &output, |output| {
                    serde_json::to_string_pretty(output).unwrap_or_default() + "\n"
                });
            }
            Command::Copilot {
                command:
                    CopilotCommand::Ask {
                        question,
                        conversation_id,
                    },
            } => {
                let output = query::copilot_ask(
                    &runtime,
                    &query::CopilotAskInput {
                        question: question.clone(),
                        conversation_id: conversation_id.clone(),
                    },
                )?;
                return emit("annum_copilot_ask", cli.json, &output, |value| {
                    render_workiq_answer(value)
                });
            }
            Command::Status => {
                let (state, source) = query::resolve_state(&runtime)?;
                let output = serde_json::json!({"source":source,"account":state.account,"collector":state.collector,"counts":{"email":state.mail.len(),"events":state.events.len(),"chats":state.chats.len(),"teams":state.teams.len()},"saved_at":state.saved_at});
                return emit("annum_status", cli.json, &output, |value| {
                    format!(
                        "{}\n",
                        serde_json::to_string_pretty(value).unwrap_or_default()
                    )
                });
            }
            Command::Mcp {
                command: McpCommand::Stdio,
            } => {
                query::serve_mcp(&runtime)?;
                return Ok(());
            }
            Command::Client
            | Command::Daemon { .. }
            | Command::Config { .. }
            | Command::Sync
            | Command::Snapshot { .. } => {}
        }
    }
    if cli.json {
        bail!("--json requires a terse command");
    }
    let client = Some(annum::client::ClientOptions {
        cache_store: cache.clone(),
        use_cache: config.client.cache && !cli.no_cache,
        use_daemon: config.client.daemon && !cli.no_daemon,
        endpoint: cli
            .daemon_url
            .unwrap_or_else(|| config.client.daemon_url.clone()),
        token_path: cli
            .token_file
            .unwrap_or_else(|| config.client_token_path(&config_path)),
        fallback: config.client.fallback && !cli.no_fallback,
        fallback_timeout: std::time::Duration::from_secs(config.client.fallback_timeout_secs),
        fallback_lease_path: config.fallback_lease_path(&config_path),
    });
    ui::run(RunOptions {
        no_graphics: cli.no_graphics || !config.graphics,
        cache_store: cache,
        client,
        config,
    })
}

fn run_email(runtime: &query::QueryRuntime, command: &EmailCommand, json: bool) -> Result<()> {
    match command {
        EmailCommand::List(args) => {
            let output = query::mail_list(runtime, &args.into())?;
            emit("annum_email_list", json, &output, query::render_mail)
        }
        EmailCommand::Get(args) => {
            let output = query::mail_get(runtime, &args.into())?;
            emit("annum_email_get", json, &output, |o| {
                format!(
                    "# {}\nFrom: {} <{}>\nDate: {}\n\n{}\n",
                    o.message.subject,
                    o.message.from.name,
                    o.message.from.address,
                    o.message.received_at,
                    if o.message.body_markdown.is_empty() {
                        &o.message.body_preview
                    } else {
                        &o.message.body_markdown
                    }
                )
            })
        }
        EmailCommand::Send(args) => {
            let output = query::send_mail(
                runtime,
                &query::SendMailInput {
                    to: args.to.clone(),
                    subject: args.subject.clone(),
                    body: args.body.clone(),
                    confirmed: args.confirm,
                },
            )?;
            emit_receipt("annum_email_send", json, &output)
        }
        EmailCommand::Reply(args) => {
            let output = query::reply_mail(
                runtime,
                &query::ReplyMailInput {
                    id: args.id.clone(),
                    body: args.body.clone(),
                    reply_all: args.reply_all,
                    confirmed: args.confirm,
                },
            )?;
            emit_receipt("annum_email_reply", json, &output)
        }
        EmailCommand::MarkRead(args) => {
            let output = query::mark_read(
                runtime,
                &query::MarkReadInput {
                    id: args.id.clone(),
                    read: !args.unread,
                    confirmed: args.confirm,
                },
            )?;
            emit_receipt("annum_email_mark_read", json, &output)
        }
    }
}
fn run_calendar(
    runtime: &query::QueryRuntime,
    command: &CalendarCommand,
    json: bool,
) -> Result<()> {
    match command {
        CalendarCommand::List(args) => {
            let output = query::calendar_list(runtime, &args.into())?;
            emit("annum_calendar_list", json, &output, query::render_events)
        }
        CalendarCommand::Get(args) => {
            let output = query::calendar_get(runtime, &args.into())?;
            emit("annum_calendar_get", json, &output, |output| {
                serde_json::to_string_pretty(output).unwrap_or_default() + "\n"
            })
        }
        CalendarCommand::Create(args) => {
            let output = query::create_event(
                runtime,
                &query::CreateEventInput {
                    subject: args.subject.clone(),
                    start: args.start.clone(),
                    end: args.end.clone(),
                    timezone: args.timezone.clone(),
                    attendees: args.attendee.clone(),
                    body: args.body.clone(),
                    confirmed: args.confirm,
                },
            )?;
            emit_receipt("annum_calendar_create", json, &output)
        }
        CalendarCommand::Respond(args) => {
            let output = query::respond_event(
                runtime,
                &query::RespondEventInput {
                    id: args.id.clone(),
                    response: args.response.clone(),
                    comment: args.comment.clone(),
                    send_response: args.send_response,
                    confirmed: args.confirm,
                },
            )?;
            emit_receipt("annum_calendar_respond", json, &output)
        }
    }
}
fn run_chat(runtime: &query::QueryRuntime, command: &ChatCommand, json: bool) -> Result<()> {
    match command {
        ChatCommand::List(args) => {
            let output = query::chat_list(runtime, &args.into())?;
            emit("annum_chat_list", json, &output, query::render_chats)
        }
        ChatCommand::Get(args) => {
            let output = query::chat_get(runtime, &args.into())?;
            emit("annum_chat_get", json, &output, |o| {
                serde_json::to_string_pretty(o).unwrap_or_default() + "\n"
            })
        }
        ChatCommand::Send(args) => {
            let output = query::send_chat(
                runtime,
                &query::SendChatInput {
                    chat_id: args.chat_id.clone(),
                    body: args.body.clone(),
                    confirmed: args.confirm,
                },
            )?;
            emit_receipt("annum_chat_send", json, &output)
        }
    }
}
fn run_teams(runtime: &query::QueryRuntime, command: &TeamsCommand, json: bool) -> Result<()> {
    match command {
        TeamsCommand::List(args) => {
            let output = query::teams(runtime, &args.into())?;
            emit("annum_teams_list", json, &output, |output| {
                serde_json::to_string_pretty(output).unwrap_or_default() + "\n"
            })
        }
        TeamsCommand::Channels(args) => {
            let output = query::channel_list(
                runtime,
                &query::ChannelListInput {
                    team_id: args.team_id.clone(),
                    limit: args.limit,
                },
            )?;
            emit("annum_channel_list", json, &output, |output| {
                serde_json::to_string_pretty(output).unwrap_or_default() + "\n"
            })
        }
        TeamsCommand::Get(args) => {
            let output = query::channel_get(
                runtime,
                &query::ChannelGetInput {
                    team_id: args.team_id.clone(),
                    channel_id: args.channel_id.clone(),
                },
            )?;
            emit("annum_channel_get", json, &output, |output| {
                serde_json::to_string_pretty(output).unwrap_or_default() + "\n"
            })
        }
    }
}

fn emit_receipt(command: &str, json: bool, output: &query::MutationReceipt) -> Result<()> {
    emit(command, json, output, |o| {
        format!(
            "accepted: {} {} -> {} (refresh queued: {})\n",
            o.operation, o.target, o.accepted, o.refresh_queued
        )
    })
}
fn emit<T: serde::Serialize, F: FnOnce(&T) -> String>(
    command: &str,
    json: bool,
    output: &T,
    human: F,
) -> Result<()> {
    if json {
        println!("{}", query::json_output(command, output)?);
    } else {
        print!("{}", human(output));
    }
    Ok(())
}
fn render_workiq_answer(value: &serde_json::Value) -> String {
    value
        .get("answer")
        .and_then(serde_json::Value::as_str)
        .map_or_else(
            || {
                format!(
                    "{}\n",
                    serde_json::to_string_pretty(value).unwrap_or_default()
                )
            },
            |answer| format!("{answer}\n"),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;
    #[test]
    fn cli_contract_is_valid() {
        Cli::command().debug_assert();
    }
    #[test]
    fn bare_annum_opens_client() {
        let cli = Cli::try_parse_from(["annum"]).unwrap();
        assert!(cli.command.is_none());
    }
    #[test]
    fn deterministic_and_write_shapes_parse() {
        assert!(matches!(
            Cli::try_parse_from(["annum", "email", "list", "--unread"])
                .unwrap()
                .command,
            Some(Command::Email {
                command: EmailCommand::List(_)
            })
        ));
        assert!(
            Cli::try_parse_from([
                "annum",
                "email",
                "send",
                "--to",
                "a@example.com",
                "--subject",
                "Hi",
                "--body",
                "Body",
                "--confirm"
            ])
            .is_ok()
        );
        assert!(Cli::try_parse_from(["annum", "config", "schema"]).is_ok());
        assert!(
            Cli::try_parse_from([
                "annum",
                "teams",
                "get",
                "--team-id",
                "t1",
                "--channel-id",
                "c1",
            ])
            .is_ok()
        );
    }
}
