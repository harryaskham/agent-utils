use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
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
    /// Continuously fill the cache and serve authenticated snapshots/SSE.
    Daemon {
        /// HTTP bind address (default from config: daemon.bind).
        #[arg(long, value_name = "ADDR")]
        bind: Option<String>,
        /// Bearer token file (generated mode 0600 when absent).
        #[arg(long, value_name = "PATH")]
        token_file: Option<PathBuf>,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let config_path = cli
        .config
        .clone()
        .unwrap_or_else(slick::Config::default_path);
    let config = slick::Config::load(&config_path)?;
    let cache = CacheStore::new(cli.cache.clone().unwrap_or_else(CacheStore::default_path));
    if let Some(Command::Daemon { bind, token_file }) = &cli.command {
        if cli.demo
            || cli.snapshot
            || cli.sync_once
            || cli.fetch_file.is_some()
            || cli.no_cache
            || cli.no_daemon
            || cli.no_fallback
            || cli.fallback_timeout.is_some()
            || cli.daemon_url.is_some()
        {
            bail!("slick daemon cannot be combined with client/TUI/snapshot/sync options");
        }
        return slick::daemon::run(slick::daemon::DaemonOptions {
            cache_store: cache,
            bind: bind.clone().unwrap_or_else(|| config.daemon.bind.clone()),
            token_path: token_file
                .clone()
                .or(cli.token_file.clone())
                .unwrap_or_else(|| config.daemon_token_path(&config_path)),
            min_refresh_secs: config.daemon.min_refresh_secs,
        });
    }
    let explicit_client = matches!(cli.command, Some(Command::Client));
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
