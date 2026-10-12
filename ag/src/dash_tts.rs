//! Bounded, process-owned projection of the same collector as `ag tts`.
//! Browsers subscribe to a journal, never to SSH/file readers. A watch channel
//! only wakes readers: a slow consumer is reset explicitly, not backpressure.
use crate::{
    config::{Config, Host},
    model::{FleetEvent, TailEvent},
    service,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc, watch};
use tokio_util::sync::CancellationToken;

pub const MAX_EVENTS: usize = 500;
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_TEXT: usize = 16 * 1024;
pub const MAX_CLIENTS: usize = 32;

fn clipped(value: &str, max: usize) -> String {
    let mut end = value.len().min(max);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}
fn optional(value: Option<String>) -> Option<String> {
    value.map(|v| clipped(&v, 512))
}

#[derive(Clone, Debug, Serialize)]
pub struct NodeStatus {
    pub host: String,
    pub state: String,
    pub message: String,
    pub updated_ms: u64,
    pub last_speech_ms: Option<u64>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Speech {
    pub timestamp: String,
    pub kind: String,
    pub agent: Option<String>,
    pub session: Option<String>,
    pub cwd: Option<String>,
    pub text: String,
    pub truncated: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventData {
    Speech { record: Speech, node: NodeStatus },
    Status { node: NodeStatus },
}
#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    pub id: String,
    pub received_ms: u64,
    #[serde(flatten)]
    pub data: EventData,
    #[serde(skip)]
    seq: u64,
}
struct Encoded {
    entry: Arc<Entry>,
    json: Arc<str>,
}
#[derive(Clone, Debug, Serialize)]
pub struct Summary {
    pub enabled: bool,
    pub running: bool,
    pub event_id: String,
    pub retained_events: usize,
    pub retained_bytes: usize,
    pub evicted_events: u64,
    pub subscribers: usize,
    pub received_speech: u64,
    pub nodes: Vec<NodeStatus>,
}
#[derive(Serialize)]
pub struct Snapshot {
    pub version: u8,
    pub reason: String,
    #[serde(flatten)]
    pub summary: Summary,
    pub records: Vec<Arc<Entry>>,
}
struct Journal {
    running: bool,
    seq: u64,
    entries: VecDeque<Encoded>,
    bytes: usize,
    evicted: u64,
    speech: u64,
    nodes: BTreeMap<String, NodeStatus>,
}
pub struct Feed {
    enabled: bool,
    epoch: String,
    journal: Mutex<Journal>,
    pub changed: watch::Sender<u64>,
    pub clients: Arc<Semaphore>,
}
pub enum Delivery {
    Reset(Snapshot),
    Event { id: String, json: Arc<str> },
}
impl Feed {
    pub fn new(enabled: bool, hosts: &[Host]) -> Arc<Self> {
        Arc::new(Self {
            enabled,
            epoch: uuid::Uuid::new_v4().simple().to_string(),
            journal: Mutex::new(Journal {
                running: enabled,
                seq: 0,
                entries: VecDeque::new(),
                bytes: 0,
                evicted: 0,
                speech: 0,
                nodes: hosts
                    .iter()
                    .map(|h| {
                        (
                            h.name.clone(),
                            NodeStatus {
                                host: h.name.clone(),
                                state: if enabled { "connecting" } else { "disabled" }.into(),
                                message: String::new(),
                                updated_ms: 0,
                                last_speech_ms: None,
                            },
                        )
                    })
                    .collect(),
            }),
            changed: watch::channel(0).0,
            clients: Arc::new(Semaphore::new(MAX_CLIENTS)),
        })
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, Journal> {
        self.journal.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn id(&self, seq: u64) -> String {
        format!("{}:{seq}", self.epoch)
    }
    fn summary_locked(&self, j: &Journal) -> Summary {
        Summary {
            enabled: self.enabled,
            running: j.running,
            event_id: self.id(j.seq),
            retained_events: j.entries.len(),
            retained_bytes: j.bytes,
            evicted_events: j.evicted,
            received_speech: j.speech,
            subscribers: MAX_CLIENTS - self.clients.available_permits(),
            nodes: j.nodes.values().cloned().collect(),
        }
    }
    pub fn summary(&self) -> Summary {
        self.summary_locked(&self.lock())
    }
    fn snapshot_locked(&self, j: &Journal, reason: &str) -> Snapshot {
        Snapshot {
            version: 1,
            reason: reason.into(),
            summary: self.summary_locked(j),
            records: j
                .entries
                .iter()
                .filter(|e| matches!(e.entry.data, EventData::Speech { .. }))
                .map(|e| e.entry.clone())
                .collect(),
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot_locked(&self.lock(), "snapshot")
    }

    /// Snapshot and replay cursor are obtained under the same narrow lock. No
    /// serialization, socket send or async operation holds it on the read path.
    pub fn next(&self, after: Option<&str>) -> Option<Delivery> {
        let j = self.lock();
        let reset = |reason| Some(Delivery::Reset(self.snapshot_locked(&j, reason)));
        let Some(after) = after else {
            return reset("initial");
        };
        let Some((epoch, seq)) = after.split_once(':') else {
            return reset("invalid");
        };
        if epoch != self.epoch {
            return reset("restarted");
        }
        let Ok(seq) = seq.parse::<u64>() else {
            return reset("invalid");
        };
        if seq > j.seq {
            return reset("invalid");
        }
        if j.entries
            .front()
            .is_some_and(|e| seq < e.entry.seq.saturating_sub(1))
        {
            return reset("expired");
        }
        j.entries
            .iter()
            .find(|e| e.entry.seq > seq)
            .map(|e| Delivery::Event {
                id: e.entry.id.clone(),
                json: e.json.clone(),
            })
    }
    pub fn publish(&self, event: FleetEvent) {
        if matches!(event.event, TailEvent::Checkpoint { .. }) {
            return;
        }
        let now = crate::doctor::now_ms();
        let mut j = self.lock();
        // Only configured hosts belong in the projection. Never grow a map
        // from peer-supplied identities (FleetEvent.host is transport-owned).
        let Some(node) = j.nodes.get_mut(&event.host) else {
            return;
        };
        node.updated_ms = now;
        let data = match event.event {
            TailEvent::Speech { record, .. } => {
                node.state = "connected".into();
                node.message.clear();
                node.last_speech_ms = Some(now);
                EventData::Speech {
                    node: node.clone(),
                    record: Speech {
                        timestamp: clipped(&record.timestamp, 128),
                        kind: clipped(&record.kind, 64),
                        agent: optional(record.agent),
                        session: optional(record.session),
                        cwd: optional(record.cwd),
                        truncated: record.text.len() > MAX_TEXT,
                        text: clipped(&record.text, MAX_TEXT),
                    },
                }
            }
            TailEvent::Status { state, message } => {
                node.state = match state.as_str() {
                    "reset" => "connected",
                    "offline" if crate::paratenic::offline_reason(&message).is_none() => "error",
                    "connected" | "waiting" | "warning" | "offline" => &state,
                    _ => "warning",
                }
                .into();
                node.message = clipped(&message, 512);
                EventData::Status { node: node.clone() }
            }
            TailEvent::Checkpoint { .. } => unreachable!(),
        };
        if matches!(data, EventData::Speech { .. }) {
            j.speech += 1;
        }
        j.seq += 1;
        let seq = j.seq;
        let entry = Arc::new(Entry {
            id: self.id(seq),
            received_ms: now,
            data,
            seq,
        });
        // Bounded fields make each frame <128 KiB even with JSON escaping.
        let json: Arc<str> = serde_json::to_string(&entry)
            .expect("speech view serializes")
            .into();
        j.bytes += json.len();
        j.entries.push_back(Encoded { entry, json });
        while j.entries.len() > MAX_EVENTS || j.bytes > MAX_BYTES {
            if let Some(old) = j.entries.pop_front() {
                j.bytes -= old.json.len();
                j.evicted += 1;
            }
        }
        drop(j);
        self.changed.send_replace(seq);
    }
    pub async fn run(
        self: Arc<Self>,
        config: Config,
        hosts: Vec<Host>,
        lines: usize,
        cancel: CancellationToken,
    ) {
        if !self.enabled {
            return;
        }
        let (tx, mut rx) = mpsc::channel(32);
        let producer_cancel = cancel.clone();
        let mut producer = tokio::spawn(service::follow_hosts(
            config,
            hosts,
            lines,
            tx,
            producer_cancel,
        ));
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                event = rx.recv() => match event { Some(event) => self.publish(event), None => break },
            }
        }
        // A dead collector must be visible; it never silently restarts another
        // set of tails while old tasks might still exist.
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_secs(3), &mut producer).await;
        if result.is_err() {
            producer.abort();
            let _ = producer.await;
        }
        self.lock().running = false;
        self.changed.send_replace(u64::MAX);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Cursor, SpeechRecord};
    fn speech(text: &str) -> FleetEvent {
        FleetEvent {
            host: "local".into(),
            event: TailEvent::Speech {
                record: SpeechRecord {
                    version: None,
                    id: None,
                    timestamp: "now".into(),
                    kind: "tts".into(),
                    agent: None,
                    session: None,
                    host: None,
                    cwd: None,
                    text: text.into(),
                    extra: BTreeMap::new(),
                },
                cursor: Cursor::default(),
            },
        }
    }
    #[test]
    fn ordered_replay_reset_and_silent_checkpoints() {
        let feed = Feed::new(true, &[Host::local()]);
        let Delivery::Reset(initial) = feed.next(None).unwrap() else {
            panic!()
        };
        feed.publish(speech("one"));
        feed.publish(speech("two"));
        let Delivery::Event { id, json } = feed.next(Some(&initial.summary.event_id)).unwrap()
        else {
            panic!()
        };
        assert!(json.contains("one"));
        let Delivery::Event { id: last, json } = feed.next(Some(&id)).unwrap() else {
            panic!()
        };
        assert!(json.contains("two"));
        assert!(feed.next(Some(&last)).is_none());
        feed.publish(FleetEvent {
            host: "local".into(),
            event: TailEvent::Checkpoint {
                cursor: Cursor::default(),
            },
        });
        assert!(feed.next(Some(&last)).is_none());
        let Delivery::Reset(reset) = feed.next(Some("retired:100")).unwrap() else {
            panic!()
        };
        assert_eq!(reset.reason, "restarted");
        assert_eq!(reset.records.len(), 2);
    }
    #[test]
    fn slow_readers_reset_and_memory_is_bounded_by_count_and_bytes() {
        let feed = Feed::new(true, &[Host::local()]);
        let old = feed.summary().event_id;
        for _ in 0..MAX_EVENTS + 20 {
            feed.publish(speech("short"));
        }
        assert_eq!(feed.summary().retained_events, MAX_EVENTS);
        let Delivery::Reset(reset) = feed.next(Some(&old)).unwrap() else {
            panic!()
        };
        assert_eq!(reset.reason, "expired");
        for _ in 0..MAX_EVENTS {
            feed.publish(speech(&"世".repeat(MAX_TEXT)));
        }
        let snapshot = feed.snapshot();
        assert!(snapshot.summary.retained_bytes <= MAX_BYTES);
        assert!(snapshot.summary.retained_events < MAX_EVENTS);
        assert!(snapshot.records.iter().all(|e| match &e.data {
            EventData::Speech { record, .. } => record.truncated && record.text.len() <= MAX_TEXT,
            _ => false,
        }));
    }
}
