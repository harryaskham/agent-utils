use std::collections::HashMap;
use std::fmt::Write as FmtWrite;
use std::io::{self, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use chrono::{DateTime, Datelike, Local, Utc};
use ratakittui::{
    Background, Border, Chrome, DrawFlush, EffectsSink, LifecycleTracker, Padding, RenderEffects,
    Shadow,
};
use ratatui::backend::{CrosstermBackend, TestBackend};
use ratatui::buffer::Buffer;
use ratatui::crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Widget, Wrap};
use ratatui::{Frame, Terminal};

use kittui::{CellRect, Direction as KittuiDirection, RendererKind, Rgba, Runtime, TerminalInfo};
use kittui_kitty::PlacementOptions;

use crate::cache::CacheStore;
use crate::client::{ClientHealth, ClientOptions, ClientSubscription, ClientUpdate};
use crate::config::{AlertMode, Config, ThemeName};
use crate::feed::{Feed, FeedTarget};
use crate::images::{self, ImageStore};
use crate::markdown::{extract_urls, preview, render_markdown, render_markdown_for};
use crate::markdown::{ImageKind, ImagePlacement, IMAGE_PLACEHOLDER};
use crate::model::{CacheState, Conversation, ConversationKind, Message, RefreshState, SlackFile};
use crate::slack::SlackService;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};

