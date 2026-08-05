use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const CACHE_VERSION: u32 = 1;
pub const SEVEN_DAYS_SECS: i64 = 7 * 24 * 60 * 60;

/// Collector state for one independently refreshed cache domain.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RefreshState {
    /// No collector has attempted this domain yet.
    #[default]
    Unknown,
    /// A request for this domain is currently in flight.
    Refreshing,
    /// The last attempt produced a complete snapshot.
    Healthy,
    /// Some data was retained, but the attempt was not complete.
    Partial,
    /// Slack asked the collector to stop and retry later.
    Backoff,
    /// The last attempt failed for a reason other than throttling.
    Error,
}

/// Persistent health and coverage metadata for one refresh domain.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct DomainHealth {
    pub state: RefreshState,
    pub last_attempt_at: Option<i64>,
    pub last_success_at: Option<i64>,
    pub next_attempt_at: Option<i64>,
    pub consecutive_failures: u32,
    pub detail: String,
}

/// Persistent status written by `slick daemon` beside the cache payload.
///
/// `saved_at` can advance for a health-only update, so clients must use these
/// per-domain success timestamps when deciding whether activity is complete.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct CollectorHealth {
    pub running: bool,
    pub revision: u64,
    pub current_domain: Option<String>,
    pub rate_limited_until: Option<i64>,
    pub last_cycle_at: Option<i64>,
    pub last_error: String,
    pub domains: BTreeMap<String, DomainHealth>,
}

/// Durable cursor for a multi-page Slack search. A domain's complete-refresh
/// timestamp advances only after every page in its fixed window succeeds.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct SearchProgress {
    pub window_start: i64,
    pub next_page: u32,
    pub cursor: String,
    pub complete: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub real_name: String,
    pub title: String,
    pub is_bot: bool,
    pub deleted: bool,
}

impl User {
    #[must_use]
    pub fn label(&self) -> &str {
        [
            &self.display_name,
            &self.real_name,
            &self.username,
            &self.id,
        ]
        .into_iter()
        .find(|value| !value.is_empty())
        .map_or("unknown", String::as_str)
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ConversationKind {
    Dm,
    GroupDm,
    PrivateChannel,
    #[default]
    Channel,
}

impl ConversationKind {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Dm => "DM",
            Self::GroupDm => "Group DM",
            Self::PrivateChannel => "Private channel",
            Self::Channel => "Channel",
        }
    }

