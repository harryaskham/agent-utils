//! Loops, schedules and goals running inside pi-daemon sessions: agent-utils'
//! `loop.mjs` keeps each session's `/loop`, `/after`, `/cron` and `/goal` in the
//! session's `agent-utils.loops` Durable document. `ag` reads them over each
//! node's pi-daemon `/chord` (`sessions.list`, then `session.document`), for a
//! rough, periodic overview of what automation runs where. Read-only.
//!
//! A loop fires work, which keeps its session's activity fresh, so only sessions
//! active within [`ACTIVE_WINDOW_MS`] are read (at most [`MAX_SESSIONS_READ`]
//! per node, most recent first); a schedule rarer than that window is missed
//! until it fires.
use crate::{
    Error, Result,
    config::Host,
    paratenic::{self, Endpoint, NodeEndpoints},
};
use futures_util::{SinkExt, StreamExt};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_tungstenite::tungstenite::{
    Message, client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig,
};

/// The `/chord` WebSocket subprotocol.
const CHORD_PROTOCOL: &str = "pi-daemon.chord.v1";
/// Sessions active within this window are read.
pub const ACTIVE_WINDOW_MS: u64 = 8 * 24 * 3600 * 1000;
/// Sessions read per node at most, most recently active first.
pub const MAX_SESSIONS_READ: usize = 128;
/// Catalog pages read per node at most (1000 sessions each).
const MAX_PAGES: usize = 20;
/// Characters of a prompt or goal kept.
const MAX_PROMPT: usize = 240;
const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
const CALL_TIMEOUT: Duration = Duration::from_secs(15);
/// One node's whole read, at most.
const NODE_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct LoopsInput {
    #[serde(flatten)]
    pub selection: crate::model::Selection,
}