/// Palette for one named theme.
///
/// Slick renders both Ratatui text and Kitty chrome, so a theme carries the
/// text colours plus the hex gradients/rails the chrome rasterizer needs.
#[derive(Clone, Copy, Debug)]
struct Palette {
    accent: Color,
    header: Color,
    cyan: Color,
    green: Color,
    yellow: Color,
    red: Color,
    fg: Color,
    muted: Color,
    selection: Color,
    chrome_sidebar: (&'static str, &'static str, &'static str),
    chrome_content: (&'static str, &'static str, &'static str),
    chrome_detail: (&'static str, &'static str, &'static str),
    chrome_dark: (&'static str, &'static str, &'static str),
    chrome_header: (&'static str, &'static str),
    chrome_header_dark: (&'static str, &'static str),
}

const SLICK_PALETTE: Palette = Palette {
    accent: Color::Rgb(0x7c, 0x5c, 0xfc),
    header: Color::Rgb(0x61, 0x1f, 0x69),
    cyan: Color::Rgb(0x4d, 0xd9, 0xe8),
    green: Color::Rgb(0x5c, 0xd6, 0x91),
    yellow: Color::Rgb(0xf2, 0xc7, 0x66),
    red: Color::Rgb(0xef, 0x6a, 0x73),
    fg: Color::Rgb(0xe6, 0xe3, 0xeb),
    muted: Color::Rgb(0x99, 0x95, 0xa4),
    selection: Color::Rgb(0x31, 0x2a, 0x42),
    chrome_sidebar: ("#241229ff", "#17121bff", "#7c5cfcff"),
    chrome_content: ("#171820ff", "#101117ff", "#4dd9e8ff"),
    chrome_detail: ("#181621ff", "#101017ff", "#9d84ffff"),
    chrome_dark: ("#171820ff", "#111219ff", "#5a5c6aff"),
    chrome_header: ("#611f69ff", "#3f1447ff"),
    chrome_header_dark: ("#171820ff", "#111219ff"),
};

const NORD_PALETTE: Palette = Palette {
    accent: Color::Rgb(0x81, 0xa1, 0xc1),
    header: Color::Rgb(0x3b, 0x42, 0x52),
    cyan: Color::Rgb(0x88, 0xc0, 0xd0),
    green: Color::Rgb(0xa3, 0xbe, 0x8c),
    yellow: Color::Rgb(0xeb, 0xcb, 0x8b),
    red: Color::Rgb(0xbf, 0x61, 0x6a),
    fg: Color::Rgb(0xec, 0xef, 0xf4),
    muted: Color::Rgb(0x8f, 0x9a, 0xad),
    selection: Color::Rgb(0x3b, 0x42, 0x52),
    chrome_sidebar: ("#3b4252ff", "#2e3440ff", "#81a1c1ff"),
    chrome_content: ("#2e3440ff", "#272c36ff", "#88c0d0ff"),
    chrome_detail: ("#2e3440ff", "#272c36ff", "#b48eadff"),
    chrome_dark: ("#2e3440ff", "#272c36ff", "#4c566aff"),
    chrome_header: ("#4c566aff", "#3b4252ff"),
    chrome_header_dark: ("#2e3440ff", "#272c36ff"),
};

const SLATE_PALETTE: Palette = Palette {
    accent: Color::Rgb(0x7f, 0x9c, 0xc4),
    header: Color::Rgb(0x2b, 0x31, 0x3b),
    cyan: Color::Rgb(0x79, 0xb8, 0xc4),
    green: Color::Rgb(0x8f, 0xbc, 0x8f),
    yellow: Color::Rgb(0xd8, 0xc0, 0x84),
    red: Color::Rgb(0xc4, 0x7b, 0x7b),
    fg: Color::Rgb(0xe4, 0xe7, 0xec),
    muted: Color::Rgb(0x93, 0x9b, 0xa8),
    selection: Color::Rgb(0x33, 0x3a, 0x46),
    chrome_sidebar: ("#2b313bff", "#20242cff", "#7f9cc4ff"),
    chrome_content: ("#232830ff", "#1b1f26ff", "#79b8c4ff"),
    chrome_detail: ("#232830ff", "#1b1f26ff", "#a8b1c4ff"),
    chrome_dark: ("#232830ff", "#1b1f26ff", "#4b525eff"),
    chrome_header: ("#3a414dff", "#2b313bff"),
    chrome_header_dark: ("#232830ff", "#1b1f26ff"),
};

/// Active palette. Slick renders on one thread, so a simple global keeps the
/// existing colour constants readable at every call site.
static ACTIVE_THEME: AtomicU8 = AtomicU8::new(0);

fn set_active_theme(theme: ThemeName) {
    let index = match theme {
        ThemeName::Slick => 0,
        ThemeName::Nord => 1,
        ThemeName::Slate => 2,
    };
    ACTIVE_THEME.store(index, Ordering::Relaxed);
}

/// Palette for an explicit theme, independent of the process-global active
/// theme. Keeping this pure lets tests assert theme→palette mapping without
/// racing on `ACTIVE_THEME` (Rust runs tests in parallel threads, and any test
/// calling `apply_config` stores into that same global).
fn palette_for(theme: ThemeName) -> Palette {
    match theme {
        ThemeName::Nord => NORD_PALETTE,
        ThemeName::Slate => SLATE_PALETTE,
        ThemeName::Slick => SLICK_PALETTE,
    }
}

fn palette() -> Palette {
    palette_for(match ACTIVE_THEME.load(Ordering::Relaxed) {
        1 => ThemeName::Nord,
        2 => ThemeName::Slate,
        _ => ThemeName::Slick,
    })
}

#[allow(non_snake_case)]
fn PURPLE() -> Color {
    palette().accent
}
#[allow(non_snake_case)]
fn SLACK_PURPLE() -> Color {
    palette().header
}
#[allow(non_snake_case)]
fn CYAN() -> Color {
    palette().cyan
}
#[allow(non_snake_case)]
fn GREEN() -> Color {
    palette().green
}
#[allow(non_snake_case)]
fn YELLOW() -> Color {
    palette().yellow
}
#[allow(non_snake_case)]
fn RED() -> Color {
    palette().red
}
#[allow(non_snake_case)]
fn FG() -> Color {
    palette().fg
}
#[allow(non_snake_case)]
fn MUTED() -> Color {
    palette().muted
}
const SIDEBAR_DM_ROWS: usize = 12;
/// Floor for the configurable auto-refresh interval. Each cycle refreshes the
/// visible target, so a tighter loop would burn Slack rate limit for no
/// perceptible gain.
const MIN_AUTO_REFRESH_SECS: u64 = 15;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Page {
    #[default]
    Notifications,
    Feed,
    Favorites,
    Dms,
    Channels,
    Files,
}

impl Page {
    const ALL: [Self; 6] = [
        Self::Notifications,
        Self::Feed,
        Self::Favorites,
        Self::Dms,
        Self::Channels,
        Self::Files,
    ];

    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Notifications => "Activity",
            Self::Feed => "Feed",
            Self::Favorites => "Favorites",
            Self::Dms => "Direct messages",
            Self::Channels => "Channels",
            Self::Files => "Files",
        }
    }

    #[must_use]
    const fn icon(self) -> &'static str {
        match self {
            Self::Notifications => "◉",
            Self::Feed => "≋",
            Self::Favorites => "★",
            Self::Dms => "◌",
            Self::Channels => "#",
            Self::Files => "▱",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Focus {
    #[default]
    Sidebar,
    Content,
    Detail,
}

#[derive(Clone, Debug)]
enum HitAction {
    Page(Page),
    Conversation(String, ConversationKind),
    Notification(usize),
    FeedEntry(usize),
    Message(usize),
    File(usize),
    Focus(Focus),
}

#[derive(Clone, Debug)]
struct HitRegion {
    rect: Rect,
    action: HitAction,
}

/// Draggable pane divider.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Divider {
    /// Between the sidebar and the content pane.
    Sidebar,
    /// Between the file list and its Markdown detail pane.
    Detail,
}

/// One image to draw over reserved placeholder cells.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ImageRun {
    /// Column of the first reserved cell.
    x: u16,
    /// Row of the reserved cell.
    y: u16,
    /// Cell footprint: 1x2 for emoji, aspect-scaled block for attachments.
    cols: u16,
    rows: u16,
    /// Source URL, used as the placement identity.
    url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct LinkRun {
    x: u16,
    y: u16,
    text: String,
    url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ThreadView {
    conversation_id: String,
    root_ts: String,
}

#[derive(Clone, Debug)]
enum RefreshTarget {
    Notifications,
    Conversation(String),
    Files,
    Sidebar,
}

#[derive(Clone, Debug)]
enum WorkerCommand {
    Bootstrap,
    LoadConversation(String),
    LoadThread {
        conversation_id: String,
        thread_ts: String,
    },
    LoadFile(String),
    Refresh(RefreshTarget),
    Stop,
}

#[derive(Clone, Debug)]
enum WorkerEvent {
    Started(String),
    Updated(Box<CacheState>, String),
    Status(String),
    Health(ClientHealth),
    Failed(String),
    FallbackRequired(String),
    DaemonRecovered,
}

struct Worker {
    tx: Option<Sender<WorkerCommand>>,
    rx: Option<Receiver<WorkerEvent>>,
    client: Option<ClientSubscription>,
}

impl Worker {
    fn spawn(initial: CacheState, store: CacheStore, persist: bool) -> Self {
        let (command_tx, command_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();
        thread::spawn(move || {
            let mut state = initial;
            let service = SlackService::from_environment();
            while let Ok(mut command) = command_rx.recv() {
                // Coalesce bursts (mouse selection, key repeat, repeated
                // Ctrl-R) to the newest visible request. Slack I/O stays
                // single-flight and stale queued work never delays input.
                while let Ok(newer) = command_rx.try_recv() {
                    command = newer;
                }
                if matches!(command, WorkerCommand::Stop) {
                    break;
                }
                let label = command_label(&command);
                let _ = event_tx.send(WorkerEvent::Started(label.clone()));
                let result = match &service {
                    Ok(service) => run_worker_command(service, &mut state, &command),
                    Err(error) => Err(anyhow::anyhow!(error.to_string())),
                };
                match result {
                    Ok(()) => {
                        state.normalize();
                        state.saved_at = Some(CacheState::now());
                        let save_result = if persist { store.save(&state) } else { Ok(()) };
                        let status = save_result.map_or_else(
                            |error| format!("{label}; cache warning: {error}"),
                            |()| label.clone(),
                        );
                        // A throttled-but-recovered call still matters to the
                        // user: surface it rather than silently reporting success.
                        let status = crate::slack::take_notice()
                            .map_or(status, |notice| format!("{label}; {notice}"));
                        let _ =
                            event_tx.send(WorkerEvent::Updated(Box::new(state.clone()), status));
                    }
                    Err(error) => {
                        let _ = event_tx.send(WorkerEvent::Failed(format!("{label}: {error:#}")));
                    }
                }
            }
        });
        Self {
            tx: Some(command_tx),
            rx: Some(event_rx),
            client: None,
        }
    }

    fn spawn_client(options: ClientOptions) -> Self {
        Self {
            tx: None,
            rx: None,
            client: Some(ClientSubscription::spawn(options)),
        }
    }

    fn events(&self) -> Vec<WorkerEvent> {
        if let Some(rx) = &self.rx {
            return rx.try_iter().collect();
        }
        self.client.as_ref().map_or_else(Vec::new, |client| {
            client
                .rx
                .try_iter()
                .map(|update| match update {
                    ClientUpdate::State(state, status) => WorkerEvent::Updated(state, status),
                    ClientUpdate::Health(health) => WorkerEvent::Health(health),
                    ClientUpdate::Status(status) => WorkerEvent::Status(status),
                    ClientUpdate::Error(error) => WorkerEvent::Failed(error),
                    ClientUpdate::FallbackRequired(reason) => WorkerEvent::FallbackRequired(reason),
                    ClientUpdate::DaemonRecovered => WorkerEvent::DaemonRecovered,
                })
                .collect()
        })
    }

    fn request_client_refresh(&self, domain: String) -> bool {
        self.client
            .as_ref()
            .is_some_and(|client| client.request_refresh(domain))
    }

    fn send(&self, command: WorkerCommand) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(command);
        }
    }

    fn stop(&self) {
        self.send(WorkerCommand::Stop);
        if let Some(client) = &self.client {
            client.stop();
        }
    }
}

fn client_refresh_domain(command: &WorkerCommand) -> Option<String> {
    match command {
        WorkerCommand::Bootstrap | WorkerCommand::Refresh(RefreshTarget::Notifications) => {
            Some("notifications".into())
        }
        WorkerCommand::LoadConversation(id)
        | WorkerCommand::Refresh(RefreshTarget::Conversation(id)) => {
            Some(format!("conversation:{id}"))
        }
        WorkerCommand::LoadThread {
            conversation_id,
            thread_ts,
        } => Some(format!("thread:{conversation_id}:{thread_ts}")),
        WorkerCommand::LoadFile(id) => Some(format!("file-content:{id}")),
        WorkerCommand::Refresh(RefreshTarget::Files) => Some("files".into()),
        WorkerCommand::Refresh(RefreshTarget::Sidebar) => Some("sidebar".into()),
        WorkerCommand::Stop => None,
    }
}

fn command_label(command: &WorkerCommand) -> String {
    match command {
        WorkerCommand::Bootstrap => "Refreshing seven-day activity".into(),
        WorkerCommand::LoadConversation(_) => "Loading visible conversation".into(),
        WorkerCommand::LoadThread { .. } => "Loading thread replies".into(),
        WorkerCommand::LoadFile(_) => "Loading file content".into(),
        WorkerCommand::Refresh(RefreshTarget::Notifications) => {
            "Refreshing visible activity".into()
        }
        WorkerCommand::Refresh(RefreshTarget::Conversation(_)) => {
            "Refreshing visible messages".into()
        }
        WorkerCommand::Refresh(RefreshTarget::Files) => "Refreshing visible files".into(),
        WorkerCommand::Refresh(RefreshTarget::Sidebar) => "Refreshing DMs and channels".into(),
        WorkerCommand::Stop => "Stopping".into(),
    }
}

fn run_worker_command(
    service: &SlackService,
    state: &mut CacheState,
    command: &WorkerCommand,
) -> Result<()> {
    match command {
        WorkerCommand::Bootstrap => service.bootstrap(state),
        WorkerCommand::LoadConversation(id) => service.refresh_conversation(state, id),
        WorkerCommand::LoadThread {
            conversation_id,
            thread_ts,
        } => service.refresh_thread(state, conversation_id, thread_ts),
        WorkerCommand::LoadFile(id) => service.load_file_content(state, id),
        WorkerCommand::Refresh(target) => {
            service.refresh_sidebar(state)?;
            match target {
                RefreshTarget::Notifications => service.refresh_notifications(state),
                RefreshTarget::Conversation(id) => service.refresh_conversation(state, id),
                RefreshTarget::Files => service.refresh_files(state),
                RefreshTarget::Sidebar => Ok(()),
            }
        }
        WorkerCommand::Stop => Ok(()),
    }
}

struct Graphics {
    runtime: Runtime,
    tracker: LifecycleTracker,
    placed: HashMap<String, (u32, CellRect)>,
    placed_images: HashMap<String, (u32, CellRect)>,
}

impl Graphics {
    fn new() -> Result<Self> {
        let runtime = Runtime::builder()
            .terminal(TerminalInfo::detect())
            .renderer(RendererKind::Cpu)
            .build()
            .context("initialize Ratakittui graphics")?;
        Ok(Self {
            runtime,
            tracker: LifecycleTracker::new(),
            placed: HashMap::new(),
            placed_images: HashMap::new(),
        })
    }
}

pub struct App {
    pub state: CacheState,
    page: Page,
    focus: Focus,
    selected_notification: usize,
    selected_favorite: usize,
    selected_dm: usize,
    selected_channel: usize,
    selected_file: usize,
    content_scroll: u16,
    detail_scroll: u16,
    activity_offset: usize,
    overview_offset: usize,
    file_offset: usize,
    content_view_height: u16,
    content_view_width: u16,
    detail_view_height: u16,
    detail_view_width: u16,
    section_overview: bool,
    sidebar_offset: usize,
    sidebar_width: u16,
    detail_percent: u16,
    viewport_width: u16,
    config: Config,
    config_path: PathBuf,
    images: ImageStore,
    image_runs: Vec<ImageRun>,
    image_client: Option<reqwest::blocking::Client>,
    cell_size: (u16, u16),
    feed: Feed,
    selected_feed: usize,
    feed_offset: usize,
    dragging: Option<Divider>,
    sidebar_visible: bool,
    fullscreen_content: bool,
    osc8_links: bool,
    filter: String,
    filter_mode: bool,
    show_help: bool,
    should_quit: bool,
    busy: bool,
    busy_since: Option<Instant>,
    status: String,
    last_error: Option<String>,
    hits: Vec<HitRegion>,
    link_runs: Vec<LinkRun>,
    selected_message: usize,
    thread_stack: Vec<ThreadView>,
    worker: Option<Worker>,
    smart_client: bool,
    fallback_worker: Option<Worker>,
    fallback_store: Option<CacheStore>,
    fallback_persist: bool,
    client_health: Option<ClientHealth>,
    pending_g: bool,
}

impl App {
    #[must_use]
    pub fn demo(state: CacheState) -> Self {
        Self::new(state, None, false)
    }

    fn live(state: CacheState, store: CacheStore) -> Self {
        let worker = Worker::spawn(state.clone(), store, true);
        let app = Self::new(state, Some(worker), false);
        if let Some(worker) = &app.worker {
            worker.send(WorkerCommand::Bootstrap);
        }
        app
    }

    fn client(state: CacheState, options: ClientOptions) -> Self {
        let fallback_store = options.cache_store.clone();
        let fallback_persist = options.use_cache;
        let mut app = Self::new(state, Some(Worker::spawn_client(options)), true);
        app.fallback_store = Some(fallback_store);
        app.fallback_persist = fallback_persist;
        app
    }

    fn new(state: CacheState, worker: Option<Worker>, smart_client: bool) -> Self {
        Self {
            status: if state.saved_at.is_some() {
                "cached".into()
            } else {
                "starting".into()
            },
            state,
            page: Page::Notifications,
            focus: Focus::Sidebar,
            selected_notification: 0,
            selected_favorite: 0,
            selected_dm: 0,
            selected_channel: 0,
            selected_file: 0,
            content_scroll: 0,
            detail_scroll: 0,
            activity_offset: 0,
            overview_offset: 0,
            file_offset: 0,
            content_view_height: 1,
            content_view_width: 1,
            detail_view_height: 1,
            detail_view_width: 1,
            section_overview: false,
            sidebar_offset: 0,
            sidebar_width: 32,
            detail_percent: 64,
            viewport_width: 120,
            config: Config::default(),
            config_path: Config::default_path(),
            images: ImageStore::new(images::default_root(&CacheStore::default_path())),
            image_runs: Vec::new(),
            image_client: None,
            cell_size: (8, 16),
            feed: Feed::default(),
            selected_feed: 0,
            feed_offset: 0,
            dragging: None,
            sidebar_visible: true,
            fullscreen_content: false,
            osc8_links: false,
            filter: String::new(),
            filter_mode: false,
            show_help: false,
            should_quit: false,
            busy: false,
            busy_since: None,
            last_error: None,
            hits: Vec::new(),
            link_runs: Vec::new(),
            selected_message: 0,
            thread_stack: Vec::new(),
            worker,
            smart_client,
            fallback_worker: None,
            fallback_store: None,
            fallback_persist: true,
            client_health: None,
            pending_g: false,
        }
    }

    fn drain_worker(&mut self) -> bool {
        // Fallback results apply first. A daemon-recovery event collected in
        // the same drain must win instead of being overwritten by a late
        // embedded-collector snapshot.
        let mut events: Vec<(WorkerEvent, bool)> =
            self.fallback_worker
                .as_ref()
                .map_or_else(Vec::new, |worker| {
                    worker
                        .events()
                        .into_iter()
                        .map(|event| (event, true))
                        .collect()
                });
        if let Some(worker) = &self.worker {
            events.extend(worker.events().into_iter().map(|event| (event, false)));
        }
        let changed = !events.is_empty();
        for (event, from_fallback) in events {
            match event {
                WorkerEvent::Started(status) => {
                    self.busy = true;
                    self.busy_since.get_or_insert_with(Instant::now);
                    self.status = if from_fallback {
                        format!("fallback · {status}")
                    } else {
                        status
                    };
                    self.last_error = None;
                }
                WorkerEvent::Updated(state, status) => {
                    let catch_up = self.smart_client
                        && self
                            .state
                            .refreshed_at("notifications")
                            .is_none_or(|refreshed| {
                                CacheState::now().saturating_sub(refreshed) > 5 * 60
                            });
                    self.state = *state;
                    self.busy = false;
                    self.busy_since = None;
                    self.status = if from_fallback {
                        format!("fallback · {status}")
                    } else {
                        status
                    };
                    self.last_error = None;
                    self.apply_local_favorites();
                    self.apply_read_markers();
                    if catch_up {
                        self.feed.seed(&self.state);
                    } else {
                        self.feed.ingest(&self.state, Instant::now());
                    }
                    self.clamp_selection();
                    if matches!(self.page, Page::Favorites | Page::Dms | Page::Channels)
                        && !self.section_overview
                    {
                        self.content_scroll = self.max_content_scroll();
                    }
                }
                WorkerEvent::Status(status) => {
                    self.status = status;
                    self.last_error = None;
                }
                WorkerEvent::Health(health) => {
                    self.client_health = Some(health);
                }
                WorkerEvent::Failed(error) => {
                    self.busy = false;
                    self.busy_since = None;
                    self.last_error = Some(error);
                    self.status = if from_fallback {
                        "fallback · refresh failed".into()
                    } else if self.smart_client {
                        "client · source unavailable".into()
                    } else {
                        "cached · refresh failed".into()
                    };
                }
                WorkerEvent::FallbackRequired(reason) => self.start_fallback(&reason),
                WorkerEvent::DaemonRecovered => self.stop_fallback(),
            }
        }
        if changed {
            self.mark_open_conversation_read();
        }
        changed
    }

    fn start_fallback(&mut self, reason: &str) {
        if self.fallback_worker.is_some() {
            return;
        }
        let Some(store) = self.fallback_store.clone() else {
            self.last_error = Some("fallback cache store unavailable".into());
            return;
        };
        let worker = Worker::spawn(self.state.clone(), store, self.fallback_persist);
        worker.send(WorkerCommand::Bootstrap);
        self.fallback_worker = Some(worker);
        self.status = reason.to_string();
        self.last_error = None;
        self.busy = true;
        self.busy_since = Some(Instant::now());
    }

    fn stop_fallback(&mut self) {
        if let Some(worker) = self.fallback_worker.take() {
            worker.stop();
        }
        self.busy = false;
        self.busy_since = None;
    }

    fn clamp_selection(&mut self) {
        self.selected_notification =
            clamp_index(self.selected_notification, self.state.notifications.len());
        self.selected_favorite =
            clamp_index(self.selected_favorite, self.filtered_favorites().len());
        self.selected_dm = clamp_index(self.selected_dm, self.filtered_conversations(true).len());
        self.selected_channel = clamp_index(
            self.selected_channel,
            self.filtered_conversations(false).len(),
        );
        self.selected_file = clamp_index(self.selected_file, self.filtered_files().len());
        self.ensure_selected_visible();
        self.content_scroll = self.content_scroll.min(self.max_content_scroll());
        self.detail_scroll = self.detail_scroll.min(self.max_detail_scroll());
    }

    fn filtered_conversations(&self, dms: bool) -> Vec<&Conversation> {
        let needle = self.filter.to_lowercase();
        self.state
            .conversations
            .iter()
            .filter(|conversation| conversation.kind.is_dm() == dms)
            .filter(|conversation| {
                needle.is_empty()
                    || conversation.name.to_lowercase().contains(&needle)
                    || conversation.topic.to_lowercase().contains(&needle)
            })
            .collect()
    }

    /// DMs ordered by genuine latest activity, excluding conversations whose
    /// only traffic is file/canvas comment threads (Slack surfaces those as
    /// unnamed DM shells with no cached human message).
    fn active_dms(&self) -> Vec<&Conversation> {
        let mut dms: Vec<&Conversation> = self
            .filtered_conversations(true)
            .into_iter()
            .filter(|conversation| {
                conversation.activity_ts() > 0.0
                    || conversation.unread_count > 0
                    || self.state.messages.contains_key(&conversation.id)
            })
            .collect();
        dms.sort_by(|left, right| {
            right
                .unread_count
                .cmp(&left.unread_count)
                .then_with(|| {
                    right
                        .activity_ts()
                        .partial_cmp(&left.activity_ts())
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        dms
    }

    /// Channels grouped for the sidebar: favourites first, then channels with
    /// recent activity involving the user, then everything else.
    fn sidebar_channel_sections(&self) -> Vec<(String, Vec<Conversation>)> {
        let mut favourites = Vec::new();
        let mut active = Vec::new();
        let mut inactive = Vec::new();
        for conversation in self.filtered_conversations(false) {
            let recent = conversation.unread_count > 0
                || conversation.mention_count > 0
                || self.state.self_activity.contains_key(&conversation.id);
            if conversation.is_favorite {
                favourites.push(conversation.clone());
            } else if recent {
                active.push(conversation.clone());
            } else {
                inactive.push(conversation.clone());
            }
        }
        vec![
            ("Favourites".to_string(), favourites),
            ("Active".to_string(), active),
            ("Inactive".to_string(), inactive),
        ]
    }

    fn filtered_favorites(&self) -> Vec<&Conversation> {
        let needle = self.filter.to_lowercase();
        self.state
            .conversations
            .iter()
            .filter(|conversation| conversation.is_favorite)
            .filter(|conversation| {
                needle.is_empty()
                    || conversation.name.to_lowercase().contains(&needle)
                    || conversation.topic.to_lowercase().contains(&needle)
            })
            .collect()
    }

    fn filtered_files(&self) -> Vec<&SlackFile> {
        let needle = self.filter.to_lowercase();
        self.state
            .files
            .iter()
            .filter(|file| {
                needle.is_empty()
                    || file.title.to_lowercase().contains(&needle)
                    || file.author.to_lowercase().contains(&needle)
                    || file.file_type.to_lowercase().contains(&needle)
            })
            .collect()
    }

    fn selected_conversation(&self) -> Option<&Conversation> {
        match self.page {
            Page::Favorites => self
                .filtered_favorites()
                .get(self.selected_favorite)
                .copied(),
            Page::Dms => self
                .filtered_conversations(true)
                .get(self.selected_dm)
                .copied(),
            Page::Channels => self
                .filtered_conversations(false)
                .get(self.selected_channel)
                .copied(),
            Page::Notifications => self
                .state
                .notifications
                .get(self.selected_notification)
                .and_then(|notification| self.state.conversation(&notification.conversation_id)),
            Page::Feed => {
                self.feed
                    .entries()
                    .get(self.selected_feed)
                    .and_then(|entry| match &entry.target {
                        FeedTarget::Conversation { id, .. } => self.state.conversation(id),
                        FeedTarget::File { .. } => None,
                    })
            }
            Page::Files => None,
        }
    }

    fn selected_file(&self) -> Option<&SlackFile> {
        self.filtered_files().get(self.selected_file).copied()
    }

    /// Open the selected feed line's underlying conversation, thread or file.
    fn open_feed_entry(&mut self) {
        let Some(entry) = self.feed.entries().get(self.selected_feed).cloned() else {
            return;
        };
        match entry.target {
            FeedTarget::Conversation { id, kind } => self.select_conversation(id, kind),
            FeedTarget::File { id } => {
                self.page = Page::Files;
                if let Some(position) = self.filtered_files().iter().position(|file| file.id == id)
                {
                    self.selected_file = position;
                }
                self.focus = Focus::Detail;
                self.detail_scroll = 0;
                self.request_selected();
            }
        }
    }

    fn request_selected(&mut self) {
        match self.page {
            Page::Notifications => {
                if let Some(notification) = self.state.notifications.get(self.selected_notification)
                {
                    let id = notification.conversation_id.clone();
                    let kind = notification.kind;
                    self.select_conversation(id, kind);
                }
            }
            Page::Feed => self.open_feed_entry(),
            Page::Favorites | Page::Dms | Page::Channels => {
                if self.in_message_view() && self.focus != Focus::Sidebar {
                    self.open_selected_thread();
                    return;
                }
                if let Some(conversation) = self.selected_conversation() {
                    let id = conversation.id.clone();
                    if self.state.messages.get(&id).is_none_or(Vec::is_empty) {
                        self.send(WorkerCommand::LoadConversation(id));
                    }
                    self.section_overview = false;
                    self.selected_message = self.visible_messages().len().saturating_sub(1);
                    self.focus = Focus::Content;
                    self.content_scroll = self.max_content_scroll();
                }
            }
            Page::Files => {
                if let Some(file) = self.selected_file() {
                    let id = file.id.clone();
                    if file.content_markdown.is_empty() || file.content_status == "not_loaded" {
                        self.send(WorkerCommand::LoadFile(id));
                    }
                    self.focus = Focus::Detail;
                }
            }
        }
    }

    fn select_conversation(&mut self, id: String, kind: ConversationKind) {
        let dms = kind.is_dm();
        self.page = if dms { Page::Dms } else { Page::Channels };
        let conversations = self.filtered_conversations(dms);
        let index = conversations
            .iter()
            .position(|item| item.id == id)
            .unwrap_or(0);
        if dms {
            self.selected_dm = index;
        } else {
            self.selected_channel = index;
        }
        self.section_overview = false;
        self.thread_stack.clear();
        self.focus = Focus::Content;
        self.selected_message = self
            .state
            .messages
            .get(&id)
            .map_or(0, |messages| messages.len().saturating_sub(1));
        self.content_scroll = self.max_content_scroll();
        if self.state.messages.get(&id).is_none_or(Vec::is_empty) {
            self.send(WorkerCommand::LoadConversation(id));
        } else {
            // Content is already cached, so it is on screen now: this counts as
            // read. The lazy-load path marks read when its messages arrive.
            self.mark_conversation_read(&id);
        }
    }

    fn send(&mut self, command: WorkerCommand) {
        if self.smart_client {
            if let Some(worker) = &self.fallback_worker {
                worker.send(command);
                self.busy = true;
                self.busy_since.get_or_insert_with(Instant::now);
            } else if client_refresh_domain(&command).is_some_and(|domain| {
                self.worker
                    .as_ref()
                    .is_some_and(|worker| worker.request_client_refresh(domain))
            }) {
                self.status = "client · daemon refresh queued".into();
                self.last_error = None;
            } else {
                self.status = "client · waiting for cache/daemon".into();
                self.last_error = None;
            }
            return;
        }
        if let Some(worker) = &self.worker {
            worker.send(command);
            self.busy = true;
            self.busy_since.get_or_insert_with(Instant::now);
        } else {
            self.status = "demo mode · network disabled".into();
        }
    }

    fn refresh_visible(&mut self) {
        let target = match self.page {
            Page::Notifications | Page::Feed => RefreshTarget::Notifications,
            Page::Favorites | Page::Dms | Page::Channels if self.section_overview => {
                RefreshTarget::Sidebar
            }
            Page::Favorites | Page::Dms | Page::Channels => self
                .selected_conversation()
                .map_or(RefreshTarget::Sidebar, |conversation| {
                    RefreshTarget::Conversation(conversation.id.clone())
                }),
            Page::Files => RefreshTarget::Files,
        };
        self.send(WorkerCommand::Refresh(target));
    }

    /// Interval between automatic background refreshes, or `None` when the
    /// user has opted out (`refresh-interval-secs: 0`).
    ///
    /// Clamped to a floor because each cycle costs Slack calls and the client
    /// must not be able to throttle the operator's token through config alone.
    fn auto_refresh_interval(&self) -> Option<Duration> {
        match self.config.refresh_interval_secs {
            0 => None,
            seconds => Some(Duration::from_secs(seconds.max(MIN_AUTO_REFRESH_SECS))),
        }
    }

    /// Fire one automatic refresh cycle if the worker is free.
    ///
    /// Returns whether work was dispatched. Skipped while `busy` so a slow
    /// Slack call can never accumulate a queue of stale refreshes, and a no-op
    /// in demo mode because `send` has no worker there.
    fn auto_refresh(&mut self) -> bool {
        if self.busy {
            return false;
        }
        if self.smart_client {
            if self.fallback_worker.is_none() {
                return false;
            }
        } else if self.worker.is_none() {
            return false;
        }
        self.refresh_visible();
        true
    }

    fn handle_key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            return;
        }
        if self.filter_mode {
            match key.code {
                KeyCode::Esc | KeyCode::Enter => self.filter_mode = false,
                KeyCode::Backspace => {
                    let _ = self.filter.pop();
                    self.clamp_selection();
                }
                KeyCode::Char(character) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    self.filter.push(character);
                    self.clamp_selection();
                }
                _ => {}
            }
            return;
        }
        if self.show_help {
            if matches!(key.code, KeyCode::Esc | KeyCode::Char('?') | KeyCode::Enter) {
                self.show_help = false;
            }
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) {
            match key.code {
                KeyCode::Char('c') => self.should_quit = true,
                KeyCode::Char('r') => self.refresh_visible(),
                KeyCode::Char('u') => self.scroll_up(8),
                KeyCode::Char('d') => self.scroll_down(8),
                _ => {}
            }
            return;
        }
        let was_pending_g = self.pending_g;
        self.pending_g = false;
        match key.code {
            KeyCode::Char('q') => {
                if self.thread_stack.pop().is_some() {
                    self.content_scroll = self.max_content_scroll();
                } else if self.fullscreen_content {
                    self.fullscreen_content = false;
                } else if !self.sidebar_visible {
                    self.sidebar_visible = true;
                    self.focus = Focus::Sidebar;
                } else if matches!(self.page, Page::Favorites | Page::Dms | Page::Channels)
                    && !self.section_overview
                {
                    self.section_overview = true;
                    self.focus = Focus::Sidebar;
                }
            }
            KeyCode::Char('?') => self.show_help = true,
            KeyCode::Char('/') => self.filter_mode = true,
            KeyCode::Char('s') => self.toggle_local_favorite(),
            KeyCode::Char('T') => self.cycle_theme(),
            KeyCode::Char('\\') => self.toggle_sidebar(),
            KeyCode::Char('f') => self.toggle_fullscreen(),
            KeyCode::Char('g') if was_pending_g => self.go_top(),
            KeyCode::Char('g') => self.pending_g = true,
            KeyCode::Char('G') => self.go_bottom(),
            KeyCode::Char('1') => self.set_page(Page::Notifications),
            KeyCode::Char('2') => self.set_page(Page::Dms),
            KeyCode::Char('3') => self.set_page(Page::Channels),
            KeyCode::Char('4') => self.set_page(Page::Files),
            KeyCode::Char('5') => self.set_page(Page::Favorites),
            KeyCode::Char('6') => self.set_page(Page::Feed),
            KeyCode::Tab => self.cycle_focus(true),
            KeyCode::BackTab => self.cycle_focus(false),
            KeyCode::Up | KeyCode::Char('k') => self.move_selection(-1),
            KeyCode::Down | KeyCode::Char('j') => self.move_selection(1),
            KeyCode::Left | KeyCode::Char('h') => self.previous_page(),
            KeyCode::Right | KeyCode::Char('l') => self.next_page(),
            KeyCode::Enter => self.request_selected(),
            KeyCode::PageUp => self.scroll_up(12),
            KeyCode::PageDown | KeyCode::Char(' ') => self.scroll_down(12),
            KeyCode::Home | KeyCode::Char('0') => self.set_scroll(0),
            KeyCode::Esc if !self.filter.is_empty() => {
                self.filter.clear();
                self.clamp_selection();
            }
            _ => {}
        }
    }

    fn go_top(&mut self) {
        if self.navigates_list() {
            match self.page {
                Page::Notifications => self.selected_notification = 0,
                Page::Feed => self.selected_feed = 0,
                Page::Favorites => self.selected_favorite = 0,
                Page::Dms => self.selected_dm = 0,
                Page::Channels => self.selected_channel = 0,
                Page::Files => self.selected_file = 0,
            }
            self.activity_offset = 0;
            self.overview_offset = 0;
            self.file_offset = 0;
        }
        self.set_scroll(0);
    }

    fn go_bottom(&mut self) {
        if self.navigates_list() {
            match self.page {
                Page::Notifications => {
                    self.selected_notification = self.state.notifications.len().saturating_sub(1);
                }
                Page::Feed => {
                    self.selected_feed = self.feed.entries().len().saturating_sub(1);
                }
                Page::Favorites => {
                    self.selected_favorite = self.filtered_favorites().len().saturating_sub(1);
                }
                Page::Dms => {
                    self.selected_dm = self.filtered_conversations(true).len().saturating_sub(1);
                }
                Page::Channels => {
                    self.selected_channel =
                        self.filtered_conversations(false).len().saturating_sub(1);
                }
                Page::Files => self.selected_file = self.filtered_files().len().saturating_sub(1),
            }
            self.ensure_selected_visible();
        } else {
            let maximum = if self.focus == Focus::Detail {
                self.max_detail_scroll()
            } else {
                self.max_content_scroll()
            };
            self.set_scroll(maximum);
        }
    }

    fn toggle_sidebar(&mut self) {
        self.fullscreen_content = false;
        self.sidebar_visible = !self.sidebar_visible;
        self.focus = if self.sidebar_visible {
            Focus::Sidebar
        } else if self.page == Page::Files {
            Focus::Detail
        } else {
            Focus::Content
        };
    }

    fn toggle_fullscreen(&mut self) {
        let has_markdown = self.page == Page::Files
            || matches!(self.page, Page::Favorites | Page::Dms | Page::Channels)
                && !self.section_overview;
        if !has_markdown {
            return;
        }
        self.fullscreen_content = !self.fullscreen_content;
        self.focus = if self.page == Page::Files {
            Focus::Detail
        } else {
            Focus::Content
        };
    }

    fn set_page(&mut self, page: Page) {
        self.page = page;
        self.content_scroll = 0;
        self.detail_scroll = 0;
        self.activity_offset = 0;
        self.overview_offset = 0;
        self.file_offset = 0;
        self.section_overview = matches!(page, Page::Favorites | Page::Dms | Page::Channels);
        self.thread_stack.clear();
        self.selected_message = 0;
        self.focus = Focus::Sidebar;
        if page == Page::Files && self.state.files.is_empty() {
            self.send(WorkerCommand::Refresh(RefreshTarget::Files));
        }
    }

    fn next_page(&mut self) {
        let index = Page::ALL
            .iter()
            .position(|page| *page == self.page)
            .unwrap_or(0);
        self.set_page(Page::ALL[(index + 1) % Page::ALL.len()]);
    }

    fn previous_page(&mut self) {
        let index = Page::ALL
            .iter()
            .position(|page| *page == self.page)
            .unwrap_or(0);
        self.set_page(Page::ALL[(index + Page::ALL.len() - 1) % Page::ALL.len()]);
    }

    fn cycle_focus(&mut self, forward: bool) {
        if !self.sidebar_visible || self.fullscreen_content {
            self.sidebar_visible = true;
            self.fullscreen_content = false;
            self.focus = Focus::Sidebar;
            return;
        }
        let order: &[Focus] = if self.page == Page::Files {
            &[Focus::Sidebar, Focus::Content, Focus::Detail]
        } else {
            &[Focus::Sidebar, Focus::Content]
        };
        let index = order
            .iter()
            .position(|focus| *focus == self.focus)
            .unwrap_or(0);
        self.focus = if forward {
            order[(index + 1) % order.len()]
        } else {
            order[(index + order.len() - 1) % order.len()]
        };
        if self.focus == Focus::Sidebar
            && matches!(self.page, Page::Favorites | Page::Dms | Page::Channels)
        {
            self.section_overview = true;
        }
    }

    fn navigates_list(&self) -> bool {
        match self.page {
            Page::Notifications | Page::Feed => true,
            Page::Favorites | Page::Dms | Page::Channels => {
                self.section_overview || self.focus == Focus::Sidebar
            }
            Page::Files => self.focus != Focus::Detail,
        }
    }

    fn in_message_view(&self) -> bool {
        matches!(self.page, Page::Favorites | Page::Dms | Page::Channels) && !self.section_overview
    }

    fn message_row_starts(&self) -> Vec<usize> {
        let messages = self.visible_messages();
        let mut prefix = String::new();
        if let Some(conversation) = self.selected_conversation() {
            if self.thread_stack.is_empty() && !conversation.topic.is_empty() {
                let _ = write!(prefix, "> {}\n\n", conversation.topic);
            }
        }
        let mut starts = Vec::with_capacity(messages.len());
        let mut previous_date = None;
        for message in &messages {
            if let Some(section) = date_section(&message.timestamp) {
                if previous_date.as_deref() != Some(section.key.as_str()) {
                    let _ = write!(prefix, "## {}\n\n", section.label);
                    previous_date = Some(section.key);
                }
            }
            starts.push(wrapped_markdown_rows(&prefix, self.content_view_width).saturating_sub(1));
            let _ = write!(prefix, "### x\n\n{}\n\n---\n\n", message.text);
        }
        starts
    }

    fn move_message_selection(&mut self, delta: isize) {
        let len = self.visible_messages().len();
        self.selected_message = offset_index(self.selected_message, len, delta);
        self.follow_selected_message();
    }

    fn follow_selected_message(&mut self) {
        let messages = self.visible_messages();
        if messages.is_empty() {
            self.content_scroll = 0;
            return;
        }
        let index = self.selected_message.min(messages.len() - 1);
        let starts = self.message_row_starts();
        let rows_before = starts.get(index).copied().unwrap_or(0);
        let maximum = self.max_content_scroll();
        let target = u16::try_from(rows_before).unwrap_or(u16::MAX).min(maximum);
        let viewport = self.content_view_height.saturating_sub(2).max(1);
        if target < self.content_scroll || target >= self.content_scroll.saturating_add(viewport) {
            self.content_scroll = target;
        }
    }

    fn open_selected_thread(&mut self) {
        let Some(conversation) = self.selected_conversation().cloned() else {
            return;
        };
        let messages = self.visible_messages();
        let Some(message) = messages.get(self.selected_message).cloned() else {
            return;
        };
        if message.reply_count == 0 && message.thread_ts.is_none() {
            return;
        }
        let root_ts = message
            .thread_ts
            .clone()
            .unwrap_or_else(|| message.ts.clone());
        let view = ThreadView {
            conversation_id: conversation.id.clone(),
            root_ts: root_ts.clone(),
        };
        if self.thread_stack.last() == Some(&view) {
            return;
        }
        self.thread_stack.push(view);
        self.selected_message = 0;
        if !self
            .state
            .threads
            .contains_key(&CacheState::thread_key(&conversation.id, &root_ts))
        {
            self.send(WorkerCommand::LoadThread {
                conversation_id: conversation.id,
                thread_ts: root_ts,
            });
        }
        self.content_scroll = self.max_content_scroll();
    }

    fn move_selection(&mut self, delta: isize) {
        if self.in_message_view() && self.focus != Focus::Sidebar {
            self.move_message_selection(delta);
            return;
        }
        if !self.navigates_list() {
            if delta < 0 {
                self.scroll_up(1);
            } else {
                self.scroll_down(1);
            }
            return;
        }
        let (selected, len) = match self.page {
            Page::Notifications => (
                &mut self.selected_notification,
                self.state.notifications.len(),
            ),
            Page::Feed => {
                let len = self.feed.entries().len();
                (&mut self.selected_feed, len)
            }
            Page::Favorites => {
                let len = self.filtered_favorites().len();
                (&mut self.selected_favorite, len)
            }
            Page::Dms => {
                let len = self.filtered_conversations(true).len();
                (&mut self.selected_dm, len)
            }
            Page::Channels => {
                let len = self.filtered_conversations(false).len();
                (&mut self.selected_channel, len)
            }
            Page::Files => {
                let len = self.filtered_files().len();
                (&mut self.selected_file, len)
            }
        };
        *selected = offset_index(*selected, len, delta);
        self.ensure_selected_visible();
        if self.page == Page::Files {
            self.detail_scroll = 0;
        } else if !self.section_overview {
            self.content_scroll = 0;
        }
    }

    fn ensure_selected_visible(&mut self) {
        match self.page {
            Page::Notifications => keep_visible(
                self.selected_notification,
                &mut self.activity_offset,
                usize::from(self.content_view_height.saturating_sub(2) / 3).max(1),
            ),
            Page::Feed => keep_visible(
                self.selected_feed,
                &mut self.feed_offset,
                usize::from(self.content_view_height.saturating_sub(2) / 2).max(1),
            ),
            Page::Favorites => keep_visible(
                self.selected_favorite,
                &mut self.overview_offset,
                usize::from(self.content_view_height.saturating_sub(2)).max(1),
            ),
            Page::Dms => keep_visible(
                self.selected_dm,
                &mut self.overview_offset,
                usize::from(self.content_view_height.saturating_sub(2)).max(1),
            ),
            Page::Channels => keep_visible(
                self.selected_channel,
                &mut self.overview_offset,
                usize::from(self.content_view_height.saturating_sub(2)).max(1),
            ),
            Page::Files => keep_visible(
                self.selected_file,
                &mut self.file_offset,
                usize::from(self.content_view_height.saturating_sub(2) / 3).max(1),
            ),
        }
    }

    fn visible_messages(&self) -> Vec<Message> {
        if let Some(view) = self.thread_stack.last() {
            return self
                .state
                .threads
                .get(&CacheState::thread_key(
                    &view.conversation_id,
                    &view.root_ts,
                ))
                .cloned()
                .unwrap_or_default();
        }
        self.selected_conversation()
            .and_then(|conversation| self.state.messages.get(&conversation.id))
            .cloned()
            .unwrap_or_default()
    }

    fn conversation_markdown(&self) -> String {
        let Some(conversation) = self.selected_conversation() else {
            return "Select a conversation".into();
        };
        let mut markdown = String::new();
        if let Some(view) = self.thread_stack.last() {
            let _ = write!(
                markdown,
                "> Thread in **{}** · press `q` to go back\n\n",
                conversation.name
            );
            let _ = view;
        } else if !conversation.topic.is_empty() {
            let _ = write!(markdown, "> {}\n\n", conversation.topic);
        }
        let messages = self.visible_messages();
        if messages.is_empty() {
            markdown.push_str("_Press Enter to load up to seven days of content._");
        } else {
            let mut previous_date = None;
            for (index, message) in messages.iter().enumerate() {
                if let Some(section) = date_section(&message.timestamp) {
                    if previous_date.as_deref() != Some(section.key.as_str()) {
                        let _ = write!(markdown, "## {}\n\n", section.label);
                        previous_date = Some(section.key);
                    }
                }
                let selected = index == self.selected_message && self.thread_stack.is_empty();
                let thread = if message.reply_count > 0 {
                    format!(
                        "  ·  💬 {} repl{}",
                        message.reply_count,
                        if message.reply_count == 1 { "y" } else { "ies" }
                    )
                } else {
                    String::new()
                };
                let permalink = if message.permalink.is_empty() {
                    String::new()
                } else {
                    "  ·  open ↗".to_string()
                };
                let _ = write!(
                    markdown,
                    "### {}{}  ·  {}{thread}{permalink}\n\n{}\n\n---\n\n",
                    if selected { "▸ " } else { "" },
                    if message.author.is_empty() {
                        &message.user_id
                    } else {
                        &message.author
                    },
                    short_time(&message.timestamp),
                    message.text,
                );
            }
        }
        markdown
    }

    fn max_content_scroll(&self) -> u16 {
        if self.navigates_list() {
            return 0;
        }
        let rows = wrapped_markdown_rows(&self.conversation_markdown(), self.content_view_width);
        scroll_max(rows, self.content_view_height)
    }

    fn max_detail_scroll(&self) -> u16 {
        let rows = self.selected_file().map_or(1, |file| {
            let markdown = if file.content_markdown.is_empty() {
                &file.title
            } else {
                &file.content_markdown
            };
            wrapped_markdown_rows(markdown, self.detail_view_width)
        });
        scroll_max(rows, self.detail_view_height)
    }

    fn scroll_up(&mut self, amount: u16) {
        match self.focus {
            Focus::Detail => self.detail_scroll = self.detail_scroll.saturating_sub(amount),
            _ => self.content_scroll = self.content_scroll.saturating_sub(amount),
        }
    }

    fn scroll_down(&mut self, amount: u16) {
        match self.focus {
            Focus::Detail => {
                self.detail_scroll = self
                    .detail_scroll
                    .saturating_add(amount)
                    .min(self.max_detail_scroll());
            }
            _ => {
                self.content_scroll = self
                    .content_scroll
                    .saturating_add(amount)
                    .min(self.max_content_scroll());
            }
        }
    }

    fn set_scroll(&mut self, value: u16) {
        match self.focus {
            Focus::Detail => self.detail_scroll = value.min(self.max_detail_scroll()),
            _ => self.content_scroll = value.min(self.max_content_scroll()),
        }
    }

    fn handle_mouse(&mut self, mouse: MouseEvent) -> bool {
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) if self.divider_at(mouse.column).is_some() => {
                // Grab a pane divider: drag resizes, matching normal desktop
                // split behaviour.
                self.dragging = self.divider_at(mouse.column);
                true
            }
            MouseEventKind::Drag(MouseButton::Left) => match self.dragging {
                Some(Divider::Sidebar) => {
                    self.sidebar_width = mouse.column.clamp(18, self.viewport_width / 2);
                    true
                }
                Some(Divider::Detail) => {
                    let content = self
                        .viewport_width
                        .saturating_sub(self.sidebar_visible_width());
                    if content > 0 {
                        let offset = mouse.column.saturating_sub(self.sidebar_visible_width());
                        let percent = 100u32
                            .saturating_sub(u32::from(offset) * 100 / u32::from(content.max(1)));
                        self.detail_percent = u16::try_from(percent.clamp(20, 80)).unwrap_or(64);
                    }
                    true
                }
                None => false,
            },
            MouseEventKind::Up(MouseButton::Left) => self.dragging.take().is_some(),
            MouseEventKind::Down(MouseButton::Left) => {
                if let Some(action) = self
                    .hits
                    .iter()
                    .rev()
                    .find(|hit| contains(hit.rect, mouse.column, mouse.row))
                    .map(|hit| hit.action.clone())
                {
                    match action {
                        HitAction::Page(page) => self.set_page(page),
                        HitAction::Conversation(id, kind) => self.select_conversation(id, kind),
                        HitAction::Notification(index) => {
                            self.page = Page::Notifications;
                            self.selected_notification = index;
                            self.focus = Focus::Content;
                        }
                        HitAction::FeedEntry(index) => {
                            self.page = Page::Feed;
                            self.selected_feed = index;
                            self.focus = Focus::Content;
                            self.open_feed_entry();
                        }
                        HitAction::File(index) => {
                            self.page = Page::Files;
                            self.selected_file = index;
                            self.focus = Focus::Detail;
                            self.detail_scroll = 0;
                            self.request_selected();
                        }
                        HitAction::Focus(focus) => self.focus = focus,
                        HitAction::Message(index) => {
                            self.selected_message = index;
                            self.focus = Focus::Content;
                            self.open_selected_thread();
                        }
                    }
                    true
                } else {
                    false
                }
            }
            MouseEventKind::ScrollUp => {
                if self.pointer_in_sidebar(mouse.column) {
                    self.sidebar_offset = self.sidebar_offset.saturating_sub(3);
                } else if self.navigates_list() {
                    self.move_selection(-1);
                } else {
                    self.scroll_up(3);
                }
                true
            }
            MouseEventKind::ScrollDown => {
                if self.pointer_in_sidebar(mouse.column) {
                    self.sidebar_offset = self.sidebar_offset.saturating_add(3);
                } else if self.navigates_list() {
                    self.move_selection(1);
                } else {
                    self.scroll_down(3);
                }
                true
            }
            _ => false,
        }
    }

    fn sidebar_visible_width(&self) -> u16 {
        if self.sidebar_visible && !self.fullscreen_content {
            self.sidebar_width
        } else {
            0
        }
    }

    /// Divider whose grab column contains `column`, if any.
    fn divider_at(&self, column: u16) -> Option<Divider> {
        let sidebar_edge = self.sidebar_visible_width();
        if sidebar_edge > 0 && column.abs_diff(sidebar_edge) <= 1 {
            return Some(Divider::Sidebar);
        }
        if self.page == Page::Files {
            let content = self.viewport_width.saturating_sub(sidebar_edge);
            let split = sidebar_edge + content.saturating_mul(100 - self.detail_percent) / 100;
            if content > 0 && column.abs_diff(split) <= 1 {
                return Some(Divider::Detail);
            }
        }
        None
    }

    /// Seed snapshots/demo views from persisted history without replay pacing.
    fn prime_feed(&mut self) {
        self.feed.seed(&self.state);
    }

    fn apply_config(&mut self, config: Config, path: PathBuf) {
        set_active_theme(config.theme);
        self.sidebar_width = config.sidebar_width.clamp(18, 80);
        self.detail_percent = config.detail_percent.clamp(20, 80);
        self.config = config;
        self.config_path = path;
        self.apply_local_favorites();
        self.apply_read_markers();
    }

    /// The snapshot-age label shown in the status bar.
    ///
    /// Shared with the redraw gate in `run_loop`, so the loop can repaint
    /// exactly when this string changes rather than once a second regardless.
    fn staleness_label(&self) -> String {
        let (key, label) = self.visible_refresh_domain();
        let age = snapshot_age(self.state.refreshed_at(&key));
        let mut status = format!("{label} {}", age.trim_start_matches("snapshot "));
        if let Some(domain) = self.state.collector.domains.get(&key) {
            match domain.state {
                RefreshState::Partial => status.push_str(" · partial gap"),
                RefreshState::Backoff => {
                    let remaining = self
                        .state
                        .collector
                        .rate_limited_until
                        .map_or(0, |until| until.saturating_sub(CacheState::now()));
                    if remaining > 0 {
                        let _ = write!(status, " · rate limit {remaining}s");
                    } else {
                        status.push_str(" · rate limited");
                    }
                }
                RefreshState::Error => status.push_str(" · refresh error"),
                RefreshState::Refreshing => status.push_str(" · refreshing"),
                RefreshState::Unknown | RefreshState::Healthy => {}
            }
        }
        status
    }

    fn visible_refresh_domain(&self) -> (String, &'static str) {
        match self.page {
            Page::Notifications | Page::Feed => ("notifications".into(), "activity"),
            Page::Files => ("files".into(), "files"),
            Page::Favorites | Page::Dms | Page::Channels if self.section_overview => {
                ("sidebar".into(), "inventory")
            }
            Page::Favorites | Page::Dms | Page::Channels => {
                self.selected_conversation().map_or_else(
                    || ("sidebar".into(), "inventory"),
                    |conversation| (format!("conversation:{}", conversation.id), "conversation"),
                )
            }
        }
    }

    /// Animation generation for the in-flight worker. The main loop compares
    /// this value rather than blindly redrawing, so liveness is visible while a
    /// network call runs without bringing back the permanent idle repaint.
    fn liveness_tick(&self) -> Option<u64> {
        self.busy.then(|| {
            self.busy_since
                .map_or(0, |started| started.elapsed().as_millis() as u64 / 160)
        })
    }

    /// Icon, colour and bounded text for source/worker liveness.
    fn header_status(&self) -> (&'static str, Color, String) {
        if self.smart_client {
            if let Some(health) = &self.client_health {
                let daemon = if health.daemon_enabled {
                    health.daemon_age_secs.map_or_else(
                        || "daemon (waiting)".into(),
                        |age| format!("daemon ({})", compact_age(age)),
                    )
                } else {
                    "daemon (off)".into()
                };
                let cache = if health.cache_enabled {
                    health.cache_age_secs.map_or_else(
                        || "cache (empty)".into(),
                        |age| format!("cache ({})", compact_age(age)),
                    )
                } else {
                    "cache (off)".into()
                };
                let fallback = if health.fallback_active {
                    " · fallback"
                } else {
                    ""
                };
                let domain_state = self
                    .state
                    .collector
                    .domains
                    .get(&self.visible_refresh_domain().0)
                    .map(|domain| &domain.state);
                let hard_error = matches!(
                    domain_state,
                    Some(RefreshState::Backoff | RefreshState::Error)
                );
                let degraded = matches!(domain_state, Some(RefreshState::Partial));
                let source_error =
                    health.error.is_some() && (health.daemon_connected || !health.cache_live);
                let (icon, color) = if hard_error
                    || source_error
                    || (health.fallback_active && self.last_error.is_some())
                    || (!health.daemon_connected && !health.cache_live && !health.fallback_active)
                {
                    ("●", RED())
                } else if !health.daemon_connected || degraded || health.fallback_active {
                    ("●", YELLOW())
                } else {
                    ("●", GREEN())
                };
                return (icon, color, format!("{daemon} · {cache}{fallback}"));
            }
        }
        if self.busy {
            let tick = self.liveness_tick().unwrap_or(0);
            let icon = ["◐", "◓", "◑", "◒"][usize::try_from(tick % 4).unwrap_or(0)];
            let elapsed = self
                .busy_since
                .map_or(0, |started| started.elapsed().as_secs());
            let slow = elapsed >= 45;
            let text = if slow {
                format!("{} · slow {elapsed}s", self.status)
            } else {
                format!("{} · {elapsed}s", self.status)
            };
            (icon, if slow { RED() } else { YELLOW() }, text)
        } else if self.last_error.is_some() {
            ("!", RED(), self.status.clone())
        } else {
            ("●", GREEN(), self.status.clone())
        }
    }

    /// Escape sequence for any newly arrived mentions/DMs, coalesced into one
    /// announcement and cleared once taken.
    fn take_alert_sequence(&mut self) -> Option<String> {
        let count = self.feed.take_alerts();
        alert_sequence(self.config.alerts, count)
    }

    /// Mark the conversation currently on screen as read, if any.
    ///
    /// Opening a conversation whose messages were not cached dispatches a
    /// lazy load, so the newest timestamp is only known once the worker
    /// answers; this runs after each update to close that gap.
    fn mark_open_conversation_read(&mut self) {
        if self.section_overview
            || !matches!(self.page, Page::Favorites | Page::Dms | Page::Channels)
        {
            return;
        }
        let Some(id) = self
            .selected_conversation()
            .map(|conversation| conversation.id.clone())
        else {
            return;
        };
        if self.state.messages.get(&id).is_some_and(|m| !m.is_empty()) {
            self.mark_conversation_read(&id);
        }
    }

    /// Clear unread badges already covered by a local read marker.
    ///
    /// Slick never sends `conversations.mark`, so Slack keeps reporting a
    /// conversation as unread after it has been read here. Zeroing the count
    /// locally keeps Slick's own view self-consistent; every badge and sort
    /// path reads `unread_count`, so applying it at the state layer (exactly
    /// like the favourites overlay) fixes all of them at once.
    fn apply_read_markers(&mut self) {
        for conversation in &mut self.state.conversations {
            let Some(latest) = conversation.latest_ts.as_deref() else {
                continue;
            };
            if self.config.has_read_through(&conversation.id, latest) {
                conversation.unread_count = 0;
                conversation.mention_count = 0;
            }
        }
    }

    /// Record that the operator has seen this conversation up to its newest
    /// loaded message, persisting the marker.
    fn mark_conversation_read(&mut self, conversation_id: &str) {
        let newest = self
            .state
            .messages
            .get(conversation_id)
            .and_then(|messages| messages.last())
            .map(|message| message.ts.clone())
            .or_else(|| {
                self.state
                    .conversations
                    .iter()
                    .find(|conversation| conversation.id == conversation_id)
                    .and_then(|conversation| conversation.latest_ts.clone())
            });
        let Some(newest) = newest else {
            return;
        };
        if !self.config.mark_read(conversation_id, &newest) {
            return;
        }
        self.apply_read_markers();
        if let Err(error) = self.config.save(&self.config_path) {
            self.last_error = Some(error.to_string());
        }
    }

    /// Union Slack stars with locally tagged favourites.
    ///
    /// Slack's own Favorites sidebar section is not readable through the
    /// supported API (`users.channelSections.list` returns `team_is_restricted`),
    /// so the local overlay is the only way to mark the rest — and Slick stays
    /// read-only by never writing stars back to Slack.
    fn apply_local_favorites(&mut self) {
        for conversation in &mut self.state.conversations {
            if self.config.is_local_favorite(&conversation.id) {
                conversation.is_favorite = true;
            }
        }
    }

    /// Toggle the selected conversation's local favourite and persist it.
    fn toggle_local_favorite(&mut self) {
        let Some(id) = self.selected_conversation().map(|item| item.id.clone()) else {
            return;
        };
        let now_favorite = self.config.toggle_favorite(&id);
        if let Some(conversation) = self
            .state
            .conversations
            .iter_mut()
            .find(|item| item.id == id)
        {
            conversation.is_favorite = now_favorite;
        }
        match self.config.save(&self.config_path) {
            Ok(()) => {
                self.status = if now_favorite {
                    format!("Favourited locally: {id}")
                } else {
                    format!("Unfavourited locally: {id}")
                };
            }
            Err(error) => self.last_error = Some(error.to_string()),
        }
    }

    fn cycle_theme(&mut self) {
        self.config.theme = self.config.theme.next();
        set_active_theme(self.config.theme);
        self.status = format!("Theme: {}", self.config.theme.label());
        if let Err(error) = self.config.save(&self.config_path) {
            self.last_error = Some(error.to_string());
        }
    }

    /// Fetch any images referenced by the pane and pair them with the reserved
    /// placeholder cells, in document order.
    ///
    /// Order is stable across wrapping, so pairing by sequence is safe: the nth
    /// placeholder in the buffer is the nth image in the source.
    fn collect_image_runs(
        &mut self,
        buffer: &Buffer,
        area: Rect,
        placements: &[ImagePlacement],
        cell_width_px: u16,
        cell_height_px: u16,
    ) {
        if placements.is_empty() || area.width == 0 || area.height == 0 {
            return;
        }
        let mut found: Vec<(u16, u16)> = Vec::new();
        for y in area.y..area.bottom() {
            for x in area.x..area.right() {
                if buffer[(x, y)].symbol().starts_with(IMAGE_PLACEHOLDER) {
                    found.push((x, y));
                }
            }
        }
        let content_cols = area.width.saturating_sub(2).max(1);
        for ((x, y), placement) in found.into_iter().zip(placements.iter()) {
            let Some(image) = self.image_for(placement) else {
                continue;
            };
            let (cols, rows) = match placement.kind {
                // Emoji are punctuation: exactly the two cells a unicode glyph
                // would occupy, one row, never reflowing the sentence.
                ImageKind::Emoji => (2, 1),
                ImageKind::Attachment => {
                    image.block_cells(cell_width_px, cell_height_px, content_cols)
                }
            };
            self.image_runs.push(ImageRun {
                x,
                y,
                cols,
                rows: rows.min(area.bottom().saturating_sub(y)).max(1),
                url: placement.url.clone(),
            });
        }
    }

    /// Cached image for a placement, fetching it once if necessary.
    fn image_for(&mut self, placement: &ImagePlacement) -> Option<crate::images::CachedImage> {
        if let Some(hit) = self.images.get(&placement.url) {
            return Some(hit);
        }
        if self.images.failed(&placement.url) {
            return None;
        }
        let client = self
            .image_client
            .get_or_insert_with(reqwest::blocking::Client::new);
        let response = client
            .get(&placement.url)
            .timeout(Duration::from_secs(5))
            .send()
            .and_then(reqwest::blocking::Response::bytes);
        match response {
            Ok(bytes) => match self.images.insert(&placement.url, bytes.to_vec()) {
                Ok(entry) => Some(entry),
                Err(error) => {
                    self.images
                        .record_failure(&placement.url, error.to_string());
                    None
                }
            },
            Err(error) => {
                self.images
                    .record_failure(&placement.url, error.to_string());
                None
            }
        }
    }

    fn pointer_in_sidebar(&self, column: u16) -> bool {
        self.sidebar_visible && !self.fullscreen_content && column < self.sidebar_width
    }

    fn render(&mut self, frame: &mut Frame<'_>, graphics: Option<(&Runtime, &EffectsSink)>) {
        self.hits.clear();
        self.link_runs.clear();
        self.image_runs.clear();
        self.viewport_width = frame.area().width;
        let area = frame.area();
        let vertical = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(1),
                Constraint::Min(8),
                Constraint::Length(1),
            ])
            .split(area);
        self.render_header(frame, vertical[0], graphics);
        let body = vertical[1];
        if self.fullscreen_content {
            if self.page == Page::Files {
                self.detail_view_height = body.height;
                self.detail_view_width = body.width;
                self.render_file_detail(frame, body, graphics);
            } else {
                self.content_view_height = body.height;
                self.content_view_width = body.width;
                self.render_content(frame, body, graphics);
            }
        } else {
            let content = if self.sidebar_visible {
                let columns = Layout::default()
                    .direction(Direction::Horizontal)
                    .constraints([Constraint::Length(self.sidebar_width), Constraint::Min(20)])
                    .split(body);
                self.render_sidebar(frame, columns[0], graphics);
                columns[1]
            } else {
                body
            };
            if self.page == Page::Files {
                let files = Layout::default()
                    .direction(Direction::Horizontal)
                    .constraints([
                        Constraint::Percentage(100 - self.detail_percent),
                        Constraint::Percentage(self.detail_percent),
                    ])
                    .split(content);
                self.content_view_height = files[0].height;
                self.content_view_width = files[0].width;
                self.detail_view_height = files[1].height;
                self.detail_view_width = files[1].width;
                self.render_files(frame, files[0], graphics);
                self.render_file_detail(frame, files[1], graphics);
            } else {
                self.content_view_height = content.height;
                self.content_view_width = content.width;
                self.render_content(frame, content, graphics);
            }
        }
        self.render_footer(frame, vertical[2], graphics);
        if self.show_help {
            self.render_help(frame, area);
        }
    }

