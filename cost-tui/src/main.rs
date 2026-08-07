#![forbid(unsafe_code)]

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use configurable_cli::ConfigCommand;
use cost_tui::cache::CacheStore;
use cost_tui::client::{ClientOptions, ClientSubscription};
use cost_tui::collector::{configured_accounts, default_accounts, fetch_all};
use cost_tui::config::{manager as config_manager, Config};
use cost_tui::daemon::{run as run_daemon, sync_once, DaemonOptions};
use cost_tui::history::{summarize, HistoryStore};
use cost_tui::model::{AccountUsage, CostState};
use cost_tui::ui::{demo_state, run_client, run_demo, run_standalone, snapshot_state};

#[derive(Debug, Parser)]
#[command(
    name = "cost-tui",
    version,
    about = "Daemon-backed multi-account GitHub Copilot usage dashboard"
)]
struct Cli {
    /// Configuration file (default: `$COST_TUI_CONFIG` or `~/.config/cost-tui/config.yaml`).
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    /// Atomic state cache path.
    #[arg(long, global = true)]
    cache: Option<PathBuf>,
    /// Append-only durable JSONL history path.
    #[arg(long, global = true)]
    history: Option<PathBuf>,
    /// Account override as LOGIN@HOST. Repeat for multiple accounts.
    #[arg(long = "account", value_name = "LOGIN@HOST", global = true)]
    accounts: Vec<String>,
    /// Override collection/standalone refresh interval.
    #[arg(long, global = true)]
    refresh_secs: Option<u64>,
    /// Override daemon HTTP(S) or unix:// endpoint.
    #[arg(long, global = true)]
    daemon_url: Option<String>,
    /// Override daemon bearer-token file.
    #[arg(long, global = true)]
    token_file: Option<PathBuf>,
    /// Disable atomic cache reads/write-through for this client.
    #[arg(long, global = true)]
    no_cache: bool,
    /// Disable daemon snapshot/SSE access for this client.
    #[arg(long, global = true)]
    no_daemon: bool,
    /// Explicitly collect directly with gh in this client process.
    #[arg(long, global = true)]
    standalone: bool,
    /// Disable Kittui/Kitty graphical chrome.
    #[arg(long, global = true)]
    no_graphics: bool,
    /// Use deterministic offline data.
    #[arg(long, global = true)]
    demo: bool,
    /// Render a deterministic text snapshot and exit.
    #[arg(long, global = true)]
    snapshot: bool,
    /// Fetch all accounts directly once as sanitized JSON.
    #[arg(long, global = true)]
    once: bool,
    /// Emit JSON for terse commands.
    #[arg(long, global = true)]
    json: bool,
    /// Snapshot width in cells.
    #[arg(long, default_value_t = 120, global = true)]
    width: u16,
    /// Snapshot height in cells.
    #[arg(long, default_value_t = 42, global = true)]
    height: u16,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Clone, Debug, Subcommand)]
enum Command {
    /// Open the smart cache/daemon client (default).
    Client,
    /// Run the sole normal gh collector, history writer, cache, and SSE server.
    Daemon(DaemonArgs),
    /// Explicit one-shot direct collection into cache and JSONL history.
    Sync,
    /// Show daemon/cache collector status.
    Status,
    /// Inspect durable JSONL samples and computed rate windows.
    History(HistoryArgs),
    /// Show daemon service logs; use -f to follow.
    #[command(alias = "logs")]
    Log(LogArgs),
    /// Inspect or manage canonical configuration.
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
}

#[derive(Clone, Debug, Args)]
struct DaemonArgs {
    /// HTTP bind; empty disables TCP when --unix-socket is set.
    #[arg(long)]
    bind: Option<String>,
    /// Owner-local Unix socket serving the same authenticated protocol.
    #[arg(long)]
    unix_socket: Option<PathBuf>,
}