    #[must_use]
    pub const fn is_dm(self) -> bool {
        matches!(self, Self::Dm | Self::GroupDm)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct Conversation {
    pub id: String,
    pub name: String,
    pub kind: ConversationKind,
    pub user_id: Option<String>,
    pub topic: String,
    pub purpose: String,
    pub unread_count: u32,
    pub mention_count: u32,
    #[serde(default)]
    pub is_favorite: bool,
    pub latest_ts: Option<String>,
    pub is_member: bool,
    pub is_archived: bool,
}

impl Conversation {
    #[must_use]
    pub fn activity_ts(&self) -> f64 {
        self.latest_ts
            .as_deref()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct Message {
    pub ts: String,
    pub timestamp: String,
    pub user_id: String,
    pub author: String,
    pub text: String,
    pub permalink: String,
    pub thread_ts: Option<String>,
    pub reply_count: u32,
    pub file_ids: Vec<String>,
    pub attachment_ids: Vec<String>,
}

impl Message {
    #[must_use]
    pub fn unix_ts(&self) -> f64 {
        self.ts.parse::<f64>().unwrap_or(0.0)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct Notification {
    pub key: String,
    pub conversation_id: String,
    pub conversation_name: String,
    pub kind: ConversationKind,
    pub message: Message,
    pub unread: bool,
    pub mention: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct SlackFile {
    pub id: String,
    pub title: String,
    pub file_type: String,
    pub user_id: String,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    pub size_bytes: u64,
    pub permalink: String,
    pub provenance: Vec<String>,
    pub access: String,
    #[serde(default)]
    pub download_url: String,
    #[serde(default)]
    pub content_markdown: String,
    #[serde(default)]
    pub content_status: String,
    #[serde(default)]
    pub content_fetched_at: Option<i64>,
}

impl SlackFile {
    #[must_use]
    pub fn is_canvas(&self) -> bool {
        self.file_type.eq_ignore_ascii_case("canvas")
            || self.file_type.eq_ignore_ascii_case("quip")
            || self.download_url.ends_with("/canvas")
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct CacheState {
    pub version: u32,
    pub team_id: String,
    pub team_name: String,
    pub self_user_id: String,
    pub self_username: String,
    pub users: BTreeMap<String, User>,
    pub conversations: Vec<Conversation>,
    pub messages: BTreeMap<String, Vec<Message>>,
    #[serde(default)]
    pub threads: BTreeMap<String, Vec<Message>>,
    pub notifications: Vec<Notification>,
    pub files: Vec<SlackFile>,
    pub last_refresh: BTreeMap<String, i64>,
    #[serde(default)]
    pub self_activity: BTreeMap<String, String>,
    #[serde(default)]
    pub collector: CollectorHealth,
    #[serde(default)]
    pub search_progress: BTreeMap<String, SearchProgress>,
    pub saved_at: Option<i64>,
}

impl Default for CacheState {
    fn default() -> Self {
        Self {
            version: CACHE_VERSION,
            team_id: String::new(),
            team_name: String::new(),
            self_user_id: String::new(),
            self_username: String::new(),
            users: BTreeMap::new(),
            conversations: Vec::new(),
            messages: BTreeMap::new(),
            threads: BTreeMap::new(),
            notifications: Vec::new(),
            files: Vec::new(),
            last_refresh: BTreeMap::new(),
            self_activity: BTreeMap::new(),
            collector: CollectorHealth::default(),
            search_progress: BTreeMap::new(),
            saved_at: None,
        }
    }
}

impl CacheState {
    #[must_use]
    pub fn now() -> i64 {
        Utc::now().timestamp()
    }

    #[must_use]
    pub fn seven_days_ago() -> i64 {
        Self::now().saturating_sub(SEVEN_DAYS_SECS)
    }

    #[must_use]
    pub fn since_for(&self, key: &str) -> i64 {
        self.last_refresh
            .get(key)
            .copied()
            .unwrap_or_else(Self::seven_days_ago)
    }

    pub fn mark_refreshed(&mut self, key: impl Into<String>) {
        self.last_refresh.insert(key.into(), Self::now());
    }

    /// Last complete refresh for a domain, preferring daemon coverage metadata
    /// and falling back to pre-daemon cache timestamps.
    #[must_use]
    pub fn refreshed_at(&self, key: &str) -> Option<i64> {
        match (
            self.collector
                .domains
                .get(key)
                .and_then(|domain| domain.last_success_at),
            self.last_refresh.get(key).copied(),
        ) {
            (Some(collector), Some(legacy)) => Some(collector.max(legacy)),
            (collector, legacy) => collector.or(legacy),
        }
    }

    /// Mutable health record, created lazily for old cache files.
    pub fn domain_health_mut(&mut self, key: &str) -> &mut DomainHealth {
        self.collector.domains.entry(key.to_string()).or_default()
    }

    #[must_use]
    pub fn thread_key(conversation_id: &str, thread_ts: &str) -> String {
        format!("{conversation_id}:{thread_ts}")
    }

    #[must_use]
    pub fn conversation(&self, id: &str) -> Option<&Conversation> {
        self.conversations.iter().find(|item| item.id == id)
    }

    #[must_use]
    pub fn user_label(&self, id: &str) -> String {
        self.users
            .get(id)
            .map_or_else(|| id.to_string(), |user| user.label().to_string())
    }

    pub fn merge_messages(&mut self, conversation_id: &str, incoming: Vec<Message>) {
        let messages = self
            .messages
            .entry(conversation_id.to_string())
            .or_default();
        let mut seen: HashSet<String> = messages.iter().map(|message| message.ts.clone()).collect();
        messages.extend(
            incoming
                .into_iter()
                .filter(|message| seen.insert(message.ts.clone())),
        );
        messages.sort_by(|left, right| {
            left.unix_ts()
                .partial_cmp(&right.unix_ts())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if messages.len() > 500 {
            messages.drain(..messages.len() - 500);
        }
    }

    pub fn normalize(&mut self) {
        if self.version != CACHE_VERSION {
            *self = Self::default();
            return;
        }
        self.conversations.retain(|item| !item.is_archived);
        self.conversations.sort_by(|left, right| {
            right
                .is_favorite
                .cmp(&left.is_favorite)
                .then_with(|| right.unread_count.cmp(&left.unread_count))
                .then_with(|| {
                    right
                        .activity_ts()
                        .partial_cmp(&left.activity_ts())
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        self.notifications.sort_by(|left, right| {
            right
                .message
                .unix_ts()
                .partial_cmp(&left.message.unix_ts())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        self.notifications.truncate(5_000);
        self.files
            .sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        self.files.truncate(1_000);
        for messages in self.messages.values_mut().chain(self.threads.values_mut()) {
            messages.sort_by(|left, right| {
                left.unix_ts()
                    .partial_cmp(&right.unix_ts())
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            if messages.len() > 500 {
                messages.drain(..messages.len() - 500);
            }
        }
    }

    #[must_use]
    pub fn friendly_saved_at(&self) -> String {
        self.saved_at
            .and_then(|value| DateTime::from_timestamp(value, 0))
            .map_or_else(
                || "never".to_string(),
                |value: DateTime<Utc>| value.format("%Y-%m-%d %H:%M UTC").to_string(),
            )
    }
}

impl remote_cli::Snapshot for CacheState {
    const APP_NAME: &'static str = "slick";
    const DISPLAY_NAME: &'static str = "Slick";
    const CACHE_DIR_ENV: &'static str = "SLICK_CACHE_DIR";

    fn normalize(&mut self) {
        CacheState::normalize(self);
    }

    fn revision(&self) -> u64 {
        self.collector.revision
    }

    fn set_revision(&mut self, revision: u64) {
        self.collector.revision = revision;
    }

    fn saved_at(&self) -> Option<i64> {
        self.saved_at
    }

    fn set_saved_at(&mut self, saved_at: Option<i64>) {
        self.saved_at = saved_at;
    }

    fn latest_refresh(&self) -> Option<i64> {
        self.last_refresh.values().copied().max()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(ts: &str) -> Message {
        Message {
            ts: ts.to_string(),
            text: format!("message {ts}"),
            ..Message::default()
        }
    }

    #[test]
    fn user_label_prefers_display_then_real_then_username() {
        let mut user = User {
            id: "U1".into(),
            username: "ada".into(),
            real_name: "Ada Lovelace".into(),
            display_name: "Ada".into(),
            ..User::default()
        };
        assert_eq!(user.label(), "Ada");
        user.display_name.clear();
        assert_eq!(user.label(), "Ada Lovelace");
        user.real_name.clear();
        assert_eq!(user.label(), "ada");
    }

    #[test]
    fn merge_messages_deduplicates_and_sorts() {
        let mut state = CacheState::default();
        state.merge_messages("C1", vec![message("2"), message("1")]);
        state.merge_messages("C1", vec![message("2"), message("3")]);
        let timestamps: Vec<_> = state.messages["C1"]
            .iter()
            .map(|item| item.ts.as_str())
            .collect();
        assert_eq!(timestamps, vec!["1", "2", "3"]);
    }

    #[test]
    fn normalization_orders_unread_then_recent() {
        let mut state = CacheState {
            conversations: vec![
                Conversation {
                    id: "old".into(),
                    name: "old".into(),
                    unread_count: 0,
                    latest_ts: Some("1".into()),
                    ..Conversation::default()
                },
                Conversation {
                    id: "unread".into(),
                    name: "unread".into(),
                    unread_count: 2,
                    latest_ts: Some("2".into()),
                    ..Conversation::default()
                },
            ],
            ..CacheState::default()
        };
        state.normalize();
        assert_eq!(state.conversations[0].id, "unread");
    }
}