    fn render_header(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        // The status zone carries a variable-width staleness phrase, so give it
        // room instead of a fixed 28 cells that clipped "1h 9m stale".
        // Give status every spare cell after the fixed team label and a
        // minimally useful search field. Wide terminals can now show the full
        // refresh action and elapsed liveness instead of clipping at 40 cells.
        let status_width = area.width.saturating_sub(48).min(80);
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(28),
                Constraint::Min(20),
                Constraint::Length(status_width),
            ])
            .split(area);
        let team = if self.state.team_name.is_empty() {
            "Slick"
        } else {
            &self.state.team_name
        };
        render_title(
            frame,
            columns[0],
            format!("  ◈ {team}"),
            graphics,
            Tone::Purple,
        );
        let search = if self.filter_mode {
            format!("  /{}▌", self.filter)
        } else if self.filter.is_empty() {
            "  Search locally  (/)".into()
        } else {
            format!("  Filter: {}  (Esc clears)", self.filter)
        };
        render_title(frame, columns[1], search, graphics, Tone::Dark);
        let (icon, color, status) = self.header_status();
        let paragraph = Paragraph::new(Line::from(vec![
            Span::styled(
                format!(" {icon} "),
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!("{} · {status}", self.staleness_label()),
                Style::default().fg(MUTED()),
            ),
        ]));
        // Header strips are one row tall: the padded pane chrome used elsewhere
        // would consume that row entirely and the status would disappear under
        // graphics, so render it through the unpadded header chrome.
        if let Some((runtime, sink)) = graphics {
            render_decorated(
                paragraph,
                &header_chrome(Tone::Dark),
                columns[2],
                frame.buffer_mut(),
                runtime,
                sink,
            );
        } else {
            frame.render_widget(paragraph, columns[2]);
        }
    }

    fn render_sidebar(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        self.hits.push(HitRegion {
            rect: area,
            action: HitAction::Focus(Focus::Sidebar),
        });
        let mut items = Vec::new();
        let mut row = list_origin(area, graphics.is_some(), false);
        for page in Page::ALL {
            let selected = page == self.page;
            let count = match page {
                Page::Notifications => self
                    .state
                    .notifications
                    .iter()
                    .filter(|item| item.unread || item.mention)
                    .count(),
                Page::Feed => self.feed.entries().len(),
                Page::Favorites => self
                    .state
                    .conversations
                    .iter()
                    .filter(|item| item.is_favorite)
                    .count(),
                Page::Dms => self
                    .state
                    .conversations
                    .iter()
                    .filter(|item| item.kind.is_dm())
                    .count(),
                Page::Channels => self
                    .state
                    .conversations
                    .iter()
                    .filter(|item| !item.kind.is_dm())
                    .count(),
                Page::Files => self.state.files.len(),
            };
            let count = if count > 0 {
                format!(" {count:>3}")
            } else {
                String::new()
            };
            let style = if selected {
                Style::default()
                    .fg(Color::White)
                    .bg(SLACK_PURPLE())
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(FG())
            };
            items.push(
                ListItem::new(Line::from(vec![
                    Span::styled(
                        format!(" {} ", page.icon()),
                        Style::default().fg(if selected { Color::White } else { CYAN() }),
                    ),
                    Span::styled(format!("{:<19}{count}", page.label()), style),
                ]))
                .style(style),
            );
            self.hits.push(HitRegion {
                rect: Rect::new(area.x + 1, row, area.width.saturating_sub(2), 1),
                action: HitAction::Page(page),
            });
            row = row.saturating_add(1);
        }
        items.push(ListItem::new(""));
        row = row.saturating_add(1);

        let dms: Vec<Conversation> = self
            .active_dms()
            .into_iter()
            .take(SIDEBAR_DM_ROWS)
            .cloned()
            .collect();
        let channels = self.sidebar_channel_sections();
        let mut sections: Vec<(String, Vec<Conversation>)> = vec![("Direct messages".into(), dms)];
        sections.extend(channels);

        // Everything below the nav scrolls as one list so the complete channel
        // inventory is reachable instead of a fixed eight-row window.
        let mut scrollable: Vec<(Option<String>, Option<Conversation>)> = Vec::new();
        for (title, conversations) in sections {
            if conversations.is_empty() {
                continue;
            }
            scrollable.push((Some(title), None));
            for conversation in conversations {
                scrollable.push((None, Some(conversation)));
            }
        }
        let body_rows = usize::from(area.height.saturating_sub(row.saturating_sub(area.y)))
            .saturating_sub(1)
            .max(1);
        self.sidebar_offset = self.sidebar_offset.min(
            scrollable
                .len()
                .saturating_sub(body_rows.min(scrollable.len())),
        );
        for entry in scrollable.iter().skip(self.sidebar_offset).take(body_rows) {
            match entry {
                (Some(title), _) => {
                    items.push(ListItem::new(Line::from(Span::styled(
                        format!("  {title}"),
                        Style::default().fg(MUTED()).add_modifier(Modifier::BOLD),
                    ))));
                }
                (_, Some(conversation)) => {
                    let marker = if conversation.kind.is_dm() {
                        "●"
                    } else {
                        "#"
                    };
                    let unread = unread_badge(conversation);
                    let label_width = usize::from(area.width.saturating_sub(11)).max(10);
                    items.push(ListItem::new(conversation_line(
                        conversation,
                        marker,
                        unread,
                        label_width,
                    )));
                    self.hits.push(HitRegion {
                        rect: Rect::new(area.x + 1, row, area.width.saturating_sub(2), 1),
                        action: HitAction::Conversation(conversation.id.clone(), conversation.kind),
                    });
                }
                _ => {}
            }
            row = row.saturating_add(1);
        }
        let list = List::new(items).block(pane_block(
            graphics.is_some(),
            self.focus == Focus::Sidebar,
            String::new(),
        ));
        render_list(
            frame,
            area,
            list,
            graphics,
            Tone::Sidebar,
            self.focus == Focus::Sidebar,
        );
    }

    fn render_content(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        self.hits.push(HitRegion {
            rect: area,
            action: HitAction::Focus(Focus::Content),
        });
        match self.page {
            Page::Notifications => self.render_notifications(frame, area, graphics),
            Page::Feed => self.render_feed(frame, area, graphics),
            Page::Favorites | Page::Dms | Page::Channels if self.section_overview => {
                self.render_conversation_overview(frame, area, graphics);
            }
            Page::Favorites | Page::Dms | Page::Channels => {
                self.render_messages(frame, area, graphics);
            }
            Page::Files => {}
        }
    }

    /// Live feed: one line per arriving item, newest first.
    fn render_feed(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        let mut items = Vec::new();
        let mut row = list_origin(area, graphics.is_some(), true);
        let row_budget = usize::from(area.height.saturating_sub(2)).max(1);
        let visible = (row_budget / 2).max(1);
        keep_visible(self.selected_feed, &mut self.feed_offset, visible);
        let entries: Vec<_> = self.feed.entries().to_vec();
        self.feed_offset = self
            .feed_offset
            .min(entries.len().saturating_sub(visible.min(entries.len())));
        if entries.is_empty() {
            items.push(ListItem::new(Line::from(Span::styled(
                "  Waiting for arrivals. New messages, mentions and files stream in here.",
                Style::default().fg(MUTED()),
            ))));
        }
        let summary_width = usize::from(area.width.saturating_sub(34)).max(24);
        let mut used_rows = 0usize;
        let mut previous_date = None;
        for (index, entry) in entries.iter().enumerate().skip(self.feed_offset) {
            let section = date_section(&entry.time);
            let starts_date = section
                .as_ref()
                .is_some_and(|section| previous_date.as_deref() != Some(section.key.as_str()));
            let needed = 1 + usize::from(starts_date);
            if used_rows + needed > row_budget {
                break;
            }
            if starts_date {
                let section = section.as_ref().expect("checked above");
                items.push(date_header(section));
                previous_date = Some(section.key.clone());
                row = row.saturating_add(1);
                used_rows += 1;
            }
            let selected = index == self.selected_feed;
            let style = if selected {
                Style::default().bg(palette().selection)
            } else {
                Style::default()
            };
            let marker = if entry.mention {
                "@"
            } else if entry.revision > 0 {
                "~"
            } else {
                "·"
            };
            items.push(
                ListItem::new(Line::from(vec![
                    Span::styled(
                        format!(" {marker} "),
                        Style::default().fg(if entry.mention { YELLOW() } else { CYAN() }),
                    ),
                    Span::styled(
                        format!("{:>5} ", short_time(&entry.time)),
                        Style::default().fg(if entry.unread { GREEN() } else { MUTED() }),
                    ),
                    Span::styled(
                        format!("{:<18} ", truncate_label(&entry.source, 18)),
                        Style::default().fg(FG()).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        preview(&entry.summary, summary_width),
                        Style::default().fg(if selected { FG() } else { MUTED() }),
                    ),
                ]))
                .style(style),
            );
            self.hits.push(HitRegion {
                rect: Rect::new(area.x + 1, row, area.width.saturating_sub(2), 1),
                action: HitAction::FeedEntry(index),
            });
            row = row.saturating_add(1);
            used_rows += 1;
        }
        let pending = self.feed.pending_len();
        let list = List::new(items).block(pane_block(
            graphics.is_some(),
            self.focus == Focus::Content,
            if pending > 0 {
                format!(" Feed · {} lines · {pending} incoming ", entries.len())
            } else {
                format!(" Feed · {} lines ", entries.len())
            },
        ));
        render_list(
            frame,
            area,
            list,
            graphics,
            Tone::Content,
            self.focus == Focus::Content,
        );
    }

    fn render_notifications(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        let mut items = Vec::new();
        let mut row = list_origin(area, graphics.is_some(), true);
        // Date and conversation headers are non-clickable rows. Use a
        // conservative three-row selection window, then fill any spare rows.
        let row_budget = usize::from(area.height.saturating_sub(2)).max(1);
        let visible = (row_budget / 3).max(1);
        keep_visible(
            self.selected_notification,
            &mut self.activity_offset,
            visible,
        );
        self.activity_offset = self
            .activity_offset
            .min(self.state.notifications.len().saturating_sub(visible));
        if self.state.notifications.is_empty() {
            items.push(ListItem::new(Line::from(vec![
                Span::styled("  ✓ ", Style::default().fg(GREEN())),
                Span::styled(
                    "You're all caught up",
                    Style::default().fg(FG()).add_modifier(Modifier::BOLD),
                ),
            ])));
            items.push(ListItem::new("  Mentions, unread DMs and recent DM activity from the last seven days appear here."));
        }
        // Preview width follows the pane instead of a fixed cap so text runs to
        // the real edge: the gutter is "   HH:MM NEW " plus chrome borders.
        let preview_width = usize::from(area.width.saturating_sub(16)).max(24);
        let mut previous_conversation: Option<&str> = None;
        let mut previous_date = None;
        let mut used_rows = 0usize;
        for (index, notification) in self
            .state
            .notifications
            .iter()
            .enumerate()
            .skip(self.activity_offset)
        {
            let section = date_section(&notification.message.timestamp);
            let starts_date = section
                .as_ref()
                .is_some_and(|section| previous_date.as_deref() != Some(section.key.as_str()));
            if starts_date {
                previous_conversation = None;
            }
            let starts_run = previous_conversation != Some(notification.conversation_id.as_str());
            let needed = 1 + usize::from(starts_date) + usize::from(starts_run);
            if used_rows + needed > row_budget {
                break;
            }
            if starts_date {
                let section = section.as_ref().expect("checked above");
                items.push(date_header(section));
                previous_date = Some(section.key.clone());
                row = row.saturating_add(1);
                used_rows += 1;
            }
            let selected = index == self.selected_notification;
            let marker = if notification.mention {
                "@"
            } else if notification.kind.is_dm() {
                "●"
            } else {
                "#"
            };
            let style = if selected {
                Style::default().bg(palette().selection)
            } else {
                Style::default()
            };
            if starts_run {
                items.push(ListItem::new(Line::from(vec![
                    Span::styled(
                        format!(" {marker} "),
                        Style::default()
                            .fg(if notification.mention {
                                YELLOW()
                            } else {
                                CYAN()
                            })
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        notification.conversation_name.clone(),
                        Style::default().fg(FG()).add_modifier(Modifier::BOLD),
                    ),
                ])));
                row = row.saturating_add(1);
                used_rows += 1;
            }
            previous_conversation = Some(notification.conversation_id.as_str());
            let badge = if notification.unread { " NEW" } else { "" };
            items.push(
                ListItem::new(Line::from(vec![
                    Span::styled(
                        format!(
                            "   {:>5}{badge} ",
                            short_time(&notification.message.timestamp)
                        ),
                        Style::default().fg(if badge.is_empty() { MUTED() } else { GREEN() }),
                    ),
                    Span::styled(
                        preview(&notification.message.text, preview_width),
                        Style::default().fg(if selected { FG() } else { MUTED() }),
                    ),
                ]))
                .style(style),
            );
            self.hits.push(HitRegion {
                rect: Rect::new(area.x + 1, row, area.width.saturating_sub(2), 1),
                action: HitAction::Notification(index),
            });
            row = row.saturating_add(1);
            used_rows += 1;
        }
        let list = List::new(items).block(pane_block(
            graphics.is_some(),
            self.focus == Focus::Content,
            format!(
                " Activity · {} items · {}/{} ",
                self.state.notifications.len(),
                self.selected_notification
                    .saturating_add(1)
                    .min(self.state.notifications.len()),
                self.state.notifications.len().max(1),
            ),
        ));
        render_list(
            frame,
            area,
            list,
            graphics,
            Tone::Content,
            self.focus == Focus::Content,
        );
    }

    fn render_conversation_overview(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        let (label, conversations, selected) = match self.page {
            Page::Favorites => (
                "Favorites",
                self.filtered_favorites()
                    .into_iter()
                    .cloned()
                    .collect::<Vec<_>>(),
                self.selected_favorite,
            ),
            Page::Dms => (
                "Direct messages",
                self.filtered_conversations(true)
                    .into_iter()
                    .cloned()
                    .collect::<Vec<_>>(),
                self.selected_dm,
            ),
            _ => (
                "Channels",
                self.filtered_conversations(false)
                    .into_iter()
                    .cloned()
                    .collect::<Vec<_>>(),
                self.selected_channel,
            ),
        };
        let panes = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(62), Constraint::Percentage(38)])
            .split(area);
        let visible = usize::from(panes[0].height.saturating_sub(2)).max(1);
        let offset = self
            .overview_offset
            .min(conversations.len().saturating_sub(visible));
        self.overview_offset = offset;
        let mut items = Vec::new();
        let mut row = list_origin(panes[0], graphics.is_some(), true);
        for (index, conversation) in conversations.iter().enumerate().skip(offset).take(visible) {
            let is_selected = index == selected;
            let style = if is_selected {
                Style::default().bg(palette().selection)
            } else {
                Style::default()
            };
            items.push(
                ListItem::new(conversation_line(
                    conversation,
                    if conversation.kind.is_dm() {
                        "●"
                    } else {
                        "#"
                    },
                    unread_badge(conversation),
                    24,
                ))
                .style(style),
            );
            self.hits.push(HitRegion {
                rect: Rect::new(panes[0].x + 1, row, panes[0].width.saturating_sub(2), 1),
                action: HitAction::Conversation(conversation.id.clone(), conversation.kind),
            });
            row = row.saturating_add(1);
        }
        let total = conversations.len();
        let title = format!(
            " {} · {total} total · {}/{} ",
            label,
            selected.saturating_add(1).min(total),
            total.max(1),
        );
        let list = List::new(items).block(pane_block(graphics.is_some(), true, title));
        render_list(frame, panes[0], list, graphics, Tone::Content, true);

        let detail = conversations.get(selected).map_or_else(
            || "No matching conversations. Press `/` to change the local filter.".to_string(),
            |conversation| {
                let messages = self
                    .state
                    .messages
                    .get(&conversation.id)
                    .map_or(0, Vec::len);
                format!(
                    "# {}\n\n**{}**\n\n{}\n\n{}\n\n- ID: `{}`\n- Favorite: {}\n- Cached messages: {messages}\n- Activity: {}\n\nPress **Enter** to open. Use `/` to search this complete cached inventory.",
                    conversation.name,
                    conversation.kind.label(),
                    conversation.topic,
                    conversation.purpose,
                    conversation.id,
                    if conversation.is_favorite { "yes" } else { "no" },
                    if conversation.activity_ts() > 0.0 { "recent" } else { "unknown" },
                )
            },
        );
        let paragraph = Paragraph::new(render_markdown(&detail))
            .block(
                Block::default()
                    .borders(if graphics.is_some() {
                        Borders::NONE
                    } else {
                        Borders::ALL
                    })
                    .title(" Overview "),
            )
            .wrap(Wrap { trim: false });
        render_paragraph(frame, panes[1], paragraph, graphics, Tone::Detail, false);
    }

    fn render_messages(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        let Some(conversation) = self.selected_conversation().cloned() else {
            render_paragraph(
                frame,
                area,
                Paragraph::new("Select a conversation"),
                graphics,
                Tone::Content,
                self.focus == Focus::Content,
            );
            return;
        };
        let markdown = self.conversation_markdown();
        let starts = self.message_row_starts();
        let inner_top = area.y.saturating_add(1);
        let inner_rows = area.height.saturating_sub(2);
        for (index, start) in starts.iter().enumerate() {
            let end = starts.get(index + 1).copied().unwrap_or(usize::MAX);
            let start_row = u16::try_from(*start).unwrap_or(u16::MAX);
            if start_row < self.content_scroll {
                continue;
            }
            let offset = start_row - self.content_scroll;
            if offset >= inner_rows {
                break;
            }
            let height = u16::try_from(end.saturating_sub(*start))
                .unwrap_or(u16::MAX)
                .min(inner_rows - offset)
                .max(1);
            self.hits.push(HitRegion {
                rect: Rect::new(
                    area.x.saturating_add(1),
                    inner_top.saturating_add(offset),
                    area.width.saturating_sub(2),
                    height,
                ),
                action: HitAction::Message(index),
            });
        }
        let thread_hint = if self.thread_stack.is_empty() {
            String::new()
        } else {
            format!(" · thread depth {}", self.thread_stack.len())
        };
        let title = format!(
            " {} {} · {}{thread_hint} ",
            if conversation.kind.is_dm() {
                "●"
            } else {
                "#"
            },
            conversation.name,
            conversation.kind.label()
        );
        let (rendered, image_placements) = render_markdown_for(&markdown, graphics.is_some());
        let paragraph = Paragraph::new(rendered)
            .block(
                Block::default()
                    .borders(if graphics.is_some() {
                        Borders::NONE
                    } else {
                        Borders::ALL
                    })
                    .title(title),
            )
            .wrap(Wrap { trim: false })
            .scroll((self.content_scroll, 0));
        render_paragraph(
            frame,
            area,
            paragraph,
            graphics,
            Tone::Content,
            self.focus == Focus::Content,
        );
        if self.osc8_links {
            collect_url_runs(frame.buffer_mut(), area, &markdown, &mut self.link_runs);
            self.collect_message_links(frame.buffer_mut(), area, &starts);
        }
        let (cell_w, cell_h) = self.cell_size;
        self.collect_image_runs(frame.buffer_mut(), area, &image_placements, cell_w, cell_h);
    }

    fn collect_message_links(&mut self, buffer: &Buffer, area: Rect, starts: &[usize]) {
        let messages = self.visible_messages();
        let inner_top = area.y.saturating_add(1);
        let inner_rows = area.height.saturating_sub(2);
        for (index, message) in messages.iter().enumerate() {
            if message.permalink.is_empty() {
                continue;
            }
            let Some(start) = starts.get(index) else {
                continue;
            };
            let start_row = u16::try_from(*start).unwrap_or(u16::MAX);
            if start_row < self.content_scroll {
                continue;
            }
            let offset = start_row - self.content_scroll;
            if offset >= inner_rows {
                break;
            }
            for probe in 0..3u16 {
                let y = inner_top.saturating_add(offset).saturating_add(probe);
                if y >= area.bottom() {
                    break;
                }
                let row = row_text(buffer, area, y);
                let Some(byte_index) = row.find("open ↗") else {
                    continue;
                };
                let Ok(column) = u16::try_from(row[..byte_index].chars().count()) else {
                    break;
                };
                self.link_runs.push(LinkRun {
                    x: area.x.saturating_add(column),
                    y,
                    text: "open ↗".to_string(),
                    url: message.permalink.clone(),
                });
                break;
            }
        }
    }

    fn render_files(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        self.hits.push(HitRegion {
            rect: area,
            action: HitAction::Focus(Focus::Content),
        });
        let files: Vec<SlackFile> = self.filtered_files().into_iter().cloned().collect();
        let mut items = Vec::new();
        let mut row = list_origin(area, graphics.is_some(), true);
        let row_budget = usize::from(area.height.saturating_sub(2)).max(1);
        let visible = (row_budget / 3).max(1);
        keep_visible(self.selected_file, &mut self.file_offset, visible);
        self.file_offset = self.file_offset.min(files.len().saturating_sub(visible));
        if files.is_empty() {
            items.push(ListItem::new(
                "No recent files. Ctrl-R refreshes the visible seven-day window.",
            ));
        }
        let mut previous_date = None;
        let mut used_rows = 0usize;
        for (index, file) in files.iter().enumerate().skip(self.file_offset) {
            let section = date_section(&file.updated_at);
            let starts_date = section
                .as_ref()
                .is_some_and(|section| previous_date.as_deref() != Some(section.key.as_str()));
            let needed = 2 + usize::from(starts_date);
            if used_rows + needed > row_budget {
                break;
            }
            if starts_date {
                let section = section.as_ref().expect("checked above");
                items.push(date_header(section));
                previous_date = Some(section.key.clone());
                row = row.saturating_add(1);
                used_rows += 1;
            }
            let selected = index == self.selected_file;
            let style = if selected {
                Style::default().bg(palette().selection)
            } else {
                Style::default()
            };
            items.push(
                ListItem::new(Line::from(vec![
                    Span::styled(
                        if file.is_canvas() { " ▤ " } else { " ▱ " },
                        Style::default().fg(if file.is_canvas() { PURPLE() } else { CYAN() }),
                    ),
                    Span::styled(
                        file.title.clone(),
                        Style::default().fg(FG()).add_modifier(Modifier::BOLD),
                    ),
                ]))
                .style(style),
            );
            items.push(
                ListItem::new(Line::from(Span::styled(
                    format!(
                        "   {} · {} · {}",
                        file.file_type,
                        file.author,
                        short_time(&file.updated_at)
                    ),
                    Style::default().fg(MUTED()),
                )))
                .style(style),
            );
            self.hits.push(HitRegion {
                rect: Rect::new(area.x + 1, row, area.width.saturating_sub(2), 2),
                action: HitAction::File(index),
            });
            row = row.saturating_add(2);
            used_rows += 2;
        }
        let list = List::new(items).block(
            Block::default()
                .borders(if graphics.is_some() {
                    Borders::NONE
                } else {
                    Borders::ALL
                })
                .title(format!(
                    " Recent files · {} · {}/{} ",
                    files.len(),
                    self.selected_file.saturating_add(1).min(files.len()),
                    files.len().max(1),
                )),
        );
        render_list(
            frame,
            area,
            list,
            graphics,
            Tone::Content,
            self.focus == Focus::Content,
        );
    }

    fn render_file_detail(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        self.hits.push(HitRegion {
            rect: area,
            action: HitAction::Focus(Focus::Detail),
        });
        let (title, markdown) = self.selected_file().map_or_else(
            || ("File preview".to_string(), "_Select a file._".to_string()),
            |file| {
                let body = if file.content_markdown.is_empty() {
                    format!(
                        "# {}\n\n**{}** · {}\n\nPress Enter or click to fetch Canvas content as Markdown.\n\n[Open in Slack]({})",
                        file.title, file.file_type, file.author, file.permalink
                    )
                } else {
                    file.content_markdown.clone()
                };
                (format!("{} · Markdown", file.title), body)
            },
        );
        let (rendered, image_placements) = render_markdown_for(&markdown, graphics.is_some());
        let paragraph = Paragraph::new(rendered)
            .block(
                Block::default()
                    .borders(if graphics.is_some() {
                        Borders::NONE
                    } else {
                        Borders::ALL
                    })
                    .title(format!(" {title} ")),
            )
            .wrap(Wrap { trim: false })
            .scroll((self.detail_scroll, 0));
        render_paragraph(
            frame,
            area,
            paragraph,
            graphics,
            Tone::Detail,
            self.focus == Focus::Detail,
        );
        if self.osc8_links {
            collect_url_runs(frame.buffer_mut(), area, &markdown, &mut self.link_runs);
        }
        let (cell_w, cell_h) = self.cell_size;
        self.collect_image_runs(frame.buffer_mut(), area, &image_placements, cell_w, cell_h);
    }

    fn render_footer(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        let error = self.last_error.as_ref().map(|error| preview(error, 120));
        let line = error.map_or_else(
            || {
                Line::from(vec![
                    Span::styled(" 1-6", key_style()),
                    Span::raw(" views  "),
                    Span::styled("↑↓/jk", key_style()),
                    Span::raw(" move  "),
                    Span::styled("Enter", key_style()),
                    Span::raw(" open/thread  "),
                    Span::styled("q", key_style()),
                    Span::raw(" back  "),
                    Span::styled("\\", key_style()),
                    Span::raw(" sidebar  "),
                    Span::styled("f", key_style()),
                    Span::raw(" full  "),
                    Span::styled("Ctrl-R", key_style()),
                    Span::raw(" refresh  "),
                    Span::styled("/", key_style()),
                    Span::raw(" filter  "),
                    Span::styled("?", key_style()),
                    Span::raw(" help  "),
                    Span::styled("Ctrl-C", key_style()),
                    Span::raw(" quit"),
                ])
            },
            |error| {
                Line::from(vec![
                    Span::styled(
                        " ! ",
                        Style::default().fg(RED()).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(error, Style::default().fg(RED())),
                ])
            },
        );
        let paragraph = Paragraph::new(line).style(Style::default().fg(FG()));
        if let Some((runtime, sink)) = graphics {
            // A one-row strip cannot use pane chrome: uniform vertical padding
            // reduces its inner rect to zero and makes every footer glyph
            // disappear. Header chrome is deliberately unpadded.
            render_decorated(
                paragraph,
                &header_chrome(Tone::Dark),
                area,
                frame.buffer_mut(),
                runtime,
                sink,
            );
        } else {
            frame.render_widget(paragraph, area);
        }
    }

    fn render_help(&self, frame: &mut Frame<'_>, area: Rect) {
        let width = area.width.min(72);
        let height = area.height.min(23);
        let popup = centered_rect(width, height, area);
        frame.render_widget(Clear, popup);
        let help = Text::from(vec![
            Line::from(Span::styled("Slick · keyboard and mouse", Style::default().fg(PURPLE()).add_modifier(Modifier::BOLD))),
            Line::default(),
            Line::from(vec![Span::styled("1-6 / ←→", key_style()), Span::raw("  Activity, Feed, Favorites, DMs, Channels, Files")]),
            Line::from(vec![Span::styled("↑↓ / j k", key_style()), Span::raw("  Move selection, message or scroll focused content")]),
            Line::from(vec![Span::styled("g g / G / 0", key_style()), Span::raw(" Top, bottom and home (Vim-style)")]),
            Line::from(vec![Span::styled("Enter", key_style()), Span::raw("       Open conversation/file, or open a thread on a reply-bearing message")]),
            Line::from(vec![Span::styled("\\ / f", key_style()), Span::raw("       Toggle sidebar, fullscreen the Markdown pane")]),
            Line::from(vec![Span::styled("Tab", key_style()), Span::raw("         Cycle focus; also restores a hidden sidebar")]),
            Line::from(vec![Span::styled("Ctrl-R", key_style()), Span::raw("      Refresh only the visible view plus DM list")]),
            Line::from(vec![Span::styled("Ctrl-U/D", key_style()), Span::raw("    Page rich content up/down")]),
            Line::from(vec![Span::styled("/", key_style()), Span::raw("           Filter cached names/files locally")]),
            Line::from(vec![Span::styled("Esc", key_style()), Span::raw("         Clear filter or close this help")]),
            Line::from(vec![Span::styled("q", key_style()), Span::raw("           Pop thread, fullscreen, sidebar or conversation")]),
            Line::from(vec![Span::styled("Ctrl-C", key_style()), Span::raw("      Quit")]),
            Line::default(),
            Line::from(Span::styled("Mouse", Style::default().fg(CYAN()).add_modifier(Modifier::BOLD))),
            Line::raw("Click navigation, conversations, notifications and files. Scroll the focused pane with the wheel."),
            Line::default(),
            Line::from(Span::styled("Refresh contract", Style::default().fg(GREEN()).add_modifier(Modifier::BOLD))),
            Line::raw(if self.smart_client && self.fallback_worker.is_some() {
                "Smart client fallback: Ctrl-R refreshes through the leased read-only collector."
            } else if self.smart_client {
                "Smart client: cache and daemon SSE are merged; Ctrl-R waits for source data."
            } else {
                "Live worker: Ctrl-R refreshes the sidebar, then only the active view."
            }),
            Line::default(),
            Line::from(Span::styled(
                "Read-only: Slick never sends, edits, reacts, joins or marks messages read in Slack.",
                Style::default().fg(YELLOW()),
            )),
        ]);
        frame.render_widget(
            Paragraph::new(help)
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(PURPLE()))
                        .title(" Help "),
                )
                .wrap(Wrap { trim: false }),
            popup,
        );
    }
}

