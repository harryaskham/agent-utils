#![allow(clippy::too_many_lines)]

use std::collections::{BTreeMap, HashMap};
use std::io::{self, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use crate::client::{ClientHealth, ClientSubscription, ClientUpdate};
use crate::collector::{default_accounts, fetch_all};
use crate::history::{summarize, HistorySample};
use crate::model::{AccountId, AccountUsage, CostState, Quota, RateSummary, WindowSpend};
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
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, Gauge, Paragraph, Row, Sparkline, Table, Wrap};
use ratatui::{Frame, Terminal};

const PURPLE: Color = Color::Rgb(0x9d, 0x84, 0xff);
const CYAN: Color = Color::Rgb(0x4d, 0xd9, 0xe8);
const GREEN: Color = Color::Rgb(0x5c, 0xd6, 0x91);
const YELLOW: Color = Color::Rgb(0xf2, 0xc7, 0x66);
const RED: Color = Color::Rgb(0xef, 0x6a, 0x73);
const FG: Color = Color::Rgb(0xe6, 0xe3, 0xeb);
const MUTED: Color = Color::Rgb(0x99, 0x95, 0xa4);

#[derive(Debug)]
enum WorkerEvent {
    Started,
    Finished(Vec<AccountUsage>),
}

struct Worker {
    tx: Sender<()>,
    rx: Receiver<WorkerEvent>,
}

impl Worker {
    fn spawn(accounts: Vec<AccountId>) -> Self {
        let (command_tx, command_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();
        thread::spawn(move || {
            while command_rx.recv().is_ok() {
                while command_rx.try_recv().is_ok() {}
                let _ = event_tx.send(WorkerEvent::Started);
                let usages = fetch_all(&accounts);
                let _ = event_tx.send(WorkerEvent::Finished(usages));
            }
        });
        Self {
            tx: command_tx,
            rx: event_rx,
        }
    }

    fn refresh(&self) {
        let _ = self.tx.send(());
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
            .context("initialize Kittui graphics")?;
        Ok(Self {
            runtime,
            tracker: LifecycleTracker::new(),
            placed: HashMap::new(),
        })
    }
}

struct App {
    usages: Vec<AccountUsage>,
    selected: usize,
    histories: HashMap<String, Vec<u64>>,
    history_times: HashMap<String, (i64, i64)>,
    rates: BTreeMap<String, RateSummary>,
    deltas: HashMap<String, f64>,
    worker: Option<Worker>,
    subscription: Option<ClientSubscription>,
    client_health: Option<ClientHealth>,
    busy: bool,
    status: String,
    source: String,
    refresh_interval: Duration,
    next_refresh: Instant,
    show_help: bool,
    should_quit: bool,
}

impl App {
    fn new(usages: Vec<AccountUsage>, refresh_secs: u64, embedded: bool) -> Self {
        let accounts = usages.iter().map(|usage| usage.account.clone()).collect();
        let worker = embedded.then(|| Worker::spawn(accounts));
        let mut app = Self {
            usages,
            selected: 0,
            histories: HashMap::new(),
            history_times: HashMap::new(),
            rates: BTreeMap::new(),
            deltas: HashMap::new(),
            worker,
            subscription: None,
            client_health: None,
            busy: false,
            status: if embedded {
                "standalone starting"
            } else {
                "demo"
            }
            .into(),
            source: if embedded { "STANDALONE" } else { "DEMO" }.into(),
            refresh_interval: Duration::from_secs(refresh_secs),
            next_refresh: Instant::now() + Duration::from_secs(refresh_secs),
            show_help: false,
            should_quit: false,
        };
        app.record_history();
        if embedded {
            app.request_refresh();
        }
        app
    }

    fn from_state(state: CostState, refresh_secs: u64, subscription: ClientSubscription) -> Self {
        let mut app = Self::new(state.usages.clone(), refresh_secs, false);
        app.subscription = Some(subscription);
        app.source = "CLIENT".into();
        app.status = "loading cache/daemon".into();
        app.apply_state(state, "client · initial");
        app
    }

    fn from_static_state(state: CostState, refresh_secs: u64) -> Self {
        let mut app = Self::new(state.usages.clone(), refresh_secs, false);
        app.apply_state(state, "demo");
        app.source = "DEMO".into();
        app.status = "demo · network disabled".into();
        app
    }

    fn request_refresh(&mut self) {
        if self.busy {
            return;
        }
        if let Some(subscription) = &self.subscription {
            if subscription.request_refresh("all".into()) {
                self.status = "daemon refresh requested".into();
                self.busy = true;
            } else {
                self.status = "daemon refresh unavailable".into();
            }
        } else if let Some(worker) = &self.worker {
            worker.refresh();
            self.busy = true;
            self.status = "standalone refresh queued".into();
        } else {
            self.status = "demo · network disabled".into();
        }
    }

