use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const CACHE_VERSION: u32 = 1;
pub const MAX_MAIL: usize = 5_000;
pub const MAX_EVENTS: usize = 2_000;
pub const MAX_MESSAGES_PER_CHAT: usize = 1_000;

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RefreshState {
    #[default]
    Unknown,
    Refreshing,
    Healthy,
    Partial,
    Backoff,
    Error,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(default)]
pub struct DomainHealth {
    pub state: RefreshState,
    pub last_attempt_at: Option<i64>,
    pub last_success_at: Option<i64>,
    pub next_attempt_at: Option<i64>,
    pub consecutive_failures: u32,
    pub detail: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(default)]
pub struct CollectorHealth {
    pub running: bool,
    pub revision: u64,
    pub current_domain: Option<String>,
    pub last_cycle_at: Option<i64>,
    pub last_error: String,
    pub domains: BTreeMap<String, DomainHealth>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(default)]
pub struct Account {
    pub id: String,
    pub display_name: String,
    pub mail: String,
    pub user_principal_name: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(default)]
pub struct Address {
    pub name: String,
    pub address: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(default)]
pub struct MailMessage {
    pub id: String,
    pub subject: String,
    pub from: Address,
    pub to: Vec<Address>,
    pub received_at: String,
    pub sent_at: String,
    pub body_preview: String,
    pub body_markdown: String,
    pub is_read: bool,
    pub importance: String,
    pub has_attachments: bool,
    pub conversation_id: String,
    pub web_link: String,
    pub folder: String,
}