impl Drop for App {
    fn drop(&mut self) {
        if let Some(worker) = &self.worker {
            worker.stop();
        }
        if let Some(worker) = &self.fallback_worker {
            worker.stop();
        }
    }
}

#[derive(Clone, Copy)]
enum Tone {
    Purple,
    Sidebar,
    Content,
    Detail,
    Dark,
}

fn chrome(tone: Tone, focused: bool) -> Chrome {
    let theme = palette();
    let (top, bottom, rail) = match tone {
        Tone::Purple => (
            theme.chrome_header.0,
            theme.chrome_header.1,
            theme.chrome_sidebar.2,
        ),
        Tone::Sidebar => theme.chrome_sidebar,
        Tone::Content => theme.chrome_content,
        Tone::Detail => theme.chrome_detail,
        Tone::Dark => theme.chrome_dark,
    };
    let rail = if focused { "#f2c766ff" } else { rail };
    Chrome::default()
        .background(Background::Linear {
            direction: KittuiDirection::Vertical,
            start: Rgba::parse(top).unwrap_or_else(|_| Rgba::rgb(0x17, 0x18, 0x20)),
            end: Rgba::parse(bottom).unwrap_or_else(|_| Rgba::rgb(0x10, 0x11, 0x17)),
        })
        .border(Border::rounded(
            Rgba::parse(rail).unwrap_or_else(|_| Rgba::rgb(0x7c, 0x5c, 0xfc)),
            if focused { 2.0 } else { 1.0 },
            8.0,
        ))
        .shadow(Shadow {
            dx_px: 2.0,
            dy_px: 2.0,
            color: Rgba::rgba(0, 0, 0, 0x88),
        })
        .padding(Padding::uniform(1))
}