    fn drain_sources(&mut self) -> bool {
        let worker_events = self
            .worker
            .as_ref()
            .map_or_else(Vec::new, |worker| worker.rx.try_iter().collect());
        let client_events = self
            .subscription
            .as_ref()
            .map_or_else(Vec::new, |subscription| {
                subscription.rx.try_iter().collect()
            });
        let changed = !worker_events.is_empty() || !client_events.is_empty();
        for event in worker_events {
            match event {
                WorkerEvent::Started => {
                    self.busy = true;
                    self.status = "querying all accounts in parallel".into();
                }
                WorkerEvent::Finished(incoming) => {
                    self.merge(incoming);
                    self.busy = false;
                    self.next_refresh = Instant::now() + self.refresh_interval;
                    let good = self.usages.iter().filter(|usage| usage.online()).count();
                    self.status = format!("refreshed {good}/{} accounts", self.usages.len());
                }
            }
        }
        for event in client_events {
            match event {
                ClientUpdate::State(state, source) => self.apply_state(*state, &source),
                ClientUpdate::Health(health) => {
                    self.busy = false;
                    self.client_health = Some(health);
                }
                ClientUpdate::Status(status) => self.status = status,
                ClientUpdate::Error(error) => self.status = error,
                ClientUpdate::FallbackRequired(reason) => {
                    self.status = format!("{reason}; direct fallback is disabled");
                }
                ClientUpdate::DaemonRecovered => self.status = "daemon recovered".into(),
            }
        }
        changed
    }

    fn apply_state(&mut self, state: CostState, source: &str) {
        self.merge(state.usages);
        self.histories = state
            .series
            .iter()
            .map(|(key, points)| {
                (
                    key.clone(),
                    points
                        .iter()
                        .map(|point| credit_sample(point.credits_used))
                        .collect(),
                )
            })
            .collect();
        self.history_times = state
            .series
            .iter()
            .filter_map(|(key, points)| {
                Some((
                    key.clone(),
                    (points.first()?.captured_at, points.last()?.captured_at),
                ))
            })
            .collect();
        self.rates = state.rates;
        self.busy = state.collector.current_domain.is_some();
        self.status = if state.collector.last_error.is_empty() {
            source.to_string()
        } else {
            format!("{source} · {}", state.collector.last_error)
        };
        self.source = if source.contains("daemon") {
            "DAEMON"
        } else if source.contains("cache") {
            "CACHE"
        } else {
            "CLIENT"
        }
        .into();
        if let Some(next) = state.collector.next_attempt_at {
            let seconds = u64::try_from(next.saturating_sub(CostState::now()).max(0)).unwrap_or(0);
            self.next_refresh = Instant::now() + Duration::from_secs(seconds);
        }
    }

    fn merge(&mut self, incoming: Vec<AccountUsage>) {
        let old: HashMap<_, _> = self
            .usages
            .iter()
            .cloned()
            .map(|usage| (usage.account.key(), usage))
            .collect();
        self.usages = incoming
            .into_iter()
            .map(|mut usage| {
                let key = usage.account.key();
                if let Some(previous) = old.get(&key) {
                    if usage.error.is_some() {
                        let error = usage.error.take();
                        let refreshed_at = usage.refreshed_at;
                        usage = previous.clone();
                        usage.error = error;
                        usage.refreshed_at = refreshed_at;
                    } else if let (Some(current), Some(old_quota)) =
                        (usage.premium(), previous.premium())
                    {
                        let same_cycle = current.reset_marker().is_empty()
                            || old_quota.reset_marker().is_empty()
                            || current.reset_marker() == old_quota.reset_marker();
                        let elapsed = usage.refreshed_at.saturating_sub(previous.refreshed_at);
                        if same_cycle
                            && elapsed > 0
                            && current.credits_used >= old_quota.credits_used
                        {
                            let delta = current.credits_used - old_quota.credits_used;
                            self.deltas.insert(key.clone(), delta);
                            self.rates
                                .entry(key)
                                .or_default()
                                .current_dollars_per_minute =
                                Some(delta * 0.01 * 60.0 / elapsed as f64);
                        }
                    }
                }
                usage
            })
            .collect();
        self.selected = self.selected.min(self.usages.len().saturating_sub(1));
        self.record_history();
    }

    fn record_history(&mut self) {
        for usage in &self.usages {
            let Some(quota) = usage.premium() else {
                continue;
            };
            let points = self.histories.entry(usage.account.key()).or_default();
            points.push(credit_sample(quota.credits_used));
            if points.len() > 72 {
                points.remove(0);
            }
        }
    }

    fn timer_tick(&mut self) {
        if !self.busy && self.worker.is_some() && Instant::now() >= self.next_refresh {
            self.request_refresh();
        }
    }

    fn countdown_label(&self) -> String {
        if self.busy {
            return "refreshing now".into();
        }
        let seconds = self
            .next_refresh
            .saturating_duration_since(Instant::now())
            .as_secs();
        if seconds == 0 {
            "refresh due".into()
        } else {
            format!("next in {}", countdown_duration(seconds))
        }
    }