/// One live loop, schedule or goal.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct LoopItem {
    /// The session's number for it (`/loop stop N`).
    pub number: u64,
    /// `loop` (every interval), `after` (once), `cron` or `goal`.
    pub kind: String,
    /// The prompt it sends (a goal: its text), shortened.
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
    /// When it next fires (milliseconds since the epoch); none for a goal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
    /// A goal's nudges so far, and its limit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nudges: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_nudges: Option<u64>,
    /// Delivered as a steer while the agent is busy (else a follow-up).
    pub steer: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct SessionLoops {
    pub session_id: String,
    pub title: String,
    pub cwd: String,
    pub profile: String,
    /// The agent is working now.
    pub working: bool,
    pub archived: bool,
    pub active_at_ms: u64,
    pub loops: Vec<LoopItem>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct NodeLoops {
    /// The node (its pi-daemon).
    pub host: String,
    /// `ok`, `offline` (not reachable: quiet), `error`, or `none` (no pi-daemon configured).
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Only sessions with live loops, most recently active first.
    pub sessions: Vec<SessionLoops>,
    /// Sessions whose loops were read, and documents that could not be.
    pub read: usize,
    pub unreadable: usize,
    /// Sessions left out: inactive longer than the window, or beyond the cap.
    pub skipped: usize,
    pub observed_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct FleetLoops {
    pub nodes: Vec<NodeLoops>,
    /// Live loops and schedules (`loop`, `after`, `cron`), and goals.
    pub loops: usize,
    pub goals: usize,
    pub window_ms: u64,
    pub observed_at: String,
}

fn shorten(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= MAX_PROMPT {
        return flat;
    }
    let mut out: String = flat.chars().take(MAX_PROMPT - 1).collect();
    out.push('…');
    out
}

fn number(value: &Value) -> Option<u64> {
    match value {
        Value::Number(n) => n
            .as_u64()
            .or_else(|| n.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)),
        _ => None,
    }
}

/// The next tick of an interval loop after `now`: `startedAt + k × interval`
/// (as agent-utils' `nextFireAt`: missed ticks are skipped).
pub fn next_fire_at(started_at: u64, interval_ms: u64, now: u64) -> u64 {
    if interval_ms == 0 || started_at + interval_ms > now {
        return started_at + interval_ms;
    }
    started_at + ((now - started_at) / interval_ms + 1) * interval_ms
}

/// A loops document's live entries, by number.
pub fn loops_from_document(doc: &Value, now: u64) -> Vec<LoopItem> {
    let Some(entries) = doc.get("loops").and_then(Value::as_object) else {
        return vec![];
    };
    let mut items: Vec<LoopItem> = entries
        .iter()
        .filter_map(|(key, entry)| {
            let index = key.parse::<u64>().ok()?;
            if entry.get("stopped").and_then(Value::as_bool) == Some(true) {
                return None;
            }
            let kind = entry
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("loop")
                .to_owned();
            let text = |name: &str| entry.get(name).and_then(Value::as_str).map(str::to_owned);
            let started_at_ms = entry.get("startedAt").and_then(number);
            let interval_secs = entry
                .get("intervalSecs")
                .and_then(number)
                .filter(|s| *s > 0);
            let next_at_ms = match kind.as_str() {
                "after" | "cron" => entry.get("nextAt").and_then(number),
                "goal" => None,
                _ => match (started_at_ms, interval_secs) {
                    (Some(start), Some(secs)) => Some(next_fire_at(start, secs * 1000, now)),
                    _ => None,
                },
            };
            let cron = entry.get("cron");
            Some(LoopItem {
                number: index,
                prompt: shorten(&text("prompt").unwrap_or_default()),
                interval_secs: (kind == "loop").then_some(interval_secs).flatten(),
                cron: cron
                    .and_then(|c| c.get("expression"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                time_zone: cron
                    .and_then(|c| c.get("timeZone"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                next_at_ms,
                started_at_ms,
                nudges: (kind == "goal").then(|| entry.get("nudges").and_then(number).unwrap_or(0)),
                max_nudges: (kind == "goal")
                    .then(|| entry.get("maxNudges").and_then(number))
                    .flatten(),
                steer: text("deliverAs").as_deref() == Some("steer"),
                kind,
            })
        })
        .collect();
    items.sort_by_key(|item| item.number);
    items
}

/// `ws://node:7463/chord` from the node's pi-daemon `/ahp` endpoint.
fn chord_url(endpoint: &Endpoint) -> Result<String> {
    let mut url =
        url::Url::parse(&endpoint.url).map_err(|e| Error::Config(format!("pi-daemon url: {e}")))?;
    url.set_path("/chord");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.to_string())
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A minimal `/chord` client: one call at a time, subscriptions never opened.
struct Chord {
    socket: Socket,
    next: u64,
}

impl Chord {
    async fn connect(endpoint: &Endpoint) -> Result<Self> {
        let mut request = chord_url(endpoint)?
            .as_str()
            .into_client_request()
            .map_err(|e| Error::Config(format!("chord url: {e}")))?;
        let headers = request.headers_mut();
        headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(CHORD_PROTOCOL),
        );
        if let Some(path) = &endpoint.token_file {
            let token = paratenic::read_token(path)?;
            let value = HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| Error::Config("token contains invalid header characters".into()))?;
            headers.insert("authorization", value);
        }
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_MESSAGE_BYTES));
        let (socket, _) = tokio::time::timeout(
            CONNECT_TIMEOUT,
            tokio_tungstenite::connect_async_with_config(request, Some(config), true),
        )
        .await
        .map_err(|_| Error::Transport("chord connect timed out".into()))?
        .map_err(|e| {
            Error::Transport(format!(
                "chord connect: {}",
                paratenic::redact(&e.to_string())
            ))
        })?;
        Ok(Self { socket, next: 1 })
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next;
        self.next += 1;
        let request = json!({ "id": id, "method": method, "params": params });
        self.socket
            .send(Message::text(request.to_string()))
            .await
            .map_err(|e| Error::Transport(format!("chord send: {e}")))?;
        let wait = async {
            while let Some(message) = self.socket.next().await {
                let message = message.map_err(|e| Error::Transport(format!("chord: {e}")))?;
                let text = match message {
                    Message::Text(text) => text.to_string(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(reply) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if reply.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if let Some(error) = reply.get("error") {
                    let code = error.get("code").and_then(Value::as_str).unwrap_or("error");
                    let message = error.get("message").and_then(Value::as_str).unwrap_or("");
                    return Err(Error::Transport(format!(
                        "{method}: {code}: {}",
                        crate::terminal_text(message)
                    )));
                }
                return Ok(reply.get("result").cloned().unwrap_or(Value::Null));
            }
            Err(Error::Transport("chord connection closed".into()))
        };
        tokio::time::timeout(CALL_TIMEOUT, wait)
            .await
            .map_err(|_| Error::Transport(format!("{method} timed out")))?
    }

    async fn close(mut self) {
        let _ = self.socket.close(None).await;
    }
}

async fn read_node(
    endpoint: &Endpoint,
    now: u64,
) -> Result<(Vec<SessionLoops>, usize, usize, usize)> {
    let mut chord = Chord::connect(endpoint).await?;
    let result = async {
        let mut rows: Vec<Value> = vec![];
        let mut after: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut params = json!({ "limit": 1000 });
            if let Some(cursor) = &after {
                params["after"] = json!(cursor);
            }
            let page = chord.call("sessions.list", params).await?;
            let items = page
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            // Most recently active first: stop once a page leaves the window.
            let past_window = items.iter().any(|row| {
                row.get("activeAt")
                    .and_then(number)
                    .is_some_and(|at| now.saturating_sub(at) > ACTIVE_WINDOW_MS)
            });
            rows.extend(items);
            match page.get("next").and_then(Value::as_str) {
                Some(next) if !past_window => after = Some(next.to_owned()),
                _ => break,
            }
        }
        let total = rows.len();
        let candidates: Vec<&Value> = rows
            .iter()
            .filter(|row| {
                row.get("activeAt")
                    .and_then(number)
                    .is_some_and(|at| now.saturating_sub(at) <= ACTIVE_WINDOW_MS)
            })
            .take(MAX_SESSIONS_READ)
            .collect();
        let skipped = total - candidates.len();
        let (mut read, mut unreadable) = (0, 0);
        let mut sessions = vec![];
        for row in candidates {
            let Some(id) = row.get("id").and_then(Value::as_str) else {
                continue;
            };
            let params = json!({
                "sessionId": id,
                "kind": "agent-utils.loops",
                "version": 1,
                "scope": "session",
            });
            let doc = match chord.call("session.document", params).await {
                Ok(doc) => doc,
                Err(_) => {
                    unreadable += 1;
                    continue;
                }
            };
            read += 1;
            let loops = doc
                .get("value")
                .map(|value| loops_from_document(value, now))
                .unwrap_or_default();
            if loops.is_empty() {
                continue;
            }
            let text = |name: &str| {
                row.get(name)
                    .and_then(Value::as_str)
                    .map(crate::terminal_text)
                    .unwrap_or_default()
            };
            sessions.push(SessionLoops {
                session_id: id.to_owned(),
                title: text("title"),
                cwd: text("cwd"),
                profile: text("profile"),
                working: row.get("liveWork").and_then(Value::as_bool) == Some(true),
                archived: row.get("isArchived").and_then(Value::as_bool) == Some(true),
                active_at_ms: row.get("activeAt").and_then(number).unwrap_or(0),
                loops,
            });
        }
        Ok((sessions, read, unreadable, skipped))
    }
    .await;
    chord.close().await;
    result
}

/// One node's pi-daemon loops; failures are the node's state, never an error.
pub async fn node_loops(host: &Host, endpoint: Option<&Endpoint>, now: u64) -> NodeLoops {
    let mut node = NodeLoops {
        host: host.name.clone(),
        observed_at: paratenic::now_rfc3339(),
        ..NodeLoops::default()
    };
    let Some(endpoint) = endpoint else {
        node.state = "none".into();
        return node;
    };
    match tokio::time::timeout(NODE_TIMEOUT, read_node(endpoint, now)).await {
        Ok(Ok((sessions, read, unreadable, skipped))) => {
            node.state = "ok".into();
            node.sessions = sessions;
            node.read = read;
            node.unreadable = unreadable;
            node.skipped = skipped;
        }
        Ok(Err(error)) => {
            let message = error.to_string();
            match paratenic::offline_reason(&message) {
                Some(reason) => {
                    node.state = "offline".into();
                    node.error = Some(reason.into());
                }
                None => {
                    node.state = "error".into();
                    node.error = Some(message);
                }
            }
        }
        Err(_) => {
            node.state = "offline".into();
            node.error = Some("timed out".into());
        }
    }
    node.observed_at = paratenic::now_rfc3339();
    node
}

/// Every node's pi-daemon loops, concurrently.
pub async fn fleet_loops(targets: Vec<(Host, NodeEndpoints)>) -> FleetLoops {
    let now = crate::doctor::now_ms();
    let nodes = futures_util::future::join_all(
        targets
            .iter()
            .map(|(host, endpoints)| node_loops(host, endpoints.daemon.as_ref(), now)),
    )
    .await;
    let all = nodes
        .iter()
        .flat_map(|n| &n.sessions)
        .flat_map(|s| &s.loops);
    let goals = all.clone().filter(|item| item.kind == "goal").count();
    let loops = all.count() - goals;
    FleetLoops {
        nodes,
        loops,
        goals,
        window_ms: ACTIVE_WINDOW_MS,
        observed_at: paratenic::now_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_loops_document_reads_as_its_live_loops_schedules_and_goals() {
        let doc = json!({
            "last": 5,
            "loops": {
                "1": { "taskId": "1", "prompt": "Check  the\ninbox", "intervalSecs": 300, "deliverAs": "steer", "startedAt": 1_000_000, "conversationId": 1 },
                "2": { "taskId": "2", "kind": "cron", "prompt": "/compact", "cron": { "expression": "0 9 * * 1-5", "timeZone": "Europe/London" }, "nextAt": 9_000_000, "startedAt": 1 },
                "3": { "taskId": "3", "kind": "after", "prompt": "ping", "nextAt": 2_000_000, "startedAt": 1 },
                "4": { "taskId": "4", "kind": "goal", "prompt": "all tests pass", "nudges": 3, "maxNudges": 20, "startedAt": 5 },
                "5": { "taskId": "5", "prompt": "stopped one", "intervalSecs": 60, "startedAt": 1, "stopped": true },
            }
        });
        let items = loops_from_document(&doc, 1_000_000 + 700_000);
        assert_eq!(
            items.iter().map(|i| i.number).collect::<Vec<_>>(),
            [1, 2, 3, 4]
        );
        assert_eq!(items[0].kind, "loop");
        assert_eq!(items[0].prompt, "Check the inbox");
        assert_eq!(items[0].interval_secs, Some(300));
        assert_eq!(
            items[0].next_at_ms,
            Some(1_000_000 + 900_000),
            "missed ticks are skipped"
        );
        assert!(items[0].steer);
        assert_eq!(items[1].cron.as_deref(), Some("0 9 * * 1-5"));
        assert_eq!(items[1].time_zone.as_deref(), Some("Europe/London"));
        assert_eq!(items[1].next_at_ms, Some(9_000_000));
        assert_eq!(items[1].interval_secs, None);
        assert_eq!(items[2].next_at_ms, Some(2_000_000));
        assert_eq!(items[3].kind, "goal");
        assert_eq!((items[3].nudges, items[3].max_nudges), (Some(3), Some(20)));
        assert_eq!(items[3].next_at_ms, None);
        assert!(loops_from_document(&json!({}), 0).is_empty());
        assert!(loops_from_document(&Value::Null, 0).is_empty());
    }

    #[test]
    fn long_prompts_are_shortened_and_chord_lives_beside_ahp() {
        let long = "x".repeat(1000);
        assert_eq!(shorten(&long).chars().count(), MAX_PROMPT);
        let endpoint = Endpoint {
            url: "ws://ms-mac:7463/ahp".into(),
            token_file: None,
            allow_plaintext_non_loopback: true,
            source: "pi-client".into(),
        };
        assert_eq!(chord_url(&endpoint).unwrap(), "ws://ms-mac:7463/chord");
        assert_eq!(next_fire_at(1000, 100, 1350), 1400);
        assert_eq!(next_fire_at(1000, 100, 1050), 1100);
    }
}
