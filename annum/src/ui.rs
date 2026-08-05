use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use kittui::{CellRect, Direction as KittuiDirection, RendererKind, Rgba, Runtime, TerminalInfo};
use kittui_kitty::PlacementOptions;
use ratakittui::{
    Background, Border, Chrome, DrawFlush, EffectsSink, LifecycleTracker, Padding, RenderEffects,
    Shadow,
};
use ratatui::backend::{CrosstermBackend, TestBackend};
use ratatui::buffer::Buffer;
use ratatui::crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseButton, MouseEventKind,
};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::{Frame, Terminal};

use crate::cache::CacheStore;
use crate::client::{ClientHealth, ClientOptions, ClientSubscription, ClientUpdate};
use crate::config::Config;
use crate::daemon;
use crate::model::{CacheState, CalendarEvent, ChatMessage, MailMessage};

const PURPLE: Color = Color::Rgb(0x9d, 0x84, 0xff);
const CYAN: Color = Color::Rgb(0x4d, 0xd9, 0xe8);
const GREEN: Color = Color::Rgb(0x5c, 0xd6, 0x91);
const YELLOW: Color = Color::Rgb(0xf2, 0xc7, 0x66);
const RED: Color = Color::Rgb(0xef, 0x6a, 0x73);
const FG: Color = Color::Rgb(0xe6, 0xe3, 0xeb);
const MUTED: Color = Color::Rgb(0x99, 0x95, 0xa4);
const BG: Color = Color::Rgb(0x0d, 0x0e, 0x13);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Page {
    #[default]
    Email,
    Calendar,
    Chats,
    Teams,
    Search,
}

impl Page {
    const ALL: [Self; 5] = [
        Self::Email,
        Self::Calendar,
        Self::Chats,
        Self::Teams,
        Self::Search,
    ];
    fn label(self) -> &'static str {
        match self {
            Self::Email => "Email",
            Self::Calendar => "Calendar",
            Self::Chats => "Chats",
            Self::Teams => "Teams",
            Self::Search => "Search",
        }
    }
    fn domain(self, state: &CacheState, selected: usize) -> String {
        match self {
            Self::Email | Self::Search => "mail:inbox".into(),
            Self::Calendar => "calendar".into(),
            Self::Chats => state
                .chats
                .get(selected)
                .map_or_else(|| "chats".into(), |chat| format!("chat:{}", chat.id)),
            Self::Teams => "teams".into(),
        }
    }
    fn next(self) -> Self {
        let index = Self::ALL.iter().position(|page| *page == self).unwrap_or(0);
        Self::ALL[(index + 1) % Self::ALL.len()]
    }
    fn previous(self) -> Self {
        let index = Self::ALL.iter().position(|page| *page == self).unwrap_or(0);
        Self::ALL[(index + Self::ALL.len() - 1) % Self::ALL.len()]
    }
}

pub struct RunOptions {
    pub no_graphics: bool,
    pub cache_store: CacheStore,
    pub client: Option<ClientOptions>,
    pub config: Config,
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
            .context("initialize Kittui graphics")?;
        Ok(Self {
            runtime,
            tracker: LifecycleTracker::new(),
            placed: HashMap::new(),
        })
    }
}

struct FallbackWorker {
    rx: Receiver<Result<CacheState, String>>,
}

impl FallbackWorker {
    fn spawn(store: CacheStore, config: Config) -> Self {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let result = daemon::sync_once(&store, &config.workiq, &config.collector)
                .map_err(|error| format!("{error:#}"));
            let _ = tx.send(result);
        });
        Self { rx }
    }
}

struct App {
    state: CacheState,
    page: Page,
    selected: usize,
    detail_scroll: u16,
    list_focus: bool,
    query: String,
    searching: bool,
    client: Option<ClientSubscription>,
    health: Option<ClientHealth>,
    status: String,
    error: Option<String>,
    fallback: Option<FallbackWorker>,
    cache_store: CacheStore,
    config: Config,
    show_help: bool,
    should_quit: bool,
}