#[derive(Clone, Debug, Args)]
struct HistoryArgs {
    /// Restrict to one LOGIN@HOST account.
    #[arg(long = "filter-account")]
    account: Option<String>,
    /// Most recent samples to emit (0 means all retained samples).
    #[arg(short = 'n', long, default_value_t = 100)]
    limit: usize,
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
    #[arg(short = 'n', long, default_value_t = 50)]
    lines: usize,
    #[arg(short = 'f', long)]
    follow: bool,
    #[arg(long, value_enum, default_value_t)]
    stream: LogStreamArg,
    #[arg(long = "file", value_name = "PATH")]
    files: Vec<PathBuf>,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    if let Some(Command::Log(args)) = &cli.command {
        return show_logs(args);
    }
    let manager = config_manager();
    if let Some(Command::Config { command }) = &cli.command {
        let output = manager.execute(cli.config.as_deref(), command.clone())?;
        if cli.json {
            println!("{}", serde_json::to_string_pretty(&output.json)?);
        } else {
            print!("{}", output.human);
        }
        return Ok(());
    }
    let loaded = manager.load(cli.config.as_deref())?;
    let config_path = loaded.path;
    let mut config = loaded.config;
    if !cli.accounts.is_empty() {
        config.accounts.clone_from(&cli.accounts);
    }
    if let Some(refresh_secs) = cli.refresh_secs {
        config.refresh_secs = refresh_secs.max(10);
    }
    if let Some(endpoint) = &cli.daemon_url {
        config.client.daemon_url.clone_from(endpoint);
    }
    if let Some(token_file) = &cli.token_file {
        config.client.token_file = Some(token_file.clone());
        config.daemon.token_file = Some(token_file.clone());
    }
    let cache_path = cli.cache.unwrap_or_else(CacheStore::default_path);
    let history_path = cli
        .history
        .unwrap_or_else(|| config.history_path(&cache_path));
    let cache_store = CacheStore::new(cache_path);
    let history_store = HistoryStore::new(history_path);

    if cli.snapshot {
        print!(
            "{}",
            snapshot_state(
                demo_state(),
                cli.width.max(80),
                cli.height.max(28),
                config.refresh_secs,
            )
        );
        return Ok(());
    }
    if cli.demo {
        return run_demo(
            demo_state(),
            config.refresh_secs,
            cli.no_graphics || !config.graphics,
        );
    }
    let command = cli.command.unwrap_or(Command::Client);
    match command {
        Command::Daemon(args) => {
            let accounts = configured_accounts(&config.accounts)?;
            let bind = args.bind.unwrap_or(config.daemon.bind.clone());
            let unix_socket = args.unix_socket.or(config.daemon.unix_socket.clone());
            let token_path = config.daemon_token_path(&config_path);
            run_daemon(&DaemonOptions {
                cache_store,
                history_store,
                accounts,
                refresh_secs: config.refresh_secs,
                min_refresh_secs: config.daemon.min_refresh_secs,
                history: config.history,
                bind,
                unix_socket,
                token_path,
            })
        }
        Command::Sync => {
            if !cli.standalone && config.client.daemon && !cli.no_daemon {
                remote_cli::request_refresh(
                    &config.client.daemon_url,
                    &config.client_token_path(&config_path),
                    "all",
                )?;
                println!("daemon refresh requested");
                Ok(())
            } else {
                let accounts = configured_accounts(&config.accounts)?;
                let state = sync_once(&cache_store, &history_store, &accounts, &config.history)?;
                println!("{}", serde_json::to_string_pretty(&state)?);
                Ok(())
            }
        }
        Command::Status => show_status(&config, &config_path, &cache_store, cli.no_daemon),
        Command::History(args) => show_history(&history_store, &args, cli.json),
        Command::Client => {
            if cli.once {
                let accounts = configured_accounts(&config.accounts)?;
                println!("{}", serde_json::to_string_pretty(&fetch_all(&accounts))?);
                return Ok(());
            }
            if cli.standalone {
                let accounts = configured_accounts(&config.accounts)?;
                let initial = initial_usages(&cache_store, &accounts, !cli.no_cache);
                return run_standalone(
                    initial,
                    config.refresh_secs,
                    cli.no_graphics || !config.graphics,
                );
            }
            let state = if cli.no_cache {
                CostState::default()
            } else {
                cache_store.load().unwrap_or_default()
            };
            let accounts = if config.accounts.is_empty() {
                default_accounts()
            } else {
                configured_accounts(&config.accounts)?
            };
            let state = ensure_initial_state(state, &accounts);
            let token_path = config.client_token_path(&config_path);
            let fallback_lease_path = config.fallback_lease_path(&config_path);
            let subscription = ClientSubscription::spawn(ClientOptions {
                cache_store,
                use_cache: config.client.cache && !cli.no_cache,
                use_daemon: config.client.daemon && !cli.no_daemon,
                endpoint: config.client.daemon_url,
                token_path,
                fallback: false,
                fallback_timeout: Duration::from_secs(config.client.fallback_timeout_secs.max(1)),
                fallback_lease_path,
            });
            run_client(
                state,
                subscription,
                config.refresh_secs,
                cli.no_graphics || !config.graphics,
            )
        }
        Command::Log(_) | Command::Config { .. } => unreachable!("handled before config load"),
    }
}

