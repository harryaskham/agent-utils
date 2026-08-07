use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use slick::cache::CacheStore;
use slick::ui::{self, Page, RunOptions};

#[derive(Debug, Parser)]
#[command(name = "slick", version, about = "A read-only, graphical Slack TUI")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,

    /// Run with deterministic offline demo data.
    #[arg(long)]
    demo: bool,

    /// Render a deterministic text snapshot and exit (implies --demo unless --live is set).
    #[arg(long)]
    snapshot: bool,

    /// With --snapshot, load the cache instead of demo data. No network calls are made.
    #[arg(long)]
    live: bool,

    /// Perform one live, non-interactive refresh into the cache and exit.
    #[arg(long)]
    sync_once: bool,

    /// Fetch one cached Slack file/Canvas by ID into the cache and exit.
    #[arg(long, value_name = "FILE_ID")]
    fetch_file: Option<String>,

    /// Emit stable mcp-cli JSON envelopes for query commands.
    #[arg(long, global = true)]
    json: bool,

    /// Disable Ratakittui/Kitty graphical chrome and use plain terminal borders.
    #[arg(long, global = true)]
    no_graphics: bool,

    /// Override the cache JSON path.
    #[arg(long, global = true, value_name = "PATH")]
    cache: Option<PathBuf>,

    /// Remove the cache before startup.
    #[arg(long, global = true)]
    clear_cache: bool,

    /// Snapshot width in terminal cells.
    #[arg(long, default_value_t = 120)]
    width: u16,

    /// Initial/snapshot view.
    #[arg(long, global = true, default_value = "activity", value_parser = ["activity", "feed", "favorites", "dms", "channels", "files"])]
    page: String,

    /// With --snapshot, open the selected conversation/file instead of its overview.
    #[arg(long)]
    open: bool,

    /// Config file path (default: `$SLICK_CONFIG`, else `~/.config/slick/config.yaml`).
    #[arg(long, global = true)]
    config: Option<std::path::PathBuf>,

    /// Do not load, follow, or persist the durable cache in smart-client mode.
    #[arg(long, global = true)]
    no_cache: bool,

    /// Do not connect to the daemon. This is strict cache-only mode unless
    /// --no-cache is also set, which requests immediate embedded fallback.
    #[arg(long, global = true)]
    no_daemon: bool,

    /// Never activate the embedded read-only collector after a source outage.
    #[arg(long, global = true)]
    no_fallback: bool,

    /// Override the configured source-outage timeout before fallback.
    #[arg(long, global = true, value_name = "SECONDS")]
    fallback_timeout: Option<u64>,

    /// Authenticated Slick daemon base URL for smart-client mode.
    #[arg(long, global = true, value_name = "URL")]
    daemon_url: Option<String>,

    /// Bearer token file for daemon/client authentication (default beside config).
    #[arg(long, global = true, value_name = "PATH")]
    token_file: Option<PathBuf>,

    /// Snapshot height in terminal cells.
    #[arg(long, default_value_t = 36)]
    height: u16,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Run the smart TUI client (also the default when no command is given).
    Client,
    /// List the merged message/file feed.
    Feed(ListArgs),
    /// Query grouped activity.
    Activity {
        #[command(subcommand)]
        command: ListCommand,
    },
    /// Query direct messages.
    Dm {
        #[command(subcommand)]
        command: ListGetCommand,
    },
    /// Query channels.
    Channel {
        #[command(subcommand)]
        command: ListGetCommand,
    },
    /// Query files and Canvas Markdown.
    Files {
        #[command(subcommand)]
        command: ListGetCommand,
    },
    /// Inspect, initialize, validate, import, export, or schema-check config.yaml.
    Config {
        #[command(subcommand)]
        command: Option<configurable_cli::ConfigCommand>,
    },
    /// Show daemon service logs; use -f to follow.
    #[command(alias = "logs")]
    Log(LogArgs),
    /// Serve Slick query tools over MCP stdio.
    Mcp {
        #[command(subcommand)]
        command: McpCommand,
    },
    /// Continuously fill the cache and serve authenticated snapshots/SSE.
    Daemon {
        /// HTTP bind address (default from config: daemon.bind).
        #[arg(long, value_name = "ADDR")]
        bind: Option<String>,
        /// Owner-local Unix socket serving the same authenticated protocol.
        #[arg(long, value_name = "PATH")]
        unix_socket: Option<PathBuf>,
        /// Bearer token file (generated mode 0600 when absent).
        #[arg(long, value_name = "PATH")]
        token_file: Option<PathBuf>,
    },
}

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
enum LogStreamArg {
    Stdout,
    #[default]
    Stderr,
    All,
}