    fn handle_key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
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
            KeyCode::Char('r') => self.request_refresh(),
            KeyCode::Left | KeyCode::Char('h' | 'k') | KeyCode::Up => {
                self.selected = self.selected.saturating_sub(1);
            }
            KeyCode::Right | KeyCode::Char('l' | 'j') | KeyCode::Down => {
                self.selected = self
                    .selected
                    .saturating_add(1)
                    .min(self.usages.len().saturating_sub(1));
            }
            KeyCode::Char(value @ '1'..='9') => {
                let index = value.to_digit(10).unwrap_or(1) as usize - 1;
                if index < self.usages.len() {
                    self.selected = index;
                }
            }
            _ => {}
        }
    }

    fn handle_mouse(&mut self, column: u16, row: u16, cards: &[Rect]) -> bool {
        if let Some(index) = cards.iter().position(|area| contains(*area, column, row)) {
            self.selected = index;
            true
        } else {
            false
        }
    }

    fn render(
        &self,
        frame: &mut Frame<'_>,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) -> Vec<Rect> {
        let area = frame.area();
        let wide = area.width >= 92;
        let rows = if wide {
            self.usages.len().div_ceil(2)
        } else {
            self.usages.len()
        };
        let cards_height = u16::try_from(
            rows.saturating_mul(7)
                .saturating_add(rows.saturating_sub(1)),
        )
        .unwrap_or(20)
        .min(area.height.saturating_sub(13).max(7));
        let vertical = Layout::vertical([
            Constraint::Length(3),
            Constraint::Length(cards_height),
            Constraint::Min(9),
            Constraint::Length(1),
        ])
        .split(area);

        self.render_header(frame, vertical[0], graphics);
        let cards = card_grid(vertical[1], self.usages.len(), wide);
        for (index, usage) in self.usages.iter().enumerate() {
            if let Some(card) = cards.get(index) {
                self.render_card(frame, *card, usage, index == self.selected, graphics);
            }
        }
        self.render_detail(frame, vertical[2], graphics);
        self.render_footer(frame, vertical[3]);
        if self.show_help {
            Self::render_help(frame, area);
        }
        cards
    }

    fn render_header(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        let inner = panel(frame, area, "", false, Tone::Header, graphics);
        let total_used: f64 = self
            .usages
            .iter()
            .filter_map(AccountUsage::premium)
            .map(|quota| quota.credits_used)
            .sum();
        let total_entitlement: f64 = self
            .usages
            .iter()
            .filter_map(AccountUsage::premium)
            .map(|quota| quota.entitlement)
            .sum();
        let online = self.usages.iter().filter(|usage| usage.online()).count();
        let state = if self.busy {
            "REFRESHING"
        } else {
            self.source.as_str()
        };
        let columns = Layout::horizontal([
            Constraint::Length(28),
            Constraint::Min(35),
            Constraint::Length(30),
        ])
        .split(inner);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(" ◈ ", Style::default().fg(PURPLE)),
                Span::styled(
                    "COPILOT COSTS",
                    Style::default()
                        .fg(Color::White)
                        .add_modifier(Modifier::BOLD),
                ),
            ])),
            columns[0],
        );
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("Used ", Style::default().fg(MUTED)),
                Span::styled(format_number(total_used), Style::default().fg(YELLOW)),
                Span::styled(" / ", Style::default().fg(MUTED)),
                Span::styled(format_number(total_entitlement), Style::default().fg(FG)),
                Span::styled(
                    format!("  ·  {}", format_currency(total_used * 0.01)),
                    Style::default().fg(CYAN),
                ),
            ])),
            columns[1],
        );
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    format!("● {state}"),
                    Style::default()
                        .fg(if self.busy { YELLOW } else { GREEN })
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  {online}/{} accounts", self.usages.len()),
                    Style::default().fg(MUTED),
                ),
            ]))
            .alignment(ratatui::layout::Alignment::Right),
            columns[2],
        );
    }

    fn render_card(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        usage: &AccountUsage,
        selected: bool,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        let title = format!(" {}@{} ", usage.account.login, usage.account.host);
        let inner = panel(frame, area, &title, selected, Tone::Card, graphics);
        if inner.height == 0 || inner.width == 0 {
            return;
        }
        let Some(quota) = usage.premium() else {
            let (icon, color, message) = if let Some(error) = &usage.error {
                ("!", RED, error.as_str())
            } else {
                ("◌", YELLOW, "Waiting for first refresh…")
            };
            frame.render_widget(
                Paragraph::new(vec![
                    Line::from(Span::styled(
                        format!(
                            "{icon} {}",
                            if usage.error.is_some() {
                                "OFFLINE"
                            } else {
                                "LOADING"
                            }
                        ),
                        Style::default().fg(color).add_modifier(Modifier::BOLD),
                    )),
                    Line::default(),
                    Line::from(Span::styled(message, Style::default().fg(MUTED))),
                ])
                .wrap(Wrap { trim: true }),
                inner,
            );
            return;
        };

        let delta = self
            .deltas
            .get(&usage.account.key())
            .copied()
            .unwrap_or(0.0);
        let status = if let Some(error) = &usage.error {
            (format!("! stale · {error}"), RED)
        } else {
            (format!("● {}", fallback(&usage.plan, "Copilot")), GREEN)
        };
        let content = Layout::vertical([
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Length(1),
            Constraint::Min(1),
        ])
        .split(inner);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    status.0,
                    Style::default().fg(status.1).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  ·  {}", short_sku(&usage.sku)),
                    Style::default().fg(MUTED),
                ),
            ])),
            content[0],
        );
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("Used ", Style::default().fg(MUTED)),
                Span::styled(
                    format_number(quota.credits_used),
                    Style::default().fg(YELLOW).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  {}", format_currency(quota.credits_used * 0.01)),
                    Style::default().fg(CYAN),
                ),
                Span::styled(
                    if delta > 0.0 {
                        format!("  Δ +{}", format_number(delta))
                    } else {
                        String::new()
                    },
                    Style::default().fg(PURPLE),
                ),
            ])),
            content[1],
        );
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("Left ", Style::default().fg(MUTED)),
                Span::styled(
                    format_number(quota.remaining_value()),
                    Style::default().fg(GREEN).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  ·  {:.1}%", quota.percent_left()),
                    Style::default().fg(FG),
                ),
            ])),
            content[2],
        );
        let ratio = quota.used_ratio();
        let gauge = Gauge::default()
            .gauge_style(
                Style::default()
                    .fg(usage_color(ratio))
                    .bg(Color::Rgb(0x24, 0x25, 0x30)),
            )
            .ratio(ratio)
            .label(format!("{:.1}% used", ratio * 100.0));
        frame.render_widget(gauge, content[3]);
    }

    fn render_detail(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        graphics: Option<(&Runtime, &EffectsSink)>,
    ) {
        let Some(usage) = self.usages.get(self.selected) else {
            return;
        };
        let title = format!(" Details · {} ", usage.account.key());
        let inner = panel(frame, area, &title, true, Tone::Detail, graphics);
        if inner.height < 3 || inner.width < 20 {
            return;
        }
        let chunks = Layout::vertical([
            Constraint::Length(2),
            Constraint::Min(4),
            Constraint::Length(5),
        ])
        .split(inner);
        let assigned = if usage.assigned_date.is_empty() {
            "unknown".into()
        } else {
            short_timestamp(&usage.assigned_date)
        };
        let age = age_label(usage.refreshed_at);
        let metadata = Text::from(vec![
            Line::from(vec![
                Span::styled("Plan  ", Style::default().fg(MUTED)),
                Span::styled(fallback(&usage.plan, "unknown"), Style::default().fg(FG)),
                Span::styled("    SKU  ", Style::default().fg(MUTED)),
                Span::styled(fallback(&usage.sku, "unknown"), Style::default().fg(CYAN)),
            ]),
            Line::from(vec![
                Span::styled("Seat  ", Style::default().fg(MUTED)),
                Span::styled(assigned, Style::default().fg(FG)),
                Span::styled("    Snapshot  ", Style::default().fg(MUTED)),
                Span::styled(
                    age,
                    Style::default().fg(if usage.error.is_some() { RED } else { GREEN }),
                ),
            ]),
        ]);
        frame.render_widget(Paragraph::new(metadata), chunks[0]);

        let header = Row::new([
            "Quota",
            "Used",
            "Remaining",
            "Entitlement",
            "% left",
            "Overage",
            "Reset",
        ])
        .style(Style::default().fg(PURPLE).add_modifier(Modifier::BOLD));
        let rows: Vec<Row<'_>> = ordered_quotas(usage)
            .into_iter()
            .map(|(name, quota)| {
                Row::new([
                    quota_label(name),
                    if quota.unlimited {
                        "unlimited".into()
                    } else {
                        format_number(quota.credits_used)
                    },
                    if quota.unlimited {
                        "unlimited".into()
                    } else {
                        format_number(quota.remaining_value())
                    },
                    if quota.unlimited {
                        "—".into()
                    } else {
                        format_number(quota.entitlement)
                    },
                    if quota.unlimited {
                        "∞".into()
                    } else {
                        format!("{:.1}%", quota.percent_left())
                    },
                    if quota.overage_permitted {
                        format_number(quota.overage_count)
                    } else {
                        "disabled".into()
                    },
                    quota.reset_label(),
                ])
                .style(Style::default().fg(FG))
            })
            .collect();
        let table = Table::new(
            rows,
            [
                Constraint::Length(20),
                Constraint::Length(13),
                Constraint::Length(13),
                Constraint::Length(13),
                Constraint::Length(8),
                Constraint::Length(10),
                Constraint::Min(12),
            ],
        )
        .header(header)
        .column_spacing(1);
        frame.render_widget(table, chunks[1]);

        let key = usage.account.key();
        let points: &[u64] = self.histories.get(&key).map_or(&[], Vec::as_slice);
        let bottom = Layout::horizontal([
            Constraint::Length(58),
            Constraint::Length(22),
            Constraint::Min(8),
        ])
        .split(chunks[2]);
        let rates = self.rates.get(&key).cloned().unwrap_or_default();
        frame.render_widget(Paragraph::new(rate_lines(&rates)), bottom[0]);
        let span = self.history_times.get(&key).map_or_else(
            || "no durable span".into(),
            |(first, last)| {
                format!(
                    "{} span",
                    duration_label(u64::try_from(last.saturating_sub(*first)).unwrap_or(0))
                )
            },
        );
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled("Durable history", Style::default().fg(MUTED))),
                Line::from(Span::styled(
                    format!("{} samples", rates.sample_count),
                    Style::default().fg(FG),
                )),
                Line::from(Span::styled(span, Style::default().fg(FG))),
                Line::from(Span::styled(
                    rates.latest_sample_at.map_or_else(
                        || "waiting".into(),
                        |at| format!("latest {}", age_label(at)),
                    ),
                    Style::default().fg(MUTED),
                )),
            ]),
            bottom[1],
        );
        frame.render_widget(
            Sparkline::default()
                .data(points)
                .style(Style::default().fg(CYAN)),
            bottom[2],
        );
    }

    fn render_footer(&self, frame: &mut Frame<'_>, area: Rect) {
        let countdown = self.countdown_label();
        let line = Line::from(vec![
            Span::styled(
                "  ←/→ 1–9",
                Style::default().fg(CYAN).add_modifier(Modifier::BOLD),
            ),
            Span::styled(" select   ", Style::default().fg(MUTED)),
            Span::styled("r", Style::default().fg(CYAN).add_modifier(Modifier::BOLD)),
            Span::styled(" refresh   ", Style::default().fg(MUTED)),
            Span::styled("?", Style::default().fg(CYAN).add_modifier(Modifier::BOLD)),
            Span::styled(" help   ", Style::default().fg(MUTED)),
            Span::styled("q", Style::default().fg(CYAN).add_modifier(Modifier::BOLD)),
            Span::styled(" quit", Style::default().fg(MUTED)),
            Span::styled(
                format!("     {} · {countdown}", self.status),
                Style::default().fg(if self.busy { YELLOW } else { GREEN }),
            ),
        ]);
        frame.render_widget(
            Paragraph::new(line).style(Style::default().bg(Color::Rgb(0x0d, 0x0e, 0x13))),
            area,
        );
    }

    fn render_help(frame: &mut Frame<'_>, area: Rect) {
        let popup = centered_rect(76, 18, area);
        frame.render_widget(Clear, popup);
        let help = Text::from(vec![
            Line::from(Span::styled(
                "Cost TUI",
                Style::default().fg(PURPLE).add_modifier(Modifier::BOLD),
            )),
            Line::default(),
            Line::raw("Normal mode reads daemon/cache snapshots; the daemon alone polls"),
            Line::raw("/copilot_internal/user and records owner-only JSONL history."),
            Line::default(),
            help_line("←/→ · h/l · j/k", "Select account"),
            help_line("1–9", "Select account directly"),
            help_line("r", "Request a daemon refresh (or standalone refresh)"),
            help_line("? / Esc", "Close this help"),
            help_line("q / Ctrl-C", "Quit"),
            Line::default(),
            Line::from(Span::styled("Security", Style::default().fg(GREEN).add_modifier(Modifier::BOLD))),
            Line::raw("Tokens come from `gh auth token`, exist only in child-process env, and"),
            Line::raw("are never written to argv, logs, cache, snapshots, or UI state."),
            Line::default(),
            Line::from(Span::styled(
                "Quota values are the exact API units (no 1K scaling). Dollar figures use $0.01/credit.",
                Style::default().fg(YELLOW),
            )),
        ]);
        frame.render_widget(
            Paragraph::new(help)
                .block(
                    Block::default()
                        .borders(Borders::ALL)
                        .border_style(Style::default().fg(PURPLE))
                        .title(" Help "),
                )
                .wrap(Wrap { trim: false })
                .style(Style::default().fg(FG).bg(Color::Rgb(0x10, 0x11, 0x17))),
            popup,
        );
    }
}