fn header_chrome(tone: Tone) -> Chrome {
    let theme = palette();
    let (start, end) = match tone {
        Tone::Purple => theme.chrome_header,
        _ => theme.chrome_header_dark,
    };
    Chrome::default()
        .background(Background::Linear {
            direction: KittuiDirection::Horizontal,
            start: Rgba::parse(start).unwrap_or_else(|_| Rgba::rgb(0x17, 0x18, 0x20)),
            end: Rgba::parse(end).unwrap_or_else(|_| Rgba::rgb(0x11, 0x12, 0x19)),
        })
        .padding(Padding::default())
}

fn render_title(
    frame: &mut Frame<'_>,
    area: Rect,
    title: String,
    graphics: Option<(&Runtime, &EffectsSink)>,
    tone: Tone,
) {
    let paragraph = Paragraph::new(title).style(
        Style::default()
            .fg(Color::White)
            .bg(if graphics.is_some() {
                Color::Reset
            } else {
                SLACK_PURPLE()
            })
            .add_modifier(Modifier::BOLD),
    );
    if let Some((runtime, sink)) = graphics {
        render_decorated(
            paragraph,
            &header_chrome(tone),
            area,
            frame.buffer_mut(),
            runtime,
            sink,
        );
    } else {
        frame.render_widget(paragraph, area);
    }
}