#[derive(Clone, Debug, Args)]
struct LogArgs {
    /// Number of existing lines to show.
    #[arg(short = 'n', long, default_value_t = 50)]
    lines: usize,
    /// Continue following newly appended lines.
    #[arg(short = 'f', long)]
    follow: bool,
    /// Select launchd stdout, stderr, or both.
    #[arg(long, value_enum, default_value_t)]
    stream: LogStreamArg,
    /// Explicit log file; repeat to follow multiple files.
    #[arg(long = "file", value_name = "PATH")]
    files: Vec<PathBuf>,
}

#[derive(Clone, Debug, Args)]
struct ListArgs {
    /// Maximum records to return.
    #[arg(long)]
    limit: Option<usize>,
}

impl From<&ListArgs> for slick::query::ListInput {
    fn from(value: &ListArgs) -> Self {
        Self { limit: value.limit }
    }
}

#[derive(Clone, Debug, Args)]
struct GetArgs {
    /// Slack conversation or file id.
    #[arg(long)]
    id: String,
}

impl From<&GetArgs> for slick::query::GetInput {
    fn from(value: &GetArgs) -> Self {
        Self {
            id: value.id.clone(),
        }
    }
}

#[derive(Clone, Debug, Subcommand)]
enum ListCommand {
    List(ListArgs),
}

#[derive(Clone, Debug, Subcommand)]
enum ListGetCommand {
    List(ListArgs),
    Get(GetArgs),
}

