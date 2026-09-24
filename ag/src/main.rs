use ag::{
    Error, Result,
    config::{self, Paths},
    model::*,
    service::{self, Service},
    speech::{self, SpeechKind},
    store, terminal_text,
};
use clap::{Args, CommandFactory, Parser, Subcommand};
use configurable_cli::ConfigCommand;
use mcp_cli::{JsonEnvelope, JsonError};
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
    about = "Agent speech and shared images across your machines",
    arg_required_else_help = true
)]
struct Cli {
    /// YAML configuration ($AG_CONFIG or ~/.config/ag/config.yaml).
    #[arg(long, global = true)]
    config: Option<PathBuf>,
    /// JSON envelope; following emits one envelope per line.
    #[arg(long, global = true)]
    json: bool,
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
fn speech_line(host: &str, record: &SpeechRecord) -> String {
    terminal_text(&format!(
        "{} [{}] [{}] {}: {}",
        record.timestamp,
        host,
        record.kind,
        record
            .agent
            .as_deref()
            .or(record.session.as_deref())
            .unwrap_or("unknown"),
        record.text
    ))
}
fn finite_tts(service: &Service, selection: Selection, limit: usize, as_json: bool) -> Result<u8> {
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
            text(&speech_line(host, record))?;
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

fn follow(service: &Service, selection: Selection, lines: usize, as_json: bool) -> Result<u8> {
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
                            TailEvent::Speech { record, .. } if !as_json => text(&speech_line(&event.host, record)),
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
                TtsCommand::List(args) => finite_tts(&service, selection, args.limit, cli.json),
                TtsCommand::Tail {
                    lines,
                    no_follow: true,
                } => finite_tts(&service, selection, lines, cli.json),
                TtsCommand::Tail {
                    lines,
                    no_follow: false,
                } => follow(&service, selection, lines, cli.json),
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