/// Pane block with a focus-visible border.
///
/// Under Kitty chrome the border is drawn by the graphics underlay, so the
/// Ratatui block stays borderless; the focused rail colour still marks focus.
/// Without graphics the border itself is recoloured so focus is obvious.
fn pane_block(graphics: bool, focused: bool, title: String) -> Block<'static> {
    let mut block = Block::default().borders(if graphics {
        Borders::NONE
    } else {
        Borders::ALL
    });
    // Ratatui reserves a title row even for an empty title. The sidebar used
    // to render one row below its manually calculated hit regions because its
    // empty title silently consumed that row in graphical mode.
    if !title.is_empty() {
        block = block.title(title);
    }
    if !graphics {
        block = block.border_style(if focused {
            Style::default().fg(YELLOW()).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(MUTED())
        });
    }
    block
}

fn render_list(
    frame: &mut Frame<'_>,
    area: Rect,
    list: List<'_>,
    graphics: Option<(&Runtime, &EffectsSink)>,
    tone: Tone,
    focused: bool,
) {
    if let Some((runtime, sink)) = graphics {
        render_decorated(
            list,
            &chrome(tone, focused),
            area,
            frame.buffer_mut(),
            runtime,
            sink,
        );
    } else {
        frame.render_widget(list, area);
    }
}

fn render_paragraph(
    frame: &mut Frame<'_>,
    area: Rect,
    paragraph: Paragraph<'_>,
    graphics: Option<(&Runtime, &EffectsSink)>,
    tone: Tone,
    focused: bool,
) {
    if let Some((runtime, sink)) = graphics {
        render_decorated(
            paragraph,
            &chrome(tone, focused),
            area,
            frame.buffer_mut(),
            runtime,
            sink,
        );
    } else {
        frame.render_widget(paragraph, area);
    }
}

/// First row of list content inside `area` for hit-region mapping.
///
/// With Kitty chrome the widget is rendered into `Chrome::inner_rect`, which
/// applies one cell of padding; a Ratatui `Block` title then consumes one more
/// row. Hit regions must use the same origin as the rendered rows or clicks
/// land on the neighbouring entry.
fn list_origin(area: Rect, graphics: bool, titled: bool) -> u16 {
    let widget_area = if graphics {
        // Use the exact component geometry instead of duplicating the current
        // padding constant. This stays correct as Ratakittui evolves.
        chrome(Tone::Content, false).inner_rect(area)
    } else {
        area
    };
    let title = if titled { "list" } else { "" };
    pane_block(graphics, false, title.to_string())
        .inner(widget_area)
        .y
}

fn render_decorated<W: Widget>(
    widget: W,
    chrome: &Chrome,
    area: Rect,
    buffer: &mut Buffer,
    runtime: &Runtime,
    sink: &EffectsSink,
) {
    let effects = render_chrome_underlay(area, chrome, runtime);
    widget.render(chrome.inner_rect(area), buffer);
    sink.push(effects);
}

fn render_chrome_underlay(area: Rect, chrome: &Chrome, runtime: &Runtime) -> RenderEffects {
    // Ratakittui 0.2 builds layer geometry from the absolute Ratatui `Rect`
    // while rasterizing into a footprint-sized image. For any pane whose x/y
    // is non-zero, that draws the chrome offset *inside its own image* and
    // clips most (or all) of it before Kitty then places the image at x/y a
    // second time. Build layer geometry in image-local coordinates and retain
    // the absolute footprint only for terminal placement.
    let local_area = Rect::new(0, 0, area.width, area.height);
    let Some(mut scene) = chrome.to_scene(local_area) else {
        return RenderEffects::default();
    };
    scene.footprint = CellRect::new(area.x, area.y, area.width, area.height);
    let id = scene.id();
    // Ratakittui's default unicode placement uses implicit z=0 placements.
    // In Ghostty (and especially through tmux), repeated frames can accumulate
    // those placeholders as offset strips and they cover Ratatui text. Slick's
    // chrome is an underlay, so use one stable absolute placement per scene at
    // z=-1: no placeholder grid, no placement accumulation, text remains above.
    let options = chrome_underlay_options(id.kitty_image_id());
    runtime
        .place_at_with_options_by_id(&scene, scene.footprint, &options, &id)
        .map_or_else(
            |_| RenderEffects::default(),
            |placement| RenderEffects::from_placement(placement, id),
        )
}

/// Collect hyperlink runs for text already rendered into `buffer`.
///
/// Ratatui measures cell widths with `unicode-width`, so escape bytes must
/// never be written into buffer symbols: the miscount makes the frame diff
/// skip neighbouring cells and leaves stale text behind. Slick therefore
/// records link positions here and emits OSC 8 directly to the terminal after
/// the frame flush, exactly like its Kitty graphics transactions.
fn collect_url_runs(buffer: &Buffer, area: Rect, source: &str, runs: &mut Vec<LinkRun>) {
    let urls = extract_urls(source);
    if urls.is_empty() || area.width == 0 || area.height == 0 {
        return;
    }
    for y in area.y..area.bottom() {
        let row = row_text(buffer, area, y);
        if !row.contains("http") {
            continue;
        }
        for url in &urls {
            let mut search_from = 0;
            while let Some(found) = row[search_from..].find(url.as_str()) {
                let byte_index = search_from + found;
                search_from = byte_index + url.len();
                let column = row[..byte_index].chars().count();
                let Ok(column) = u16::try_from(column) else {
                    continue;
                };
                runs.push(LinkRun {
                    x: area.x.saturating_add(column),
                    y,
                    text: url.clone(),
                    url: url.clone(),
                });
            }
        }
    }
}

fn row_text(buffer: &Buffer, area: Rect, y: u16) -> String {
    (area.x..area.right())
        .map(|x| buffer[(x, y)].symbol().chars().next().unwrap_or(' '))
        .collect()
}

/// Escape sequence announcing `count` new mentions/unread DMs.
///
/// Emitted after the frame flush, exactly like the OSC 8 link runs: escapes
/// must never reach Ratatui buffer symbols or `unicode-width` miscounts them.
/// OSC 777 is what Ghostty/kitty understand for desktop notifications, and the
/// bell is appended as the universal fallback.
fn alert_sequence(mode: AlertMode, count: usize) -> Option<String> {
    if count == 0 {
        return None;
    }
    match mode {
        AlertMode::Off => None,
        AlertMode::Bell => Some("\x07".to_string()),
        AlertMode::Notify => {
            let body = if count == 1 {
                "1 new mention or DM".to_string()
            } else {
                format!("{count} new mentions or DMs")
            };
            Some(format!("\x1b]777;notify;Slick;{body}\x07\x07"))
        }
    }
}

fn write_link_runs<W: Write>(writer: &mut W, runs: &[LinkRun]) -> io::Result<()> {
    if runs.is_empty() {
        return Ok(());
    }
    let mut out = String::new();
    for run in runs {
        let _ = write!(
            out,
            "\x1b[{};{}H\x1b]8;;{}\x07\x1b[4;36m{}\x1b[0m\x1b]8;;\x07",
            run.y.saturating_add(1),
            run.x.saturating_add(1),
            run.url,
            run.text
        );
    }
    writer.write_all(out.as_bytes())?;
    writer.flush()
}

/// Draw inline images over their reserved placeholder cells.
///
/// Emoji are placed at z above the text so the reserved blanks are covered,
/// with `C=1` (guaranteed by the placement builder) so the terminal cursor
/// never advances and the line cannot reflow. Placement ids are derived from
/// the image and its cell position, so a redraw replaces rather than stacks.
fn place_image_runs(graphics: &mut Graphics, runs: &[ImageRun], store: &mut ImageStore) -> String {
    let mut out = String::new();
    let mut current = HashMap::new();
    for run in runs {
        let Some(image) = store.get(&run.url) else {
            continue;
        };
        let key = format!("img:{}:{}:{}", run.url, run.x, run.y);
        let image_id = images::stable_hash(&key);
        let image_id = u32::from_str_radix(&image_id[..8], 16).unwrap_or(1) | 1;
        let footprint = CellRect::new(run.x, run.y, run.cols, run.rows);
        current.insert(key.clone(), (image_id, footprint));
        if graphics
            .placed_images
            .get(&key)
            .is_some_and(|placed| *placed == (image_id, footprint))
        {
            continue;
        }
        let options = PlacementOptions::absolute_with_id(image_id)
            .with_z_index(1)
            .without_cursor_advance();
        let placement = graphics.runtime.place_png_frame_with_options(
            image_id,
            image.bytes.as_slice(),
            footprint,
            &options,
        );
        out.push_str(&placement.upload);
        out.push_str(&placement.placement);
    }
    // A scroll changes image screen coordinates. Placements from the previous
    // frame that are no longer present must be explicitly deleted; otherwise
    // Kitty keeps every historical coordinate and paints a vertical stack.
    for (key, (image_id, _)) in &graphics.placed_images {
        if !current.contains_key(key) {
            out.push_str(&graphics.runtime.unplace(*image_id));
        }
    }
    graphics.placed_images = current;
    out
}

fn finalize_graphics_frame(graphics: &mut Graphics, sink: &EffectsSink) -> DrawFlush {
    let mut flush = DrawFlush::default();
    let mut current = HashMap::new();
    for effects in sink.drain() {
        graphics.tracker.keep(&effects);
        if let (Some(scene_id), Some(image_id), Some(footprint)) = (
            effects.scene_id.as_ref(),
            effects.image_id,
            effects.footprint,
        ) {
            let key = scene_id.0.clone();
            let unchanged = graphics
                .placed
                .get(&key)
                .is_some_and(|placed| *placed == (image_id, footprint));
            current.insert(key, (image_id, footprint));
            if !unchanged {
                flush.upload.push_str(&effects.upload);
                // Runtime placements are cursor-anchored and already include
                // the absolute move for `footprint`. The placement options now
                // carry Kitty's `C=1` contract directly, so no transport-fragile
                // escape-string surgery is needed here.
                flush.placement.push_str(&effects.placement);
                flush.placement.push_str(&effects.embed);
            }
        } else {
            flush.upload.push_str(&effects.upload);
            flush.placement.push_str(&effects.placement);
            flush.placement.push_str(&effects.embed);
        }
    }
    for image_id in graphics.tracker.end_frame() {
        flush.deletes.push_str(&graphics.runtime.unplace(image_id));
    }
    graphics.placed = current;
    flush
}

fn write_graphics_flush<W: Write>(writer: &mut W, flush: &DrawFlush) -> io::Result<()> {
    if flush.is_empty() {
        return Ok(());
    }
    // Crossterm starts every Ratatui diff with an absolute cursor move. Do not
    // wrap Kitty traffic in DECSC/DECRC or CSI save/restore: terminals disagree
    // about the modes restored by those sequences, and Ghostty can subsequently
    // interpret every Ratatui coordinate one row lower. Leaving the cursor at
    // the last placement origin is harmless because the next text draw anchors
    // itself absolutely.
    writer.write_all(flush.upload.as_bytes())?;
    writer.write_all(flush.placement.as_bytes())?;
    writer.write_all(flush.deletes.as_bytes())?;
    writer.flush()
}

fn chrome_underlay_options(image_id: u32) -> PlacementOptions {
    PlacementOptions::absolute_with_id(image_id)
        .with_z_index(-1)
        .without_cursor_advance()
}

fn conversation_line(
    conversation: &Conversation,
    marker: &str,
    unread: String,
    width: usize,
) -> Line<'static> {
    let active = conversation.unread_count > 0
        || conversation.activity_ts() >= CacheState::seven_days_ago() as f64;
    Line::from(vec![
        Span::styled(
            if conversation.is_favorite {
                " ★"
            } else {
                "  "
            },
            Style::default().fg(YELLOW()),
        ),
        Span::styled(
            format!("{marker} "),
            Style::default().fg(if active { GREEN() } else { MUTED() }),
        ),
        Span::styled(
            format!("{:<width$}", truncate_label(&conversation.name, width)),
            Style::default()
                .fg(if conversation.unread_count > 0 {
                    Color::White
                } else {
                    FG()
                })
                .add_modifier(if conversation.unread_count > 0 {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                }),
        ),
        Span::styled(
            unread,
            Style::default().fg(GREEN()).add_modifier(Modifier::BOLD),
        ),
    ])
}

fn unread_badge(conversation: &Conversation) -> String {
    if conversation.unread_count == 0 {
        String::new()
    } else {
        format!("{}", conversation.unread_count.min(99))
    }
}

fn truncate_label(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut value: String = value.chars().take(max.saturating_sub(1)).collect();
    value.push('…');
    value
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct DateSection {
    key: String,
    label: String,
}

fn date_section(timestamp: &str) -> Option<DateSection> {
    let local = DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .map(|date| date.with_timezone(&Local))
        .or_else(|| {
            timestamp
                .parse::<f64>()
                .ok()
                .and_then(|seconds| DateTime::<Utc>::from_timestamp(seconds as i64, 0))
                .map(|date| date.with_timezone(&Local))
        })?;
    let day = local.day();
    let suffix = if (11..=13).contains(&(day % 100)) {
        "th"
    } else {
        match day % 10 {
            1 => "st",
            2 => "nd",
            3 => "rd",
            _ => "th",
        }
    };
    Some(DateSection {
        key: local.format("%Y-%m-%d").to_string(),
        label: format!(
            "{} {day}{suffix} {}",
            local.format("%A"),
            local.format("%B")
        ),
    })
}

fn date_header(section: &DateSection) -> ListItem<'static> {
    ListItem::new(Line::from(Span::styled(
        format!("  {}", section.label),
        Style::default().fg(MUTED()).add_modifier(Modifier::BOLD),
    )))
}