#[derive(Clone, Copy)]
enum Tone {
    Header,
    Card,
    Detail,
}

fn chrome(tone: Tone, focused: bool) -> Chrome {
    let (top, bottom, rail) = match tone {
        Tone::Header => ("#201744ff", "#10121bff", "#9d84ffff"),
        Tone::Card => ("#171b27ff", "#101219ff", "#4dd9e8ff"),
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
                Paragraph::new(Line::from(Span::styled(
                    title.to_string(),
                    Style::default()
                        .fg(if focused { YELLOW } else { PURPLE })
                        .add_modifier(Modifier::BOLD),
                ))),
                Rect::new(inner.x, inner.y, inner.width, 1),
            );
            inner.y = inner.y.saturating_add(1);
            inner.height = inner.height.saturating_sub(1);
        }
        inner
    } else {
        let block = Block::default()
            .borders(Borders::ALL)
            .title(title.to_string())
            .border_style(
                Style::default()
                    .fg(if focused { YELLOW } else { PURPLE })
                    .add_modifier(if focused {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            );
        let inner = block.inner(area);
        frame.render_widget(block, area);
        inner
    }
}

fn render_chrome_underlay(area: Rect, chrome: &Chrome, runtime: &Runtime) -> RenderEffects {
    let local_area = Rect::new(0, 0, area.width, area.height);
    let Some(mut scene) = chrome.to_scene(local_area) else {
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
                // PlacementOptions carries Kitty's C=1 contract directly;
                // avoid transport-fragile escape-string rewriting here.
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

pub fn run_demo(state: CostState, refresh_secs: u64, no_graphics: bool) -> Result<()> {
    run_app(App::from_static_state(state, refresh_secs), no_graphics)
}

pub fn run_standalone(
    usages: Vec<AccountUsage>,
    refresh_secs: u64,
    no_graphics: bool,
) -> Result<()> {
    run_app(App::new(usages, refresh_secs, true), no_graphics)
}

pub fn run_client(
    state: CostState,
    subscription: ClientSubscription,
    refresh_secs: u64,
    no_graphics: bool,
) -> Result<()> {
    run_app(
        App::from_state(state, refresh_secs, subscription),
        no_graphics,
    )
}

fn run_app(mut app: App, no_graphics: bool) -> Result<()> {
    let mut stdout = io::stdout();
    enable_raw_mode().context("enable terminal raw mode")?;
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture).context("enter Cost TUI screen")?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend).context("initialize Cost TUI terminal")?;
    terminal.clear().context("clear Cost TUI terminal")?;
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
    let mut last_tick = Instant::now();
    let mut last_countdown = app.countdown_label();
    let mut card_regions = Vec::new();
    while !app.should_quit {
        dirty |= app.drain_sources();
        if last_tick.elapsed() >= Duration::from_secs(1) {
            app.timer_tick();
            let countdown = app.countdown_label();
            if countdown != last_countdown {
                last_countdown = countdown;
                dirty = true;
            }
            last_tick = Instant::now();
        }
        if dirty {
            if let Some(graphics) = graphics.as_deref_mut() {
                graphics.tracker.begin_frame();
                let sink = EffectsSink::new();
                terminal.draw(|frame| {
                    card_regions = app.render(frame, Some((&graphics.runtime, &sink)));
                })?;
                let flush = finalize_graphics_frame(graphics, &sink);
                write_graphics_flush(terminal.backend_mut(), &flush)?;
            } else {
                terminal.draw(|frame| {
                    card_regions = app.render(frame, None);
                })?;
            }
            last_countdown = app.countdown_label();
            dirty = false;
        }

        if event::poll(Duration::from_millis(40))? {
            dirty |= match event::read()? {
                Event::Key(key) => {
                    app.handle_key(key);
                    true
                }
                Event::Mouse(mouse)
                    if matches!(mouse.kind, MouseEventKind::Down(MouseButton::Left)) =>
                {
                    app.handle_mouse(mouse.column, mouse.row, &card_regions)
                }
                Event::Resize(_, _) | Event::FocusGained | Event::FocusLost => true,
                Event::Mouse(_) | Event::Paste(_) => false,
            };
        }
    }
    Ok(())
}

#[must_use]
pub fn snapshot_state(state: CostState, width: u16, height: u16, refresh_secs: u64) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).expect("test backend");
    let app = App::from_static_state(state, refresh_secs);
    terminal
        .draw(|frame| {
            let _ = app.render(frame, None);
        })
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