fn initial_usages(
    store: &CacheStore,
    accounts: &[cost_tui::AccountId],
    use_cache: bool,
) -> Vec<AccountUsage> {
    let cached = if use_cache {
        store.load().unwrap_or_default().usages
    } else {
        Vec::new()
    };
    accounts
        .iter()
        .map(|account| {
            cached
                .iter()
                .find(|usage| usage.account == *account)
                .cloned()
                .unwrap_or_else(|| AccountUsage::loading(account.clone()))
        })
        .collect()
}

fn ensure_initial_state(mut state: CostState, accounts: &[cost_tui::AccountId]) -> CostState {
    if state.usages.is_empty() {
        state.usages = accounts
            .iter()
            .cloned()
            .map(AccountUsage::loading)
            .collect();
    }
    state.normalize();
    state
}

fn show_status(
    config: &Config,
    config_path: &std::path::Path,
    store: &CacheStore,
    no_daemon: bool,
) -> Result<()> {
    let (state, source) = if config.client.daemon && !no_daemon {
        match remote_cli::fetch_json::<CostState>(
            &config.client.daemon_url,
            &config.client_token_path(config_path),
            "/snapshot",
        ) {
            Ok(state) => (state, "daemon"),
            Err(error) => (
                store
                    .load()
                    .context("load Cost TUI cache after daemon failure")?,
                if error.to_string().is_empty() {
                    "cache"
                } else {
                    "cache (daemon unavailable)"
                },
            ),
        }
    } else {
        (store.load()?, "cache")
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "source": source,
            "collector": state.collector,
            "accounts": state.usages.len(),
            "revision": state.revision,
            "saved_at": state.saved_at,
            "aggregate_rates": state.rates.get(cost_tui::AGGREGATE_KEY),
        }))?
    );
    Ok(())
}

fn show_history(store: &HistoryStore, args: &HistoryArgs, json: bool) -> Result<()> {
    let mut samples = store.load()?;
    if let Some(account) = &args.account {
        samples.retain(|sample| sample.account_key() == *account);
    }
    if args.limit > 0 && samples.len() > args.limit {
        samples.drain(..samples.len() - args.limit);
    }
    let (_, rates) = summarize(&samples, 576, CostState::now());
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "path": store.path(),
                "samples": samples,
                "rates": rates,
            }))?
        );
    } else {
        println!("history: {}", store.path().display());
        for sample in &samples {
            println!(
                "{}  {:<42} {:>12.0} credits  ${:>10.2}",
                sample.captured_at,
                sample.account_key(),
                sample.credits_used,
                sample.credits_used * 0.01
            );
        }
        if let Some(aggregate) = rates.get(cost_tui::AGGREGATE_KEY) {
            println!(
                "aggregate: now {}  1h ${:.2}  24h ${:.2}  7d ${:.2}  28d ${:.2}  MTD ${:.2}",
                aggregate
                    .current_dollars_per_minute
                    .map_or_else(|| "waiting".into(), |value| format!("${value:.2}/min")),
                aggregate.hour.dollars,
                aggregate.day.dollars,
                aggregate.week.dollars,
                aggregate.twenty_eight_days.dollars,
                aggregate.calendar_month.dollars,
            );
        }
    }
    Ok(())
}

fn show_logs(args: &LogArgs) -> Result<()> {
    let mut options = remote_cli::DaemonLogOptions::new("cost-tui");
    options.lines = args.lines;
    options.follow = args.follow;
    options.stream = match args.stream {
        LogStreamArg::Stdout => remote_cli::LogStream::Stdout,
        LogStreamArg::Stderr => remote_cli::LogStream::Stderr,
        LogStreamArg::All => remote_cli::LogStream::All,
    };
    options.files.clone_from(&args.files);
    remote_cli::show_daemon_logs(&options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_keeps_legacy_and_daemon_shapes() {
        assert!(Cli::try_parse_from(["cost-tui", "--snapshot"]).is_ok());
        assert!(Cli::try_parse_from(["cost-tui", "daemon", "--bind", "0.0.0.0:7622"]).is_ok());
        assert!(Cli::try_parse_from(["cost-tui", "history", "-n", "20", "--json"]).is_ok());
        assert!(Cli::try_parse_from(["cost-tui", "log", "-f"]).is_ok());
        assert!(Cli::try_parse_from(["cost-tui", "config", "schema"]).is_ok());
    }
}