fn compact_age(seconds: u64) -> String {
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3_600 {
        format!("{}m", seconds / 60)
    } else {
        format!("{}h {}m", seconds / 3_600, (seconds % 3_600) / 60)
    }
}

fn snapshot_age(saved_at: Option<i64>) -> String {
    let Some(saved_at) = saved_at else {
        return "snapshot uncached".into();
    };
    let age = CacheState::now().saturating_sub(saved_at);
    if age < 5 {
        "snapshot fresh".into()
    } else if age < 60 {
        // Bucketed to 5s: the redraw gate repaints whenever this label
        // changes, and second-by-second precision here is worth nothing
        // visually while costing a full frame rebuild every second.
        format!("snapshot {}s stale", (age / 5) * 5)
    } else if age < 3_600 {
        format!("snapshot {}m stale", age / 60)
    } else if age < 86_400 {
        format!("snapshot {}h {}m stale", age / 3_600, (age % 3_600) / 60)
    } else {
        format!("snapshot {}d stale", age / 86_400)
    }
}

fn short_time(value: &str) -> String {
    if let Some(time) = value.split('T').nth(1) {
        return time.chars().take(5).collect();
    }
    value.chars().take(16).collect()
}

fn key_style() -> Style {
    Style::default().fg(CYAN()).add_modifier(Modifier::BOLD)
}

fn clamp_index(index: usize, len: usize) -> usize {
    if len == 0 {
        0
    } else {
        index.min(len - 1)
    }
}

fn offset_index(index: usize, len: usize, delta: isize) -> usize {
    if len == 0 {
        return 0;
    }
    if delta < 0 {
        index.saturating_sub(delta.unsigned_abs())
    } else {
        index.saturating_add(delta.unsigned_abs()).min(len - 1)
    }
}

fn keep_visible(selected: usize, offset: &mut usize, visible: usize) {
    let visible = visible.max(1);
    if selected < *offset {
        *offset = selected;
    } else if selected >= offset.saturating_add(visible) {
        *offset = selected.saturating_add(1).saturating_sub(visible);
    }
}

fn wrapped_markdown_rows(source: &str, viewport_width: u16) -> usize {
    Paragraph::new(render_markdown(source))
        .wrap(Wrap { trim: false })
        .line_count(viewport_width.saturating_sub(4).max(1))
        .max(1)
}

fn scroll_max(rows: usize, viewport_height: u16) -> u16 {
    let visible = usize::from(viewport_height.saturating_sub(2).max(1));
    u16::try_from(rows.saturating_sub(visible)).unwrap_or(u16::MAX)
}

fn contains(rect: Rect, column: u16, row: u16) -> bool {
    column >= rect.x
        && column < rect.x.saturating_add(rect.width)
        && row >= rect.y
        && row < rect.y.saturating_add(rect.height)
}

fn centered_rect(width: u16, height: u16, area: Rect) -> Rect {
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width.min(area.width),
        height.min(area.height),
    )
}

pub struct RunOptions {
    pub demo: bool,
    pub no_graphics: bool,
    pub cache_store: CacheStore,
    pub client: Option<ClientOptions>,
    pub initial_page: Page,
    pub config: Config,
    pub config_path: PathBuf,
}

pub fn run(options: RunOptions) -> Result<()> {
    let initial = if options.demo {
        crate::slack::demo_state()
    } else if options
        .client
        .as_ref()
        .is_some_and(|client| !client.use_cache)
    {
        CacheState::default()
    } else {
        options.cache_store.load().unwrap_or_default()
    };
    let mut app = if options.demo {
        App::demo(initial)
    } else if let Some(client) = options.client {
        App::client(initial, client)
    } else {
        App::live(initial, options.cache_store)
    };
    app.apply_config(options.config.clone(), options.config_path.clone());
    // Persisted history must be fully visible on the first frame. Only later
    // daemon/network deltas enter the paced-arrival queue.
    app.feed.seed(&app.state);
    app.set_page(options.initial_page);
    app.osc8_links = true;
    let mut stdout = io::stdout();
    enable_raw_mode().context("enable terminal raw mode")?;
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture).context("enter Slick screen")?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).context("initialize Slick terminal")?;
    terminal.clear().context("clear Slick terminal")?;
    let mut graphics = if options.no_graphics {
        None
    } else {
        Graphics::new().ok()
    };

    let result = run_loop(&mut terminal, &mut app, graphics.as_mut());

    if let Some(graphics) = graphics.as_mut() {
        graphics.tracker.begin_frame();
        let sink = EffectsSink::new();
        let flush = finalize_graphics_frame(graphics, &sink);
        let _ = write_graphics_flush(terminal.backend_mut(), &flush);
    }
    disable_raw_mode().ok();
    execute!(
        terminal.backend_mut(),
        DisableMouseCapture,
        LeaveAlternateScreen
    )
    .ok();
    terminal.show_cursor().ok();
    result
}

const MAX_EVENT_BATCH: usize = 256;

/// Keep every semantic input event while collapsing consecutive drag samples
/// to the newest pointer coordinate. Terminals can report hundreds of drag
/// positions faster than graphical chrome can rasterize them; replaying each
/// stale coordinate makes the divider visibly trail the pointer.
fn coalesce_input_events(events: Vec<Event>) -> Vec<Event> {
    let mut output = Vec::with_capacity(events.len());
    let mut pending_drag = None;
    for event in events {
        if matches!(
            event,
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::Drag(_),
                ..
            })
        ) {
            pending_drag = Some(event);
        } else {
            if let Some(drag) = pending_drag.take() {
                output.push(drag);
            }
            output.push(event);
        }
    }
    if let Some(drag) = pending_drag {
        output.push(drag);
    }
    output
}

fn run_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
    mut graphics: Option<&mut Graphics>,
) -> Result<()> {
    let mut dirty = true;
    let mut last_timer_tick = Instant::now();
    // Automatic refresh keeps the workday view live without a keypress. It is
    // deliberately driven from the UI loop (not a timer thread) so it can skip
    // a cycle whenever the worker is still busy.
    let auto_refresh_interval = app.auto_refresh_interval();
    let mut last_auto_refresh = Instant::now();
    let mut last_staleness = app.staleness_label();
    let mut last_liveness_tick = app.liveness_tick();
    while !app.should_quit {
        dirty |= app.drain_worker();
        if let Some(interval) = auto_refresh_interval {
            if last_auto_refresh.elapsed() >= interval {
                // Reset the clock even when the worker was busy, so a slow
                // call spaces the next attempt instead of firing immediately.
                last_auto_refresh = Instant::now();
                dirty |= app.auto_refresh();
            }
        }
        if last_timer_tick.elapsed() >= Duration::from_millis(120) {
            // The feed releases queued arrivals on a cadence, so tick faster
            // than the staleness clock and repaint when it emits.
            let released = app.feed.tick(Instant::now());
            if released > 0 {
                dirty = true;
            }
            let liveness_tick = app.liveness_tick();
            if liveness_tick != last_liveness_tick {
                last_liveness_tick = liveness_tick;
                dirty = true;
            }
            if last_timer_tick.elapsed() >= Duration::from_secs(1) {
                last_timer_tick = Instant::now();
                // Repaint for staleness only when the rendered label actually
                // changes. Unconditionally marking dirty here rebuilt and
                // diffed a whole frame every second forever, even with nothing
                // on screen changing - a guaranteed wakeup per second in a TUI
                // meant to sit open all day.
                let staleness = app.staleness_label();
                if staleness != last_staleness {
                    last_staleness = staleness;
                    dirty = true;
                }
            }
        }
        if dirty {
            if let Some(graphics) = graphics.as_deref_mut() {
                graphics.tracker.begin_frame();
                let sink = EffectsSink::new();
                terminal.draw(|frame| app.render(frame, Some((&graphics.runtime, &sink))))?;
                let mut flush = finalize_graphics_frame(graphics, &sink);
                let inline = place_image_runs(graphics, &app.image_runs, &mut app.images);
                flush.placement.push_str(&inline);
                write_graphics_flush(terminal.backend_mut(), &flush)?;
            } else {
                terminal.draw(|frame| app.render(frame, None))?;
            }
            write_link_runs(terminal.backend_mut(), &app.link_runs)?;
            dirty = false;
        }

        if let Some(alert) = app.take_alert_sequence() {
            // After the frame flush, like the OSC 8 runs: escapes must never
            // reach Ratatui buffer symbols.
            terminal.backend_mut().write_all(alert.as_bytes())?;
            terminal.backend_mut().flush()?;
        }

        if event::poll(Duration::from_millis(16))? {
            let mut events = vec![event::read()?];
            while events.len() < MAX_EVENT_BATCH && event::poll(Duration::ZERO)? {
                events.push(event::read()?);
            }
            for event in coalesce_input_events(events) {
                let changed = match event {
                    Event::Key(key) => {
                        app.handle_key(key);
                        true
                    }
                    Event::Mouse(mouse) => app.handle_mouse(mouse),
                    Event::Resize(_, _) | Event::FocusGained | Event::FocusLost => true,
                    Event::Paste(_) => false,
                };
                dirty |= changed;
            }
        }
    }
    Ok(())
}

#[must_use]
pub fn snapshot(state: CacheState, width: u16, height: u16) -> String {
    snapshot_page(state, width, height, Page::Notifications)
}

#[must_use]
pub fn snapshot_page(state: CacheState, width: u16, height: u16, page: Page) -> String {
    snapshot_view(state, width, height, page, false)
}

/// Render a deterministic snapshot, optionally opening the selected item so
/// message/thread layout can be inspected without a live terminal.
#[must_use]
pub fn snapshot_view(state: CacheState, width: u16, height: u16, page: Page, open: bool) -> String {
    snapshot_view_with_config(state, width, height, page, open, &Config::default())
}

/// Snapshot honouring user configuration (theme and favourites overlay).
#[must_use]
pub fn snapshot_view_with_config(
    state: CacheState,
    width: u16,
    height: u16,
    page: Page,
    open: bool,
    config: &Config,
) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("test backend");
    let mut app = App::demo(state);
    app.apply_config(config.clone(), Config::default_path());
    app.prime_feed();
    app.set_page(page);
    if open {
        app.content_view_width = width;
        app.content_view_height = height.saturating_sub(2);
        app.request_selected();
    }
    terminal
        .draw(|frame| app.render(frame, None))
        .expect("render snapshot");
    buffer_text(terminal.backend().buffer())
}

