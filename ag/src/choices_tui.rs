//! `ag choices`: a fleet inbox for agent elicitations.
//!
//! Direction: dense, quiet, keyboard-first. A node → agent → question rail on
//! the left, the selected question as a working pane on the right, one status
//! rail. Terminal palette only. The pure state machine (`App`) is separate from
//! the I/O loop so key handling and rendering are testable with TestBackend.
use crate::{
    config::{Config, Host},
    paratenic::{self, AnswerInput, AnswerReceipt, AnswerState, Choice, Endpoint, FleetChoices},
};
use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    Node {
        host: String,
        waiting: usize,
        error: Option<String>,
    },
    Agent {
        title: String,
        provider: String,
    },
    Choice {
        node: usize,
        agent: usize,
        choice: usize,
    },
}

#[derive(Clone, Debug, Default)]
pub struct Draft {
    pub question: usize,
    pub cursor: BTreeMap<usize, usize>,
    pub picked: BTreeMap<usize, BTreeSet<usize>>,
    pub answered: BTreeMap<String, serde_json::Value>,
    pub freeform: BTreeMap<usize, String>,
    /// Optional questions explicitly left blank.
    pub skipped: BTreeSet<String>,
}
impl Draft {
    fn visited(&self, id: &str) -> bool {
        self.answered.contains_key(id)
            || self.answered.contains_key(&format!("{id}#freeform"))
            || self.skipped.contains(id)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Mode {
    Normal,
    /// Editing freeform/text for the given question index.
    Text(usize, String),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Focus {
    Rail,
    Detail,
}

#[derive(Debug, PartialEq)]
pub enum Action {
    Refresh,
    Submit(AnswerInput),
    Quit,
}

pub struct App {
    pub fleet: Option<FleetChoices>,
    pub rows: Vec<Row>,
    pub selected: usize,
    pub scroll: usize,
    pub focus: Focus,
    pub mode: Mode,
    pub drafts: HashMap<String, Draft>,
    pub status: Option<(String, Color)>,
    pub refreshing: bool,
    pub sending: Option<String>,
    pub last_refresh: Option<Instant>,
    pub armed: Option<(String, char)>,
    pub receipts: HashMap<String, AnswerReceipt>,
    rail_hits: Vec<(u16, usize)>,
    option_hits: Vec<(u16, usize)>,
    rail_area: Rect,
    detail_area: Rect,
}

impl Default for App {
    fn default() -> Self {
        Self {
            fleet: None,
            rows: vec![],
            selected: 0,
            scroll: 0,
            focus: Focus::Rail,
            mode: Mode::Normal,
            drafts: HashMap::new(),
            status: None,
            refreshing: true,
            sending: None,
            last_refresh: None,
            armed: None,
            receipts: HashMap::new(),
            rail_hits: vec![],
            option_hits: vec![],
            rail_area: Rect::default(),
            detail_area: Rect::default(),
        }
    }
}

fn key_of(choice: &Choice) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}",
        choice.host, choice.session, choice.request_id
    )
}

impl App {
    pub fn choice(&self, index: usize) -> Option<&Choice> {
        let fleet = self.fleet.as_ref()?;
        match self.rows.get(index)? {
            Row::Choice {
                node,
                agent,
                choice,
            } => fleet
                .nodes
                .get(*node)?
                .agents
                .get(*agent)?
                .choices
                .get(*choice),
            _ => None,
        }
    }
    pub fn current(&self) -> Option<&Choice> {
        self.choice(self.selected)
    }
    fn agent_of(&self, index: usize) -> Option<&paratenic::AgentChoices> {
        let Row::Choice { node, agent, .. } = self.rows.get(index)? else {
            return None;
        };
        self.fleet.as_ref()?.nodes.get(*node)?.agents.get(*agent)
    }
    fn selectable(&self) -> Vec<usize> {
        self.rows
            .iter()
            .enumerate()
            .filter(|(_, r)| matches!(r, Row::Choice { .. }))
            .map(|(i, _)| i)
            .collect()
    }
    pub fn waiting(&self) -> usize {
        self.fleet.as_ref().map_or(0, |f| f.actionable)
    }

    pub fn set_fleet(&mut self, fleet: FleetChoices) {
        let keep = self.current().map(key_of);
        let mut rows = vec![];
        for (n, node) in fleet.nodes.iter().enumerate() {
            let waiting = node
                .agents
                .iter()
                .flat_map(|a| &a.choices)
                .filter(|c| c.actionable)
                .count();
            // Offline nodes are summarized in the top rail, not listed.
            if node.agents.is_empty() && node.state != "error" {
                continue;
            }
            rows.push(Row::Node {
                host: node.host.clone(),
                waiting,
                error: node.error.clone(),
            });
            for (a, agent) in node.agents.iter().enumerate() {
                rows.push(Row::Agent {
                    title: agent.title.clone(),
                    provider: agent.provider.clone(),
                });
                for c in 0..agent.choices.len() {
                    rows.push(Row::Choice {
                        node: n,
                        agent: a,
                        choice: c,
                    });
                }
            }
        }
        let live: BTreeSet<String> = fleet
            .nodes
            .iter()
            .flat_map(|n| &n.agents)
            .flat_map(|a| &a.choices)
            .map(key_of)
            .collect();
        self.drafts.retain(|k, _| live.contains(k));
        self.fleet = Some(fleet);
        self.rows = rows;
        let selectable = self.selectable();
        self.selected = keep
            .and_then(|k| {
                selectable
                    .iter()
                    .copied()
                    .find(|i| self.choice(*i).map(key_of).as_deref() == Some(k.as_str()))
            })
            .or_else(|| selectable.iter().copied().find(|i| *i >= self.selected))
            .or_else(|| selectable.last().copied())
            .unwrap_or(0);
        if let Mode::Text(..) = self.mode {
            if self.current().is_none() {
                self.mode = Mode::Normal;
            }
        }
        self.refreshing = false;
        self.last_refresh = Some(Instant::now());
    }