fn card_grid(area: Rect, count: usize, wide: bool) -> Vec<Rect> {
    if count == 0 {
        return Vec::new();
    }
    let columns = if wide { 2 } else { 1 };
    let rows = count.div_ceil(columns);
    let row_constraints = vec![Constraint::Ratio(1, u32::try_from(rows).unwrap_or(1)); rows];
    let row_areas = Layout::vertical(row_constraints).spacing(1).split(area);
    let mut output = Vec::new();
    for (row_index, row_area) in row_areas.iter().enumerate() {
        let remaining = count.saturating_sub(row_index * columns);
        let this_row = remaining.min(columns);
        let constraints =
            vec![Constraint::Ratio(1, u32::try_from(this_row).unwrap_or(1)); this_row];
        output.extend(
            Layout::horizontal(constraints)
                .spacing(1)
                .split(*row_area)
                .iter()
                .copied(),
        );
    }
    output
}

fn ordered_quotas(usage: &AccountUsage) -> Vec<(&str, &Quota)> {
    let mut rows = Vec::new();
    for key in ["premium_interactions", "ai_credits", "chat", "completions"] {
        if let Some(quota) = usage.quotas.get(key) {
            rows.push((key, quota));
        }
    }
    for (key, quota) in &usage.quotas {
        if !rows.iter().any(|(existing, _)| *existing == key) {
            rows.push((key.as_str(), quota));
        }
    }
    rows
}