impl App {
    fn new(options: RunOptions) -> Self {
        let state = options.cache_store.load().unwrap_or_default();
        let page = parse_page(&options.config.start_page);
        Self {
            state,
            page,
            selected: 0,
            detail_scroll: 0,
            list_focus: true,
            query: String::new(),
            searching: false,
            client: options.client.map(ClientSubscription::spawn),
            health: None,
            status: "starting".into(),
            error: None,
            fallback: None,
            cache_store: options.cache_store,
            config: options.config,
            show_help: false,
            should_quit: false,
        }
    }

    fn drain_sources(&mut self) -> bool {
        let mut dirty = false;
        let updates = self
            .client
            .as_ref()
            .map_or_else(Vec::new, |client| client.rx.try_iter().collect());
        for update in updates {
            dirty = true;
            match update {
                ClientUpdate::State(state, status) => {
                    self.state = *state;
                    self.status = status;
                    self.error = None;
                    self.clamp_selection();
                }
                ClientUpdate::Health(health) => self.health = Some(health),
                ClientUpdate::Status(status) => self.status = status,
                ClientUpdate::Error(error) => self.error = Some(error),
                ClientUpdate::FallbackRequired(reason) => {
                    self.status = reason;
                    if self.fallback.is_none() {
                        self.fallback = Some(FallbackWorker::spawn(
                            self.cache_store.clone(),
                            self.config.clone(),
                        ));
                    }
                }
                ClientUpdate::DaemonRecovered => self.fallback = None,
            }
        }
        if let Some(worker) = &self.fallback {
            if let Ok(result) = worker.rx.try_recv() {
                dirty = true;
                self.fallback = None;
                match result {
                    Ok(state) => {
                        self.state = state;
                        self.status = "embedded fallback complete".into();
                        self.error = None;
                        self.clamp_selection();
                    }
                    Err(error) => self.error = Some(error),
                }
            }
        }
        dirty
    }

    fn clamp_selection(&mut self) {
        self.selected = self.selected.min(self.item_count().saturating_sub(1));
    }

    fn item_count(&self) -> usize {
        match self.page {
            Page::Email | Page::Search => self.filtered_mail().len(),
            Page::Calendar => self.filtered_events().len(),
            Page::Chats => self.state.chats.len(),
            Page::Teams => self
                .state
                .teams
                .iter()
                .map(|team| {
                    self.state
                        .channels
                        .get(&team.id)
                        .map_or(1, |channels| channels.len().max(1))
                })
                .sum(),
        }
    }

    fn filtered_mail(&self) -> Vec<&MailMessage> {
        self.state
            .mail
            .iter()
            .filter(|message| {
                self.query.is_empty()
                    || fuzzy_contains(&message.subject, &self.query)
                    || fuzzy_contains(&message.from.name, &self.query)
                    || fuzzy_contains(&message.body_preview, &self.query)
            })
            .collect()
    }

    fn filtered_events(&self) -> Vec<&CalendarEvent> {
        self.state
            .events
            .iter()
            .filter(|event| {
                self.query.is_empty()
                    || fuzzy_contains(&event.subject, &self.query)
                    || fuzzy_contains(&event.location, &self.query)
                    || fuzzy_contains(&event.organizer.name, &self.query)
            })
            .collect()
    }