    fn draft(&mut self) -> Option<&mut Draft> {
        let key = key_of(self.current()?);
        Some(self.drafts.entry(key).or_default())
    }
    fn question_index(&self) -> usize {
        self.current()
            .and_then(|c| self.drafts.get(&key_of(c)))
            .map_or(0, |d| d.question)
    }
    /// Options shown for a question; booleans render as Yes/No rows.
    pub fn option_labels(question: &paratenic::Question) -> Vec<(String, Option<String>, bool)> {
        match question.kind.as_str() {
            "boolean" => vec![("Yes".into(), None, false), ("No".into(), None, false)],
            _ => question
                .options
                .iter()
                .map(|o| (o.label.clone(), o.description.clone(), o.recommended))
                .collect(),
        }
    }
    fn cursor(&self) -> usize {
        let Some(choice) = self.current() else {
            return 0;
        };
        let q = self.question_index();
        self.drafts
            .get(&key_of(choice))
            .and_then(|d| d.cursor.get(&q).copied())
            .unwrap_or_else(|| {
                choice
                    .questions
                    .get(q)
                    .and_then(|q| q.options.iter().position(|o| o.recommended))
                    .unwrap_or(0)
            })
    }

    fn move_selection(&mut self, delta: isize) {
        let selectable = self.selectable();
        if selectable.is_empty() {
            return;
        }
        let at = selectable
            .iter()
            .position(|i| *i == self.selected)
            .unwrap_or(0) as isize;
        let next = (at + delta).clamp(0, selectable.len() as isize - 1) as usize;
        self.selected = selectable[next];
        self.armed = None;
    }
    fn move_cursor(&mut self, delta: isize) {
        let Some(choice) = self.current() else { return };
        let q = self.question_index();
        let Some(question) = choice.questions.get(q) else {
            return;
        };
        let count = Self::option_labels(question).len();
        if count == 0 {
            return;
        }
        let next = (self.cursor() as isize + delta).clamp(0, count as isize - 1) as usize;
        if let Some(draft) = self.draft() {
            draft.cursor.insert(q, next);
        }
    }

    fn submit(
        &mut self,
        response: &str,
        answers: BTreeMap<String, serde_json::Value>,
    ) -> Option<Action> {
        let choice = self.current()?.clone();
        if self.sending.is_some() {
            self.status = Some(("an answer is already in flight".into(), Color::Yellow));
            return None;
        }
        self.sending = Some(key_of(&choice));
        self.status = Some((format!("sending to {}…", choice.host), Color::Cyan));
        Some(Action::Submit(AnswerInput {
            host: choice.host.clone(),
            session: choice.session.clone(),
            request_id: choice.request_id.clone(),
            response: Some(response.into()),
            answers,
            option: None,
            text: None,
            revision: Some(choice.revision.clone()),
            confirmed: true,
        }))
    }

    /// Record the current question's answer (None = skip an optional one);
    /// advance to the next unvisited question, submitting after the last.
    fn commit_question(&mut self, value: Option<serde_json::Value>) -> Option<Action> {
        let choice = self.current()?.clone();
        let q = self.question_index();
        let id = choice.questions.get(q)?.id.clone();
        let draft = self.draft()?;
        match value {
            Some(value) => {
                draft.answered.insert(id.clone(), value);
                draft.skipped.remove(&id);
            }
            None => {
                draft.skipped.insert(id);
            }
        }
        self.advance(&choice)
    }
    fn advance(&mut self, choice: &Choice) -> Option<Action> {
        let draft = self.draft()?.clone();
        let next = choice
            .questions
            .iter()
            .enumerate()
            .find(|(_, q)| !draft.visited(&q.id))
            .map(|(i, _)| i);
        match next {
            Some(i) => {
                if let Some(draft) = self.draft() {
                    draft.question = i;
                }
                self.status = Some((
                    format!("question {} of {}", i + 1, choice.questions.len()),
                    Color::Cyan,
                ));
                None
            }
            None => self.submit("accept", draft.answered),
        }
    }

    fn choose(&mut self, index: usize) -> Option<Action> {
        let choice = self.current()?.clone();
        if !choice.actionable {
            self.status = Some((
                choice.stale_reason.clone().unwrap_or_default(),
                Color::Yellow,
            ));
            return None;
        }
        if choice.questions.is_empty() {
            return self.confirm('a', "accept", BTreeMap::new());
        }
        let q = self.question_index();
        let question = choice.questions.get(q)?.clone();
        let labels = Self::option_labels(&question);
        if index >= labels.len() {
            return None;
        }
        if let Some(draft) = self.draft() {
            draft.cursor.insert(q, index);
        }
        match question.kind.as_str() {
            "single-select" => {
                self.commit_question(Some(question.options[index].id.clone().into()))
            }
            "boolean" => self.commit_question(Some((index == 0).into())),
            "multi-select" => {
                let draft = self.draft()?;
                let set = draft.picked.entry(q).or_default();
                if !set.remove(&index) {
                    set.insert(index);
                }
                None
            }
            _ => None,
        }
    }

    fn confirm(
        &mut self,
        key: char,
        response: &str,
        answers: BTreeMap<String, serde_json::Value>,
    ) -> Option<Action> {
        let id = key_of(self.current()?);
        if self.armed.as_ref() == Some(&(id.clone(), key)) {
            self.armed = None;
            return self.submit(response, answers);
        }
        self.armed = Some((id, key));
        let what = match key {
            'd' => "decline",
            'a' => "accept",
            _ => "confirm",
        };
        self.status = Some((format!("press {key} again to {what}"), Color::Yellow));
        None
    }

