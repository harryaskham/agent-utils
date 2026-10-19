use ag::{
    Error, Result,
    config::{self, Paths},
    model::*,
    service::{self, Service},
    speech::{self, SpeechKind},
    store, terminal_text,
};
mod output;

use clap::{Args, ColorChoice, CommandFactory, Parser, Subcommand};
use configurable_cli::ConfigCommand;
use mcp_cli::{JsonEnvelope, JsonError};
use output::SpeechOutput;
use serde::Serialize;
use std::{
    fs::OpenOptions,
    io::{self, Write},
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Parser)]
#[command(
    name = "ag",
    version,
    about = "Agent speech, images, audio, choices and health across your machines",
    arg_required_else_help = true
)]
struct Cli {
    /// YAML configuration ($AG_CONFIG or ~/.config/ag/config.yaml).
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    /// JSON envelope; following emits one envelope per line.
    #[arg(long, global = true)]
    json: bool,
    /// Color human speech headers (auto honors NO_COLOR and TERM=dumb).
    #[arg(long, global = true, value_enum, default_value_t = ColorChoice::Auto)]
    color: ColorChoice,
    /// Select configured nodes (repeatable); default is all enabled nodes.
    #[arg(long = "host", global = true)]
    hosts: Vec<String>,
    /// Target this machine without SSH or fleet recursion.
    #[arg(long, global = true, conflicts_with = "hosts")]
    local: bool,
    /// Override the feed path on selected nodes (~/ expands on each node).
    #[arg(long, global = true)]
    tts_feed: Option<String>,
    /// Override the image archive on selected nodes.
    #[arg(long, global = true)]
    image_dir: Option<String>,
    /// Override the shared-audio archive on selected nodes.
    #[arg(long, global = true)]
    audio_dir: Option<String>,
    /// Override the runtime speech mute file on selected nodes.
    #[arg(long, global = true)]
    mute_state: Option<String>,
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand)]
enum Commands {
    /// List configured nodes and effective storage paths.
    Hosts,
    /// Read speech requests, independently of playback success.
    Tts {
        #[command(subcommand)]
        command: TtsCommand,
    },
    /// Open a fleet-wide image gallery (or list/pull/get registered images).
    Image {
        #[command(flatten)]
        options: GalleryArgs,
        #[command(subcommand)]
        command: Option<ImageCommand>,
    },
    /// Open a fleet-wide player for explicitly shared audio (or list/pull/get/play clips).
    Audio {
        #[command(flatten)]
        options: GalleryArgs,
        #[command(subcommand)]
        command: Option<AudioCommand>,
    },
    /// Sync every media pathway (images and shared audio) and regenerate both viewers.
    Sync {
        /// Only images (combine with --audio; neither selects all pathways).
        #[arg(long)]
        images: bool,
        /// Only shared audio.
        #[arg(long)]
        audio: bool,
        /// Read caches only; no SSH or rsync.
        #[arg(long)]
        offline: bool,
        /// Ask rsync to checksum files too, repairing same-size/mtime cache corruption.
        #[arg(long)]
        checksum: bool,
        /// Image cache directory (default gallery.cache_dir or ~/.cache/ag/images).
        #[arg(long)]
        image_cache_dir: Option<String>,
        /// Audio cache directory (default gallery.audio_cache_dir or ~/.cache/ag/audio).
        #[arg(long)]
        audio_cache_dir: Option<String>,
    },
    /// Answer pending agent questions across the fleet (TUI; list/answer for scripts).
    Choices {
        /// Background refresh interval for the TUI, in seconds.
        #[arg(long, default_value_t = 60)]
        interval: u64,
        #[command(subcommand)]
        command: Option<ChoicesCommand>,
    },
    /// Check each node: SSH/ag, Paratenic AHP, speech feed and gallery cache.
    Doctor,
    /// Serve a live local web dashboard of choices, health, speech, images and audio.
    Dash {
        /// Listener (default dash.bind, 127.0.0.1:7795). Wildcards still need the token.
        #[arg(long)]
        bind: Option<std::net::SocketAddr>,
        /// Public HTTP(S) origin, e.g. http://helsinki.miku-owl.ts.net:7795.
        #[arg(long)]
        public_origin: Option<String>,
        /// Persistent access token (created privately if missing; symlinks supported).
        #[arg(long)]
        token_file: Option<String>,
        /// Print the URL without opening a browser.
        #[arg(long)]
        no_open: bool,
        /// Skip periodic image pulls (serve the existing gallery cache only).
        #[arg(long)]
        no_images: bool,
        /// Skip periodic shared-audio pulls (serve the existing audio cache only).
        #[arg(long)]
        no_audio: bool,
        /// Disable the shared live speech collector.
        #[arg(long)]
        no_tts: bool,
        /// Recent speech lines per host when dash starts (0–1000).
        #[arg(long)]
        tts_lines: Option<usize>,
        /// Gallery cache directory (as for ag image).
        #[arg(long)]
        cache_dir: Option<String>,
        /// Audio cache directory (as for ag audio).
        #[arg(long)]
        audio_cache_dir: Option<String>,
        /// Choices/health refresh seconds (default dash.refresh_seconds).
        #[arg(long)]
        refresh: Option<u64>,
        /// Media (image + audio) sync seconds (default dash.image_refresh_seconds).
        #[arg(long)]
        image_refresh: Option<u64>,
    },
    /// Manage canonical YAML configuration (symlinks preserved).
    Config {
        #[command(subcommand)]
        command: Option<ConfigCommand>,
    },
    /// Serve finite read/config and confirmed speech-control tools over MCP stdio.
    Mcp {
        #[command(subcommand)]
        command: McpCommand,
    },
    /// List typed MCP contracts without network access.
    Tools,
    /// Invoke the same typed handler as MCP with JSON arguments.
    Call {
        tool: String,
        #[arg(default_value = "{}")]
        input: String,
    },
    /// Generate shell completions without loading configuration.
    Completions { shell: clap_complete::Shell },
    /// Private peer protocol. Does not load fleet configuration.
    #[command(hide = true)]
    Node {
        #[command(subcommand)]
        command: NodeCommand,
    },
}
#[derive(Subcommand)]
enum ChoicesCommand {
    /// Print pending questions grouped by node and agent.
    List {
        /// Include stale and non-chat entries with the reason they cannot be answered here.
        #[arg(long)]
        all: bool,
    },
    /// Answer one question through Paratenic (ids from `ag choices list --json`).
    Answer {
        #[arg(long = "node")]
        node: String,
        #[arg(long)]
        session: String,
        #[arg(long)]
        request: String,
        /// Option id, label or 1-based index (single question).
        #[arg(long)]
        option: Option<String>,
        /// Freeform/text reply (single question).
        #[arg(long)]
        text: Option<String>,
        /// Answers object keyed by question id, as JSON.
        #[arg(long)]
        answers: Option<String>,
        /// accept, decline or cancel.
        #[arg(long, default_value = "accept")]
        response: String,
        /// Refuse when the request changed since this revision was listed.
        #[arg(long)]
        revision: Option<String>,
    },
}
#[derive(Subcommand)]
enum McpCommand {
    Stdio,
}
#[derive(Args)]
struct ListArgs {
    #[arg(short = 'n', long, default_value_t = 20)]
    limit: usize,
}
#[derive(Args, Default)]
struct SpeechTypes {
    /// Select editor read-aloud.
    #[arg(long)]
    read: bool,
    /// Select assistant TTS.
    #[arg(long)]
    tts: bool,
    /// Select tool-batch narration.
    #[arg(long)]
    narrate: bool,
    /// Select spoken choices (without closing prompts).
    #[arg(long)]
    choices: bool,
}
impl SpeechTypes {
    fn kinds(&self) -> Vec<SpeechKind> {
        [
            (self.read, SpeechKind::Read),
            (self.tts, SpeechKind::Tts),
            (self.narrate, SpeechKind::Narrate),
            (self.choices, SpeechKind::Choices),
        ]
        .into_iter()
        .filter_map(|(selected, kind)| selected.then_some(kind))
        .collect()
    }
}
#[derive(Subcommand)]
enum TtsCommand {
    /// Mute selected types (default all) on selected nodes (default all enabled).
    Mute(SpeechTypes),
    /// Unmute selected types (default all); muted backlog is not replayed.
    Unmute(SpeechTypes),
    /// Show node-wide runtime mute policy, independent of session on/off settings.
    Status,
    /// Follow all selected feeds until Ctrl-C; reconnect using byte cursors.
    Tail {
        #[arg(short = 'n', long, default_value_t = 20)]
        lines: usize,
        /// Print the latest lines and exit instead of following.
        #[arg(long)]
        no_follow: bool,
    },
    /// Print a finite snapshot of recent requests.
    List(ListArgs),
}
#[derive(Args, Default)]
struct GalleryArgs {
    /// Local gallery cache; defaults to ~/.cache/ag/images (XDG_CACHE_HOME honored).
    #[arg(long)]
    cache_dir: Option<String>,
    /// Read cached images only; no SSH or rsync.
    #[arg(long)]
    offline: bool,
    /// Generate the gallery without launching a browser (also implied by --json).
    #[arg(long)]
    no_open: bool,
    /// Ask rsync to checksum files too, repairing same-size/mtime cache corruption.
    #[arg(long)]
    checksum: bool,
}
#[derive(Subcommand)]
enum ImageCommand {
    /// Open the fleet gallery; same as ag image without a subcommand.
    View(GalleryArgs),
    /// Incrementally cache all selected archives and write the gallery, without opening it.
    Pull(GalleryArgs),
    /// List newest image metadata across all selected nodes.
    List {
        #[arg(short = 'n', long, default_value_t = 100)]
        limit: usize,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Show metadata for an id from image list (select one node).
    Info { id: String },
    /// Download and checksum-verify an image. Never overwrites an existing file.
    Get {
        id: String,
        #[arg(short, long)]
        output: PathBuf,
    },
}
#[derive(Subcommand)]
enum AudioCommand {
    /// Open the fleet audio player; same as ag audio without a subcommand.
    View(GalleryArgs),
    /// Incrementally cache all selected audio archives and write the player, without opening it.
    Pull(GalleryArgs),
    /// List newest shared-audio metadata across all selected nodes.
    List {
        #[arg(short = 'n', long, default_value_t = 100)]
        limit: usize,
        #[arg(long)]
        agent: Option<String>,
    },
    /// Show metadata for an id from audio list (select one node).
    Info { id: String },
    /// Download and checksum-verify a clip. Never overwrites an existing file.
    Get {
        id: String,
        #[arg(short, long)]
        output: PathBuf,
    },
    /// Play a clip locally (from the audio cache, or fetched from one --host).
    Play {
        id: String,
        /// auto (default), pulse, sox or ffplay (CoreAudio).
        #[arg(long)]
        backend: Option<String>,
        /// Pulse server (default PI_AUDIO_SERVER, then PULSE_SERVER).
        #[arg(long)]
        server: Option<String>,
        /// Pulse sink / sox device (default PI_AUDIO_SINK, then PULSE_SINK).
        #[arg(long, alias = "device")]
        sink: Option<String>,
        /// Volume percent, 0–150.
        #[arg(long, default_value_t = 100)]
        volume: u32,
        /// Start offset in seconds.
        #[arg(long, default_value_t = 0.0)]
        start: f64,
        /// Audio cache directory to search first.
        #[arg(long)]
        cache_dir: Option<String>,
    },
}
#[derive(Subcommand)]
enum NodeCommand {
    TtsMute {
        #[arg(long)]
        path: Option<String>,
        #[arg(long, value_enum)]
        kind: Vec<SpeechKind>,
    },
    TtsUnmute {
        #[arg(long)]
        path: Option<String>,
        #[arg(long, value_enum)]
        kind: Vec<SpeechKind>,
    },
    TtsStatus {
        #[arg(long)]
        path: Option<String>,
    },
    TtsList {
        #[arg(long)]
        path: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: usize,
    },
    Tts {
        #[arg(long)]
        path: Option<String>,
        #[arg(long, default_value_t = 20)]
        lines: usize,
        #[arg(long)]
        follow: bool,
        #[arg(long)]
        cursor: Option<String>,
        #[arg(long, default_value_t = 500)]
        poll_ms: u64,
        #[arg(long)]
        watch_stdin: bool,
    },
    ImageList {
        #[arg(long)]
        root: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
        #[arg(long)]
        agent: Option<String>,
    },
    ImageInfo {
        #[arg(long)]
        root: Option<String>,
        #[arg(long)]
        id: String,
    },
    ImageRead {
        #[arg(long)]
        root: Option<String>,
        #[arg(long)]
        id: String,
    },
    AudioList {
        #[arg(long)]
        root: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
        #[arg(long)]
        agent: Option<String>,
    },
    AudioInfo {
        #[arg(long)]
        root: Option<String>,
        #[arg(long)]
        id: String,
    },
    AudioRead {
        #[arg(long)]
        root: Option<String>,
        #[arg(long)]
        id: String,
    },
}
fn raw_json(value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    let mut stdout = io::stdout().lock();
    stdout.write_all(&bytes)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}
fn json(value: impl Serialize) -> Result<()> {
    raw_json(&JsonEnvelope::success(value))
}
fn text(value: &str) -> Result<()> {
    let mut out = io::stdout().lock();
    writeln!(out, "{value}")?;
    out.flush()?;
    Ok(())
}
fn speech_entry(output: &SpeechOutput, host: &str, record: &SpeechRecord) -> Result<()> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(output.entry(host, record).as_bytes())?;
    stdout.flush()?;
    Ok(())
}
fn finite_tts(
    service: &Service,
    selection: Selection,
    limit: usize,
    as_json: bool,
    output: &SpeechOutput,
) -> Result<u8> {
    let result = service.tts_list(ListInput {
        selection,
        limit,
        agent: None,
    })?;
    let partial = result.hosts.iter().any(|h| h.error.is_some());
    if as_json {
        json(&result)?;
    } else {
        let mut records = vec![];
        for host in &result.hosts {
            if let Some(error) = &host.error {
                eprintln!(
                    "[{}] {}",
                    terminal_text(&host.host),
                    terminal_text(&error.message)
                );
            }
            if let Some(data) = &host.data {
                for warning in &data.warnings {
                    eprintln!("[{}] {}", terminal_text(&host.host), terminal_text(warning));
                }
                records.extend(data.records.iter().map(|r| (&host.host, r)));
            }
        }
        records.sort_by(|a, b| a.1.timestamp.cmp(&b.1.timestamp).then(a.0.cmp(b.0)));
        for (host, record) in records {
            speech_entry(output, host, record)?;
        }
    }
    Ok(if partial { 3 } else { 0 })
}
fn show_speech_control(result: FleetSpeechControl, as_json: bool) -> Result<u8> {
    let failed = result.hosts.iter().any(|host| host.error.is_some());
    if as_json {
        json(&result)?;
    } else {
        for host in result.hosts {
            if let Some(error) = host.error {
                eprintln!(
                    "[{}] {}{}",
                    terminal_text(&host.host),
                    terminal_text(&error.message),
                    if matches!(host.disposition, SpeechDisposition::Unconfirmed) {
                        "; policy write unconfirmed — it may have applied; run tts status to reconcile"
                    } else {
                        ""
                    }
                );
            }
            if let Some(data) = host.data {
                let kinds = SpeechKind::ALL
                    .into_iter()
                    .map(|kind| {
                        format!(
                            "/{}={}",
                            kind.name(),
                            if data.state.muted[&kind] {
                                "muted"
                            } else {
                                "unmuted"
                            }
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                text(&format!("[{}] {kinds}", terminal_text(&host.host)))?;
            }
        }
    }
    Ok(if failed { 3 } else { 0 })
}

fn follow(
    service: &Service,
    selection: Selection,
    lines: usize,
    as_json: bool,
    output: &SpeechOutput,
) -> Result<u8> {
    service.hosts(&selection)?;
    store::check_limit(lines)?;
    service.runtime.block_on(async {
        let cancel = CancellationToken::new();
        let (tx, mut rx) = mpsc::channel(64);
        let work = service.follow(selection, lines, tx, cancel.clone());
        tokio::pin!(work);
        let signal = tokio::signal::ctrl_c(); tokio::pin!(signal);
        let mut completed = false;
        let outcome = loop {
            tokio::select! {
                result = &mut work => { completed = true; break result; },
                _ = &mut signal => break Ok(()),
                next = rx.recv() => {
                    if let Some(event) = next {
                        let result = match &event.event {
                            TailEvent::Checkpoint { .. } => Ok(()),
                            TailEvent::Speech { record, .. } if !as_json => speech_entry(output, &event.host, record),
                            TailEvent::Status { state, message } if !as_json => { eprintln!("[{}] {}: {}", terminal_text(&event.host), terminal_text(state), terminal_text(message)); Ok(()) },
                            _ => json(&event),
                        };
                        if let Err(error) = result { break Err(error); }
                    }
                }
            }
        };
        cancel.cancel();
        // Joining ensures SSH children are killed/reaped before exiting.
        if !completed { let _ = work.await; }
        outcome.map(|_| 0)
    })
}

fn node(command: NodeCommand) -> Result<u8> {
    match command {
        NodeCommand::TtsMute { path, kind } => json(speech::set_muted(
            &Paths {
                tts_mute: path,
                ..Paths::default()
            }
            .mute()?,
            &kind,
            true,
        )?)?,
        NodeCommand::TtsUnmute { path, kind } => json(speech::set_muted(
            &Paths {
                tts_mute: path,
                ..Paths::default()
            }
            .mute()?,
            &kind,
            false,
        )?)?,
        NodeCommand::TtsStatus { path } => json(speech::read_state(
            &Paths {
                tts_mute: path,
                ..Paths::default()
            }
            .mute()?,
        )?)?,
        NodeCommand::TtsList { path, limit } => json(store::speech_list(
            &Paths {
                tts_feed: path,
                ..Paths::default()
            }
            .tts()?,
            limit,
        )?)?,
        NodeCommand::ImageList { root, limit, agent } => json(store::image_list(
            &Paths {
                image_dir: root,
                ..Paths::default()
            }
            .images()?,
            limit,
            agent.as_deref(),
        )?)?,
        NodeCommand::ImageInfo { root, id } => json(store::image_info(
            &Paths {
                image_dir: root,
                ..Paths::default()
            }
            .images()?,
            &id,
        )?)?,
        NodeCommand::ImageRead { root, id } => {
            let bytes = store::image_bytes(
                &Paths {
                    image_dir: root,
                    ..Paths::default()
                }
                .images()?,
                &id,
            )?;
            io::stdout().lock().write_all(&bytes)?;
        }
        NodeCommand::AudioList { root, limit, agent } => json(store::audio_list(
            &Paths {
                audio_dir: root,
                ..Paths::default()
            }
            .audio()?,
            limit,
            agent.as_deref(),
        )?)?,
        NodeCommand::AudioInfo { root, id } => json(store::audio_info(
            &Paths {
                audio_dir: root,
                ..Paths::default()
            }
            .audio()?,
            &id,
        )?)?,
        NodeCommand::AudioRead { root, id } => {
            let bytes = store::audio_bytes(
                &Paths {
                    audio_dir: root,
                    ..Paths::default()
                }
                .audio()?,
                &id,
            )?;
            io::stdout().lock().write_all(&bytes)?;
        }
        NodeCommand::Tts {
            path,
            lines,
            follow,
            cursor,
            poll_ms,
            watch_stdin,
        } => {
            if !(100..=60000).contains(&poll_ms) {
                return Err(Error::Invalid("poll-ms must be 100–60000".into()));
            }
            let path = Paths {
                tts_feed: path,
                ..Paths::default()
            }
            .tts()?;
            let mut cursor = cursor.map(|s| serde_json::from_str(&s)).transpose()?;
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?;
            if !follow {
                for event in store::TailReader::new(path, lines, cursor)?.poll()? {
                    raw_json(&event)?;
                }
            } else {
                runtime.block_on(async {
                    let cancel = CancellationToken::new();
                    let (tx, mut rx) = mpsc::channel(16);
                    let writer_cancel = cancel.clone();
                    let writer = tokio::spawn(async move {
                        while let Some(event) = rx.recv().await {
                            if let Err(error) = raw_json(&event) { writer_cancel.cancel(); return Err(error); }
                        }
                        Ok(())
                    });
                    let stdin_cancel = cancel.clone();
                    let stdin_watcher = watch_stdin.then(|| tokio::task::spawn_blocking(move || {
                        use std::{io::Read, os::fd::AsFd};
                        let mut stdin = io::stdin();
                        let mut byte = [0u8; 1];
                        while !stdin_cancel.is_cancelled() {
                            let mut fds = [nix::poll::PollFd::new(stdin.as_fd(), nix::poll::PollFlags::POLLIN)];
                            match nix::poll::poll(&mut fds, 100u16) {
                                Ok(0) => (),
                                Ok(_) => if stdin.read(&mut byte).unwrap_or(0) == 0 { stdin_cancel.cancel(); break; },
                                Err(nix::errno::Errno::EINTR) => (),
                                Err(_) => { stdin_cancel.cancel(); break; }
                            }
                        }
                    }));
                    let work = service::local_tail(path, lines, &mut cursor, poll_ms, &tx, &cancel);
                    let result = tokio::select! { value = work => value, _ = tokio::signal::ctrl_c() => Ok(()) };
                    cancel.cancel(); drop(tx);
                    if let Some(watcher) = stdin_watcher { let _ = watcher.await; }
                    let written = writer.await.map_err(|e| Error::Transport(e.to_string()))?;
                    result.and(written)
                })?;
            }
        }
    }
    Ok(0)
}

fn color_enabled(choice: ColorChoice) -> bool {
    use std::io::IsTerminal;
    match choice {
        ColorChoice::Always => true,
        ColorChoice::Never => false,
        ColorChoice::Auto => {
            io::stdout().is_terminal()
                && std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty())
                && std::env::var_os("TERM").is_none_or(|v| v != "dumb")
        }
    }
}
fn paint(color: bool, sgr: &str, text: &str) -> String {
    let text = terminal_text(text);
    if color {
        format!("\x1b[{sgr}m{text}\x1b[0m")
    } else {
        text
    }
}
fn print_choices(fleet: &ag::paratenic::FleetChoices, color: bool) -> Result<u8> {
    let mut out = String::new();
    let offline: Vec<_> = fleet
        .nodes
        .iter()
        .filter(|n| n.state == "offline")
        .map(|n| n.host.as_str())
        .collect();
    if !offline.is_empty() {
        eprintln!(
            "{}",
            paint(color, "2", &format!("offline: {}", offline.join(", ")))
        );
    }
    for node in &fleet.nodes {
        if node.state == "error" {
            if let Some(error) = &node.error {
                eprintln!("[{}] {}", terminal_text(&node.host), terminal_text(error));
            }
        }
        for agent in &node.agents {
            out.push_str(&format!(
                "{} {} {}\n",
                paint(color, "36", &format!("[{}]", node.host)),
                paint(color, "1", &agent.title),
                paint(color, "2", &agent.provider)
            ));
            for choice in &agent.choices {
                let mark = if choice.actionable {
                    paint(color, "33", "◆")
                } else {
                    paint(color, "2", "◇")
                };
                out.push_str(&format!(
                    "  {mark} {}\n",
                    terminal_text(
                        &choice
                            .title
                            .split_whitespace()
                            .collect::<Vec<_>>()
                            .join(" ")
                    )
                ));
                out.push_str(&paint(
                    color,
                    "2",
                    &format!(
                        "    --node {} --session {} --request {} --revision {}",
                        choice.host, choice.session, choice.request_id, choice.revision
                    ),
                ));
                out.push('\n');
                for question in &choice.questions {
                    if choice.questions.len() > 1 {
                        out.push_str(&format!(
                            "    {} ({})\n",
                            terminal_text(question.title.as_deref().unwrap_or(&question.message)),
                            question.id
                        ));
                    }
                    for (i, option) in question.options.iter().enumerate() {
                        out.push_str(&format!(
                            "    {} {}{}\n",
                            paint(color, "36", &(i + 1).to_string()),
                            terminal_text(&option.label),
                            if option.recommended {
                                paint(color, "32", " (recommended)")
                            } else {
                                String::new()
                            }
                        ));
                    }
                    if choice.questions.len() == 1
                        && (question.allow_freeform || question.kind == "text")
                    {
                        out.push_str(&paint(color, "2", "    --text \"…\" for a freeform reply"));
                        out.push('\n');
                    }
                }
                if choice.questions.len() > 1 {
                    let ids: Vec<_> = choice
                        .questions
                        .iter()
                        .map(|q| format!("\"{}\":…", q.id))
                        .collect();
                    out.push_str(&paint(
                        color,
                        "2",
                        &format!("    --answers '{{{}}}'", ids.join(",")),
                    ));
                    out.push('\n');
                }
                if let Some(reason) = &choice.stale_reason {
                    out.push_str(&format!("    {}\n", paint(color, "33", reason)));
                }
            }
        }
    }
    let reached = fleet.nodes.iter().filter(|n| n.state == "ok").count();
    let configured = fleet
        .nodes
        .iter()
        .filter(|n| matches!(n.state.as_str(), "ok" | "error" | "offline"))
        .count();
    let missing: Vec<_> = fleet
        .nodes
        .iter()
        .filter(|n| n.state == "unconfigured")
        .map(|n| n.host.as_str())
        .collect();
    out.push_str(&paint(
        color,
        "2",
        &format!(
            "{} waiting · {reached}/{configured} Paratenic hosts reached{}",
            fleet.actionable,
            if missing.is_empty() {
                String::new()
            } else {
                format!(" · no endpoint: {}", missing.join(", "))
            }
        ),
    ));
    text(&out)?;
    Ok(if fleet.nodes.iter().any(|n| n.state == "error") {
        3
    } else {
        0
    })
}
fn print_doctor(report: &ag::doctor::DoctorReport, color: bool) -> Result<u8> {
    use ag::doctor::Status;
    let sgr = |s: Status| match s {
        Status::Ok => "32",
        Status::Warn => "33",
        Status::Error => "31",
        Status::Skip | Status::Offline => "2",
    };
    let mut out = String::new();
    for node in &report.nodes {
        if node.status == Status::Offline {
            let why = node
                .checks
                .first()
                .map(|c| c.summary.trim_start_matches("offline · "))
                .unwrap_or("offline");
            out.push_str(&paint(
                color,
                "2",
                &format!("{} {}  offline · {why}", node.status.symbol(), node.host),
            ));
            out.push('\n');
            continue;
        }
        out.push_str(&format!(
            "{} {}\n",
            paint(color, sgr(node.status), node.status.symbol()),
            paint(color, "1", &node.host)
        ));
        for check in &node.checks {
            out.push_str(&format!(
                "  {} {:<10} {}\n",
                paint(color, sgr(check.status), check.status.symbol()),
                check.name,
                terminal_text(&check.summary)
            ));
        }
    }
    let c = &report.counts;
    out.push_str(&paint(
        color,
        "2",
        &format!(
            "{} nodes · {} ok · {} warning · {} error · {} offline · {} sessions waiting",
            report.nodes.len(),
            c.ok,
            c.warn,
            c.error,
            c.offline,
            c.input_needed_sessions
        ),
    ));
    text(&out)?;
    Ok(match report.status {
        Status::Error => 3,
        _ => 0,
    })
}

fn clock(ms: u64) -> String {
    let total = ms / 1000;
    let (h, m, s) = (total / 3600, total % 3600 / 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}
fn host_line(kind: &str, host: &str, state: &str, count: usize, warnings: &[String]) -> String {
    format!(
        "[{kind}] [{host}] {state} · {count} {}{}",
        if kind == "audio" { "clips" } else { "images" },
        if warnings.is_empty() {
            String::new()
        } else {
            format!(" · {}", warnings.join("; "))
        }
    )
}
fn merge_gallery_args(outer: GalleryArgs, inner: Option<GalleryArgs>) -> GalleryArgs {
    match inner {
        Some(inner) => GalleryArgs {
            cache_dir: inner.cache_dir.or(outer.cache_dir),
            offline: inner.offline || outer.offline,
            no_open: inner.no_open || outer.no_open,
            checksum: inner.checksum || outer.checksum,
        },
        None => outer,
    }
}
fn write_new_file(output: &std::path::Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(output)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(output);
        return Err(error.into());
    }
    Ok(())
}
fn audio_command(
    service: &Service,
    selection: Selection,
    options: GalleryArgs,
    command: Option<AudioCommand>,
    as_json: bool,
) -> Result<u8> {
    match command {
        None | Some(AudioCommand::View(_)) | Some(AudioCommand::Pull(_)) => {
            let pull_only = matches!(command, Some(AudioCommand::Pull(_)));
            let options = merge_gallery_args(
                options,
                match command {
                    Some(AudioCommand::View(inner) | AudioCommand::Pull(inner)) => Some(inner),
                    _ => None,
                },
            );
            let result = service.audio_gallery(ag::gallery::GalleryInput {
                selection,
                cache_dir: options.cache_dir,
                offline: options.offline,
                checksum: options.checksum,
                confirmed: true,
            })?;
            let partial = result.hosts.iter().any(|host| {
                host.state == "unavailable" || host.invalid > 0 || !host.warnings.is_empty()
            });
            if as_json {
                json(&result)?;
            } else {
                for host in &result.hosts {
                    eprintln!(
                        "{}",
                        terminal_text(&host_line(
                            "audio",
                            &host.host,
                            &host.state,
                            host.clips,
                            &host.warnings
                        ))
                    );
                }
                text(&terminal_text(&format!(
                    "{} audio clips · {} · {}\n{}",
                    result.clips,
                    clock(result.duration_ms),
                    if options.offline {
                        "cached / offline"
                    } else {
                        "local fleet snapshot"
                    },
                    result.index.display()
                )))?;
                if !pull_only && !options.no_open {
                    ag::gallery::open_viewer(&result.index)?;
                }
            }
            Ok(if partial { 3 } else { 0 })
        }
        Some(AudioCommand::List { limit, agent }) => {
            let result = service.audio_list(ListInput {
                selection,
                limit,
                agent,
            })?;
            let partial = result.hosts.iter().any(|h| h.error.is_some());
            if as_json {
                json(&result)?;
            } else {
                let mut records = vec![];
                for host in &result.hosts {
                    if let Some(error) = &host.error {
                        eprintln!(
                            "[{}] {}",
                            terminal_text(&host.host),
                            terminal_text(&error.message)
                        );
                    }
                    if let Some(data) = &host.data {
                        for w in &data.warnings {
                            eprintln!("[{}] {}", terminal_text(&host.host), terminal_text(w));
                        }
                        records.extend(data.records.iter().map(|r| (&host.host, r)));
                    }
                }
                records.sort_by(|a, b| b.1.timestamp.cmp(&a.1.timestamp).then(a.0.cmp(b.0)));
                for (host, record) in records {
                    let name = record.text("title").unwrap_or(record.label());
                    text(&terminal_text(&format!(
                        "{} [{}] {} {}{} ({}{} bytes)",
                        record.timestamp,
                        host,
                        record.agent,
                        record.id,
                        if name.is_empty() {
                            String::new()
                        } else {
                            format!(" · {name}")
                        },
                        record
                            .number("durationMs")
                            .map(|ms| format!("{} · ", clock(ms)))
                            .unwrap_or_default(),
                        record.bytes
                    )))?;
                }
            }
            Ok(if partial { 3 } else { 0 })
        }
        Some(AudioCommand::Info { id }) => {
            json(service.audio_info(AudioInput { selection, id })?)?;
            Ok(0)
        }
        Some(AudioCommand::Get { id, output }) => {
            let bytes = service.audio_bytes(AudioInput { selection, id })?;
            write_new_file(&output, &bytes)?;
            if as_json {
                json(serde_json::json!({"path":output,"bytes":bytes.len()}))?;
            } else {
                text(&terminal_text(&format!(
                    "{} ({} bytes)",
                    output.display(),
                    bytes.len()
                )))?;
            }
            Ok(0)
        }
        Some(AudioCommand::Play {
            id,
            backend,
            server,
            sink,
            volume,
            start,
            cache_dir,
        }) => {
            let hosts = service.hosts(&selection)?;
            let root = ag::gallery::media_cache_path(
                &service.config,
                MediaKind::Audio,
                cache_dir.or(options.cache_dir).as_ref(),
            )?;
            // Prefer a verified synced copy; otherwise fetch from one node.
            let cached = hosts.iter().find_map(|host| {
                let archive = root
                    .join("hosts")
                    .join(ag::gallery::host_key(MediaKind::Audio, host))
                    .join("archive");
                store::verify_media(&archive, &id, MediaKind::Audio)
                    .ok()
                    .map(|(path, record)| (path, record, format!("cache:{}", host.name)))
            });
            let mut _temp = None;
            let (path, record, source) = match cached {
                Some(found) => found,
                None => {
                    if hosts.len() != 1 {
                        return Err(Error::Invalid(
                            "clip is not in the local audio cache; run ag audio pull or select one --host to fetch it".into(),
                        ));
                    }
                    let input = AudioInput {
                        selection: selection.clone(),
                        id: id.clone(),
                    };
                    let record = service.audio_info(input.clone())?;
                    let bytes = service.audio_bytes(input)?;
                    let extension = std::path::Path::new(&id)
                        .extension()
                        .and_then(|e| e.to_str())
                        .filter(|e| e.chars().all(|c| c.is_ascii_alphanumeric()))
                        .unwrap_or("bin")
                        .to_owned();
                    let mut temp = tempfile::Builder::new()
                        .prefix("ag-audio-")
                        .suffix(&format!(".{extension}"))
                        .tempfile()?;
                    temp.write_all(&bytes)?;
                    temp.as_file().sync_all()?;
                    let path = temp.path().to_path_buf();
                    _temp = Some(temp);
                    (path, record, format!("fetched:{}", hosts[0].name))
                }
            };
            let label = record
                .text("title")
                .map(str::to_owned)
                .or_else(|| (!record.label().is_empty()).then(|| record.label().to_owned()))
                .unwrap_or_else(|| id.clone());
            if !as_json {
                eprintln!(
                    "{}",
                    terminal_text(&format!("▶ {label} · {source} · Ctrl-C stops"))
                );
            }
            let (output, completed) = service.runtime.block_on(ag::audio_play::play(
                &path,
                &label,
                &ag::audio_play::PlayOptions {
                    backend,
                    server,
                    sink,
                    volume,
                    start_seconds: start,
                },
            ))?;
            let receipt = ag::audio_play::PlayReceipt {
                id,
                source,
                output,
                completed,
            };
            if as_json {
                json(&receipt)?;
            } else {
                text(&terminal_text(&format!(
                    "{} {label} via {}{}{}",
                    if completed { "played" } else { "stopped" },
                    receipt.output.backend,
                    receipt
                        .output
                        .sink
                        .as_deref()
                        .map(|s| format!(" · sink {s}"))
                        .unwrap_or_default(),
                    receipt
                        .output
                        .server
                        .as_deref()
                        .map(|s| format!(" · server {s}"))
                        .unwrap_or_default()
                )))?;
            }
            Ok(0)
        }
    }
}

fn execute(cli: Cli) -> Result<u8> {
    if let Commands::Completions { shell } = cli.command {
        clap_complete::generate(shell, &mut Cli::command(), "ag", &mut io::stdout());
        return Ok(0);
    }
    if let Commands::Config { command } = cli.command {
        let output = config::manager()
            .execute(
                cli.config.as_deref(),
                command.unwrap_or(ConfigCommand::Show),
            )
            .map_err(|e| Error::Config(e.to_string()))?;
        if cli.json {
            json(output.json)?;
        } else {
            print!("{}", output.human);
        }
        return Ok(0);
    }
    if let Commands::Node { command } = cli.command {
        return node(command);
    }
    let mut config = config::load(cli.config.as_deref())?;
    if let Some(path) = cli.tts_feed {
        config.paths.tts_feed = Some(path.clone());
        for host in &mut config.hosts {
            host.paths.tts_feed = Some(path.clone());
        }
    }
    if let Some(path) = cli.image_dir {
        config.paths.image_dir = Some(path.clone());
        for host in &mut config.hosts {
            host.paths.image_dir = Some(path.clone());
        }
    }
    if let Some(path) = cli.audio_dir {
        config.paths.audio_dir = Some(path.clone());
        for host in &mut config.hosts {
            host.paths.audio_dir = Some(path.clone());
        }
    }
    if let Some(path) = cli.mute_state {
        config.paths.tts_mute = Some(path.clone());
        for host in &mut config.hosts {
            host.paths.tts_mute = Some(path.clone());
        }
    }
    let service = Service::new(config, cli.config)?;
    let selection = Selection {
        hosts: cli.hosts,
        local: cli.local,
    };
    match cli.command {
        Commands::Hosts => {
            let hosts = service.hosts(&selection)?;
            if cli.json {
                json(hosts)?;
            } else {
                for host in hosts {
                    text(&terminal_text(&format!(
                        "{}\t{}\t{}",
                        host.name,
                        if host.local {
                            "local".into()
                        } else {
                            format!(
                                "{}@{}:{}",
                                host.username.as_deref().unwrap_or("(ssh default)"),
                                host.address,
                                host.port
                            )
                        },
                        host.command
                    )))?;
                }
            }
        }
        Commands::Tts { command } => {
            let output = SpeechOutput::new(cli.color);
            return match command {
                TtsCommand::Mute(types) => show_speech_control(
                    service.speech_mute(SpeechControlInput {
                        selection,
                        kinds: types.kinds(),
                        confirmed: true,
                    })?,
                    cli.json,
                ),
                TtsCommand::Unmute(types) => show_speech_control(
                    service.speech_unmute(SpeechControlInput {
                        selection,
                        kinds: types.kinds(),
                        confirmed: true,
                    })?,
                    cli.json,
                ),
                TtsCommand::Status => {
                    show_speech_control(service.speech_status(selection)?, cli.json)
                }
                TtsCommand::List(args) => {
                    finite_tts(&service, selection, args.limit, cli.json, &output)
                }
                TtsCommand::Tail {
                    lines,
                    no_follow: true,
                } => finite_tts(&service, selection, lines, cli.json, &output),
                TtsCommand::Tail {
                    lines,
                    no_follow: false,
                } => follow(&service, selection, lines, cli.json, &output),
            };
        }
        Commands::Image { command, options } => match command {
            None | Some(ImageCommand::View(_)) | Some(ImageCommand::Pull(_)) => {
                let pull_only = matches!(command, Some(ImageCommand::Pull(_)));
                let options = match command {
                    Some(ImageCommand::View(inner) | ImageCommand::Pull(inner)) => GalleryArgs {
                        cache_dir: inner.cache_dir.or(options.cache_dir),
                        offline: inner.offline || options.offline,
                        no_open: inner.no_open || options.no_open,
                        checksum: inner.checksum || options.checksum,
                    },
                    _ => options,
                };
                let result = service.image_gallery(ag::gallery::GalleryInput {
                    selection,
                    cache_dir: options.cache_dir,
                    offline: options.offline,
                    checksum: options.checksum,
                    confirmed: true,
                })?;
                let partial = result.hosts.iter().any(|host| {
                    host.state == "unavailable" || host.invalid > 0 || !host.warnings.is_empty()
                });
                if cli.json {
                    json(&result)?;
                } else {
                    for host in &result.hosts {
                        eprintln!(
                            "{}",
                            terminal_text(&format!(
                                "[{}] {} · {} images{}",
                                host.host,
                                host.state,
                                host.images,
                                if host.warnings.is_empty() {
                                    String::new()
                                } else {
                                    format!(" · {}", host.warnings.join("; "))
                                }
                            ))
                        );
                    }
                    text(&terminal_text(&format!(
                        "{} images · {}\n{}",
                        result.images,
                        if options.offline {
                            "cached / offline"
                        } else {
                            "local fleet snapshot"
                        },
                        result.index.display()
                    )))?;
                    if !pull_only && !options.no_open {
                        ag::gallery::open_viewer(&result.index)?;
                    }
                }
                return Ok(if partial { 3 } else { 0 });
            }
            Some(ImageCommand::List { limit, agent }) => {
                let result = service.image_list(ListInput {
                    selection,
                    limit,
                    agent,
                })?;
                let partial = result.hosts.iter().any(|h| h.error.is_some());
                if cli.json {
                    json(&result)?;
                } else {
                    let mut records = vec![];
                    for host in &result.hosts {
                        if let Some(error) = &host.error {
                            eprintln!(
                                "[{}] {}",
                                terminal_text(&host.host),
                                terminal_text(&error.message)
                            );
                        }
                        if let Some(data) = &host.data {
                            for w in &data.warnings {
                                eprintln!("[{}] {}", terminal_text(&host.host), terminal_text(w));
                            }
                            records.extend(data.records.iter().map(|r| (&host.host, r)));
                        }
                    }
                    records.sort_by(|a, b| b.1.timestamp.cmp(&a.1.timestamp).then(a.0.cmp(b.0)));
                    for (host, record) in records {
                        text(&terminal_text(&format!(
                            "{} [{}] {} {} ({} bytes)",
                            record.timestamp, host, record.agent, record.id, record.bytes
                        )))?;
                    }
                }
                return Ok(if partial { 3 } else { 0 });
            }
            Some(ImageCommand::Info { id }) => {
                json(service.image_info(ImageInput { selection, id })?)?
            }
            Some(ImageCommand::Get { id, output }) => {
                let bytes = service.image_bytes(ImageInput { selection, id })?;
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(&output)?;
                if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
                    drop(file);
                    let _ = std::fs::remove_file(&output);
                    return Err(error.into());
                }
                if cli.json {
                    json(serde_json::json!({"path":output,"bytes":bytes.len()}))?;
                } else {
                    text(&terminal_text(&format!(
                        "{} ({} bytes)",
                        output.display(),
                        bytes.len()
                    )))?;
                }
            }
        },
        Commands::Audio { command, options } => {
            return audio_command(&service, selection, options, command, cli.json);
        }
        Commands::Sync {
            images,
            audio,
            offline,
            checksum,
            image_cache_dir,
            audio_cache_dir,
        } => {
            let kinds = [(images, MediaKind::Image), (audio, MediaKind::Audio)]
                .into_iter()
                .filter_map(|(selected, kind)| selected.then_some(kind))
                .collect();
            let receipt = service.sync(ag::gallery::SyncInput {
                selection,
                kinds,
                image_cache_dir,
                audio_cache_dir,
                offline,
                checksum,
                confirmed: true,
            })?;
            if cli.json {
                json(&receipt)?;
            } else {
                for (kind, error) in &receipt.errors {
                    eprintln!("[{kind}] {}", terminal_text(error));
                }
                let mode = if offline {
                    "cached / offline"
                } else {
                    "local fleet snapshot"
                };
                if let Some(r) = &receipt.images {
                    for h in &r.hosts {
                        eprintln!(
                            "{}",
                            terminal_text(&host_line(
                                "images",
                                &h.host,
                                &h.state,
                                h.images,
                                &h.warnings
                            ))
                        );
                    }
                    text(&terminal_text(&format!(
                        "{} images · {mode}\n{}",
                        r.images,
                        r.index.display()
                    )))?;
                }
                if let Some(r) = &receipt.audio {
                    for h in &r.hosts {
                        eprintln!(
                            "{}",
                            terminal_text(&host_line(
                                "audio",
                                &h.host,
                                &h.state,
                                h.clips,
                                &h.warnings
                            ))
                        );
                    }
                    text(&terminal_text(&format!(
                        "{} audio clips · {} · {mode}\n{}",
                        r.clips,
                        clock(r.duration_ms),
                        r.index.display()
                    )))?;
                }
            }
            return Ok(if receipt.partial() { 3 } else { 0 });
        }
        Commands::Choices { interval, command } => {
            return match command {
                None => {
                    if !(5..=3600).contains(&interval) {
                        return Err(Error::Invalid("--interval must be 5–3600 seconds".into()));
                    }
                    let targets = service.choice_targets(&selection)?;
                    service.runtime.block_on(ag::choices_tui::run(
                        service.config.clone(),
                        targets,
                        std::time::Duration::from_secs(interval),
                    ))?;
                    Ok(0)
                }
                Some(ChoicesCommand::List { all }) => {
                    let fleet = service.choices(ag::paratenic::ChoicesInput { selection, all })?;
                    if cli.json {
                        json(&fleet)?;
                        Ok(if fleet.nodes.iter().any(|n| n.state == "error") {
                            3
                        } else {
                            0
                        })
                    } else {
                        print_choices(&fleet, color_enabled(cli.color))
                    }
                }
                Some(ChoicesCommand::Answer {
                    node,
                    session,
                    request,
                    option,
                    text: reply,
                    answers,
                    response,
                    revision,
                }) => {
                    let answers = answers
                        .map(|a| {
                            serde_json::from_str::<
                                std::collections::BTreeMap<String, serde_json::Value>,
                            >(&a)
                        })
                        .transpose()?
                        .unwrap_or_default();
                    let receipt = service.answer(ag::paratenic::AnswerInput {
                        host: node,
                        session,
                        request_id: request,
                        response: Some(response),
                        answers,
                        option,
                        text: reply,
                        revision,
                        confirmed: true,
                    })?;
                    let accepted = matches!(receipt.state, ag::paratenic::AnswerState::Accepted);
                    if cli.json {
                        json(&receipt)?;
                    } else {
                        text(&terminal_text(
                            &format!(
                                "{:?}{}",
                                receipt.state,
                                receipt
                                    .reason
                                    .as_deref()
                                    .map(|r| format!(": {r}"))
                                    .unwrap_or_default()
                            )
                            .to_lowercase(),
                        ))?;
                    }
                    Ok(if accepted { 0 } else { 3 })
                }
            };
        }
        Commands::Doctor => {
            let report = service.doctor(ag::doctor::DoctorInput { selection })?;
            return if cli.json {
                json(&report)?;
                Ok(if report.status == ag::doctor::Status::Error {
                    3
                } else {
                    0
                })
            } else {
                print_doctor(&report, color_enabled(cli.color))
            };
        }
        Commands::Dash {
            bind,
            public_origin,
            token_file,
            no_open,
            no_images,
            no_audio,
            no_tts,
            tts_lines,
            cache_dir,
            audio_cache_dir,
            refresh,
            image_refresh,
        } => {
            let bind = match bind {
                Some(bind) => bind,
                None => service
                    .config
                    .dash
                    .bind
                    .parse()
                    .map_err(|_| Error::Config("dash.bind".into()))?,
            };
            let refresh = refresh.unwrap_or(service.config.dash.refresh_seconds);
            let image_refresh = image_refresh.unwrap_or(service.config.dash.image_refresh_seconds);
            if !(10..=86_400).contains(&refresh) || !(30..=86_400).contains(&image_refresh) {
                return Err(Error::Invalid(
                    "refresh 10–86400s, image refresh 30–86400s".into(),
                ));
            }
            let targets = service.paratenic_targets(&selection)?;
            let tts_lines = tts_lines.unwrap_or(service.config.dash.tts_lines);
            ag::store::check_limit(tts_lines)?;
            let options = ag::dash::DashOptions {
                selection,
                bind,
                public_origin: public_origin.or_else(|| service.config.dash.public_origin.clone()),
                token_file: token_file
                    .or_else(|| service.config.dash.token_file.clone())
                    .map(|p| config::expand_home(&p))
                    .transpose()?,
                refresh: std::time::Duration::from_secs(refresh),
                image_refresh: std::time::Duration::from_secs(image_refresh),
                images: !no_images,
                audio: !no_audio && service.config.dash.audio,
                tts: !no_tts && service.config.dash.tts,
                tts_lines,
                cache_dir,
                audio_cache_dir,
            };
            let as_json = cli.json;
            service.runtime.block_on(ag::dash::run(service.config.clone(), targets, options, |started| {
                if as_json {
                    let _ = json(serde_json::json!({"url": started.url, "address": started.address.to_string(), "token_file": started.token_file}));
                } else {
                    let _ = text(&format!("ag dash · {}\nCtrl-C to stop", started.url));
                    if let Some(path) = &started.token_file {
                        let _ = text(&format!("Access token: {} (append ?token=<token> on first visit)", terminal_text(&path.display().to_string())));
                    }
                }
                if !no_open && !as_json {
                    if let Err(error) = ag::gallery::open_viewer(std::path::Path::new(&started.url)) {
                        eprintln!("ag: {}", terminal_text(&error.to_string()));
                    }
                }
            }))?;
        }
        Commands::Tools => json(service::router().tool_metadata())?,
        Commands::Call { tool, input } => {
            if input.len() > MAX_RECORD_BYTES {
                return Err(Error::Limit("input exceeds 8 MiB".into()));
            }
            let result =
                service::router().call_tool(&service, &tool, serde_json::from_str(&input)?);
            let failed = result.is_error();
            raw_json(&result)?;
            return Ok(if failed { 1 } else { 0 });
        }
        Commands::Mcp { .. } => service::server()
            .serve_stdio(&service)
            .map_err(|e| Error::Transport(e.to_string()))?,
        _ => unreachable!(),
    }
    Ok(0)
}
fn main() {
    let cli = Cli::parse();
    let as_json = cli.json
        || matches!(
            cli.command,
            Commands::Node {
                command: NodeCommand::TtsList { .. }
                    | NodeCommand::TtsMute { .. }
                    | NodeCommand::TtsUnmute { .. }
                    | NodeCommand::TtsStatus { .. }
                    | NodeCommand::ImageList { .. }
                    | NodeCommand::ImageInfo { .. }
                    | NodeCommand::AudioList { .. }
                    | NodeCommand::AudioInfo { .. }
            } | Commands::Call { .. }
        );
    let code = match execute(cli) {
        Ok(code) => code,
        Err(Error::Io(e)) if e.kind() == io::ErrorKind::BrokenPipe => 0,
        Err(error) => {
            if as_json {
                let _ = raw_json(&JsonEnvelope::<serde_json::Value>::error(
                    JsonError::from_error(&error),
                ));
            } else {
                eprintln!("ag: {}", terminal_text(&error.to_string()));
            }
            1
        }
    };
    std::process::exit(code.into());
}