    fn handle_key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            return;
        }
        if self.searching {
            match key.code {
                KeyCode::Esc | KeyCode::Enter => self.searching = false,
                KeyCode::Backspace => {
                    self.query.pop();
                    self.selected = 0;
                }
                KeyCode::Char(ch) => {
                    self.query.push(ch);
                    self.selected = 0;
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
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.should_quit = true;
            return;
        }
        match key.code {
            KeyCode::Char('q') => self.should_quit = true,
            KeyCode::Char('?') => self.show_help = true,
            KeyCode::Char('/') => self.searching = true,
            KeyCode::Char('r') => self.request_refresh(),
            KeyCode::Char('o') | KeyCode::Enter => self.open_selected(),
            KeyCode::Tab | KeyCode::Right | KeyCode::Char('l') => {
                self.change_page(self.page.next());
            }
            KeyCode::BackTab | KeyCode::Left | KeyCode::Char('h') => {
                self.change_page(self.page.previous());
            }
            KeyCode::Char(value @ '1'..='5') => {
                self.change_page(Page::ALL[value.to_digit(10).unwrap_or(1) as usize - 1]);
            }
            KeyCode::Up | KeyCode::Char('k') if self.list_focus => {
                self.selected = self.selected.saturating_sub(1);
                self.detail_scroll = 0;
            }
            KeyCode::Down | KeyCode::Char('j') if self.list_focus => {
                self.selected = self.selected.saturating_add(1);
                self.clamp_selection();
                self.detail_scroll = 0;
            }
            KeyCode::Up | KeyCode::Char('k') => {
                self.detail_scroll = self.detail_scroll.saturating_sub(1);
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.detail_scroll = self.detail_scroll.saturating_add(1);
            }
            KeyCode::Char('f') => self.list_focus = !self.list_focus,
            KeyCode::PageUp => self.detail_scroll = self.detail_scroll.saturating_sub(10),
            KeyCode::PageDown => self.detail_scroll = self.detail_scroll.saturating_add(10),
            KeyCode::Home | KeyCode::Char('g') => {
                self.selected = 0;
                self.detail_scroll = 0;
            }
            KeyCode::End | KeyCode::Char('G') => {
                self.selected = self.item_count().saturating_sub(1);
                self.detail_scroll = u16::MAX / 2;
            }
            KeyCode::Esc if !self.query.is_empty() => {
                self.query.clear();
                self.selected = 0;
            }
            _ => {}
        }
    }

    fn change_page(&mut self, page: Page) {
        self.page = page;
        self.selected = 0;
        self.detail_scroll = 0;
        self.query.clear();
    }

    fn request_refresh(&mut self) {
        let domain = self.page.domain(&self.state, self.selected);
        if self
            .client
            .as_ref()
            .is_some_and(|client| client.request_refresh(domain.clone()))
        {
            self.status = format!("queued {domain}");
        } else if self.fallback.is_none() {
            self.status = "refreshing through embedded fallback".into();
            self.fallback = Some(FallbackWorker::spawn(
                self.cache_store.clone(),
                self.config.clone(),
            ));
        }
    }

    fn handle_mouse(
        &mut self,
        event: ratatui::crossterm::event::MouseEvent,
        list: Rect,
        detail: Rect,
    ) -> bool {
        match event.kind {
            MouseEventKind::Down(MouseButton::Left)
                if contains_cell(list, event.column, event.row) =>
            {
                self.list_focus = true;
                let row = usize::from(event.row.saturating_sub(list.y));
                self.selected = row.min(self.item_count().saturating_sub(1));
                self.detail_scroll = 0;
                true
            }
            MouseEventKind::Down(MouseButton::Left)
                if contains_cell(detail, event.column, event.row) =>
            {
                self.list_focus = false;
                true
            }
            MouseEventKind::ScrollUp => {
                if self.list_focus {
                    self.selected = self.selected.saturating_sub(3);
                } else {
                    self.detail_scroll = self.detail_scroll.saturating_sub(3);
                }
                true
            }
            MouseEventKind::ScrollDown => {
                if self.list_focus {
                    self.selected = self.selected.saturating_add(3);
                    self.clamp_selection();
                } else {
                    self.detail_scroll = self.detail_scroll.saturating_add(3);
                }
                true
            }
            _ => false,
        }
    }

    fn open_selected(&mut self) {
        let url = match self.page {
            Page::Email | Page::Search => self
                .filtered_mail()
                .get(self.selected)
                .map(|message| message.web_link.as_str()),
            Page::Calendar => self.filtered_events().get(self.selected).map(|event| {
                if event.join_url.is_empty() {
                    event.web_link.as_str()
                } else {
                    event.join_url.as_str()
                }
            }),
            Page::Chats => self
                .state
                .chats
                .get(self.selected)
                .map(|chat| chat.web_url.as_str()),
            Page::Teams => None,
        };
        let Some(url) = url.filter(|value| !value.is_empty()) else {
            return;
        };
        let result = if cfg!(target_os = "macos") {
            std::process::Command::new("open").arg(url).spawn()
        } else {
            std::process::Command::new("xdg-open").arg(url).spawn()
        };
        if let Err(error) = result {
            self.error = Some(format!("open link: {error}"));
        }
    }

    fn render(
        &self,
        frame: &mut Frame<'_>,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) -> (Rect, Rect) {
        let area = frame.area();
        frame.render_widget(Block::default().style(Style::default().bg(BG).fg(FG)), area);
        let rows = Layout::vertical([
            Constraint::Length(4),
            Constraint::Min(8),
            Constraint::Length(2),
        ])
        .split(area);
        self.render_header(frame, rows[0], graphics);
        let columns = Layout::horizontal([
            Constraint::Length(self.config.sidebar_width.min(area.width.saturating_sub(24))),
            Constraint::Min(24),
        ])
        .split(rows[1]);
        let list = panel(
            frame,
            columns[0],
            self.page.label(),
            self.list_focus,
            Tone::List,
            graphics,
        );
        let detail = panel(
            frame,
            columns[1],
            "Detail",
            !self.list_focus,
            Tone::Detail,
            graphics,
        );
        self.render_list(frame, list);
        self.render_detail(frame, detail);
        self.render_footer(frame, rows[2]);
        if self.show_help {
            render_help(frame, area);
        }
        (list, detail)
    }

    fn render_header(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        let inner = panel(frame, area, "", false, Tone::Header, graphics);
        let mut spans = vec![
            Span::styled(
                " ANNUM ",
                Style::default()
                    .fg(BG)
                    .bg(PURPLE)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw("  "),
        ];
        for (index, page) in Page::ALL.iter().enumerate() {
            let active = *page == self.page;
            spans.push(Span::styled(
                format!(" {}:{} ", index + 1, page.label()),
                Style::default()
                    .fg(if active { BG } else { MUTED })
                    .bg(if active { CYAN } else { BG })
                    .add_modifier(if active {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            ));
            spans.push(Span::raw(" "));
        }
        frame.render_widget(
            Paragraph::new(Line::from(spans)),
            Rect::new(inner.x, inner.y, inner.width, 1),
        );
        let account = if self.state.account.mail.is_empty() {
            &self.state.account.user_principal_name
        } else {
            &self.state.account.mail
        };
        let summary = format!(
            "{}  ·  {} email  ·  {} events  ·  {} chats  ·  rev {}",
            if account.is_empty() {
                "not synchronized"
            } else {
                account
            },
            self.state.mail.len(),
            self.state.events.len(),
            self.state.chats.len(),
            self.state.collector.revision
        );
        if inner.height > 1 {
            frame.render_widget(
                Paragraph::new(summary).style(Style::default().fg(MUTED)),
                Rect::new(inner.x, inner.y + 1, inner.width, 1),
            );
        }
    }

    fn render_list(&self, frame: &mut Frame<'_>, area: Rect) {
        let items = self.list_items();
        let list = List::new(items)
            .highlight_style(
                Style::default()
                    .fg(BG)
                    .bg(if self.list_focus { CYAN } else { PURPLE })
                    .add_modifier(Modifier::BOLD),
            )
            .highlight_symbol("› ");
        let mut state = ListState::default()
            .with_selected((!self.list_items().is_empty()).then_some(self.selected));
        frame.render_stateful_widget(list, area, &mut state);
    }

    fn list_items(&self) -> Vec<ListItem<'static>> {
        match self.page {
            Page::Email | Page::Search => self
                .filtered_mail()
                .into_iter()
                .map(|message| {
                    let marker = if message.is_read { " " } else { "●" };
                    ListItem::new(vec![
                        Line::from(vec![Span::styled(
                            format!("{marker} {}", message.subject),
                            Style::default()
                                .fg(if message.is_read { FG } else { YELLOW })
                                .add_modifier(if message.is_read {
                                    Modifier::empty()
                                } else {
                                    Modifier::BOLD
                                }),
                        )]),
                        Line::from(Span::styled(
                            format!(
                                "{}  {}",
                                display_address(&message.from.name, &message.from.address),
                                short_time(&message.received_at)
                            ),
                            Style::default().fg(MUTED),
                        )),
                    ])
                })
                .collect(),
            Page::Calendar => self
                .filtered_events()
                .into_iter()
                .map(|event| {
                    ListItem::new(vec![
                        Line::from(Span::styled(
                            event.subject.clone(),
                            Style::default().fg(FG).add_modifier(Modifier::BOLD),
                        )),
                        Line::from(Span::styled(
                            format!("{}  {}", short_time(&event.start), event.location),
                            Style::default().fg(MUTED),
                        )),
                    ])
                })
                .collect(),
            Page::Chats => self
                .state
                .chats
                .iter()
                .map(|chat| {
                    let count = self.state.chat_messages.get(&chat.id).map_or(0, Vec::len);
                    ListItem::new(vec![
                        Line::from(Span::styled(
                            chat.label(),
                            Style::default().fg(FG).add_modifier(Modifier::BOLD),
                        )),
                        Line::from(Span::styled(
                            format!("{}  ·  {count} cached", chat.chat_type),
                            Style::default().fg(MUTED),
                        )),
                    ])
                })
                .collect(),
            Page::Teams => {
                let mut items = Vec::new();
                for team in &self.state.teams {
                    let channels = self.state.channels.get(&team.id);
                    if let Some(channels) = channels.filter(|channels| !channels.is_empty()) {
                        for channel in channels {
                            items.push(ListItem::new(vec![
                                Line::from(Span::styled(
                                    channel.display_name.clone(),
                                    Style::default().fg(FG).add_modifier(Modifier::BOLD),
                                )),
                                Line::from(Span::styled(
                                    team.display_name.clone(),
                                    Style::default().fg(MUTED),
                                )),
                            ]));
                        }
                    } else {
                        items.push(ListItem::new(team.display_name.clone()));
                    }
                }
                items
            }
        }
    }

    fn render_detail(&self, frame: &mut Frame<'_>, area: Rect) {
        let text = self.detail_text();
        frame.render_widget(
            Paragraph::new(text)
                .wrap(Wrap { trim: false })
                .scroll((self.detail_scroll, 0))
                .style(Style::default().fg(FG)),
            area,
        );
    }

    fn detail_text(&self) -> Text<'static> {
        match self.page {
            Page::Email | Page::Search => self.filtered_mail().get(self.selected).map_or_else(
                || Text::from("No email selected."),
                |message| email_detail(message),
            ),
            Page::Calendar => self.filtered_events().get(self.selected).map_or_else(
                || Text::from("No event selected."),
                |event| event_detail(event),
            ),
            Page::Chats => self.state.chats.get(self.selected).map_or_else(
                || Text::from("No chat selected."),
                |chat| {
                    let messages = self
                        .state
                        .chat_messages
                        .get(&chat.id)
                        .map_or(&[][..], Vec::as_slice);
                    chat_detail(&chat.label(), messages)
                },
            ),
            Page::Teams => Text::from(vec![
                Line::styled(
                    "Teams and channels",
                    Style::default().fg(PURPLE).add_modifier(Modifier::BOLD),
                ),
                Line::raw(""),
                Line::raw(
                    "Select a channel, press r to request a channel inventory refresh, or use annum search for deterministic cached content.",
                ),
            ]),
        }
    }

    fn render_footer(&self, frame: &mut Frame<'_>, area: Rect) {
        let health = self.health.as_ref().map_or("", |health| {
            if health.daemon_connected {
                "daemon live"
            } else if health.fallback_active {
                "fallback"
            } else {
                "cache"
            }
        });
        let search = if self.searching {
            format!("  search: {}_", self.query)
        } else if self.query.is_empty() {
            String::new()
        } else {
            format!("  filter: {}", self.query)
        };
        let error = self
            .error
            .as_ref()
            .map_or(String::new(), |error| format!("  ERROR: {error}"));
        let line = Line::from(vec![
            Span::styled(
                " Tab",
                Style::default().fg(CYAN).add_modifier(Modifier::BOLD),
            ),
            Span::styled(" page  ", Style::default().fg(MUTED)),
            Span::styled(
                "j/k",
                Style::default().fg(CYAN).add_modifier(Modifier::BOLD),
            ),
            Span::styled(" select  ", Style::default().fg(MUTED)),
            Span::styled("/", Style::default().fg(CYAN).add_modifier(Modifier::BOLD)),
            Span::styled(" filter  ", Style::default().fg(MUTED)),
            Span::styled("r", Style::default().fg(CYAN).add_modifier(Modifier::BOLD)),
            Span::styled(" refresh  ", Style::default().fg(MUTED)),
            Span::styled("o", Style::default().fg(CYAN).add_modifier(Modifier::BOLD)),
            Span::styled(" open  ", Style::default().fg(MUTED)),
            Span::styled(
                format!("{health} · {}{search}{error}", self.status),
                Style::default().fg(if self.error.is_some() { RED } else { GREEN }),
            ),
        ]);
        frame.render_widget(Paragraph::new(line).style(Style::default().bg(BG)), area);
    }
}

fn email_detail(message: &MailMessage) -> Text<'static> {
    let body = if message.body_markdown.is_empty() {
        message.body_preview.clone()
    } else {
        message.body_markdown.clone()
    };
    Text::from(vec![
        Line::styled(
            message.subject.clone(),
            Style::default().fg(PURPLE).add_modifier(Modifier::BOLD),
        ),
        Line::raw(""),
        Line::from(vec![
            Span::styled("From  ", Style::default().fg(MUTED)),
            Span::raw(display_address(&message.from.name, &message.from.address).to_string()),
        ]),
        Line::from(vec![
            Span::styled("Date  ", Style::default().fg(MUTED)),
            Span::raw(message.received_at.clone()),
        ]),
        Line::from(vec![
            Span::styled("State ", Style::default().fg(MUTED)),
            Span::raw(if message.is_read { "read" } else { "unread" }),
        ]),
        Line::raw(""),
        Line::raw(body),
    ])
}