    pub fn key(&mut self, key: KeyEvent) -> Option<Action> {
        if key.kind != KeyEventKind::Press {
            return None;
        }
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return Some(Action::Quit);
        }
        if let Mode::Text(q, mut text) = self.mode.clone() {
            match key.code {
                KeyCode::Esc => self.mode = Mode::Normal,
                KeyCode::Enter => {
                    self.mode = Mode::Normal;
                    let choice = self.current()?.clone();
                    let question = choice.questions.get(q)?.clone();
                    let text = text.trim().to_owned();
                    if text.is_empty() {
                        if question.required || question.kind.ends_with("select") {
                            self.status = Some(("reply is empty".into(), Color::Yellow));
                            return None;
                        }
                        return self.commit_question(None);
                    }
                    if question.kind.ends_with("select") {
                        let draft = self.draft()?;
                        draft
                            .answered
                            .insert(format!("{}#freeform", question.id), text.clone().into());
                        draft.freeform.insert(q, text);
                        return self.advance(&choice);
                    }
                    return self.commit_question(Some(text.into()));
                }
                KeyCode::Backspace => {
                    text.pop();
                    self.mode = Mode::Text(q, text);
                }
                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    if text.len() < 16 * 1024 {
                        text.push(c);
                    }
                    self.mode = Mode::Text(q, text);
                }
                _ => {}
            }
            return None;
        }
        let armed = self.armed.clone();
        let action = match key.code {
            KeyCode::Char('q') | KeyCode::Esc => Some(Action::Quit),
            KeyCode::Char('r') => {
                self.refreshing = true;
                Some(Action::Refresh)
            }
            KeyCode::Char('j') | KeyCode::Down if self.focus == Focus::Rail => {
                self.move_selection(1);
                None
            }
            KeyCode::Char('k') | KeyCode::Up if self.focus == Focus::Rail => {
                self.move_selection(-1);
                None
            }
            KeyCode::Char('j') | KeyCode::Down => {
                self.move_cursor(1);
                None
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.move_cursor(-1);
                None
            }
            KeyCode::Char('J') | KeyCode::PageDown => {
                self.move_selection(1);
                None
            }
            KeyCode::Char('K') | KeyCode::PageUp => {
                self.move_selection(-1);
                None
            }
            KeyCode::Tab | KeyCode::Char('l') | KeyCode::Right => {
                self.focus = Focus::Detail;
                None
            }
            KeyCode::BackTab | KeyCode::Char('h') | KeyCode::Left => {
                self.focus = Focus::Rail;
                None
            }
            KeyCode::Char(c @ '1'..='9') => self.choose(c as usize - '1' as usize),
            KeyCode::Char(' ') => {
                let cursor = self.cursor();
                if self
                    .current()
                    .and_then(|c| c.questions.get(self.question_index()))
                    .is_some_and(|q| q.kind == "multi-select")
                {
                    self.choose(cursor)
                } else {
                    None
                }
            }
            KeyCode::Enter => {
                let choice = self.current().cloned()?;
                if !choice.actionable {
                    self.status = Some((
                        choice.stale_reason.clone().unwrap_or_default(),
                        Color::Yellow,
                    ));
                    return None;
                }
                if self.focus == Focus::Rail && !choice.questions.is_empty() {
                    self.focus = Focus::Detail;
                    return None;
                }
                let q = self.question_index();
                match choice.questions.get(q).map(|q| q.kind.as_str()) {
                    None => self.confirm('a', "accept", BTreeMap::new()),
                    Some("multi-select") => {
                        let picked = self
                            .draft()
                            .map(|d| d.picked.get(&q).cloned().unwrap_or_default())
                            .unwrap_or_default();
                        let question = choice.questions[q].clone();
                        if picked.is_empty() && question.required {
                            self.status = Some(("pick at least one (space)".into(), Color::Yellow));
                            return None;
                        }
                        let ids: Vec<serde_json::Value> = picked
                            .iter()
                            .filter_map(|i| question.options.get(*i))
                            .map(|o| o.id.clone().into())
                            .collect();
                        self.commit_question(Some(ids.into()))
                    }
                    Some("single-select" | "boolean") => {
                        let cursor = self.cursor();
                        self.choose(cursor)
                    }
                    Some(_) => {
                        self.mode = Mode::Text(q, String::new());
                        None
                    }
                }
            }
            KeyCode::Char('i') => {
                let choice = self.current()?.clone();
                let q = self.question_index();
                let question = choice.questions.get(q)?;
                if !choice.actionable {
                    return None;
                }
                if question.kind.ends_with("select") && !question.allow_freeform {
                    self.status =
                        Some(("this question has no freeform reply".into(), Color::Yellow));
                } else {
                    self.focus = Focus::Detail;
                    self.mode = Mode::Text(q, String::new());
                }
                None
            }
            KeyCode::Char('n') => {
                let choice = self.current()?.clone();
                let next = (self.question_index() + 1) % choice.questions.len().max(1);
                if let Some(d) = self.draft() {
                    d.question = next;
                }
                None
            }
            KeyCode::Char('d') => {
                if self.current().is_some_and(|c| c.actionable) {
                    self.confirm('d', "decline", BTreeMap::new())
                } else {
                    None
                }
            }
            _ => None,
        };
        if self.armed == armed && !matches!(key.code, KeyCode::Char('d' | 'a') | KeyCode::Enter) {
            self.armed = None;
        }
        action
    }

    pub fn mouse(&mut self, mouse: MouseEvent) -> Option<Action> {
        let inside = |r: Rect| {
            mouse.column >= r.x
                && mouse.column < r.x + r.width
                && mouse.row >= r.y
                && mouse.row < r.y + r.height
        };
        match mouse.kind {
            MouseEventKind::ScrollDown if inside(self.rail_area) => self.move_selection(1),
            MouseEventKind::ScrollUp if inside(self.rail_area) => self.move_selection(-1),
            MouseEventKind::ScrollDown if inside(self.detail_area) => self.move_cursor(1),
            MouseEventKind::ScrollUp if inside(self.detail_area) => self.move_cursor(-1),
            MouseEventKind::Down(MouseButton::Left) => {
                if let Some((_, row)) = self
                    .rail_hits
                    .iter()
                    .find(|(y, _)| *y == mouse.row && inside(self.rail_area))
                {
                    if matches!(self.rows.get(*row), Some(Row::Choice { .. })) {
                        self.selected = *row;
                        self.focus = Focus::Rail;
                        self.armed = None;
                    }
                } else if let Some((_, option)) = self
                    .option_hits
                    .iter()
                    .find(|(y, _)| *y == mouse.row && inside(self.detail_area))
                    .copied()
                {
                    self.focus = Focus::Detail;
                    // First click selects, second click on the same option answers.
                    if self.cursor() == option {
                        return self.choose(option);
                    }
                    let q = self.question_index();
                    if let Some(d) = self.draft() {
                        d.cursor.insert(q, option);
                    }
                }
            }
            _ => {}
        }
        None
    }

    pub fn receipt(&mut self, receipt: AnswerReceipt) {
        self.sending = None;
        let (text, color) = match receipt.state {
            AnswerState::Accepted => (format!("✓ answered on {}", receipt.host), Color::Green),
            AnswerState::Rejected => (
                format!("✕ rejected: {}", receipt.reason.clone().unwrap_or_default()),
                Color::Red,
            ),
            AnswerState::Indeterminate => (
                "? no confirmation — refreshing before any retry".into(),
                Color::Yellow,
            ),
            AnswerState::Gone => ("already answered elsewhere".into(), Color::Yellow),
            AnswerState::Changed => ("question changed — review it again".into(), Color::Yellow),
            AnswerState::Unavailable => (
                receipt
                    .reason
                    .clone()
                    .unwrap_or_else(|| "unavailable".into()),
                Color::Yellow,
            ),
        };
        self.status = Some((text, color));
        self.receipts.insert(
            format!(
                "{}\u{1f}{}\u{1f}{}",
                receipt.host, receipt.session, receipt.request_id
            ),
            receipt,
        );
    }
    pub fn failed(&mut self, error: String) {
        self.sending = None;
        self.status = Some((error, Color::Red));
    }

    // ---- rendering -------------------------------------------------------

    pub fn draw(&mut self, frame: &mut Frame) {
        let area = frame.area();
        let [top, body, bottom] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(3),
            Constraint::Length(1),
        ])
        .areas(area);
        self.draw_top(frame, top);
        let narrow = body.width < 72;
        let [rail, detail] = if narrow {
            if self.focus == Focus::Rail {
                [body, Rect::default()]
            } else {
                [Rect::default(), body]
            }
        } else {
            Layout::horizontal([Constraint::Percentage(36), Constraint::Percentage(64)]).areas(body)
        };
        self.rail_area = rail;
        self.detail_area = detail;
        if rail.width > 0 {
            self.draw_rail(frame, rail);
        }
        if detail.width > 0 {
            self.draw_detail(frame, detail);
        }
        self.draw_bottom(frame, bottom);
    }

    fn draw_top(&self, frame: &mut Frame, area: Rect) {
        let mut spans = vec![Span::styled(
            " ag choices ",
            Style::new().add_modifier(Modifier::BOLD | Modifier::REVERSED),
        )];
        if let Some(fleet) = &self.fleet {
            let errors = fleet.nodes.iter().filter(|n| n.state == "error").count();
            let offline = fleet.nodes.iter().filter(|n| n.state == "offline").count();
            let reached = fleet.nodes.iter().filter(|n| n.state == "ok").count();
            spans.push(Span::styled(
                format!("  ◆ {} waiting", fleet.actionable),
                Style::new()
                    .fg(if fleet.actionable > 0 {
                        Color::Yellow
                    } else {
                        Color::Green
                    })
                    .add_modifier(Modifier::BOLD),
            ));
            spans.push(Span::styled(
                format!("  · {reached} nodes"),
                Style::new().add_modifier(Modifier::DIM),
            ));
            if offline > 0 {
                spans.push(Span::styled(
                    format!("  · {offline} offline"),
                    Style::new().add_modifier(Modifier::DIM),
                ));
            }
            if errors > 0 {
                spans.push(Span::styled(
                    format!("  · {errors} failing"),
                    Style::new().fg(Color::Red),
                ));
            }
        }
        let when = if self.refreshing {
            "  · refreshing…".to_owned()
        } else {
            self.last_refresh
                .map(|t| format!("  · {}s ago", t.elapsed().as_secs()))
                .unwrap_or_default()
        };
        spans.push(Span::styled(when, Style::new().add_modifier(Modifier::DIM)));
        frame.render_widget(Line::from(spans), area);
    }

    fn draw_rail(&mut self, frame: &mut Frame, area: Rect) {
        let block = Block::new()
            .borders(Borders::RIGHT)
            .border_style(Style::new().add_modifier(Modifier::DIM));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        self.rail_hits.clear();
        if self.rows.is_empty() {
            let text = if self.fleet.is_none() {
                "Querying the fleet…"
            } else {
                "No agent is waiting for you."
            };
            frame.render_widget(
                Paragraph::new(text).style(Style::new().add_modifier(Modifier::DIM)),
                inner,
            );
            return;
        }
        let height = inner.height as usize;
        if self.selected < self.scroll {
            self.scroll = self.selected.saturating_sub(2);
        }
        if self.selected >= self.scroll + height {
            self.scroll = self.selected + 1 - height;
        }
        let width = inner.width as usize;
        for (offset, index) in (self.scroll..self.rows.len()).take(height).enumerate() {
            let y = inner.y + offset as u16;
            let selected = index == self.selected;
            let line = match &self.rows[index] {
                Row::Node {
                    host,
                    waiting,
                    error,
                } => {
                    let mut spans = vec![Span::styled(
                        host.clone(),
                        Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                    )];
                    match error {
                        Some(e) => spans.push(Span::styled(
                            format!("  ✕ {}", fit(e, width.saturating_sub(host.len() + 4))),
                            Style::new().fg(Color::Red),
                        )),
                        None => spans.push(Span::styled(
                            format!("  {waiting}"),
                            Style::new().add_modifier(Modifier::DIM),
                        )),
                    }
                    Line::from(spans)
                }
                Row::Agent { title, provider } => Line::from(vec![
                    Span::raw(" "),
                    Span::styled(
                        fit(title, width.saturating_sub(provider.len() + 4)),
                        Style::new().add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!(" {provider}"),
                        Style::new().add_modifier(Modifier::DIM),
                    ),
                ]),
                Row::Choice { .. } => {
                    let choice = self.choice(index).expect("row");
                    let marker = if self.sending.as_deref() == Some(&key_of(choice)) {
                        "…"
                    } else if choice.actionable {
                        "◆"
                    } else {
                        "◇"
                    };
                    let mut style = if choice.actionable {
                        Style::new()
                    } else {
                        Style::new().add_modifier(Modifier::DIM)
                    };
                    if selected {
                        // Loud only while the rail owns focus.
                        style = if self.focus == Focus::Rail {
                            style.add_modifier(Modifier::REVERSED)
                        } else {
                            style.add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
                        };
                    }
                    Line::from(vec![
                        Span::styled(
                            format!("   {marker} "),
                            Style::new().fg(if choice.actionable {
                                Color::Yellow
                            } else {
                                Color::DarkGray
                            }),
                        ),
                        Span::styled(
                            fit(&one_line(&choice.title), width.saturating_sub(6)),
                            style,
                        ),
                    ])
                }
            };
            frame.render_widget(
                line,
                Rect {
                    x: inner.x,
                    y,
                    width: inner.width,
                    height: 1,
                },
            );
            self.rail_hits.push((y, index));
        }
    }

    fn draw_detail(&mut self, frame: &mut Frame, area: Rect) {
        self.option_hits.clear();
        let inner = Rect {
            x: area.x + 2,
            y: area.y,
            width: area.width.saturating_sub(3),
            height: area.height,
        };
        let width = inner.width as usize;
        let Some(choice) = self.current().cloned() else {
            return;
        };
        let agent = self.agent_of(self.selected).cloned();
        let mut lines: Vec<Line> = vec![];
        let mut option_rows: Vec<(usize, usize)> = vec![];
        if let Some(agent) = &agent {
            lines.push(Line::from(vec![
                Span::styled(
                    agent.title.clone(),
                    Style::new().add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("  {} · {}", choice.host, agent.provider),
                    Style::new().fg(Color::Cyan),
                ),
            ]));
            if let Some(cwd) = agent.cwd.as_ref().or(agent.project.as_ref()) {
                lines.push(Line::styled(
                    fit(cwd, width),
                    Style::new().add_modifier(Modifier::DIM),
                ));
            }
        }
        lines.push(Line::raw(""));
        for text in wrap(&choice.title, width) {
            lines.push(Line::styled(
                text,
                Style::new().add_modifier(Modifier::BOLD),
            ));
        }
        if let Some(url) = &choice.url {
            lines.push(Line::styled(
                fit(url, width),
                Style::new()
                    .fg(Color::Blue)
                    .add_modifier(Modifier::UNDERLINED),
            ));
        }
        if let Some(reason) = &choice.stale_reason {
            lines.push(Line::raw(""));
            lines.push(Line::styled(
                format!("◇ {reason}"),
                Style::new().fg(Color::Yellow),
            ));
        }
        let q = self.question_index();
        let draft = self
            .drafts
            .get(&key_of(&choice))
            .cloned()
            .unwrap_or_default();
        let total = choice.questions.len();
        for (qi, question) in choice.questions.iter().enumerate() {
            if total > 1 && qi != q {
                let done = draft.answered.contains_key(&question.id)
                    || draft
                        .answered
                        .contains_key(&format!("{}#freeform", question.id));
                lines.push(Line::styled(
                    format!(
                        "{} {}",
                        if done { "✓" } else { "·" },
                        fit(
                            &one_line(question.title.as_deref().unwrap_or(&question.message)),
                            width.saturating_sub(2)
                        )
                    ),
                    Style::new().add_modifier(Modifier::DIM),
                ));
                continue;
            }
            lines.push(Line::raw(""));
            let before = lines.len();
            if total > 1 {
                lines.push(Line::styled(
                    format!("Question {} of {total}", qi + 1),
                    Style::new().fg(Color::Cyan),
                ));
            }
            if let Some(title) = &question.title {
                for text in wrap(title, width) {
                    lines.push(Line::styled(
                        text,
                        Style::new().add_modifier(Modifier::BOLD),
                    ));
                }
            }
            if question.message != choice.title {
                for text in wrap(&question.message, width) {
                    lines.push(Line::raw(text));
                }
            }
            if lines.len() > before {
                lines.push(Line::raw(""));
            }
            let cursor = self.cursor();
            let picked = draft.picked.get(&qi).cloned().unwrap_or_default();
            for (oi, (label, description, recommended)) in
                Self::option_labels(question).into_iter().enumerate()
            {
                let focused = oi == cursor && self.focus == Focus::Detail;
                let mark = if question.kind == "multi-select" {
                    if picked.contains(&oi) { "[x]" } else { "[ ]" }
                } else if oi == cursor {
                    "▶"
                } else {
                    " "
                };
                let mut style = Style::new();
                if focused {
                    style = style.add_modifier(Modifier::REVERSED);
                }
                option_rows.push((lines.len(), oi));
                lines.push(Line::from(vec![
                    Span::styled(format!(" {} ", mark), Style::new().fg(Color::Yellow)),
                    Span::styled(
                        format!("{}", oi + 1),
                        Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(" "),
                    Span::styled(
                        fit(&label, width.saturating_sub(10)),
                        style.add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        if recommended { "  recommended" } else { "" },
                        Style::new().fg(Color::Green).add_modifier(Modifier::DIM),
                    ),
                ]));
                if let Some(description) = description {
                    for text in wrap(&description, width.saturating_sub(7)) {
                        option_rows.push((lines.len(), oi));
                        lines.push(Line::styled(
                            format!("       {text}"),
                            Style::new().add_modifier(Modifier::DIM),
                        ));
                    }
                }
            }
            if question.kind.ends_with("select") && question.allow_freeform {
                lines.push(Line::styled(
                    "     i  reply in your own words",
                    Style::new().add_modifier(Modifier::DIM),
                ));
            }
            if total > 1 {
                let hint = match question.kind.as_str() {
                    "multi-select" => "Space toggle · Enter next",
                    "single-select" | "boolean" => "1–9 or Enter to choose",
                    _ if question.required => "Enter to type the answer",
                    _ => "Enter to type · Enter on empty skips",
                };
                lines.push(Line::styled(
                    format!("     {hint}"),
                    Style::new().add_modifier(Modifier::DIM),
                ));
            }
            if let Some(text) = draft.freeform.get(&qi) {
                lines.push(Line::styled(
                    format!("     “{}”", fit(text, width.saturating_sub(8))),
                    Style::new().fg(Color::Green),
                ));
            }
        }
        if let Mode::Text(_, text) = &self.mode {
            lines.push(Line::raw(""));
            lines.push(Line::from(vec![
                Span::styled(
                    "reply › ",
                    Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                ),
                Span::raw(text.clone()),
                Span::styled("▏", Style::new().fg(Color::Cyan)),
            ]));
        }
        // Keep the focused option visible.
        let anchor = option_rows
            .iter()
            .find(|(_, oi)| *oi == self.cursor())
            .map_or(0, |(line, _)| *line);
        let height = inner.height as usize;
        let scroll = anchor
            .saturating_sub(height.saturating_sub(4))
            .min(lines.len().saturating_sub(height.min(lines.len())));
        let scroll = if matches!(self.mode, Mode::Text(..)) {
            lines.len().saturating_sub(height)
        } else {
            scroll
        };
        for (line, option) in option_rows {
            if line >= scroll && line < scroll + height {
                self.option_hits
                    .push((inner.y + (line - scroll) as u16, option));
            }
        }
        frame.render_widget(Paragraph::new(lines).scroll((scroll as u16, 0)), inner);
    }

    fn draw_bottom(&self, frame: &mut Frame, area: Rect) {
        let line = match (&self.status, &self.mode) {
            (_, Mode::Text(..)) => Line::styled(
                " Enter send · Esc cancel",
                Style::new().add_modifier(Modifier::DIM),
            ),
            (Some((text, color)), _) => Line::styled(format!(" {text}"), Style::new().fg(*color)),
            _ => Line::styled(
                " j/k · Tab pane · 1–9/Enter answer · i reply · d decline · r refresh · q quit",
                Style::new().add_modifier(Modifier::DIM),
            ),
        };
        frame.render_widget(line, area);
    }
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
pub fn fit(text: &str, width: usize) -> String {
    let text = crate::terminal_text(text);
    if Line::raw(text.as_str()).width() <= width {
        return text;
    }
    let mut out = String::new();
    for c in text.chars() {
        if Line::raw(format!("{out}{c}…")).width() > width {
            break;
        }
        out.push(c);
    }
    out.push('…');
    out
}
pub fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(8);
    let mut out = vec![];
    for paragraph in crate::terminal_text(text).replace("\\n", "\n").lines() {
        let mut line = String::new();
        for word in paragraph.split_whitespace() {
            let candidate = if line.is_empty() {
                word.to_owned()
            } else {
                format!("{line} {word}")
            };
            if Line::raw(candidate.as_str()).width() > width && !line.is_empty() {
                out.push(std::mem::take(&mut line));
                line = word.to_owned();
            } else {
                line = candidate;
            }
            while Line::raw(line.as_str()).width() > width {
                let split: String = line.chars().take(width).collect();
                line = line.chars().skip(width).collect();
                out.push(split);
            }
        }
        out.push(line);
    }
    while out.len() > 1 && out.last().is_some_and(String::is_empty) {
        out.pop();
    }
    out
}