#[derive(Clone, Debug, Subcommand)]
enum McpCommand {
    /// Run NDJSON-framed MCP over stdin/stdout.
    Stdio {
        /// Skip the daemon and permit explicit cache/direct-source fallback.
        #[arg(long)]
        standalone: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if let Some(Command::Log(args)) = &cli.command {
        let mut options = remote_cli::DaemonLogOptions::new("slick");
        options.lines = args.lines;
        options.follow = args.follow;
        options.stream = match args.stream {
            LogStreamArg::Stdout => remote_cli::LogStream::Stdout,
            LogStreamArg::Stderr => remote_cli::LogStream::Stderr,
            LogStreamArg::All => remote_cli::LogStream::All,
        };
        options.files.clone_from(&args.files);
        remote_cli::show_daemon_logs(&options)?;
        return Ok(());
    }
    if let Some(Command::Config { command }) = &cli.command {
        let output = slick::config::manager().execute(
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
        .unwrap_or_else(slick::Config::default_path);
    let config = slick::Config::load(&config_path)?;
    let cache = CacheStore::new(cli.cache.clone().unwrap_or_else(CacheStore::default_path));
    if let Some(Command::Daemon {
        bind,
        unix_socket,
        token_file,
    }) = &cli.command
    {
        if cli.demo
            || cli.snapshot
            || cli.sync_once
            || cli.fetch_file.is_some()
            || cli.no_cache
            || cli.no_daemon
            || cli.no_fallback
            || cli.fallback_timeout.is_some()
            || cli.daemon_url.is_some()
            || cli.json
        {
            bail!("slick daemon cannot be combined with client/TUI/snapshot/sync options");
        }
        return slick::daemon::run(slick::daemon::DaemonOptions {
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
        });
    }
    let query_runtime = slick::query::QueryRuntime {
        cache_store: cache.clone(),
        use_cache: config.client.cache && !cli.no_cache,
        use_daemon: config.client.daemon && !cli.no_daemon,
        endpoint: cli
            .daemon_url
            .clone()
            .unwrap_or_else(|| config.client.daemon_url.clone()),
        token_path: cli
            .token_file
            .clone()
            .unwrap_or_else(|| config.client_token_path(&config_path)),
        fallback: config.client.fallback && !cli.no_fallback,
        fallback_lease_path: config.fallback_lease_path(&config_path),
    };
    if let Some(command) = &cli.command {
        match command {
            Command::Feed(args) => {
                let output = slick::query::feed(&query_runtime, &args.into())?;
                return emit_query("slick_feed", cli.json, &output, slick::query::render_feed);
            }
            Command::Activity {
                command: ListCommand::List(args),
            } => {
                let output = slick::query::activity(&query_runtime, &args.into())?;
                return emit_query(
                    "slick_activity_list",
                    cli.json,
                    &output,
                    slick::query::render_activity,
                );
            }
            Command::Dm { command } => match command {
                ListGetCommand::List(args) => {
                    let output = slick::query::conversations(&query_runtime, &args.into(), true)?;
                    return emit_query(
                        "slick_dm_list",
                        cli.json,
                        &output,
                        slick::query::render_conversations,
                    );
                }
                ListGetCommand::Get(args) => {
                    let output = slick::query::conversation_get(&query_runtime, &args.into())?;
                    return emit_query(
                        "slick_dm_get",
                        cli.json,
                        &output,
                        slick::query::render_conversation,
                    );
                }
            },
            Command::Channel { command } => match command {
                ListGetCommand::List(args) => {
                    let output = slick::query::conversations(&query_runtime, &args.into(), false)?;
                    return emit_query(
                        "slick_channel_list",
                        cli.json,
                        &output,
                        slick::query::render_conversations,
                    );
                }
                ListGetCommand::Get(args) => {
                    let output = slick::query::conversation_get(&query_runtime, &args.into())?;
                    return emit_query(
                        "slick_channel_get",
                        cli.json,
                        &output,
                        slick::query::render_conversation,
                    );
                }
            },
            Command::Files { command } => match command {
                ListGetCommand::List(args) => {
                    let output = slick::query::files(&query_runtime, &args.into())?;
                    return emit_query(
                        "slick_files_list",
                        cli.json,
                        &output,
                        slick::query::render_files,
                    );
                }
                ListGetCommand::Get(args) => {
                    let output = slick::query::file_get(&query_runtime, &args.into())?;
                    return emit_query(
                        "slick_files_get",
                        cli.json,
                        &output,
                        slick::query::render_file,
                    );
                }
            },
            Command::Mcp {
                command: McpCommand::Stdio { standalone },
            } => {
                let mut mcp_runtime = query_runtime.clone();
                if *standalone {
                    mcp_runtime.use_daemon = false;
                    mcp_runtime.fallback = true;
                } else {
                    // Default MCP reads are cache/daemon-only. Never let an
                    // agent-owned stdio server become another Slack collector.
                    mcp_runtime.fallback = false;
                }
                slick::query::serve_mcp(&mcp_runtime)?;
                return Ok(());
            }
            Command::Client | Command::Log(_) | Command::Config { .. } | Command::Daemon { .. } => {
            }
        }
    }
    let explicit_client = matches!(&cli.command, Some(Command::Client));
    if cli.json && (explicit_client || cli.command.is_none()) {
        bail!("--json requires a query command such as feed, activity, dm, channel, or files");
    }
    let utility_mode = cli.demo || cli.snapshot || cli.sync_once || cli.fetch_file.is_some();
    if explicit_client && utility_mode {
        bail!("slick client cannot be combined with demo/snapshot/sync utility modes");
    }
    let smart_client = explicit_client || !utility_mode;
    if cli.clear_cache {
        cache.clear()?;
    }
    if cli.sync_once {
        let mut state = cache.load().unwrap_or_default();
        slick::SlackService::from_environment()?.bootstrap(&mut state)?;
        cache.save(&state)?;
        println!(
            "slick sync: {} conversations, {} notifications, {} files, {} cached message streams",
            state.conversations.len(),
            state.notifications.len(),
            state.files.len(),
            state.messages.len()
        );
        return Ok(());
    }
    if let Some(file_id) = cli.fetch_file {
        let mut state = cache.load()?;
        slick::SlackService::from_environment()?.load_file_content(&mut state, &file_id)?;
        cache.save(&state)?;
        let file = state
            .files
            .iter()
            .find(|file| file.id == file_id)
            .context("loaded Slack file disappeared before cache save")?;
        println!(
            "slick file: {} ({}) — {} Markdown chars, status {}",
            file.title,
            file.id,
            file.content_markdown.chars().count(),
            file.content_status
        );
        return Ok(());
    }
    if cli.snapshot {
        let state = if cli.live {
            cache.load().unwrap_or_default()
        } else {
            slick::demo_state()
        };
        print!(
            "{}",
            ui::snapshot_view_with_config(
                state,
                cli.width.max(60),
                cli.height.max(20),
                parse_page(&cli.page),
                cli.open,
                &config,
            )
        );
        return Ok(());
    }
    let client = smart_client.then(|| slick::client::ClientOptions {
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
        fallback_timeout: std::time::Duration::from_secs(
            cli.fallback_timeout
                .unwrap_or(config.client.fallback_timeout_secs),
        ),
        fallback_lease_path: config.fallback_lease_path(&config_path),
    });
    ui::run(RunOptions {
        demo: cli.demo,
        no_graphics: cli.no_graphics || !config.graphics,
        cache_store: cache,
        client,
        initial_page: parse_page(&cli.page),
        config,
        config_path,
    })
}

fn emit_query<T, F>(command: &str, json: bool, output: &T, human: F) -> Result<()>
where
    T: serde::Serialize,
    F: FnOnce(&T) -> String,
{
    if json {
        println!("{}", slick::query::json_output(command, output)?);
    } else {
        print!("{}", human(output));
    }
    Ok(())
}

fn parse_page(value: &str) -> Page {
    match value {
        "feed" => Page::Feed,
        "favorites" => Page::Favorites,
        "dms" => Page::Dms,
        "channels" => Page::Channels,
        "files" => Page::Files,
        _ => Page::Notifications,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_slick_and_client_subcommand_select_smart_mode() {
        let plain = Cli::try_parse_from(["slick"]).unwrap();
        assert!(plain.command.is_none());
        let client = Cli::try_parse_from([
            "slick",
            "client",
            "--page",
            "feed",
            "--no-cache",
            "--fallback-timeout",
            "12",
        ])
        .unwrap();
        assert!(matches!(client.command, Some(Command::Client)));
        assert_eq!(client.page, "feed");
        assert!(client.no_cache);
        assert_eq!(client.fallback_timeout, Some(12));
    }

    #[test]
    fn query_and_mcp_command_shapes_parse_with_global_json() {
        let logs = Cli::try_parse_from(["slick", "log", "-n", "25", "-f"]).unwrap();
        assert!(matches!(
            logs.command,
            Some(Command::Log(LogArgs {
                lines: 25,
                follow: true,
                ..
            }))
        ));
        let channel =
            Cli::try_parse_from(["slick", "channel", "get", "--id", "C123", "--json"]).unwrap();
        assert!(channel.json);
        assert!(matches!(
            channel.command,
            Some(Command::Channel {
                command: ListGetCommand::Get(GetArgs { ref id })
            }) if id == "C123"
        ));
        let mcp = Cli::try_parse_from(["slick", "mcp", "stdio"]).unwrap();
        assert!(matches!(
            mcp.command,
            Some(Command::Mcp {
                command: McpCommand::Stdio { standalone: false }
            })
        ));
        let standalone = Cli::try_parse_from(["slick", "mcp", "stdio", "--standalone"]).unwrap();
        assert!(matches!(
            standalone.command,
            Some(Command::Mcp {
                command: McpCommand::Stdio { standalone: true }
            })
        ));
    }

    #[test]
    fn daemon_subcommand_keeps_compatible_bind_shape() {
        let cli = Cli::try_parse_from([
            "slick",
            "daemon",
            "--bind",
            "127.0.0.1:9001",
            "--cache",
            "/tmp/slick-state.json",
        ])
        .unwrap();
        assert!(matches!(
            cli.command,
            Some(Command::Daemon {
                bind: Some(ref bind),
                ..
            }) if bind == "127.0.0.1:9001"
        ));
        assert_eq!(cli.cache, Some(PathBuf::from("/tmp/slick-state.json")));
    }
}