fn event_detail(event: &CalendarEvent) -> Text<'static> {
    let body = if event.body_markdown.is_empty() {
        event.body_preview.clone()
    } else {
        event.body_markdown.clone()
    };
    Text::from(vec![
        Line::styled(
            event.subject.clone(),
            Style::default().fg(PURPLE).add_modifier(Modifier::BOLD),
        ),
        Line::raw(""),
        Line::from(vec![
            Span::styled("When      ", Style::default().fg(MUTED)),
            Span::raw(format!(
                "{} — {} {}",
                event.start, event.end, event.timezone
            )),
        ]),
        Line::from(vec![
            Span::styled("Organizer ", Style::default().fg(MUTED)),
            Span::raw(display_address(&event.organizer.name, &event.organizer.address).to_string()),
        ]),
        Line::from(vec![
            Span::styled("Location  ", Style::default().fg(MUTED)),
            Span::raw(event.location.clone()),
        ]),
        Line::from(vec![
            Span::styled("Response  ", Style::default().fg(MUTED)),
            Span::raw(event.response_status.clone()),
        ]),
        Line::raw(""),
        Line::raw(body),
    ])
}

fn chat_detail(title: &str, messages: &[ChatMessage]) -> Text<'static> {
    let mut lines = vec![
        Line::styled(
            title.to_string(),
            Style::default().fg(PURPLE).add_modifier(Modifier::BOLD),
        ),
        Line::raw(""),
    ];
    for message in messages {
        lines.push(Line::from(vec![
            Span::styled(
                format!(
                    "{}  ",
                    display_address(&message.from.name, &message.from.address)
                ),
                Style::default().fg(CYAN).add_modifier(Modifier::BOLD),
            ),
            Span::styled(short_time(&message.created_at), Style::default().fg(MUTED)),
        ]));
        lines.push(Line::raw(message.body_markdown.clone()));
        lines.push(Line::raw(""));
    }
    if messages.is_empty() {
        lines.push(Line::raw("No cached messages. Press r to queue this chat."));
    }
    Text::from(lines)
}