#[must_use]
pub fn demo_state() -> CostState {
    let usages = demo_usages();
    let now = CostState::now();
    let mut history = Vec::new();
    for usage in &usages {
        let Some(quota) = usage.premium() else {
            continue;
        };
        for index in 0..24_i64 {
            let distance = 23_i64.saturating_sub(index);
            history.push(HistorySample {
                schema_version: 1,
                captured_at: now.saturating_sub(distance.saturating_mul(300)),
                account: usage.account.clone(),
                credits_used: (quota.credits_used - distance as f64 * 3_200.0).max(0.0),
                entitlement: quota.entitlement,
                remaining: quota.remaining_value() + distance as f64 * 3_200.0,
                overage_count: quota.overage_count,
                overage_entitlement: quota.overage_entitlement,
                reset_marker: "2026-09-01T00:00:00Z".into(),
            });
        }
    }
    let (series, rates) = summarize(&history, 576, now);
    CostState {
        usages,
        series,
        rates,
        collector: crate::model::CollectorHealth {
            running: false,
            last_success_at: Some(now),
            successful_accounts: 4,
            total_accounts: 4,
            ..crate::model::CollectorHealth::default()
        },
        ..CostState::default()
    }
}

fn demo_usages() -> Vec<AccountUsage> {
    let samples = [
        (738_344.0, 49_261_037.2, 98.5),
        (2_061_618.0, 47_938_429.8, 95.8),
        (0.0, 50_000_000.0, 100.0),
        (1_848.0, 49_998_151.3, 99.9),
    ];
    default_accounts()
        .into_iter()
        .zip(samples)
        .map(|(account, (used, remaining, percent))| {
            let mut quotas = BTreeMap::new();
            quotas.insert(
                "premium_interactions".into(),
                Quota {
                    id: "premium_interactions".into(),
                    credits_used: used,
                    entitlement: 50_000_000.0,
                    remaining,
                    available: remaining,
                    percent_remaining: percent,
                    overage_permitted: true,
                    token_based_billing: true,
                    timestamp_utc: "2026-08-04T17:24:09.840Z".into(),
                    ..Quota::default()
                },
            );
            for id in ["chat", "completions"] {
                quotas.insert(
                    id.into(),
                    Quota {
                        id: id.into(),
                        unlimited: true,
                        percent_remaining: 100.0,
                        timestamp_utc: "2026-08-04T17:24:09.840Z".into(),
                        ..Quota::default()
                    },
                );
            }
            AccountUsage {
                login: account.login.clone(),
                account,
                plan: "enterprise".into(),
                sku: "copilot_enterprise_seat_quota".into(),
                assigned_date: "2025-12-04T21:24:06+00:00".into(),
                quotas,
                refreshed_at: CostState::now(),
                error: None,
            }
        })
        .collect()
}

