use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use slick::cache::CacheStore;
use slick::ui::{self, Page, RunOptions};

#[derive(Debug, Parser)]
#[command(name = "slick", version, about = "A read-only, graphical Slack TUI")]
struct Cli {
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
    #[arg(long)]
    no_graphics: bool,

    /// Override the cache JSON path.
    #[arg(long, value_name = "PATH")]
    cache: Option<PathBuf>,

    /// Remove the cache before startup.
    #[arg(long)]
    clear_cache: bool,

    /// Snapshot width in terminal cells.
    #[arg(long, default_value_t = 120)]
    width: u16,

    /// Initial/snapshot view.
    #[arg(long, default_value = "activity", value_parser = ["activity", "favorites", "dms", "channels", "files"])]
    page: String,

    /// With --snapshot, open the selected conversation/file instead of its overview.
    #[arg(long)]
    open: bool,

    /// Snapshot height in terminal cells.
    #[arg(long, default_value_t = 36)]
    height: u16,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let cache = CacheStore::new(cli.cache.unwrap_or_else(CacheStore::default_path));
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
            ui::snapshot_view(
                state,
                cli.width.max(60),
                cli.height.max(20),
                parse_page(&cli.page),
                cli.open,
            )
        );
        return Ok(());
    }
    ui::run(RunOptions {
        demo: cli.demo,
        no_graphics: cli.no_graphics,
        cache_store: cache,
        initial_page: parse_page(&cli.page),
    })
}

fn parse_page(value: &str) -> Page {
    match value {
        "favorites" => Page::Favorites,
        "dms" => Page::Dms,
        "channels" => Page::Channels,
        "files" => Page::Files,
        _ => Page::Notifications,
    }
}