fn display_address<'a>(name: &'a str, address: &'a str) -> &'a str {
    if name.is_empty() { address } else { name }
}
fn short_time(value: &str) -> String {
    value
        .replace('T', " ")
        .trim_end_matches('Z')
        .chars()
        .take(16)
        .collect()
}
fn fuzzy_contains(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}
fn contains_cell(area: Rect, x: u16, y: u16) -> bool {
    x >= area.x && x < area.right() && y >= area.y && y < area.bottom()
}
fn parse_page(value: &str) -> Page {
    match value {
        "calendar" => Page::Calendar,
        "chats" => Page::Chats,
        "teams" => Page::Teams,
        "search" => Page::Search,
        _ => Page::Email,
    }
}

#[derive(Clone, Copy)]
enum Tone {
    Header,
    List,
    Detail,
}
fn chrome(tone: Tone, focused: bool) -> Chrome {
    let (top, bottom, rail) = match tone {
        Tone::Header => ("#201744ff", "#10121bff", "#9d84ffff"),
        Tone::List => ("#171b27ff", "#101219ff", "#4dd9e8ff"),
        Tone::Detail => ("#181621ff", "#0f1017ff", "#9d84ffff"),
    };
    let rail = if focused { "#f2c766ff" } else { rail };
    Chrome::default()
        .background(Background::Linear {
            direction: KittuiDirection::Vertical,
            start: Rgba::parse(top).unwrap_or_else(|_| Rgba::rgb(0x17, 0x1b, 0x27)),
            end: Rgba::parse(bottom).unwrap_or_else(|_| Rgba::rgb(0x10, 0x12, 0x19)),
        })
        .border(Border::rounded(
            Rgba::parse(rail).unwrap_or_else(|_| Rgba::rgb(0x9d, 0x84, 0xff)),
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
fn panel(
    frame: &mut Frame<'_>,
    area: Rect,
    title: &str,
    focused: bool,
    tone: Tone,
    graphics: Option<(&Runtime, &EffectsSink)>,
) -> Rect {
    if let Some((runtime, sink)) = graphics {
        let chrome = chrome(tone, focused);
        sink.push(render_chrome_underlay(area, &chrome, runtime));
        let mut inner = chrome.inner_rect(area);
        if !title.is_empty() && inner.height > 0 {
            frame.render_widget(
                Paragraph::new(Line::styled(
                    title.to_string(),
                    Style::default()
                        .fg(if focused { YELLOW } else { PURPLE })
                        .add_modifier(Modifier::BOLD),
                )),
                Rect::new(inner.x, inner.y, inner.width, 1),
            );
            inner.y += 1;
            inner.height = inner.height.saturating_sub(1);
        }
        inner
    } else {
        let block = Block::default()
            .borders(Borders::ALL)
            .title(title.to_string())
            .border_style(Style::default().fg(if focused { YELLOW } else { PURPLE }));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        inner
    }
}
fn render_chrome_underlay(area: Rect, chrome: &Chrome, runtime: &Runtime) -> RenderEffects {
    let local = Rect::new(0, 0, area.width, area.height);
    let Some(mut scene) = chrome.to_scene(local) else {
        return RenderEffects::default();
    };
    scene.footprint = CellRect::new(area.x, area.y, area.width, area.height);
    let id = scene.id();
    let options = PlacementOptions::absolute_with_id(id.kitty_image_id())
        .with_z_index(-1)
        .without_cursor_advance();
    runtime
        .place_at_with_options_by_id(&scene, scene.footprint, &options, &id)
        .map_or_else(
            |_| RenderEffects::default(),
            |placement| RenderEffects::from_placement(placement, id),
        )
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
    writer.write_all(flush.upload.as_bytes())?;
    writer.write_all(flush.placement.as_bytes())?;
    writer.write_all(flush.deletes.as_bytes())?;
    writer.flush()
}

pub fn run(options: RunOptions) -> Result<()> {
    let no_graphics = options.no_graphics;
    let mut app = App::new(options);
    let mut stdout = io::stdout();
    enable_raw_mode().context("enable terminal raw mode")?;
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture).context("enter Annum screen")?;
    let mut terminal =
        Terminal::new(CrosstermBackend::new(stdout)).context("initialize Annum terminal")?;
    terminal.clear()?;
    let mut graphics = if no_graphics {
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
    let mut list = Rect::default();
    let mut detail = Rect::default();
    let mut last_tick = Instant::now();
    while !app.should_quit {
        dirty |= app.drain_sources();
        if last_tick.elapsed() >= Duration::from_secs(1) {
            dirty = true;
            last_tick = Instant::now();
        }
        if dirty {
            if let Some(graphics) = graphics.as_deref_mut() {
                graphics.tracker.begin_frame();
                let sink = EffectsSink::new();
                terminal.draw(|frame| {
                    (list, detail) = app.render(frame, Some((&graphics.runtime, &sink)));
                })?;
                let flush = finalize_graphics_frame(graphics, &sink);
                write_graphics_flush(terminal.backend_mut(), &flush)?;
            } else {
                terminal.draw(|frame| {
                    (list, detail) = app.render(frame, None);
                })?;
            }
            dirty = false;
        }
        if event::poll(Duration::from_millis(50))? {
            dirty |= match event::read()? {
                Event::Key(key) => {
                    app.handle_key(key);
                    true
                }
                Event::Mouse(mouse) => app.handle_mouse(mouse, list, detail),
                Event::Resize(_, _) | Event::FocusGained | Event::FocusLost => true,
                Event::Paste(_) => false,
            };
        }
    }
    Ok(())
}

fn render_help(frame: &mut Frame<'_>, area: Rect) {
    let popup = centered_rect(70, 18, area);
    frame.render_widget(Clear, popup);
    let text = Text::from(vec![
        Line::styled(
            "Annum keys",
            Style::default().fg(PURPLE).add_modifier(Modifier::BOLD),
        ),
        Line::raw(""),
        Line::raw("Tab / Shift-Tab / 1–5  switch surface"),
        Line::raw("j/k or arrows          select / scroll"),
        Line::raw("f                      focus list/detail"),
        Line::raw("/                      deterministic local filter"),
        Line::raw("r                      queue daemon refresh"),
        Line::raw("o / Enter              open Outlook/Teams link"),
        Line::raw("g/G                    first/last"),
        Line::raw("?                      close help"),
        Line::raw("q                      quit"),
    ]);
    frame.render_widget(
        Paragraph::new(text)
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" Help ")
                    .style(Style::default().bg(BG).fg(FG)),
            )
            .wrap(Wrap { trim: false }),
        popup,
    );
}
fn centered_rect(width: u16, height: u16, area: Rect) -> Rect {
    let width = width.min(area.width.saturating_sub(2));
    let height = height.min(area.height.saturating_sub(2));
    Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    )
}