fn credit_sample(value: f64) -> u64 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    format!("{value:.0}").parse().unwrap_or(u64::MAX)
}

fn format_number(value: f64) -> String {
    let value = value.max(0.0);
    if value >= 1_000_000_000.0 {
        format!("{:.2}B", value / 1_000_000_000.0)
    } else if value >= 1_000_000.0 {
        format!("{:.2}M", value / 1_000_000.0)
    } else if value >= 1_000.0 {
        format!("{:.1}K", value / 1_000.0)
    } else if value.fract().abs() > 0.05 {
        format!("{value:.1}")
    } else {
        format!("{value:.0}")
    }
}

fn rate_lines(rates: &RateSummary) -> Vec<Line<'static>> {
    let current = rates.current_dollars_per_minute.map_or_else(
        || "Now waiting".into(),
        |value| format!("Now {}/min", format_currency(value)),
    );
    vec![
        Line::from(vec![
            Span::styled("Spend rates", Style::default().fg(MUTED)),
            Span::styled(
                format!("  {current}"),
                Style::default().fg(YELLOW).add_modifier(Modifier::BOLD),
            ),
        ]),
        Line::from(vec![
            rate_span("1h", &rates.hour),
            Span::raw("   "),
            rate_span("24h", &rates.day),
            Span::raw("   "),
            rate_span("7d", &rates.week),
        ]),
        Line::from(vec![
            rate_span("28d", &rates.twenty_eight_days),
            Span::raw("   "),
            rate_span("MTD", &rates.calendar_month),
        ]),
        Line::from(Span::styled(
            rates.current_interval_secs.map_or_else(
                || "need two same-cycle samples".into(),
                |seconds| {
                    format!(
                        "fresh rate over {}",
                        duration_label(u64::try_from(seconds.max(0)).unwrap_or(0))
                    )
                },
            ),
            Style::default().fg(MUTED),
        )),
    ]
}