// ---- I/O loop -----------------------------------------------------------

enum Message {
    Fleet(FleetChoices),
    Receipt(AnswerReceipt),
    Failed(String),
}

struct Restore;
impl Drop for Restore {
    fn drop(&mut self) {
        let _ = crossterm::terminal::disable_raw_mode();
        let _ = crossterm::execute!(
            std::io::stdout(),
            crossterm::event::DisableMouseCapture,
            crossterm::terminal::LeaveAlternateScreen,
            crossterm::cursor::Show
        );
    }
}

pub async fn run(
    config: Config,
    targets: Vec<(Host, Option<Endpoint>)>,
    interval: Duration,
) -> crate::Result<()> {
    use futures_util::StreamExt;
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        return Err(crate::Error::Invalid(
            "ag choices needs a terminal; use `ag choices list` or --json".into(),
        ));
    }
    let endpoints: HashMap<String, Endpoint> = targets
        .iter()
        .filter_map(|(h, e)| Some((h.name.clone(), e.clone()?)))
        .collect();
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        drop(Restore);
        hook(info);
    }));
    crossterm::terminal::enable_raw_mode()?;
    let _restore = Restore;
    crossterm::execute!(
        std::io::stdout(),
        crossterm::terminal::EnterAlternateScreen,
        crossterm::event::EnableMouseCapture
    )?;
    let mut terminal =
        ratatui::Terminal::new(ratatui::backend::CrosstermBackend::new(std::io::stdout()))?;
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let refresh = |tx: tokio::sync::mpsc::Sender<Message>| {
        let config = config.clone();
        let targets = targets.clone();
        tokio::spawn(async move {
            let fleet = paratenic::fleet_choices(&config, targets, false).await;
            let _ = tx.send(Message::Fleet(fleet)).await;
        });
    };
    let mut app = App::default();
    refresh(tx.clone());
    let mut events = crossterm::event::EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    let mut next_refresh = Instant::now() + interval;
    loop {
        terminal.draw(|frame| app.draw(frame))?;
        let action = tokio::select! {
            event = events.next() => match event {
                Some(Ok(Event::Key(key))) => app.key(key),
                Some(Ok(Event::Mouse(mouse))) => app.mouse(mouse),
                Some(Ok(_)) => None,
                Some(Err(error)) => return Err(error.into()),
                None => Some(Action::Quit),
            },
            message = rx.recv() => {
                match message {
                    Some(Message::Fleet(fleet)) => app.set_fleet(fleet),
                    Some(Message::Receipt(receipt)) => { app.receipt(receipt); app.refreshing = true; next_refresh = Instant::now() + interval; refresh(tx.clone()); }
                    Some(Message::Failed(error)) => app.failed(error),
                    None => {}
                }
                None
            }
            _ = tick.tick() => {
                if Instant::now() >= next_refresh && !app.refreshing && app.sending.is_none() {
                    app.refreshing = true;
                    next_refresh = Instant::now() + interval;
                    refresh(tx.clone());
                }
                None
            }
        };
        match action {
            Some(Action::Quit) => break,
            Some(Action::Refresh) => {
                next_refresh = Instant::now() + interval;
                refresh(tx.clone());
            }
            Some(Action::Submit(input)) => {
                let Some(endpoint) = endpoints.get(&input.host).cloned() else {
                    app.failed(format!("no Paratenic endpoint for {}", input.host));
                    continue;
                };
                let config = config.clone();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let message = match paratenic::answer(&config, &endpoint, input).await {
                        Ok(receipt) => Message::Receipt(receipt),
                        Err(error) => Message::Failed(error.to_string()),
                    };
                    let _ = tx.send(message).await;
                });
            }
            None => {}
        }
    }
    let _ = std::panic::take_hook();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paratenic::{AgentChoices, NodeChoices, Question, QuestionOption};
    use ratatui::{Terminal, backend::TestBackend};

    fn question(kind: &str, freeform: bool) -> Question {
        Question {
            id: "q".into(),
            kind: kind.into(),
            title: None,
            message: "Which way?".into(),
            required: true,
            allow_freeform: freeform,
            options: ["North", "South", "East"]
                .iter()
                .enumerate()
                .map(|(i, l)| QuestionOption {
                    id: format!("o{i}"),
                    label: (*l).into(),
                    description: (i == 1).then(|| "the long way".into()),
                    recommended: i == 1,
                })
                .collect(),
        }
    }
    fn choice(id: &str, kind: &str, actionable: bool) -> Choice {
        Choice {
            host: "alpha".into(),
            session: "ahp-session:/s".into(),
            chat: "ahp-session:/s/chat".into(),
            entry: id.into(),
            request_id: id.into(),
            kind: "chatInput".into(),
            revision: "rev".into(),
            title: format!("Question {id}"),
            message: None,
            url: None,
            questions: vec![question(kind, true)],
            actionable,
            stale_reason: (!actionable).then(|| "request chat is read-only or unavailable".into()),
        }
    }
    fn fleet(choices: Vec<Choice>) -> FleetChoices {
        FleetChoices {
            observed_at: "now".into(),
            actionable: choices.iter().filter(|c| c.actionable).count(),
            nodes: vec![
                NodeChoices {
                    host: "alpha".into(),
                    state: "ok".into(),
                    error: None,
                    endpoint: None,
                    sessions: 3,
                    input_needed_sessions: 1,
                    latency_ms: Some(5),
                    agents: vec![AgentChoices {
                        session: "ahp-session:/s".into(),
                        title: "agent-utils".into(),
                        provider: "pi".into(),
                        project: None,
                        cwd: Some("/work".into()),
                        modified_at: "t".into(),
                        choices,
                    }],
                },
                NodeChoices {
                    host: "beta".into(),
                    state: "offline".into(),
                    error: Some("timed out".into()),
                    endpoint: None,
                    sessions: 0,
                    input_needed_sessions: 0,
                    latency_ms: None,
                    agents: vec![],
                },
            ],
        }
    }
    fn press(app: &mut App, code: KeyCode) -> Option<Action> {
        app.key(KeyEvent::new(code, KeyModifiers::NONE))
    }

    #[test]
    fn selection_survives_refresh_and_recommended_option_is_default() {
        let mut app = App::default();
        app.set_fleet(fleet(vec![
            choice("a", "single-select", true),
            choice("b", "single-select", true),
        ]));
        assert_eq!(app.current().unwrap().request_id, "a");
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.current().unwrap().request_id, "b");
        app.set_fleet(fleet(vec![
            choice("z", "single-select", true),
            choice("b", "single-select", true),
        ]));
        assert_eq!(
            app.current().unwrap().request_id,
            "b",
            "selection is keyed, not positional"
        );
        assert_eq!(app.cursor(), 1, "recommended option preselected");
        assert!(
            !app.rows
                .iter()
                .any(|r| matches!(r, Row::Node { host, .. } if host == "beta")),
            "offline nodes stay out of the rail"
        );
    }

    #[test]
    fn number_keys_answer_with_the_option_id_and_revision_fence() {
        let mut app = App::default();
        app.set_fleet(fleet(vec![choice("a", "single-select", true)]));
        let Some(Action::Submit(input)) = press(&mut app, KeyCode::Char('3')) else {
            panic!("no submit")
        };
        assert_eq!(input.answers.get("q"), Some(&serde_json::json!("o2")));
        assert_eq!(input.revision.as_deref(), Some("rev"));
        assert!(
            press(&mut app, KeyCode::Char('1')).is_none(),
            "one answer in flight at a time"
        );
    }

    #[test]
    fn freeform_multi_select_decline_and_stale_paths() {
        let mut app = App::default();
        app.set_fleet(fleet(vec![
            choice("a", "single-select", true),
            choice("m", "multi-select", true),
            choice("s", "single-select", false),
        ]));
        press(&mut app, KeyCode::Char('i'));
        for c in "later".chars() {
            press(&mut app, KeyCode::Char(c));
        }
        let Some(Action::Submit(input)) = press(&mut app, KeyCode::Enter) else {
            panic!("freeform")
        };
        assert_eq!(
            input.answers.get("q#freeform"),
            Some(&serde_json::json!("later"))
        );
        app.receipt(AnswerReceipt {
            host: "alpha".into(),
            session: "s".into(),
            request_id: "a".into(),
            state: AnswerState::Accepted,
            reason: None,
            client_id: None,
            client_seq: None,
        });

        // After answering in the detail pane, J/K still move between questions.
        press(&mut app, KeyCode::Char('J'));
        assert_eq!(app.current().unwrap().request_id, "m");
        press(&mut app, KeyCode::Char('1'));
        press(&mut app, KeyCode::Char('3'));
        app.focus = Focus::Detail;
        let Some(Action::Submit(input)) = press(&mut app, KeyCode::Enter) else {
            panic!("multi")
        };
        assert_eq!(
            input.answers.get("q"),
            Some(&serde_json::json!(["o0", "o2"]))
        );
        app.sending = None;

        assert!(
            press(&mut app, KeyCode::Char('d')).is_none(),
            "decline is armed first"
        );
        let Some(Action::Submit(input)) = press(&mut app, KeyCode::Char('d')) else {
            panic!("decline")
        };
        assert_eq!(input.response.as_deref(), Some("decline"));
        app.sending = None;

        press(&mut app, KeyCode::Char('J'));
        assert_eq!(app.current().unwrap().request_id, "s");
        assert!(
            press(&mut app, KeyCode::Char('1')).is_none(),
            "stale entries are never answered"
        );
        assert!(app.status.as_ref().unwrap().0.contains("read-only"));
    }

    #[test]
    fn multi_question_forms_visit_every_question_and_skip_optional_text() {
        let mut form = choice("f", "multi-select", true);
        form.questions.push(Question {
            id: "notify".into(),
            kind: "boolean".into(),
            required: true,
            options: vec![],
            ..question("boolean", false)
        });
        form.questions.push(Question {
            id: "note".into(),
            kind: "text".into(),
            required: false,
            options: vec![],
            ..question("text", false)
        });
        let mut app = App::default();
        app.set_fleet(fleet(vec![form]));
        app.focus = Focus::Detail;
        press(&mut app, KeyCode::Char(' '));
        assert!(
            press(&mut app, KeyCode::Enter).is_none(),
            "advances to question 2"
        );
        assert!(
            press(&mut app, KeyCode::Char('2')).is_none(),
            "No → advances to the optional note"
        );
        assert_eq!(app.question_index(), 2);
        assert!(
            press(&mut app, KeyCode::Enter).is_none(),
            "opens the text field"
        );
        let Some(Action::Submit(input)) = press(&mut app, KeyCode::Enter) else {
            panic!("empty optional skips and submits")
        };
        assert_eq!(input.answers.get("q"), Some(&serde_json::json!(["o1"])));
        assert_eq!(input.answers.get("notify"), Some(&serde_json::json!(false)));
        assert!(!input.answers.contains_key("note"));
    }

    #[test]
    fn renders_rail_question_options_and_counts() {
        let mut app = App::default();
        app.set_fleet(fleet(vec![choice("a", "single-select", true)]));
        app.focus = Focus::Detail;
        let mut terminal = Terminal::new(TestBackend::new(100, 20)).unwrap();
        terminal.draw(|f| app.draw(f)).unwrap();
        let text: String = terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect();
        for needle in [
            "1 waiting",
            "1 offline",
            "alpha",
            "agent-utils",
            "Question a",
            "North",
            "South",
            "recommended",
            "the long way",
            "reply in your own words",
        ] {
            assert!(text.contains(needle), "missing {needle:?}");
        }
        let narrow = Terminal::new(TestBackend::new(50, 12));
        narrow.unwrap().draw(|f| app.draw(f)).unwrap();
    }
}