impl MailMessage {
    #[must_use]
    pub fn timestamp(&self) -> i64 {
        parse_time(if self.received_at.is_empty() {
            &self.sent_at
        } else {
            &self.received_at
        })
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(default)]
pub struct CalendarEvent {
    pub id: String,
    pub subject: String,
    pub organizer: Address,
    pub attendees: Vec<Address>,
    pub start: String,
    pub end: String,
    pub timezone: String,
    pub location: String,
    pub body_preview: String,
    pub body_markdown: String,
    pub response_status: String,
    pub is_online_meeting: bool,
    pub join_url: String,
    pub web_link: String,
    pub series_master_id: String,
    pub is_cancelled: bool,
}

impl CalendarEvent {
    #[must_use]
    pub fn timestamp(&self) -> i64 {
        parse_time(&self.start)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(default)]
pub struct Chat {
    pub id: String,
    pub topic: String,
    pub chat_type: String,
    pub updated_at: String,
    pub web_url: String,
    pub members: Vec<Address>,
}

impl Chat {
    #[must_use]
    pub fn label(&self) -> String {
        if !self.topic.trim().is_empty() {
            return self.topic.clone();
        }
        let members = self
            .members
            .iter()
            .map(|member| {
                if member.name.is_empty() {
                    member.address.as_str()
                } else {
                    member.name.as_str()
                }
            })
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        if members.is_empty() {
            format!("{} chat", self.chat_type)
        } else {
            members
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(default)]
pub struct ChatMessage {
    pub id: String,
    pub created_at: String,
    pub modified_at: String,
    pub from: Address,
    pub body_markdown: String,
    pub message_type: String,
    pub reply_to_id: String,
    pub web_url: String,
    pub importance: String,
    pub deleted: bool,
}

impl ChatMessage {
    #[must_use]
    pub fn timestamp(&self) -> i64 {
        parse_time(&self.created_at)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(default)]
pub struct Team {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub web_url: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(default)]
pub struct Channel {
    pub id: String,
    pub team_id: String,
    pub display_name: String,
    pub description: String,
    pub membership_type: String,
    pub web_url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct CacheState {
    pub version: u32,
    pub account: Account,
    pub mail: Vec<MailMessage>,
    pub events: Vec<CalendarEvent>,
    pub chats: Vec<Chat>,
    pub chat_messages: BTreeMap<String, Vec<ChatMessage>>,
    pub teams: Vec<Team>,
    pub channels: BTreeMap<String, Vec<Channel>>,
    pub channel_messages: BTreeMap<String, Vec<ChatMessage>>,
    /// Opaque WorkIQ/Graph continuation or delta URL by collector domain.
    pub cursors: BTreeMap<String, String>,
    pub last_refresh: BTreeMap<String, i64>,
    pub collector: CollectorHealth,
    pub saved_at: Option<i64>,
}

impl Default for CacheState {
    fn default() -> Self {
        Self {
            version: CACHE_VERSION,
            account: Account::default(),
            mail: Vec::new(),
            events: Vec::new(),
            chats: Vec::new(),
            chat_messages: BTreeMap::new(),
            teams: Vec::new(),
            channels: BTreeMap::new(),
            channel_messages: BTreeMap::new(),
            cursors: BTreeMap::new(),
            last_refresh: BTreeMap::new(),
            collector: CollectorHealth::default(),
            saved_at: None,
        }
    }
}

impl CacheState {
    #[must_use]
    pub fn now() -> i64 {
        Utc::now().timestamp()
    }

    pub fn domain_health_mut(&mut self, domain: &str) -> &mut DomainHealth {
        self.collector
            .domains
            .entry(domain.to_string())
            .or_default()
    }

    pub fn mark_refreshed(&mut self, domain: impl Into<String>) {
        self.last_refresh.insert(domain.into(), Self::now());
    }

    #[must_use]
    pub fn refreshed_at(&self, domain: &str) -> Option<i64> {
        match (
            self.collector
                .domains
                .get(domain)
                .and_then(|health| health.last_success_at),
            self.last_refresh.get(domain).copied(),
        ) {
            (Some(current), Some(legacy)) => Some(current.max(legacy)),
            (current, legacy) => current.or(legacy),
        }
    }

    pub fn merge_mail(&mut self, incoming: Vec<MailMessage>) {
        merge_by_id(&mut self.mail, incoming, |message| &message.id);
        self.mail
            .sort_by_key(|message| std::cmp::Reverse(message.timestamp()));
        self.mail.truncate(MAX_MAIL);
    }

    pub fn merge_events(&mut self, incoming: Vec<CalendarEvent>) {
        merge_by_id(&mut self.events, incoming, |event| &event.id);
        self.events.retain(|event| !event.is_cancelled);
        self.events.sort_by_key(CalendarEvent::timestamp);
        self.events.truncate(MAX_EVENTS);
    }

    pub fn merge_chat_messages(&mut self, chat_id: &str, incoming: Vec<ChatMessage>) {
        let messages = self.chat_messages.entry(chat_id.to_string()).or_default();
        merge_by_id(messages, incoming, |message| &message.id);
        messages.retain(|message| !message.deleted);
        messages.sort_by_key(ChatMessage::timestamp);
        if messages.len() > MAX_MESSAGES_PER_CHAT {
            messages.drain(..messages.len() - MAX_MESSAGES_PER_CHAT);
        }
    }

    pub fn merge_channel_messages(&mut self, channel_key: &str, incoming: Vec<ChatMessage>) {
        let messages = self
            .channel_messages
            .entry(channel_key.to_string())
            .or_default();
        merge_by_id(messages, incoming, |message| &message.id);
        messages.retain(|message| !message.deleted);
        messages.sort_by_key(ChatMessage::timestamp);
        if messages.len() > MAX_MESSAGES_PER_CHAT {
            messages.drain(..messages.len() - MAX_MESSAGES_PER_CHAT);
        }
    }

    pub fn normalize(&mut self) {
        if self.version != CACHE_VERSION {
            *self = Self::default();
            return;
        }
        self.mail
            .sort_by_key(|message| std::cmp::Reverse(message.timestamp()));
        self.mail.truncate(MAX_MAIL);
        self.events.retain(|event| !event.is_cancelled);
        self.events.sort_by_key(CalendarEvent::timestamp);
        self.events.truncate(MAX_EVENTS);
        self.chats
            .sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        self.teams
            .sort_by(|left, right| left.display_name.cmp(&right.display_name));
        for messages in self
            .chat_messages
            .values_mut()
            .chain(self.channel_messages.values_mut())
        {
            messages.retain(|message| !message.deleted);
            messages.sort_by_key(ChatMessage::timestamp);
            if messages.len() > MAX_MESSAGES_PER_CHAT {
                messages.drain(..messages.len() - MAX_MESSAGES_PER_CHAT);
            }
        }
    }
}

impl remote_cli::Snapshot for CacheState {
    const APP_NAME: &'static str = "annum";
    const DISPLAY_NAME: &'static str = "Annum";
    const CACHE_DIR_ENV: &'static str = "ANNUM_CACHE_DIR";

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

fn merge_by_id<T: Clone, F>(current: &mut Vec<T>, incoming: Vec<T>, id: F)
where
    F: Fn(&T) -> &str,
{
    let incoming_ids = incoming
        .iter()
        .map(|item| id(item).to_string())
        .collect::<HashSet<_>>();
    current.retain(|item| !incoming_ids.contains(id(item)));
    current.extend(incoming);
}

fn parse_time(value: &str) -> i64 {
    DateTime::parse_from_rfc3339(value).map_or(0, |time| time.timestamp())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merging_replaces_existing_records_and_orders_them() {
        let mut state = CacheState::default();
        state.merge_mail(vec![MailMessage {
            id: "1".into(),
            subject: "old".into(),
            received_at: "2026-01-01T00:00:00Z".into(),
            ..MailMessage::default()
        }]);
        state.merge_mail(vec![
            MailMessage {
                id: "1".into(),
                subject: "new".into(),
                received_at: "2026-01-01T00:00:00Z".into(),
                ..MailMessage::default()
            },
            MailMessage {
                id: "2".into(),
                received_at: "2026-01-02T00:00:00Z".into(),
                ..MailMessage::default()
            },
        ]);
        assert_eq!(state.mail.len(), 2);
        assert_eq!(state.mail[0].id, "2");
        assert_eq!(state.mail[1].subject, "new");
    }

    #[test]
    fn chat_label_prefers_topic_then_members() {
        let chat = Chat {
            members: vec![Address {
                name: "Ada".into(),
                ..Address::default()
            }],
            ..Chat::default()
        };
        assert_eq!(chat.label(), "Ada");
    }
}