fn rate_span(label: &'static str, window: &WindowSpend) -> Span<'static> {
    let marker = if window.complete { "" } else { "~" };
    Span::styled(
        format!("{label} {marker}{}", format_currency(window.dollars)),
        Style::default().fg(if window.complete { CYAN } else { MUTED }),
    )
}

fn format_currency(value: f64) -> String {
    if value >= 1_000_000.0 {
        format!("${:.2}M", value / 1_000_000.0)
    } else if value >= 1_000.0 {
        format!("${:.1}K", value / 1_000.0)
    } else {
        format!("${value:.2}")
    }
}

fn usage_color(ratio: f64) -> Color {
    if ratio >= 0.9 {
        RED
    } else if ratio >= 0.65 {
        YELLOW
    } else {
        GREEN
    }
}

fn fallback<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    if value.is_empty() {
        fallback
    } else {
        value
    }
}

fn short_sku(value: &str) -> String {
    value
        .strip_prefix("copilot_")
        .unwrap_or(value)
        .replace('_', " ")
}

fn quota_label(value: &str) -> String {
    match value {
        "premium_interactions" | "ai_credits" => "AI credits".into(),
        "chat" => "Chat".into(),
        "completions" => "Completions".into(),
        other => other.replace('_', " "),
    }
}

fn short_timestamp(value: &str) -> String {
    value.split_once('T').map_or_else(
        || value.chars().take(19).collect(),
        |(date, time)| format!("{} {}", date, time.chars().take(8).collect::<String>()),
    )
}

fn age_label(timestamp: i64) -> String {
    if timestamp <= 0 {
        return "not yet refreshed".into();
    }
    let age = u64::try_from(CostState::now().saturating_sub(timestamp).max(0)).unwrap_or(0);
    format!("{} ago", duration_label(age))
}

fn countdown_duration(seconds: u64) -> String {
    if seconds < 60 {
        format!("{}s", seconds.div_ceil(5) * 5)
    } else if seconds < 3_600 {
        format!("{}m", seconds.div_ceil(60))
    } else {
        format!("{}h {}m", seconds / 3_600, (seconds % 3_600).div_ceil(60))
    }
}

fn duration_label(seconds: u64) -> String {
    if seconds < 60 {
        format!("{seconds}s")
    } else if seconds < 3_600 {
        format!("{}m {:02}s", seconds / 60, seconds % 60)
    } else {
        format!("{}h {:02}m", seconds / 3_600, (seconds % 3_600) / 60)
    }
}

fn help_line(key: &'static str, description: &'static str) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            format!("{key:<18}"),
            Style::default().fg(CYAN).add_modifier(Modifier::BOLD),
        ),
        Span::raw(description),
    ])
}

fn contains(rect: Rect, column: u16, row: u16) -> bool {
    column >= rect.x && column < rect.right() && row >= rect.y && row < rect.bottom()
}

fn centered_rect(width: u16, height: u16, area: Rect) -> Rect {
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width.min(area.width),
        height.min(area.height),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_contains_all_accounts_exact_units_and_rates() {
        let output = snapshot_state(demo_state(), 120, 38, 300);
        assert!(output.contains("COPILOT COSTS"));
        assert!(output.contains("harryaskham_microsoft@github.com"));
        assert!(output.contains("msft.ghe.com"));
        assert!(output.contains("2.06M"));
        assert!(output.contains("AI credits"));
        assert!(output.contains("Spend rates"));
    }

    #[test]
    fn formats_costs_and_counts() {
        assert_eq!(format_number(50_000_000.0), "50.00M");
        assert_eq!(format_number(738_344.0), "738.3K");
        assert_eq!(format_currency(20_616.18), "$20.6K");
    }

    #[test]
    fn countdown_changes_only_at_visible_bucket_boundaries() {
        assert_eq!(countdown_duration(299), "5m");
        assert_eq!(countdown_duration(241), "5m");
        assert_eq!(countdown_duration(240), "4m");
        assert_eq!(countdown_duration(58), "60s");
        assert_eq!(countdown_duration(54), "55s");
    }

    #[test]
    fn graphics_chrome_uses_stable_non_advancing_underlay() {
        let options = PlacementOptions::absolute_with_id(42)
            .with_z_index(-1)
            .without_cursor_advance();
        assert_eq!(options.placement_id, Some(42));
        assert!(!options.unicode_placeholder);
        assert_eq!(options.z_index, -1);
        assert!(!options.cursor_advance);
    }

    #[test]
    fn card_grid_covers_each_account() {
        let cards = card_grid(Rect::new(0, 0, 120, 15), 4, true);
        assert_eq!(cards.len(), 4);
        assert!(cards.iter().all(|card| card.width > 0 && card.height > 0));
    }
}