fn buffer_text(buffer: &Buffer) -> String {
    let area = buffer.area;
    let mut output = String::new();
    for y in area.y..area.bottom() {
        let mut line = String::new();
        for x in area.x..area.right() {
            line.push_str(buffer[(x, y)].symbol());
        }
        output.push_str(line.trim_end());
        output.push('\n');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_sections_use_human_weekday_ordinals_and_skip_empty_days() {
        let section = date_section("2026-08-04T12:00:00Z").unwrap();
        assert_eq!(section.label, "Tuesday 4th August");
        let section = date_section("2026-08-03T12:00:00Z").unwrap();
        assert_eq!(section.label, "Monday 3rd August");
    }

    #[test]
    fn feed_date_headers_do_not_capture_click_rows() {
        let mut state = crate::slack::demo_state();
        state.notifications[0].message.timestamp = "2026-08-04T12:00:00Z".into();
        state.notifications[1].message.timestamp = "2026-08-03T12:00:00Z".into();
        let backend = TestBackend::new(120, 36);
        let mut terminal = Terminal::new(backend).unwrap();
        let mut app = App::demo(state);
        app.prime_feed();
        app.set_page(Page::Feed);
        terminal.draw(|frame| app.render(frame, None)).unwrap();
        let header_rows: Vec<u16> = buffer_text(terminal.backend().buffer())
            .lines()
            .enumerate()
            .filter(|(_, line)| line.contains("August"))
            .map(|(row, _)| u16::try_from(row).unwrap())
            .collect();
        assert_eq!(header_rows.len(), 2);
        let clickable_rows: Vec<u16> = app
            .hits
            .iter()
            .filter(|hit| matches!(hit.action, HitAction::FeedEntry(_)))
            .map(|hit| hit.rect.y)
            .collect();
        assert!(
            header_rows.iter().all(|row| !clickable_rows.contains(row)),
            "date headings must remain non-clickable separators"
        );
    }

    #[test]
    fn demo_snapshot_contains_slack_surfaces() {
        let output = snapshot(crate::slack::demo_state(), 120, 36);
        assert!(output.contains("Activity"));
        assert!(output.contains("Direct messages"));
        assert!(output.contains("Channels"));
        assert!(output.contains("Files"));
        assert!(output.contains("Ada Lovelace"));
        assert!(
            output
                .lines()
                .nth(1)
                .is_some_and(|line| line.contains("Activity")),
            "body begins immediately after the one-line header"
        );
        let files = snapshot_page(crate::slack::demo_state(), 140, 40, Page::Files);
        assert!(files.contains("Slick Product Brief"));
        assert!(files.contains("Markdown"));
    }

    #[test]
    fn smart_client_commands_map_to_daemon_refresh_domains() {
        assert_eq!(
            client_refresh_domain(&WorkerCommand::Refresh(RefreshTarget::Notifications)).as_deref(),
            Some("notifications")
        );
        assert_eq!(
            client_refresh_domain(&WorkerCommand::LoadConversation("C1".into())).as_deref(),
            Some("conversation:C1")
        );
        assert_eq!(
            client_refresh_domain(&WorkerCommand::LoadThread {
                conversation_id: "C1".into(),
                thread_ts: "123.45".into(),
            })
            .as_deref(),
            Some("thread:C1:123.45")
        );
        assert_eq!(
            client_refresh_domain(&WorkerCommand::LoadFile("F1".into())).as_deref(),
            Some("file-content:F1")
        );
    }

    #[test]
    fn ctrl_r_targets_visible_view_without_changing_page() {
        let mut app = App::demo(crate::slack::demo_state());
        app.set_page(Page::Files);
        app.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL));
        assert_eq!(app.page, Page::Files);
        assert!(app.status.contains("demo mode"));
    }

    #[test]
    fn mouse_hit_test_and_offset_are_bounded() {
        assert!(contains(Rect::new(2, 3, 4, 5), 2, 3));
        assert!(!contains(Rect::new(2, 3, 4, 5), 6, 3));
        assert_eq!(offset_index(0, 3, -1), 0);
        assert_eq!(offset_index(2, 3, 1), 2);
        assert_eq!(offset_index(0, 3, 1), 1);
    }

    #[test]
    fn mouse_click_activates_hit_region_and_wheel_scrolls() {
        let mut app = App::demo(crate::slack::demo_state());
        app.hits.push(HitRegion {
            rect: Rect::new(10, 4, 12, 1),
            action: HitAction::Page(Page::Files),
        });
        app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 11,
            row: 4,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(app.page, Page::Files);
        app.focus = Focus::Detail;
        app.handle_mouse(MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 70,
            row: 10,
            modifiers: KeyModifiers::NONE,
        });
        assert_eq!(app.detail_scroll, 3);
    }

    #[test]
    fn drag_event_batches_keep_only_the_latest_motion() {
        let mouse = |kind, column| {
            Event::Mouse(MouseEvent {
                kind,
                column,
                row: 8,
                modifiers: KeyModifiers::NONE,
            })
        };
        let events = vec![
            mouse(MouseEventKind::Down(MouseButton::Left), 10),
            mouse(MouseEventKind::Drag(MouseButton::Left), 20),
            mouse(MouseEventKind::Drag(MouseButton::Left), 30),
            mouse(MouseEventKind::Drag(MouseButton::Left), 40),
            mouse(MouseEventKind::Up(MouseButton::Left), 40),
        ];
        let coalesced = coalesce_input_events(events);
        assert_eq!(coalesced.len(), 3, "down, newest drag, and up survive");
        assert!(matches!(
            &coalesced[1],
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::Drag(MouseButton::Left),
                column: 40,
                ..
            })
        ));
    }

    #[test]
    fn list_hit_origins_follow_the_real_decorated_inner_rect() {
        let area = Rect::new(0, 1, 40, 20);
        assert_eq!(list_origin(area, true, false), area.y + 1);
        assert_eq!(list_origin(area, true, true), area.y + 2);
        assert_eq!(list_origin(area, false, false), area.y + 1);
        assert_eq!(list_origin(area, false, true), area.y + 1);
    }

    #[test]
    fn activity_accepts_jk_in_content_focus() {
        let mut app = App::demo(crate::slack::demo_state());
        app.focus = Focus::Content;
        app.handle_key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE));
        assert_eq!(app.selected_notification, 1);
        app.handle_key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::NONE));
        assert_eq!(app.selected_notification, 0);
    }

    #[test]
    fn rich_scroll_is_clamped_to_document_bottom() {
        let mut app = App::demo(crate::slack::demo_state());
        app.set_page(Page::Files);
        app.focus = Focus::Detail;
        app.detail_view_height = 8;
        app.detail_view_width = 40;
        app.scroll_down(u16::MAX);
        let maximum = app.max_detail_scroll();
        assert_eq!(app.detail_scroll, maximum);
        app.scroll_down(u16::MAX);
        assert_eq!(app.detail_scroll, maximum);
    }

    #[test]
    fn graphics_chrome_uses_stable_absolute_underlay() {
        let options = chrome_underlay_options(42);
        assert_eq!(options.placement_id, Some(42));
        assert!(!options.unicode_placeholder);
        assert!(!options.cursor_advance);
        assert_eq!(options.z_index, -1);
    }

    #[test]
    fn one_row_footer_chrome_preserves_a_text_row() {
        let area = Rect::new(0, 20, 80, 1);
        assert_eq!(header_chrome(Tone::Dark).inner_rect(area).height, 1);
        assert_eq!(
            chrome(Tone::Dark, false).inner_rect(area).height,
            0,
            "pane padding would erase a one-row footer"
        );
        let snapshot = snapshot(crate::slack::demo_state(), 120, 20);
        assert!(
            snapshot
                .lines()
                .last()
                .is_some_and(|line| line.contains("1-6")),
            "the footer remains in the terminal viewport"
        );
    }

    #[test]
    fn section_headers_open_complete_inventory_overview() {
        let mut app = App::demo(crate::slack::demo_state());
        app.set_page(Page::Dms);
        assert!(app.section_overview);
        let rendered = snapshot_page(app.state.clone(), 120, 30, Page::Dms);
        assert!(rendered.contains("total"));
        assert!(rendered.contains("Overview"));
    }

    #[test]
    fn snapshot_staleness_timer_is_human_readable() {
        // Sub-minute ages bucket to 5s so an idle Slick is not forced to
        // rebuild a frame every second; 42s therefore reads as 40s.
        assert_eq!(
            snapshot_age(Some(CacheState::now() - 42)),
            "snapshot 40s stale"
        );
        assert_eq!(
            snapshot_age(Some(CacheState::now() - 125)),
            "snapshot 2m stale"
        );
    }

    #[test]
    fn thread_stack_opens_and_pops_without_quitting() {
        let mut app = App::demo(crate::slack::demo_state());
        app.set_page(Page::Dms);
        app.request_selected();
        assert!(!app.section_overview);
        app.selected_message = 0;
        app.request_selected();
        assert_eq!(app.thread_stack.len(), 1);
        assert!(app.visible_messages().len() >= 2);
        app.handle_key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE));
        assert!(app.thread_stack.is_empty());
        assert!(!app.should_quit);
        app.handle_key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE));
        assert!(!app.should_quit);
        app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert!(app.should_quit);
    }

    #[test]
    fn sidebar_and_fullscreen_toggles_are_reversible() {
        let mut app = App::demo(crate::slack::demo_state());
        app.handle_key(KeyEvent::new(KeyCode::Char('\\'), KeyModifiers::NONE));
        assert!(!app.sidebar_visible);
        app.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
        assert!(app.sidebar_visible);
        app.set_page(Page::Files);
        app.handle_key(KeyEvent::new(KeyCode::Char('f'), KeyModifiers::NONE));
        assert!(app.fullscreen_content);
        app.handle_key(KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE));
        assert!(!app.fullscreen_content);
    }

    #[test]
    fn local_favourites_union_slack_stars_without_writing_slack() {
        let dir = std::env::temp_dir().join(format!("slick-fav-{}", std::process::id()));
        let path = dir.join("config.yaml");
        let mut app = App::demo(crate::slack::demo_state());
        app.apply_config(Config::default(), path.clone());
        app.set_page(Page::Dms);
        let id = app.selected_conversation().unwrap().id.clone();
        assert!(!app.selected_conversation().unwrap().is_favorite);

        app.toggle_local_favorite();
        assert!(app.selected_conversation().unwrap().is_favorite);
        assert!(Config::load(&path).unwrap().is_local_favorite(&id));

        app.toggle_local_favorite();
        assert!(!app.selected_conversation().unwrap().is_favorite);
        assert!(!Config::load(&path).unwrap().is_local_favorite(&id));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn theme_cycling_changes_the_active_palette() {
        let dir = std::env::temp_dir().join(format!("slick-theme-{}", std::process::id()));
        let mut app = App::demo(crate::slack::demo_state());
        app.apply_config(Config::default(), dir.join("config.yaml"));
        let before = app.config.theme;
        app.cycle_theme();
        assert_eq!(app.config.theme, ThemeName::Nord);
        // Assert against the pure mapping rather than `palette()`: ACTIVE_THEME
        // is a process-global that parallel tests concurrently overwrite, which
        // made the global-reading form flaky.
        assert_ne!(
            palette_for(app.config.theme).accent,
            palette_for(before).accent
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn auto_refresh_interval_honours_opt_out_and_floor() {
        let mut app = App::demo(crate::slack::demo_state());
        let path = std::env::temp_dir().join("slick-refresh-test/config.yaml");

        // 0 means "manual only": no background traffic at all.
        let config = Config {
            refresh_interval_secs: 0,
            ..Config::default()
        };
        app.apply_config(config, path.clone());
        assert_eq!(app.auto_refresh_interval(), None);

        // A too-eager value is clamped up so config alone cannot throttle the
        // operator's Slack token.
        let config = Config {
            refresh_interval_secs: 1,
            ..Config::default()
        };
        app.apply_config(config, path.clone());
        assert_eq!(
            app.auto_refresh_interval(),
            Some(Duration::from_secs(MIN_AUTO_REFRESH_SECS))
        );

        // A sensible value is used as-is.
        let config = Config {
            refresh_interval_secs: 90,
            ..Config::default()
        };
        app.apply_config(config, path);
        assert_eq!(app.auto_refresh_interval(), Some(Duration::from_secs(90)));
    }

    #[test]
    fn smart_client_without_fallback_never_dispatches_refresh_commands() {
        let mut app = App::new(crate::slack::demo_state(), None, true);
        app.send(WorkerCommand::Bootstrap);
        assert!(!app.busy);
        assert_eq!(app.status, "client · waiting for cache/daemon");
        assert!(!app.auto_refresh());
    }

    #[test]
    fn auto_refresh_is_skipped_while_the_worker_is_busy() {
        let mut app = App::demo(crate::slack::demo_state());
        // Demo mode has no worker, so a cycle must be a no-op rather than
        // spinning or claiming it dispatched work.
        assert!(!app.auto_refresh());
        app.busy = true;
        assert!(!app.auto_refresh(), "a busy worker must not be queued onto");
    }

    #[test]
    fn busy_header_reports_elapsed_liveness_and_slow_work() {
        let mut app = App::demo(crate::slack::demo_state());
        app.busy = true;
        app.busy_since = Some(Instant::now().checked_sub(Duration::from_secs(3)).unwrap());
        let (icon, color, text) = app.header_status();
        assert!(["◐", "◓", "◑", "◒"].contains(&icon));
        assert_eq!(color, YELLOW());
        assert!(text.contains("3s"), "{text}");
        assert!(app.liveness_tick().is_some());

        app.busy_since = Some(Instant::now().checked_sub(Duration::from_secs(46)).unwrap());
        let (_, color, text) = app.header_status();
        assert_eq!(color, RED());
        assert!(text.contains("slow 46s"), "{text}");
    }

    #[test]
    fn smart_client_header_distinguishes_daemon_cache_and_outage_liveness() {
        let mut app = App::new(crate::slack::demo_state(), None, true);
        app.client_health = Some(ClientHealth {
            daemon_enabled: true,
            daemon_connected: true,
            daemon_age_secs: Some(30),
            cache_enabled: true,
            cache_live: true,
            cache_age_secs: Some(60),
            fallback_active: false,
            error: None,
        });
        let (icon, color, text) = app.header_status();
        assert_eq!(icon, "●");
        assert_eq!(color, GREEN());
        assert!(text.contains("daemon (30s)"), "{text}");
        assert!(text.contains("cache (1m)"), "{text}");

        app.client_health.as_mut().unwrap().daemon_connected = false;
        assert_eq!(app.header_status().1, YELLOW());
        app.client_health.as_mut().unwrap().cache_live = false;
        assert_eq!(app.header_status().1, RED());
    }

    #[test]
    fn visible_domain_staleness_exposes_partial_and_rate_limit_state() {
        let now = CacheState::now();
        let mut state = crate::slack::demo_state();
        let domain = state.domain_health_mut("notifications");
        domain.last_success_at = Some(now - 7_200);
        domain.state = RefreshState::Backoff;
        state.collector.rate_limited_until = Some(now + 30);
        let mut app = App::demo(state);
        app.set_page(Page::Feed);
        let status = app.staleness_label();
        assert!(status.contains("activity 2h 0m stale"), "{status}");
        assert!(status.contains("rate limit"), "{status}");
    }

    #[test]
    fn staleness_label_is_stable_between_visible_changes() {
        let now = CacheState::now();
        // Sub-minute ages bucket to 5s, so the redraw gate fires ~5x less
        // rather than rebuilding a frame every second.
        assert_eq!(snapshot_age(Some(now)), "snapshot fresh");
        assert_eq!(snapshot_age(Some(now - 3)), "snapshot fresh");
        assert_eq!(snapshot_age(Some(now - 7)), snapshot_age(Some(now - 9)));
        assert_eq!(snapshot_age(Some(now - 7)), "snapshot 5s stale");
        assert_ne!(snapshot_age(Some(now - 7)), snapshot_age(Some(now - 12)));
        // Coarser bands are unchanged.
        assert_eq!(snapshot_age(Some(now - 90)), "snapshot 1m stale");
        assert_eq!(snapshot_age(None), "snapshot uncached");
    }

    #[test]
    fn alerts_coalesce_and_respect_the_configured_mode() {
        // Off is now the DEFAULT (operator decision): ship silent, opt in.
        assert_eq!(AlertMode::default(), AlertMode::Off);
        assert_eq!(alert_sequence(AlertMode::default(), 9), None);
        // Off never announces, however many arrived.
        assert_eq!(alert_sequence(AlertMode::Off, 9), None);
        // Nothing new is never an announcement.
        assert_eq!(alert_sequence(AlertMode::Bell, 0), None);
        // A burst is ONE bell, not one per item.
        assert_eq!(alert_sequence(AlertMode::Bell, 12).as_deref(), Some("\x07"));
        // Notify carries a count and keeps the bell as a fallback.
        let notify = alert_sequence(AlertMode::Notify, 3).expect("notify sequence");
        assert!(notify.starts_with("\x1b]777;notify;Slick;"));
        assert!(notify.contains("3 new mentions or DMs"));
        assert!(notify.ends_with('\x07'));
        let single = alert_sequence(AlertMode::Notify, 1).expect("notify sequence");
        assert!(single.contains("1 new mention or DM"));
    }

    #[test]
    fn local_read_markers_clear_unread_badges() {
        let dir = std::env::temp_dir().join(format!("slick-read-{}", std::process::id()));
        let mut state = crate::slack::demo_state();
        state.conversations[0].unread_count = 5;
        state.conversations[0].mention_count = 2;
        state.conversations[0].latest_ts = Some("1717171717.000100".into());
        let id = state.conversations[0].id.clone();
        let mut app = App::demo(state);
        app.apply_config(Config::default(), dir.join("config.yaml"));

        // Slack still reports it unread because Slick never sends
        // conversations.mark.
        assert_eq!(app.state.conversations[0].unread_count, 5);

        assert!(app.config.mark_read(&id, "1717171717.000100"));
        app.apply_read_markers();
        assert_eq!(app.state.conversations[0].unread_count, 0);
        assert_eq!(app.state.conversations[0].mention_count, 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_newer_message_makes_a_read_conversation_unread_again() {
        let dir = std::env::temp_dir().join(format!("slick-read-new-{}", std::process::id()));
        let mut state = crate::slack::demo_state();
        state.conversations[0].unread_count = 1;
        state.conversations[0].latest_ts = Some("1717171717.000100".into());
        let id = state.conversations[0].id.clone();
        let mut app = App::demo(state);
        app.apply_config(Config::default(), dir.join("config.yaml"));
        app.config.mark_read(&id, "1717171717.000100");
        app.apply_read_markers();
        assert_eq!(app.state.conversations[0].unread_count, 0);

        // A message arriving after the marker must badge again.
        app.state.conversations[0].unread_count = 3;
        app.state.conversations[0].latest_ts = Some("1717171999.000200".into());
        app.apply_read_markers();
        assert_eq!(app.state.conversations[0].unread_count, 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn favorites_view_lists_starred_conversations() {
        let mut state = crate::slack::demo_state();
        state.conversations[0].is_favorite = true;
        let favorite = state.conversations[0].name.clone();
        let mut app = App::demo(state);
        app.set_page(Page::Favorites);
        assert_eq!(app.filtered_favorites().len(), 1);
        let rendered = snapshot_page(app.state.clone(), 120, 24, Page::Favorites);
        assert!(rendered.contains("Favorites"));
        assert!(rendered.contains(&favorite));
    }

    #[test]
    fn conversations_open_scrolled_to_newest_message() {
        let mut app = App::demo(crate::slack::demo_state());
        app.content_view_height = 6;
        app.content_view_width = 40;
        app.set_page(Page::Dms);
        app.request_selected();
        let messages = app.visible_messages();
        assert_eq!(app.selected_message, messages.len() - 1);
        assert_eq!(app.content_scroll, app.max_content_scroll());
    }

    #[test]
    fn emoji_runs_reserve_one_row_and_two_cells_at_the_placeholder() {
        let mut app = App::demo(crate::slack::demo_state());
        app.images = ImageStore::new(test_cache_dir("emoji-runs"));
        let area = Rect::new(0, 0, 40, 4);
        let mut buffer = Buffer::empty(area);
        buffer[(5, 1)].set_symbol(&IMAGE_PLACEHOLDER.to_string());
        let placements = vec![ImagePlacement {
            kind: ImageKind::Emoji,
            url: "https://slack-imgs.com/emoji.png".to_string(),
            alt: "calendar".to_string(),
        }];
        // Seed the cache so the run does not depend on the network.
        app.images
            .insert(&placements[0].url, png_fixture(64, 64))
            .unwrap();

        app.collect_image_runs(&buffer, area, &placements, 8, 16);
        assert_eq!(app.image_runs.len(), 1);
        let run = &app.image_runs[0];
        assert_eq!((run.x, run.y), (5, 1), "the run sits on the placeholder");
        assert_eq!(
            (run.cols, run.rows),
            (2, 1),
            "emoji occupy exactly the cells a unicode glyph would"
        );
    }

    #[test]
    fn attachment_runs_take_a_block_scaled_to_the_pane() {
        let mut app = App::demo(crate::slack::demo_state());
        app.images = ImageStore::new(test_cache_dir("attachment-runs"));
        let area = Rect::new(0, 0, 40, 20);
        let mut buffer = Buffer::empty(area);
        buffer[(1, 2)].set_symbol(&IMAGE_PLACEHOLDER.to_string());
        let placements = vec![ImagePlacement {
            kind: ImageKind::Attachment,
            url: "https://files.slack.com/diagram.png".to_string(),
            alt: "diagram".to_string(),
        }];
        app.images
            .insert(&placements[0].url, png_fixture(160, 80))
            .unwrap();

        app.collect_image_runs(&buffer, area, &placements, 8, 16);
        assert_eq!(app.image_runs.len(), 1);
        let run = &app.image_runs[0];
        assert!(run.cols > 2, "attachments are not emoji-sized: {run:?}");
        assert!(run.rows > 1, "attachments take vertical space: {run:?}");
    }

    /// Per-test cache root: tests must never write to the user's real cache,
    /// and the Nix sandbox makes `$HOME` unwritable by design.
    fn test_cache_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("slick-test-{label}-{}", std::process::id()))
    }

    fn png_fixture(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    #[test]
    fn link_runs_are_collected_without_touching_buffer_symbols() {
        let mut buffer = Buffer::empty(Rect::new(0, 0, 40, 1));
        let text = "open https://example.com/x rest";
        for (index, character) in text.chars().enumerate() {
            buffer[(u16::try_from(index).unwrap(), 0)].set_symbol(&character.to_string());
        }
        let mut runs = Vec::new();
        collect_url_runs(&buffer, Rect::new(0, 0, 40, 1), text, &mut runs);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].x, 5);
        assert_eq!(runs[0].y, 0);
        assert_eq!(runs[0].url, "https://example.com/x");
        assert_eq!(
            buffer[(5, 0)].symbol(),
            "h",
            "buffer symbols must stay one character wide so the frame diff remains exact"
        );
        let mut written = Vec::new();
        write_link_runs(&mut written, &runs).unwrap();
        let escape = String::from_utf8(written).unwrap();
        assert!(escape.starts_with("\x1b[1;6H"));
        assert!(escape.contains("\x1b]8;;https://example.com/x\x07"));
    }

    #[test]
    fn graphics_frames_skip_unchanged_placements_and_preserve_cursor() {
        let Ok(mut graphics) = Graphics::new() else {
            return;
        };
        let chrome = chrome(Tone::Content, false);
        let area = Rect::new(0, 0, 20, 6);

        graphics.tracker.begin_frame();
        let first_sink = EffectsSink::new();
        first_sink.push(render_chrome_underlay(area, &chrome, &graphics.runtime));
        let first = finalize_graphics_frame(&mut graphics, &first_sink);
        assert!(
            first.placement.contains("[1;1H"),
            "absolute placement must anchor the Kitty cursor at the scene origin"
        );
        assert!(
            first.placement.contains(",C=1,q="),
            "full-height Kitty placements must not advance and scroll the text cursor"
        );

        graphics.tracker.begin_frame();
        let second_sink = EffectsSink::new();
        second_sink.push(render_chrome_underlay(area, &chrome, &graphics.runtime));
        let second = finalize_graphics_frame(&mut graphics, &second_sink);
        assert!(
            second.placement.is_empty(),
            "unchanged chrome must not re-place every frame"
        );
        assert!(
            second.upload.is_empty(),
            "unchanged chrome must not be uploaded every frame"
        );

        let mut buffer = Vec::new();
        write_graphics_flush(&mut buffer, &first).unwrap();
        let written = String::from_utf8(buffer).unwrap();
        assert!(
            written.contains("[1;1H"),
            "the placement itself anchors the Kitty cursor"
        );

        let mut empty = Vec::new();
        write_graphics_flush(&mut empty, &second).unwrap();
        assert!(empty.is_empty(), "no-op frames write nothing");
    }

    #[test]
    fn image_frames_delete_scrolled_placements_and_preserve_the_cursor() {
        let Ok(mut graphics) = Graphics::new() else {
            return;
        };
        let mut store = ImageStore::new(test_cache_dir("placed-images"));
        let url = "https://slack-imgs.com/placed.png".to_string();
        store.insert(&url, png_fixture(64, 64)).unwrap();
        let initial = ImageRun {
            x: 4,
            y: 5,
            cols: 2,
            rows: 1,
            url: url.clone(),
        };
        let first = place_image_runs(&mut graphics, std::slice::from_ref(&initial), &mut store);
        assert!(first.contains(",C=1,q="), "{first:?}");
        assert_eq!(graphics.placed_images.len(), 1);

        let moved = ImageRun { y: 9, ..initial };
        let second = place_image_runs(&mut graphics, &[moved], &mut store);
        assert!(
            second.contains("a=d"),
            "the placement at the old scroll coordinate is deleted: {second:?}"
        );
        assert_eq!(graphics.placed_images.len(), 1);
        assert!(graphics
            .placed_images
            .keys()
            .all(|key| key.ends_with(":4:9")));
    }

    #[test]
    fn passive_mouse_motion_does_not_request_a_repaint() {
        let mut app = App::demo(crate::slack::demo_state());
        assert!(!app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Moved,
            column: 5,
            row: 5,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(!app.handle_mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 250,
            row: 250,
            modifiers: KeyModifiers::NONE,
        }));
    }

    #[test]
    fn vim_gg_and_capital_g_navigate_extremes() {
        let mut app = App::demo(crate::slack::demo_state());
        app.handle_key(KeyEvent::new(KeyCode::Char('G'), KeyModifiers::SHIFT));
        assert_eq!(app.selected_notification, app.state.notifications.len() - 1);
        app.handle_key(KeyEvent::new(KeyCode::Char('g'), KeyModifiers::NONE));
        app.handle_key(KeyEvent::new(KeyCode::Char('g'), KeyModifiers::NONE));
        assert_eq!(app.selected_notification, 0);
    }
}
