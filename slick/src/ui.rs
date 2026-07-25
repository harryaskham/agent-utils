use std::collections::HashMap;
use std::fmt::Write as FmtWrite;
use std::io::{self, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
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
use crate::markdown::{extract_urls, osc8_chunks, preview, render_markdown};
use crate::model::{CacheState, Conversation, ConversationKind, Message, SlackFile};
use crate::slack::SlackService;

const PURPLE: Color = Color::Rgb(0x7c, 0x5c, 0xfc);
const SLACK_PURPLE: Color = Color::Rgb(0x61, 0x1f, 0x69);
const CYAN: Color = Color::Rgb(0x4d, 0xd9, 0xe8);
const GREEN: Color = Color::Rgb(0x5c, 0xd6, 0x91);
const YELLOW: Color = Color::Rgb(0xf2, 0xc7, 0x66);
const RED: Color = Color::Rgb(0xef, 0x6a, 0x73);
const FG: Color = Color::Rgb(0xe6, 0xe3, 0xeb);
const MUTED: Color = Color::Rgb(0x99, 0x95, 0xa4);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Page {
    #[default]
    Notifications,
    Favorites,
    Dms,
    Channels,
    Files,
}

impl Page {
    const ALL: [Self; 5] = [
        Self::Notifications,
        Self::Favorites,
        Self::Dms,
        Self::Channels,
        Self::Files,
    ];

    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Notifications => "Activity",
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
    Message(usize),
    File(usize),
    Focus(Focus),
}

#[derive(Clone, Debug)]
struct HitRegion {
    rect: Rect,
    action: HitAction,
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
    Failed(String),
}

struct Worker {
    tx: Sender<WorkerCommand>,
    rx: Receiver<WorkerEvent>,
}

impl Worker {
    fn spawn(initial: CacheState, store: CacheStore) -> Self {
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
                        let save_result = store.save(&state);
                        let status = save_result.map_or_else(
                            |error| format!("{label}; cache warning: {error}"),
                            |()| label.clone(),
                        );
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
            tx: command_tx,
            rx: event_rx,
        }
    }

    fn send(&self, command: WorkerCommand) {
        let _ = self.tx.send(command);
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
    sidebar_visible: bool,
    fullscreen_content: bool,
    osc8_links: bool,
    filter: String,
    filter_mode: bool,
    show_help: bool,
    should_quit: bool,
    busy: bool,
    status: String,
    last_error: Option<String>,
    hits: Vec<HitRegion>,
    selected_message: usize,
    thread_stack: Vec<ThreadView>,
    worker: Option<Worker>,
    pending_g: bool,
}

impl App {
    #[must_use]
    pub fn demo(state: CacheState) -> Self {
        Self::new(state, None)
    }

    fn live(state: CacheState, store: CacheStore) -> Self {
        let worker = Worker::spawn(state.clone(), store);
        let app = Self::new(state, Some(worker));
        if let Some(worker) = &app.worker {
            worker.send(WorkerCommand::Bootstrap);
        }
        app
    }

    fn new(state: CacheState, worker: Option<Worker>) -> Self {
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
            sidebar_visible: true,
            fullscreen_content: false,
            osc8_links: false,
            filter: String::new(),
            filter_mode: false,
            show_help: false,
            should_quit: false,
            busy: false,
            last_error: None,
            hits: Vec::new(),
            selected_message: 0,
            thread_stack: Vec::new(),
            worker,
            pending_g: false,
        }
    }

    fn drain_worker(&mut self) -> bool {
        let Some(worker) = &self.worker else {
            return false;
        };
        let events: Vec<_> = worker.rx.try_iter().collect();
        let changed = !events.is_empty();
        for event in events {
            match event {
                WorkerEvent::Started(status) => {
                    self.busy = true;
                    self.status = status;
                    self.last_error = None;
                }
                WorkerEvent::Updated(state, status) => {
                    self.state = *state;
                    self.busy = false;
                    self.status = status;
                    self.last_error = None;
                    self.clamp_selection();
                    if matches!(self.page, Page::Favorites | Page::Dms | Page::Channels)
                        && !self.section_overview
                    {
                        self.content_scroll = self.max_content_scroll();
                    }
                }
                WorkerEvent::Failed(error) => {
                    self.busy = false;
                    self.last_error = Some(error.clone());
                    self.status = "cached · refresh failed".into();
                }
            }
        }
        changed
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

    fn recent_active_channels(&self) -> Vec<&Conversation> {
        let mut channels: Vec<&Conversation> = self
            .filtered_conversations(false)
            .into_iter()
            .filter(|conversation| {
                self.state.self_activity.contains_key(&conversation.id)
                    || conversation.unread_count > 0
                    || conversation.is_favorite
            })
            .collect();
        channels.sort_by(|left, right| {
            let left_activity = self
                .state
                .self_activity
                .get(&left.id)
                .and_then(|ts| ts.parse::<f64>().ok())
                .unwrap_or(0.0);
            let right_activity = self
                .state
                .self_activity
                .get(&right.id)
                .and_then(|ts| ts.parse::<f64>().ok())
                .unwrap_or(0.0);
            right_activity
                .partial_cmp(&left_activity)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| right.unread_count.cmp(&left.unread_count))
        });
        if channels.is_empty() {
            return self.filtered_conversations(false);
        }
        channels
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
            Page::Files => None,
        }
    }

    fn selected_file(&self) -> Option<&SlackFile> {
        self.filtered_files().get(self.selected_file).copied()
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
        }
    }

    fn send(&mut self, command: WorkerCommand) {
        if let Some(worker) = &self.worker {
            worker.send(command);
            self.busy = true;
        } else {
            self.status = "demo mode · network disabled".into();
        }
    }

    fn refresh_visible(&mut self) {
        let target = match self.page {
            Page::Notifications => RefreshTarget::Notifications,
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
            Page::Notifications => true,
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
        for message in &messages {
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
                usize::from(self.content_view_height.saturating_sub(2) / 2).max(1),
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
            for (index, message) in messages.iter().enumerate() {
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
                if self.navigates_list() {
                    self.move_selection(-1);
                } else {
                    self.scroll_up(3);
                }
                true
            }
            MouseEventKind::ScrollDown => {
                if self.navigates_list() {
                    self.move_selection(1);
                } else {
                    self.scroll_down(3);
                }
                true
            }
            _ => false,
        }
    }

    fn render(&mut self, frame: &mut Frame<'_>, graphics: Option<(&Runtime, &EffectsSink)>) {
        self.hits.clear();
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
                    .constraints([Constraint::Length(32), Constraint::Min(40)])
                    .split(body);
                self.render_sidebar(frame, columns[0], graphics);
                columns[1]
            } else {
                body
            };
            if self.page == Page::Files {
                let files = Layout::default()
                    .direction(Direction::Horizontal)
                    .constraints([Constraint::Percentage(36), Constraint::Percentage(64)])
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
            Self::render_help(frame, area);
        }
    }

    fn render_header(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(28),
                Constraint::Min(30),
                Constraint::Length(28),
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
        let icon = if self.busy {
            "◌"
        } else if self.last_error.is_some() {
            "!"
        } else {
            "●"
        };
        let color = if self.busy {
            YELLOW
        } else if self.last_error.is_some() {
            RED
        } else {
            GREEN
        };
        let paragraph = Paragraph::new(Line::from(vec![
            Span::styled(
                format!(" {icon} "),
                Style::default().fg(color).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                format!(
                    "{} · {}",
                    snapshot_age(
                        self.state
                            .last_refresh
                            .get("sidebar")
                            .copied()
                            .or(self.state.saved_at),
                    ),
                    self.status,
                ),
                Style::default().fg(MUTED),
            ),
        ]));
        render_paragraph(frame, columns[2], paragraph, graphics, Tone::Dark, false);
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
        let mut row = area.y.saturating_add(1);
        for page in Page::ALL {
            let selected = page == self.page;
            let count = match page {
                Page::Notifications => self
                    .state
                    .notifications
                    .iter()
                    .filter(|item| item.unread || item.mention)
                    .count(),
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
                    .bg(SLACK_PURPLE)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(FG)
            };
            items.push(
                ListItem::new(Line::from(vec![
                    Span::styled(
                        format!(" {} ", page.icon()),
                        Style::default().fg(if selected { Color::White } else { CYAN }),
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
        items.push(ListItem::new(Line::from(Span::styled(
            "  Active DMs",
            Style::default().fg(MUTED).add_modifier(Modifier::BOLD),
        ))));
        row = row.saturating_add(1);
        let dms: Vec<Conversation> = self
            .filtered_conversations(true)
            .into_iter()
            .take(8)
            .cloned()
            .collect();
        for conversation in &dms {
            let unread = unread_badge(conversation);
            items.push(ListItem::new(conversation_line(conversation, "●", unread)));
            self.hits.push(HitRegion {
                rect: Rect::new(area.x + 1, row, area.width.saturating_sub(2), 1),
                action: HitAction::Conversation(conversation.id.clone(), conversation.kind),
            });
            row = row.saturating_add(1);
        }
        items.push(ListItem::new(Line::from(Span::styled(
            "  Channels you're active in",
            Style::default().fg(MUTED).add_modifier(Modifier::BOLD),
        ))));
        row = row.saturating_add(1);
        let channels: Vec<Conversation> = self
            .recent_active_channels()
            .into_iter()
            .take(8)
            .cloned()
            .collect();
        for conversation in &channels {
            let unread = unread_badge(conversation);
            items.push(ListItem::new(conversation_line(conversation, "#", unread)));
            self.hits.push(HitRegion {
                rect: Rect::new(area.x + 1, row, area.width.saturating_sub(2), 1),
                action: HitAction::Conversation(conversation.id.clone(), conversation.kind),
            });
            row = row.saturating_add(1);
        }
        let list = List::new(items).block(
            Block::default()
                .borders(if graphics.is_some() {
                    Borders::NONE
                } else {
                    Borders::ALL
                })
                .title(" Slack "),
        );
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
            Page::Favorites | Page::Dms | Page::Channels if self.section_overview => {
                self.render_conversation_overview(frame, area, graphics);
            }
            Page::Favorites | Page::Dms | Page::Channels => {
                self.render_messages(frame, area, graphics);
            }
            Page::Files => {}
        }
    }

    fn render_notifications(
        &mut self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        let mut items = Vec::new();
        let mut row = area.y.saturating_add(1);
        let visible = usize::from(area.height.saturating_sub(2) / 2).max(1);
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
                Span::styled("  ✓ ", Style::default().fg(GREEN)),
                Span::styled(
                    "You're all caught up",
                    Style::default().fg(FG).add_modifier(Modifier::BOLD),
                ),
            ])));
            items.push(ListItem::new("  Mentions, unread DMs and recent DM activity from the last seven days appear here."));
        }
        for (index, notification) in self
            .state
            .notifications
            .iter()
            .enumerate()
            .skip(self.activity_offset)
            .take(visible)
        {
            let selected = index == self.selected_notification;
            let marker = if notification.mention {
                "@"
            } else if notification.kind.is_dm() {
                "●"
            } else {
                "#"
            };
            let badge = if notification.unread { " NEW" } else { "" };
            let style = if selected {
                Style::default().bg(Color::Rgb(0x31, 0x2a, 0x42))
            } else {
                Style::default()
            };
            items.push(
                ListItem::new(Line::from(vec![
                    Span::styled(
                        format!(" {marker} "),
                        Style::default()
                            .fg(if notification.mention { YELLOW } else { CYAN })
                            .add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        notification.conversation_name.clone(),
                        Style::default().fg(FG).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!("  {}{badge}", short_time(&notification.message.timestamp)),
                        Style::default().fg(if badge.is_empty() { MUTED } else { GREEN }),
                    ),
                ]))
                .style(style),
            );
            items.push(
                ListItem::new(Line::from(Span::styled(
                    format!("   {}", preview(&notification.message.text, 120)),
                    Style::default().fg(MUTED),
                )))
                .style(style),
            );
            self.hits.push(HitRegion {
                rect: Rect::new(area.x + 1, row, area.width.saturating_sub(2), 2),
                action: HitAction::Notification(index),
            });
            row = row.saturating_add(2);
        }
        let list = List::new(items).block(
            Block::default()
                .borders(if graphics.is_some() {
                    Borders::NONE
                } else {
                    Borders::ALL
                })
                .title(format!(
                    " Activity · {} items · {}/{} ",
                    self.state.notifications.len(),
                    self.selected_notification
                        .saturating_add(1)
                        .min(self.state.notifications.len()),
                    self.state.notifications.len().max(1),
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
        let mut row = panes[0].y.saturating_add(1);
        for (index, conversation) in conversations.iter().enumerate().skip(offset).take(visible) {
            let is_selected = index == selected;
            let style = if is_selected {
                Style::default().bg(Color::Rgb(0x31, 0x2a, 0x42))
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
        let list = List::new(items).block(
            Block::default()
                .borders(if graphics.is_some() {
                    Borders::NONE
                } else {
                    Borders::ALL
                })
                .title(title),
        );
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
        let paragraph = Paragraph::new(render_markdown(&markdown))
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
            apply_osc8_links(frame.buffer_mut(), area, &markdown);
            self.patch_message_links(frame.buffer_mut(), area, &starts);
        }
    }

    fn patch_message_links(&self, buffer: &mut Buffer, area: Rect, starts: &[usize]) {
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
                let column = row[..byte_index].chars().count();
                patch_osc8_run(buffer, area, y, column, &message.permalink, "open ↗");
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
        let mut row = area.y.saturating_add(1);
        let visible = usize::from(area.height.saturating_sub(2) / 2).max(1);
        keep_visible(self.selected_file, &mut self.file_offset, visible);
        self.file_offset = self.file_offset.min(files.len().saturating_sub(visible));
        if files.is_empty() {
            items.push(ListItem::new(
                "No recent files. Ctrl-R refreshes the visible seven-day window.",
            ));
        }
        for (index, file) in files
            .iter()
            .enumerate()
            .skip(self.file_offset)
            .take(visible)
        {
            let selected = index == self.selected_file;
            let style = if selected {
                Style::default().bg(Color::Rgb(0x31, 0x2a, 0x42))
            } else {
                Style::default()
            };
            items.push(
                ListItem::new(Line::from(vec![
                    Span::styled(
                        if file.is_canvas() { " ▤ " } else { " ▱ " },
                        Style::default().fg(if file.is_canvas() { PURPLE } else { CYAN }),
                    ),
                    Span::styled(
                        file.title.clone(),
                        Style::default().fg(FG).add_modifier(Modifier::BOLD),
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
                    Style::default().fg(MUTED),
                )))
                .style(style),
            );
            self.hits.push(HitRegion {
                rect: Rect::new(area.x + 1, row, area.width.saturating_sub(2), 2),
                action: HitAction::File(index),
            });
            row = row.saturating_add(2);
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
        let paragraph = Paragraph::new(render_markdown(&markdown))
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
            apply_osc8_links(frame.buffer_mut(), area, &markdown);
        }
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
                    Span::styled(" 1-5", key_style()),
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
                    Span::styled(" ! ", Style::default().fg(RED).add_modifier(Modifier::BOLD)),
                    Span::styled(error, Style::default().fg(RED)),
                ])
            },
        );
        render_paragraph(
            frame,
            area,
            Paragraph::new(line),
            graphics,
            Tone::Dark,
            false,
        );
    }

    fn render_help(frame: &mut Frame<'_>, area: Rect) {
        let width = area.width.min(72);
        let height = area.height.min(23);
        let popup = centered_rect(width, height, area);
        frame.render_widget(Clear, popup);
        let help = Text::from(vec![
            Line::from(Span::styled("Slick · keyboard and mouse", Style::default().fg(PURPLE).add_modifier(Modifier::BOLD))),
            Line::default(),
            Line::from(vec![Span::styled("1-5 / ←→", key_style()), Span::raw("  Activity, Favorites, DMs, Channels, Files")]),
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
            Line::from(Span::styled("Mouse", Style::default().fg(CYAN).add_modifier(Modifier::BOLD))),
            Line::raw("Click navigation, conversations, notifications and files. Scroll the focused pane with the wheel."),
            Line::default(),
            Line::from(Span::styled("Refresh contract", Style::default().fg(GREEN).add_modifier(Modifier::BOLD))),
            Line::raw("Slick caches content. Ctrl-R always updates the DM/channel sidebar, then requests only the active view from its last refresh (bounded to seven days)."),
            Line::default(),
            Line::from(Span::styled("Read-only: Slick never sends, edits, reacts, joins or marks messages read.", Style::default().fg(YELLOW))),
        ]);
        frame.render_widget(
            Paragraph::new(help)
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(PURPLE))
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
            worker.send(WorkerCommand::Stop);
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
    let (top, bottom, rail) = match tone {
        Tone::Purple => ("#611f69ff", "#3f1447ff", "#d6a8e0ff"),
        Tone::Sidebar => ("#241229ff", "#17121bff", "#7c5cfcff"),
        Tone::Content => ("#171820ff", "#101117ff", "#4dd9e8ff"),
        Tone::Detail => ("#181621ff", "#101017ff", "#9d84ffff"),
        Tone::Dark => ("#171820ff", "#111219ff", "#5a5c6aff"),
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
    let (start, end) = match tone {
        Tone::Purple => ("#611f69ff", "#3f1447ff"),
        _ => ("#171820ff", "#111219ff"),
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
                SLACK_PURPLE
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
    let Some(scene) = chrome.to_scene(area) else {
        return RenderEffects::default();
    };
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

fn patch_osc8_run(buffer: &mut Buffer, area: Rect, y: u16, column: usize, url: &str, text: &str) {
    for (offset, payload) in osc8_chunks(url, text) {
        let Ok(offset) = u16::try_from(column + offset) else {
            break;
        };
        let x = area.x.saturating_add(offset);
        if x >= area.right() {
            break;
        }
        buffer[(x, y)].set_symbol(&payload);
    }
}

fn row_text(buffer: &Buffer, area: Rect, y: u16) -> String {
    (area.x..area.right())
        .map(|x| buffer[(x, y)].symbol().chars().next().unwrap_or(' '))
        .collect()
}

fn apply_osc8_links(buffer: &mut Buffer, area: Rect, source: &str) {
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
                patch_osc8_run(buffer, area, y, column, url, url);
            }
        }
    }
}

fn finalize_graphics_frame(graphics: &mut Graphics, sink: &EffectsSink) -> DrawFlush {
    let mut flush = DrawFlush::default();
    let mut current = HashMap::new();
    for effects in sink.drain() {
        graphics.tracker.keep(&effects);
        flush.upload.push_str(&effects.upload);
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
                // The runtime placement already contains its own absolute
                // cursor move. Emitting a second host-side move (as the
                // generic Ratakittui finalizer does) is redundant and makes
                // cursor restoration harder to reason about.
                flush.placement.push_str(&effects.placement);
                flush.placement.push_str(&effects.embed);
            }
        } else {
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
    // Kittui placement commands move the real terminal cursor, while Ratatui's
    // backend still believes the cursor is where its preceding draw left it.
    // Save/restore around the complete graphics transaction so the next text
    // diff starts from the same physical and logical cursor position.
    writer.write_all(b"\x1b7")?;
    writer.write_all(flush.upload.as_bytes())?;
    writer.write_all(flush.placement.as_bytes())?;
    writer.write_all(flush.deletes.as_bytes())?;
    writer.write_all(b"\x1b8")?;
    writer.flush()
}

fn chrome_underlay_options(image_id: u32) -> PlacementOptions {
    PlacementOptions::absolute_with_id(image_id).with_z_index(-1)
}

fn conversation_line(conversation: &Conversation, marker: &str, unread: String) -> Line<'static> {
    let active = conversation.unread_count > 0
        || conversation.activity_ts() >= CacheState::seven_days_ago() as f64;
    Line::from(vec![
        Span::styled(
            if conversation.is_favorite {
                " ★"
            } else {
                "  "
            },
            Style::default().fg(YELLOW),
        ),
        Span::styled(
            format!("{marker} "),
            Style::default().fg(if active { GREEN } else { MUTED }),
        ),
        Span::styled(
            format!("{:<20}", truncate_label(&conversation.name, 20)),
            Style::default()
                .fg(if conversation.unread_count > 0 {
                    Color::White
                } else {
                    FG
                })
                .add_modifier(if conversation.unread_count > 0 {
                    Modifier::BOLD
                } else {
                    Modifier::empty()
                }),
        ),
        Span::styled(
            unread,
            Style::default().fg(GREEN).add_modifier(Modifier::BOLD),
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

fn snapshot_age(saved_at: Option<i64>) -> String {
    let Some(saved_at) = saved_at else {
        return "snapshot uncached".into();
    };
    let age = CacheState::now().saturating_sub(saved_at);
    if age < 60 {
        format!("snapshot {age}s stale")
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
    Style::default().fg(CYAN).add_modifier(Modifier::BOLD)
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
    pub initial_page: Page,
}

pub fn run(options: RunOptions) -> Result<()> {
    let initial = if options.demo {
        crate::slack::demo_state()
    } else {
        options.cache_store.load().unwrap_or_default()
    };
    let mut app = if options.demo {
        App::demo(initial)
    } else {
        App::live(initial, options.cache_store)
    };
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

fn run_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
    mut graphics: Option<&mut Graphics>,
) -> Result<()> {
    let mut dirty = true;
    let mut last_timer_tick = Instant::now();
    while !app.should_quit {
        dirty |= app.drain_worker();
        if last_timer_tick.elapsed() >= Duration::from_secs(1) {
            dirty = true;
            last_timer_tick = Instant::now();
        }
        if dirty {
            if let Some(graphics) = graphics.as_deref_mut() {
                graphics.tracker.begin_frame();
                let sink = EffectsSink::new();
                terminal.draw(|frame| app.render(frame, Some((&graphics.runtime, &sink))))?;
                let flush = finalize_graphics_frame(graphics, &sink);
                write_graphics_flush(terminal.backend_mut(), &flush)?;
            } else {
                terminal.draw(|frame| app.render(frame, None))?;
            }
            dirty = false;
        }

        if event::poll(Duration::from_millis(16))? {
            let changed = match event::read()? {
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
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("test backend");
    let mut app = App::demo(state);
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
                .is_some_and(|line| line.contains("Slack")),
            "body begins immediately after the one-line header"
        );
        let files = snapshot_page(crate::slack::demo_state(), 140, 40, Page::Files);
        assert!(files.contains("Slick Product Brief"));
        assert!(files.contains("Markdown"));
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
        assert_eq!(options.z_index, -1);
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
        assert_eq!(
            snapshot_age(Some(CacheState::now() - 42)),
            "snapshot 42s stale"
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
    fn osc8_patching_wraps_visible_urls_without_shifting_columns() {
        let mut buffer = Buffer::empty(Rect::new(0, 0, 40, 1));
        let text = "open https://example.com/x rest";
        for (index, character) in text.chars().enumerate() {
            buffer[(u16::try_from(index).unwrap(), 0)].set_symbol(&character.to_string());
        }
        apply_osc8_links(&mut buffer, Rect::new(0, 0, 40, 1), text);
        let first = buffer[(5, 0)].symbol().to_string();
        assert_eq!(
            first, "\x1b]8;;https://example.com/x\x07ht\x1b]8;;\x07",
            "link runs start on the first URL cell in two-character chunks"
        );
        assert_eq!(
            buffer[(6, 0)].symbol(),
            "t",
            "interleaved cells stay intact"
        );
        assert_eq!(
            buffer[(27, 0)].symbol(),
            "r",
            "text after the URL is untouched"
        );
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
        assert!(!first.placement.is_empty(), "first frame places chrome");

        graphics.tracker.begin_frame();
        let second_sink = EffectsSink::new();
        second_sink.push(render_chrome_underlay(area, &chrome, &graphics.runtime));
        let second = finalize_graphics_frame(&mut graphics, &second_sink);
        assert!(
            second.placement.is_empty(),
            "unchanged chrome must not re-place every frame"
        );

        let mut buffer = Vec::new();
        write_graphics_flush(&mut buffer, &first).unwrap();
        let written = String::from_utf8(buffer).unwrap();
        assert!(written.starts_with("\x1b7"), "cursor is saved first");
        assert!(written.ends_with("\x1b8"), "cursor is restored last");

        let mut empty = Vec::new();
        write_graphics_flush(&mut empty, &second).unwrap();
        assert!(empty.is_empty(), "no-op frames write nothing");
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
