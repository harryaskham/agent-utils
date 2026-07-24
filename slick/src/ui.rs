use std::fmt::Write as FmtWrite;
use std::io::{self, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use ratakittui::{
    Background, Border, Chrome, EffectsSink, KittuiList, KittuiParagraph, KittuiTitle,
    LifecycleTracker, Padding, Shadow,
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
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap};
use ratatui::{Frame, Terminal};

use kittui::{Direction as KittuiDirection, RendererKind, Rgba, Runtime, TerminalInfo};

use crate::cache::CacheStore;
use crate::markdown::{preview, render_markdown};
use crate::model::{CacheState, Conversation, ConversationKind, SlackFile};
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
    Dms,
    Channels,
    Files,
}

impl Page {
    const ALL: [Self; 4] = [Self::Notifications, Self::Dms, Self::Channels, Self::Files];

    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Notifications => "Activity",
            Self::Dms => "Direct messages",
            Self::Channels => "Channels",
            Self::Files => "Files",
        }
    }

    #[must_use]
    const fn icon(self) -> &'static str {
        match self {
            Self::Notifications => "◉",
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
    File(usize),
    Focus(Focus),
}

#[derive(Clone, Debug)]
struct HitRegion {
    rect: Rect,
    action: HitAction,
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
        })
    }
}