#[must_use]
pub fn snapshot(state: CacheState, width: u16, height: u16, page: Page, config: Config) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    let app = App {
        state,
        page,
        selected: 0,
        detail_scroll: 0,
        list_focus: true,
        query: String::new(),
        searching: false,
        client: None,
        health: None,
        status: "snapshot".into(),
        error: None,
        fallback: None,
        cache_store: CacheStore::new(std::env::temp_dir().join("annum-snapshot-unused.json")),
        config,
        show_help: false,
        should_quit: false,
    };
    terminal
        .draw(|frame| {
            let _ = app.render(frame, None);
        })
        .unwrap();
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
    use crate::model::{Address, MailMessage};
    #[test]
    fn snapshot_contains_all_primary_surfaces() {
        let mut state = CacheState::default();
        state.account.mail = "user@example.com".into();
        state.mail.push(MailMessage {
            id: "m1".into(),
            subject: "Important plan".into(),
            from: Address {
                name: "Ada".into(),
                ..Address::default()
            },
            body_preview: "Review this".into(),
            ..MailMessage::default()
        });
        let text = snapshot(state, 120, 36, Page::Email, Config::default());
        for expected in [
            "ANNUM",
            "Email",
            "Calendar",
            "Chats",
            "Teams",
            "Important plan",
            "Ada",
        ] {
            assert!(text.contains(expected), "missing {expected}\n{text}");
        }
    }
    #[test]
    fn graphics_underlay_is_stable_and_non_advancing() {
        let options = PlacementOptions::absolute_with_id(42)
            .with_z_index(-1)
            .without_cursor_advance();
        assert_eq!(options.placement_id, Some(42));
        assert!(!options.cursor_advance);
        assert_eq!(options.z_index, -1);
    }
}