pub struct App {
    pub state: CacheState,
    page: Page,
    focus: Focus,
    selected_notification: usize,
    selected_dm: usize,
    selected_channel: usize,
    selected_file: usize,
    content_scroll: u16,
    detail_scroll: u16,
    filter: String,
    filter_mode: bool,
    show_help: bool,
    should_quit: bool,
    busy: bool,
    status: String,
    last_error: Option<String>,
    hits: Vec<HitRegion>,
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
                format!("cache {}", state.friendly_saved_at())
            } else {
                "starting".into()
            },
            state,
            page: Page::Notifications,
            focus: Focus::Sidebar,
            selected_notification: 0,
            selected_dm: 0,
            selected_channel: 0,
            selected_file: 0,
            content_scroll: 0,
            detail_scroll: 0,
            filter: String::new(),
            filter_mode: false,
            show_help: false,
            should_quit: false,
            busy: false,
            last_error: None,
            hits: Vec::new(),
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
        self.selected_dm = clamp_index(self.selected_dm, self.filtered_conversations(true).len());
        self.selected_channel = clamp_index(
            self.selected_channel,
            self.filtered_conversations(false).len(),
        );
        self.selected_file = clamp_index(self.selected_file, self.filtered_files().len());
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
            Page::Dms | Page::Channels => {
                if let Some(conversation) = self.selected_conversation() {
                    let id = conversation.id.clone();
                    if self.state.messages.get(&id).is_none_or(Vec::is_empty) {
                        self.send(WorkerCommand::LoadConversation(id));
                    }
                    self.focus = Focus::Content;
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
        self.content_scroll = 0;
        self.focus = Focus::Content;
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
            Page::Dms | Page::Channels => self
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
                KeyCode::Char('c' | 'q') => self.should_quit = true,
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
            KeyCode::Char('q') => self.should_quit = true,
            KeyCode::Char('?') => self.show_help = true,
            KeyCode::Char('/') => self.filter_mode = true,
            KeyCode::Char('g') if was_pending_g => self.go_top(),
            KeyCode::Char('g') => self.pending_g = true,
            KeyCode::Char('G') => self.go_bottom(),
            KeyCode::Char('1') => self.set_page(Page::Notifications),
            KeyCode::Char('2') => self.set_page(Page::Dms),
            KeyCode::Char('3') => self.set_page(Page::Channels),
            KeyCode::Char('4') => self.set_page(Page::Files),
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
        if self.focus == Focus::Sidebar || self.page == Page::Files && self.focus == Focus::Content
        {
            match self.page {
                Page::Notifications => self.selected_notification = 0,
                Page::Dms => self.selected_dm = 0,
                Page::Channels => self.selected_channel = 0,
                Page::Files => self.selected_file = 0,
            }
        }
        self.set_scroll(0);
    }

    fn go_bottom(&mut self) {
        if self.focus == Focus::Sidebar || self.page == Page::Files && self.focus == Focus::Content
        {
            match self.page {
                Page::Notifications => {
                    self.selected_notification = self.state.notifications.len().saturating_sub(1);
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
        } else {
            let rows = match self.page {
                Page::Files => self
                    .selected_file()
                    .map_or(0, |file| file.content_markdown.lines().count()),
                Page::Dms | Page::Channels => self
                    .selected_conversation()
                    .and_then(|conversation| self.state.messages.get(&conversation.id))
                    .map_or(0, Vec::len)
                    .saturating_mul(8),
                Page::Notifications => self.state.notifications.len().saturating_mul(2),
            };
            self.set_scroll(u16::try_from(rows.saturating_sub(1)).unwrap_or(u16::MAX));
        }
    }

    fn set_page(&mut self, page: Page) {
        self.page = page;
        self.content_scroll = 0;
        self.detail_scroll = 0;
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
    }

    fn move_selection(&mut self, delta: isize) {
        if self.focus != Focus::Sidebar && self.page != Page::Files {
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
        if self.page == Page::Files {
            self.detail_scroll = 0;
        } else {
            self.content_scroll = 0;
        }
    }

    fn scroll_up(&mut self, amount: u16) {
        match self.focus {
            Focus::Detail => self.detail_scroll = self.detail_scroll.saturating_sub(amount),
            _ => self.content_scroll = self.content_scroll.saturating_sub(amount),
        }
    }

    fn scroll_down(&mut self, amount: u16) {
        match self.focus {
            Focus::Detail => self.detail_scroll = self.detail_scroll.saturating_add(amount),
            _ => self.content_scroll = self.content_scroll.saturating_add(amount),
        }
    }

    fn set_scroll(&mut self, value: u16) {
        match self.focus {
            Focus::Detail => self.detail_scroll = value,
            _ => self.content_scroll = value,
        }
    }

    fn handle_mouse(&mut self, mouse: MouseEvent) {
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
                    }
                }
            }
            MouseEventKind::ScrollUp => self.scroll_up(3),
            MouseEventKind::ScrollDown => self.scroll_down(3),
            _ => {}
        }
    }

    fn render(&mut self, frame: &mut Frame<'_>, graphics: Option<(&Runtime, &EffectsSink)>) {
        self.hits.clear();
        let area = frame.area();
        let vertical = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Min(8),
                Constraint::Length(2),
            ])
            .split(area);
        self.render_header(frame, vertical[0], graphics);
        let columns = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Length(32), Constraint::Min(40)])
            .split(vertical[1]);
        self.render_sidebar(frame, columns[0], graphics);
        if self.page == Page::Files {
            let files = Layout::default()
                .direction(Direction::Horizontal)
                .constraints([Constraint::Percentage(36), Constraint::Percentage(64)])
                .split(columns[1]);
            self.render_files(frame, files[0], graphics);
            self.render_file_detail(frame, files[1], graphics);
        } else {
            self.render_content(frame, columns[1], graphics);
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
            Span::styled(self.status.clone(), Style::default().fg(MUTED)),
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
                Page::Dms => self
                    .state
                    .conversations
                    .iter()
                    .filter(|item| item.kind.is_dm() && item.unread_count > 0)
                    .count(),
                Page::Channels => self
                    .state
                    .conversations
                    .iter()
                    .filter(|item| !item.kind.is_dm() && item.unread_count > 0)
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
            "  Direct messages",
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
            "  Channels",
            Style::default().fg(MUTED).add_modifier(Modifier::BOLD),
        ))));
        row = row.saturating_add(1);
        let channels: Vec<Conversation> = self
            .filtered_conversations(false)
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
            Page::Dms | Page::Channels => self.render_messages(frame, area, graphics),
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
        for (index, notification) in self.state.notifications.iter().enumerate() {
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
                .title(" Activity · mentions + unread + recent DMs "),
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

    fn render_messages(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        let Some(conversation) = self.selected_conversation() else {
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
        let mut markdown = String::new();
        if !conversation.topic.is_empty() {
            let _ = write!(markdown, "> {}\n\n", conversation.topic);
        }
        let messages = self.state.messages.get(&conversation.id);
        if messages.is_none_or(Vec::is_empty) {
            markdown.push_str("_Press Enter to load up to seven days of content._");
        } else if let Some(messages) = messages {
            for message in messages.iter().rev() {
                let _ = write!(
                    markdown,
                    "### {}  ·  {}\n\n{}\n\n---\n\n",
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
        let title = format!(
            " {} {} · {} ",
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
        if files.is_empty() {
            items.push(ListItem::new(
                "No recent files. Ctrl-R refreshes the visible seven-day window.",
            ));
        }
        for (index, file) in files.iter().enumerate() {
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
                .title(" Recent files · seven days "),
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
                    Span::styled(" 1-4", key_style()),
                    Span::raw(" views  "),
                    Span::styled("↑↓/jk", key_style()),
                    Span::raw(" move  "),
                    Span::styled("Enter", key_style()),
                    Span::raw(" open  "),
                    Span::styled("Tab", key_style()),
                    Span::raw(" focus  "),
                    Span::styled("Ctrl-R", key_style()),
                    Span::raw(" refresh visible + DMs  "),
                    Span::styled("/", key_style()),
                    Span::raw(" filter  "),
                    Span::styled("?", key_style()),
                    Span::raw(" help  "),
                    Span::styled("q", key_style()),
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
            Line::from(vec![Span::styled("1-4 / ←→", key_style()), Span::raw("  Activity, DMs, Channels, Files")]),
            Line::from(vec![Span::styled("↑↓ / j k", key_style()), Span::raw("  Move selection or scroll focused content")]),
            Line::from(vec![Span::styled("g g / G / 0", key_style()), Span::raw(" Top, bottom and home (Vim-style)")]),
            Line::from(vec![Span::styled("Enter", key_style()), Span::raw("       Open/load selected conversation or file")]),
            Line::from(vec![Span::styled("Tab", key_style()), Span::raw("         Cycle sidebar, content and file detail focus")]),
            Line::from(vec![Span::styled("Ctrl-R", key_style()), Span::raw("      Refresh only the visible view plus DM list")]),
            Line::from(vec![Span::styled("Ctrl-U/D", key_style()), Span::raw("    Page rich content up/down")]),
            Line::from(vec![Span::styled("/", key_style()), Span::raw("           Filter cached names/files locally")]),
            Line::from(vec![Span::styled("Esc", key_style()), Span::raw("         Clear filter or close this help")]),
            Line::from(vec![Span::styled("q / Ctrl-C", key_style()), Span::raw("  Quit safely")]),
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

fn render_title(
    frame: &mut Frame<'_>,
    area: Rect,
    title: String,
    graphics: Option<(&Runtime, &EffectsSink)>,
    tone: Tone,
) {
    if let Some((runtime, sink)) = graphics {
        let mut widget = KittuiTitle::new(&title, chrome(tone, false));
        widget.style = Style::default()
            .fg(Color::White)
            .add_modifier(Modifier::BOLD);
        sink.push(widget.render_with(area, frame.buffer_mut(), runtime));
    } else {
        frame.render_widget(
            Paragraph::new(title).style(
                Style::default()
                    .fg(Color::White)
                    .bg(SLACK_PURPLE)
                    .add_modifier(Modifier::BOLD),
            ),
            area,
        );
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
        sink.push(KittuiList::new(list, chrome(tone, focused)).render_with(
            area,
            frame.buffer_mut(),
            runtime,
        ));
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
        sink.push(
            KittuiParagraph::new(paragraph, chrome(tone, focused)).render_with(
                area,
                frame.buffer_mut(),
                runtime,
            ),
        );
    } else {
        frame.render_widget(paragraph, area);
    }
}

fn conversation_line(conversation: &Conversation, marker: &str, unread: String) -> Line<'static> {
    let active = conversation.unread_count > 0
        || conversation.activity_ts() >= CacheState::seven_days_ago() as f64;
    Line::from(vec![
        Span::styled(
            format!(" {marker} "),
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

    if let Some(graphics) = graphics.as_ref() {
        graphics.tracker.begin_frame();
        let sink = EffectsSink::new();
        let flush = ratakittui::finalize_frame(&sink, &graphics.tracker, &graphics.runtime);
        let backend = terminal.backend_mut();
        let _ = backend.write_all(flush.deletes.as_bytes());
        let _ = backend.flush();
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
    while !app.should_quit {
        dirty |= app.drain_worker();
        if dirty {
            if let Some(graphics) = graphics.as_deref_mut() {
                graphics.tracker.begin_frame();
                let sink = EffectsSink::new();
                terminal.draw(|frame| app.render(frame, Some((&graphics.runtime, &sink))))?;
                let flush = ratakittui::finalize_frame(&sink, &graphics.tracker, &graphics.runtime);
                terminal.backend_mut().write_all(flush.upload.as_bytes())?;
                terminal
                    .backend_mut()
                    .write_all(flush.placement.as_bytes())?;
                terminal.backend_mut().write_all(flush.deletes.as_bytes())?;
                terminal.backend_mut().flush()?;
            } else {
                terminal.draw(|frame| app.render(frame, None))?;
            }
            dirty = false;
        }

        if event::poll(Duration::from_millis(16))? {
            match event::read()? {
                Event::Key(key) => app.handle_key(key),
                Event::Mouse(mouse) => app.handle_mouse(mouse),
                Event::Resize(_, _) | Event::FocusGained | Event::FocusLost | Event::Paste(_) => {}
            }
            dirty = true;
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
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("test backend");
    let mut app = App::demo(state);
    app.set_page(page);
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
    fn vim_gg_and_capital_g_navigate_extremes() {
        let mut app = App::demo(crate::slack::demo_state());
        app.handle_key(KeyEvent::new(KeyCode::Char('G'), KeyModifiers::SHIFT));
        assert_eq!(app.selected_notification, app.state.notifications.len() - 1);
        app.handle_key(KeyEvent::new(KeyCode::Char('g'), KeyModifiers::NONE));
        app.handle_key(KeyEvent::new(KeyCode::Char('g'), KeyModifiers::NONE));
        assert_eq!(app.selected_notification, 0);
    }
}
