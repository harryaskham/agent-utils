use std::fmt::Write as _;
use std::sync::{Arc, OnceLock};

use mcp_cli::{
    ErrorCategory, JsonEnvelope, McpServer, StdioServerConfig, StructuredError, ToolRouter,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;

use crate::cache::CacheStore;
use crate::config::{CollectorConfig, WorkIqConfig};
use crate::daemon;
use crate::model::{CacheState, CalendarEvent, Chat, ChatMessage, MailMessage, Team};
use crate::workiq::WorkIqClient;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 5_000;

#[derive(Clone)]
pub struct QueryRuntime {
    pub cache_store: CacheStore,
    pub use_cache: bool,
    pub use_daemon: bool,
    pub endpoint: String,
    pub token_path: std::path::PathBuf,
    pub fallback: bool,
    pub fallback_lease_path: std::path::PathBuf,
    pub workiq: WorkIqConfig,
    pub collector: CollectorConfig,
    workiq_client: Arc<OnceLock<WorkIqClient>>,
}

impl QueryRuntime {
    #[must_use]
    pub fn new(
        cache_store: CacheStore,
        use_cache: bool,
        use_daemon: bool,
        endpoint: String,
        token_path: std::path::PathBuf,
        fallback: bool,
        fallback_lease_path: std::path::PathBuf,
        workiq: WorkIqConfig,
        collector: CollectorConfig,
    ) -> Self {
        Self {
            cache_store,
            use_cache,
            use_daemon,
            endpoint,
            token_path,
            fallback,
            fallback_lease_path,
            workiq,
            collector,
            workiq_client: Arc::new(OnceLock::new()),
        }
    }

    fn workiq(&self) -> Result<&WorkIqClient, QueryError> {
        if self.workiq_client.get().is_none() {
            let client = WorkIqClient::start(&self.workiq)
                .map_err(|error| QueryError::WorkIq(format!("{error:#}")))?;
            let _ = self.workiq_client.set(client);
        }
        self.workiq_client
            .get()
            .ok_or_else(|| QueryError::WorkIq("WorkIQ client initialization raced".into()))
    }
}

#[derive(Debug, Error)]
pub enum QueryError {
    #[error("cache error: {0}")]
    Cache(String),
    #[error("daemon error: {0}")]
    Daemon(String),
    #[error("WorkIQ error: {0}")]
    WorkIq(String),
    #[error("{kind} not found: {id}")]
    NotFound { kind: &'static str, id: String },
    #[error("invalid query: {0}")]
    Validation(String),
    #[error("confirmation required for this Microsoft 365 mutation")]
    ConfirmationRequired,
    #[error("MCP error: {0}")]
    Mcp(String),
}

impl StructuredError for QueryError {
    fn category(&self) -> ErrorCategory {
        match self {
            Self::NotFound { .. } => ErrorCategory::TargetNotFound,
            Self::Validation(_) | Self::ConfirmationRequired => ErrorCategory::Validation,
            Self::Daemon(_) => ErrorCategory::PlatformAdapterFailure,
            Self::Cache(_) | Self::WorkIq(_) | Self::Mcp(_) => ErrorCategory::ExecutionFailure,
        }
    }
    fn code(&self) -> String {
        match self {
            Self::Cache(_) => "annum_cache_error",
            Self::Daemon(_) => "annum_daemon_error",
            Self::WorkIq(_) => "annum_workiq_error",
            Self::NotFound { .. } => "annum_not_found",
            Self::Validation(_) => "annum_validation_error",
            Self::ConfirmationRequired => "annum_confirmation_required",
            Self::Mcp(_) => "annum_mcp_error",
        }
        .into()
    }
    fn message(&self) -> String {
        self.to_string()
    }
}

#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct ListInput {
    pub limit: Option<usize>,
    pub query: Option<String>,
    pub unread_only: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct GetInput {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SearchInput {
    pub query: String,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct QueryMeta {
    pub account: String,
    pub revision: u64,
    pub saved_at: Option<i64>,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct MailListOutput {
    pub meta: QueryMeta,
    pub messages: Vec<MailMessage>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct MailGetOutput {
    pub meta: QueryMeta,
    pub message: MailMessage,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct CalendarListOutput {
    pub meta: QueryMeta,
    pub events: Vec<CalendarEvent>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct CalendarGetOutput {
    pub meta: QueryMeta,
    pub event: CalendarEvent,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ChatListOutput {
    pub meta: QueryMeta,
    pub chats: Vec<Chat>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ChatGetOutput {
    pub meta: QueryMeta,
    pub chat: Chat,
    pub messages: Vec<ChatMessage>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct TeamsOutput {
    pub meta: QueryMeta,
    pub teams: Vec<Team>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ChannelListInput {
    pub team_id: String,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ChannelGetInput {
    pub team_id: String,
    pub channel_id: String,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ChannelListOutput {
    pub meta: QueryMeta,
    pub team: Team,
    pub channels: Vec<crate::model::Channel>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct ChannelGetOutput {
    pub meta: QueryMeta,
    pub team: Team,
    pub channel: crate::model::Channel,
    pub messages: Vec<ChatMessage>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct SearchHit {
    pub kind: String,
    pub id: String,
    pub time: String,
    pub source: String,
    pub title: String,
    pub preview: String,
    pub url: String,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct SearchOutput {
    pub meta: QueryMeta,
    pub hits: Vec<SearchHit>,
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
pub struct MutationReceipt {
    pub accepted: bool,
    pub operation: String,
    pub target: String,
    pub refresh_queued: bool,
}

pub fn resolve_state(runtime: &QueryRuntime) -> Result<(CacheState, String), QueryError> {
    let cached = if runtime.use_cache {
        runtime
            .cache_store
            .load()
            .map_err(|error| QueryError::Cache(error.to_string()))?
    } else {
        CacheState::default()
    };
    if runtime.use_daemon {
        match remote_cli::fetch_json::<CacheState>(
            &runtime.endpoint,
            &runtime.token_path,
            "/snapshot",
        ) {
            Ok(state) => {
                if runtime.use_cache {
                    runtime
                        .cache_store
                        .save_exact(&state)
                        .map_err(|error| QueryError::Cache(error.to_string()))?;
                }
                return Ok((state, "daemon".into()));
            }
            Err(error) if !state_is_empty(&cached) => {
                return Ok((cached, format!("cache (daemon unavailable: {error})")));
            }
            Err(error) if !runtime.fallback => {
                return Err(QueryError::Daemon(error.to_string()));
            }
            Err(_) => {}
        }
    } else if !state_is_empty(&cached) {
        return Ok((cached, "cache".into()));
    }
    if runtime.fallback {
        let _lease = remote_cli::FallbackLease::try_acquire(&runtime.fallback_lease_path)
            .map_err(|error| QueryError::Cache(error.to_string()))?
            .ok_or_else(|| QueryError::Daemon("fallback collector is leased".into()))?;
        let state = daemon::sync_once(&runtime.cache_store, &runtime.workiq, &runtime.collector)
            .map_err(|error| QueryError::WorkIq(format!("{error:#}")))?;
        return Ok((state, "embedded fallback".into()));
    }
    Ok((cached, "cache".into()))
}

fn state_is_empty(state: &CacheState) -> bool {
    state.account.id.is_empty()
        && state.mail.is_empty()
        && state.events.is_empty()
        && state.chats.is_empty()
        && state.teams.is_empty()
}

fn meta(state: &CacheState, source: String) -> QueryMeta {
    QueryMeta {
        account: if state.account.mail.is_empty() {
            state.account.user_principal_name.clone()
        } else {
            state.account.mail.clone()
        },
        revision: state.collector.revision,
        saved_at: state.saved_at,
        source,
    }
}

fn limit(value: Option<usize>) -> usize {
    value.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn contains(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

pub fn mail_list(runtime: &QueryRuntime, input: &ListInput) -> Result<MailListOutput, QueryError> {
    let (state, source) = resolve_state(runtime)?;
    let query = input.query.as_deref().filter(|value| !value.is_empty());
    let messages = state
        .mail
        .iter()
        .filter(|message| !input.unread_only.unwrap_or(false) || !message.is_read)
        .filter(|message| {
            query.is_none_or(|query| {
                contains(&message.subject, query)
                    || contains(&message.from.name, query)
                    || contains(&message.from.address, query)
                    || contains(&message.body_preview, query)
            })
        })
        .take(limit(input.limit))
        .cloned()
        .collect();
    Ok(MailListOutput {
        meta: meta(&state, source),
        messages,
    })
}

pub fn mail_get(runtime: &QueryRuntime, input: &GetInput) -> Result<MailGetOutput, QueryError> {
    let (state, source) = resolve_state(runtime)?;
    let message = state
        .mail
        .iter()
        .find(|message| message.id == input.id)
        .cloned()
        .ok_or_else(|| QueryError::NotFound {
            kind: "email",
            id: input.id.clone(),
        })?;
    Ok(MailGetOutput {
        meta: meta(&state, source),
        message,
    })
}

pub fn calendar_list(
    runtime: &QueryRuntime,
    input: &ListInput,
) -> Result<CalendarListOutput, QueryError> {
    let (state, source) = resolve_state(runtime)?;
    let query = input.query.as_deref().filter(|value| !value.is_empty());
    let events = state
        .events
        .iter()
        .filter(|event| {
            query.is_none_or(|query| {
                contains(&event.subject, query)
                    || contains(&event.organizer.name, query)
                    || contains(&event.location, query)
                    || contains(&event.body_preview, query)
            })
        })
        .take(limit(input.limit))
        .cloned()
        .collect();
    Ok(CalendarListOutput {
        meta: meta(&state, source),
        events,
    })
}

pub fn calendar_get(
    runtime: &QueryRuntime,
    input: &GetInput,
) -> Result<CalendarGetOutput, QueryError> {
    let (state, source) = resolve_state(runtime)?;
    let event = state
        .events
        .iter()
        .find(|event| event.id == input.id)
        .cloned()
        .ok_or_else(|| QueryError::NotFound {
            kind: "event",
            id: input.id.clone(),
        })?;
    Ok(CalendarGetOutput {
        meta: meta(&state, source),
        event,
    })
}

pub fn chat_list(runtime: &QueryRuntime, input: &ListInput) -> Result<ChatListOutput, QueryError> {
    let (state, source) = resolve_state(runtime)?;
    let query = input.query.as_deref().filter(|value| !value.is_empty());
    let chats = state
        .chats
        .iter()
        .filter(|chat| query.is_none_or(|query| contains(&chat.label(), query)))
        .take(limit(input.limit))
        .cloned()
        .collect();
    Ok(ChatListOutput {
        meta: meta(&state, source),
        chats,
    })
}

pub fn chat_get(runtime: &QueryRuntime, input: &GetInput) -> Result<ChatGetOutput, QueryError> {
    let (state, source) = resolve_state(runtime)?;
    let chat = state
        .chats
        .iter()
        .find(|chat| chat.id == input.id)
        .cloned()
        .ok_or_else(|| QueryError::NotFound {
            kind: "chat",
            id: input.id.clone(),
        })?;
    let messages = state
        .chat_messages
        .get(&input.id)
        .cloned()
        .unwrap_or_default();
    Ok(ChatGetOutput {
        meta: meta(&state, source),
        chat,
        messages,
    })
}

pub fn teams(runtime: &QueryRuntime, input: &ListInput) -> Result<TeamsOutput, QueryError> {
    let (state, source) = resolve_state(runtime)?;
    let query = input.query.as_deref().filter(|value| !value.is_empty());
    let teams = state
        .teams
        .iter()
        .filter(|team| query.is_none_or(|query| contains(&team.display_name, query)))
        .take(limit(input.limit))
        .cloned()
        .collect();
    Ok(TeamsOutput {
        meta: meta(&state, source),
        teams,
    })
}

pub fn channel_list(
    runtime: &QueryRuntime,
    input: &ChannelListInput,
) -> Result<ChannelListOutput, QueryError> {
    let (state, source) = resolve_state(runtime)?;
    let team = state
        .teams
        .iter()
        .find(|team| team.id == input.team_id)
        .cloned()
        .ok_or_else(|| QueryError::NotFound {
            kind: "team",
            id: input.team_id.clone(),
        })?;
    let channels = state
        .channels
        .get(&input.team_id)
        .into_iter()
        .flatten()
        .take(limit(input.limit))
        .cloned()
        .collect();
    Ok(ChannelListOutput {
        meta: meta(&state, source),
        team,
        channels,
    })
}

pub fn channel_get(
    runtime: &QueryRuntime,
    input: &ChannelGetInput,
) -> Result<ChannelGetOutput, QueryError> {
    let (state, source) = resolve_state(runtime)?;
    let team = state
        .teams
        .iter()
        .find(|team| team.id == input.team_id)
        .cloned()
        .ok_or_else(|| QueryError::NotFound {
            kind: "team",
            id: input.team_id.clone(),
        })?;
    let channel = state
        .channels
        .get(&input.team_id)
        .into_iter()
        .flatten()
        .find(|channel| channel.id == input.channel_id)
        .cloned()
        .ok_or_else(|| QueryError::NotFound {
            kind: "channel",
            id: input.channel_id.clone(),
        })?;
    let key = format!("channel:{}:{}", input.team_id, input.channel_id);
    let messages = state
        .channel_messages
        .get(&key)
        .cloned()
        .unwrap_or_default();
    Ok(ChannelGetOutput {
        meta: meta(&state, source),
        team,
        channel,
        messages,
    })
}

pub fn search(runtime: &QueryRuntime, input: &SearchInput) -> Result<SearchOutput, QueryError> {
    if input.query.trim().is_empty() {
        return Err(QueryError::Validation(
            "search query cannot be empty".into(),
        ));
    }
    let (state, source) = resolve_state(runtime)?;
    let mut hits = Vec::new();
    for message in &state.mail {
        if contains(&message.subject, &input.query)
            || contains(&message.body_preview, &input.query)
            || contains(&message.from.name, &input.query)
        {
            hits.push(SearchHit {
                kind: "email".into(),
                id: message.id.clone(),
                time: message.received_at.clone(),
                source: message.from.name.clone(),
                title: message.subject.clone(),
                preview: message.body_preview.clone(),
                url: message.web_link.clone(),
            });
        }
    }
    for event in &state.events {
        if contains(&event.subject, &input.query)
            || contains(&event.body_preview, &input.query)
            || contains(&event.location, &input.query)
        {
            hits.push(SearchHit {
                kind: "event".into(),
                id: event.id.clone(),
                time: event.start.clone(),
                source: event.organizer.name.clone(),
                title: event.subject.clone(),
                preview: event.body_preview.clone(),
                url: event.web_link.clone(),
            });
        }
    }
    for chat in &state.chats {
        for message in state.chat_messages.get(&chat.id).into_iter().flatten() {
            if contains(&message.body_markdown, &input.query)
                || contains(&message.from.name, &input.query)
            {
                hits.push(SearchHit {
                    kind: "chat".into(),
                    id: message.id.clone(),
                    time: message.created_at.clone(),
                    source: chat.label(),
                    title: message.from.name.clone(),
                    preview: message.body_markdown.clone(),
                    url: message.web_url.clone(),
                });
            }
        }
    }
    hits.sort_by(|left, right| right.time.cmp(&left.time));
    hits.truncate(limit(input.limit));
    Ok(SearchOutput {
        meta: meta(&state, source),
        hits,
    })
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SendMailInput {
    pub to: Vec<String>,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ReplyMailInput {
    pub id: String,
    pub body: String,
    #[serde(default)]
    pub reply_all: bool,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct MarkReadInput {
    pub id: String,
    #[serde(default = "default_true")]
    pub read: bool,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct CreateEventInput {
    pub subject: String,
    pub start: String,
    pub end: String,
    #[serde(default = "default_timezone")]
    pub timezone: String,
    pub attendees: Vec<String>,
    pub body: Option<String>,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct RespondEventInput {
    pub id: String,
    /// `accept`, `tentativelyAccept`, or `decline`.
    pub response: String,
    pub comment: Option<String>,
    #[serde(default = "default_true")]
    pub send_response: bool,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SendChatInput {
    pub chat_id: String,
    pub body: String,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct CopilotAskInput {
    pub question: String,
    pub conversation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SemanticSearchInput {
    pub query: Vec<String>,
}

fn default_true() -> bool {
    true
}
fn default_timezone() -> String {
    "UTC".into()
}
fn require_confirmation(confirmed: bool) -> Result<(), QueryError> {
    if confirmed {
        Ok(())
    } else {
        Err(QueryError::ConfirmationRequired)
    }
}

fn queue_refresh(runtime: &QueryRuntime, domain: &str) -> bool {
    runtime.use_daemon
        && remote_cli::request_refresh(&runtime.endpoint, &runtime.token_path, domain).is_ok()
}

pub fn send_mail(
    runtime: &QueryRuntime,
    input: &SendMailInput,
) -> Result<MutationReceipt, QueryError> {
    require_confirmation(input.confirmed)?;
    if input.to.is_empty() || input.subject.trim().is_empty() {
        return Err(QueryError::Validation(
            "mail requires at least one recipient and a subject".into(),
        ));
    }
    runtime
        .workiq()?
        .action(
            "/me/sendMail",
            json!({
                "message": {
                    "subject": input.subject,
                    "body": {"contentType":"Text", "content":input.body},
                    "toRecipients": input.to.iter().map(|address| json!({"emailAddress":{"address":address}})).collect::<Vec<_>>()
                },
                "saveToSentItems": true
            }),
        )
        .map_err(|error| QueryError::WorkIq(format!("{error:#}")))?;
    Ok(MutationReceipt {
        accepted: true,
        operation: "send-mail".into(),
        target: input.to.join(","),
        refresh_queued: queue_refresh(runtime, "mail:sentitems"),
    })
}

pub fn reply_mail(
    runtime: &QueryRuntime,
    input: &ReplyMailInput,
) -> Result<MutationReceipt, QueryError> {
    require_confirmation(input.confirmed)?;
    let action = if input.reply_all { "replyAll" } else { "reply" };
    runtime
        .workiq()?
        .action(
            &format!("/me/messages/{}/{action}", encode_segment(&input.id)),
            json!({"comment": input.body}),
        )
        .map_err(|error| QueryError::WorkIq(format!("{error:#}")))?;
    Ok(MutationReceipt {
        accepted: true,
        operation: action.into(),
        target: input.id.clone(),
        refresh_queued: queue_refresh(runtime, "mail:inbox"),
    })
}

pub fn mark_read(
    runtime: &QueryRuntime,
    input: &MarkReadInput,
) -> Result<MutationReceipt, QueryError> {
    require_confirmation(input.confirmed)?;
    runtime
        .workiq()?
        .update(
            &format!("/me/messages/{}", encode_segment(&input.id)),
            json!({"isRead": input.read}),
        )
        .map_err(|error| QueryError::WorkIq(format!("{error:#}")))?;
    Ok(MutationReceipt {
        accepted: true,
        operation: if input.read {
            "mark-read"
        } else {
            "mark-unread"
        }
        .into(),
        target: input.id.clone(),
        refresh_queued: queue_refresh(runtime, "mail:inbox"),
    })
}

pub fn create_event(
    runtime: &QueryRuntime,
    input: &CreateEventInput,
) -> Result<MutationReceipt, QueryError> {
    require_confirmation(input.confirmed)?;
    runtime
        .workiq()?
        .create(
            "/me/events",
            json!({
                "subject": input.subject,
                "start": {"dateTime": input.start, "timeZone": input.timezone},
                "end": {"dateTime": input.end, "timeZone": input.timezone},
                "body": {"contentType":"Text", "content":input.body.clone().unwrap_or_default()},
                "attendees": input.attendees.iter().map(|address| json!({"emailAddress":{"address":address},"type":"required"})).collect::<Vec<_>>()
            }),
        )
        .map_err(|error| QueryError::WorkIq(format!("{error:#}")))?;
    Ok(MutationReceipt {
        accepted: true,
        operation: "create-event".into(),
        target: input.subject.clone(),
        refresh_queued: queue_refresh(runtime, "calendar"),
    })
}

pub fn respond_event(
    runtime: &QueryRuntime,
    input: &RespondEventInput,
) -> Result<MutationReceipt, QueryError> {
    require_confirmation(input.confirmed)?;
    if !matches!(
        input.response.as_str(),
        "accept" | "tentativelyAccept" | "decline"
    ) {
        return Err(QueryError::Validation(
            "response must be accept, tentativelyAccept, or decline".into(),
        ));
    }
    runtime
        .workiq()?
        .action(
            &format!(
                "/me/events/{}/{}",
                encode_segment(&input.id),
                input.response
            ),
            json!({
                "comment": input.comment.clone().unwrap_or_default(),
                "sendResponse": input.send_response
            }),
        )
        .map_err(|error| QueryError::WorkIq(format!("{error:#}")))?;
    Ok(MutationReceipt {
        accepted: true,
        operation: input.response.clone(),
        target: input.id.clone(),
        refresh_queued: queue_refresh(runtime, "calendar"),
    })
}

pub fn send_chat(
    runtime: &QueryRuntime,
    input: &SendChatInput,
) -> Result<MutationReceipt, QueryError> {
    require_confirmation(input.confirmed)?;
    runtime
        .workiq()?
        .create(
            &format!("/me/chats/{}/messages", encode_segment(&input.chat_id)),
            json!({"body":{"contentType":"text","content":input.body}}),
        )
        .map_err(|error| QueryError::WorkIq(format!("{error:#}")))?;
    Ok(MutationReceipt {
        accepted: true,
        operation: "send-chat".into(),
        target: input.chat_id.clone(),
        refresh_queued: queue_refresh(runtime, &format!("chat:{}", input.chat_id)),
    })
}

pub fn copilot_ask(
    runtime: &QueryRuntime,
    input: &CopilotAskInput,
) -> Result<serde_json::Value, QueryError> {
    if input.question.trim().is_empty() {
        return Err(QueryError::Validation("question cannot be empty".into()));
    }
    runtime
        .workiq()?
        .ask(&input.question, input.conversation_id.as_deref())
        .map_err(|error| QueryError::WorkIq(format!("{error:#}")))
}

pub fn semantic_search(
    runtime: &QueryRuntime,
    input: &SemanticSearchInput,
) -> Result<serde_json::Value, QueryError> {
    if input.query.iter().all(|query| query.trim().is_empty()) {
        return Err(QueryError::Validation("query cannot be empty".into()));
    }
    runtime
        .workiq()?
        .retrieve(input.query.clone())
        .map_err(|error| QueryError::WorkIq(format!("{error:#}")))
}

fn encode_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[must_use]
pub fn build_mcp_server() -> McpServer<QueryRuntime> {
    let mut router = ToolRouter::new();
    router.add_typed_tool(
        "annum_email_list",
        "List deterministic cached Outlook mail.",
        |runtime, input: ListInput| mail_list(runtime, &input),
    );
    router.add_typed_tool(
        "annum_email_get",
        "Get one cached Outlook message by id.",
        |runtime, input: GetInput| mail_get(runtime, &input),
    );
    router.add_typed_tool(
        "annum_calendar_list",
        "List deterministic cached Outlook calendar events.",
        |runtime, input: ListInput| calendar_list(runtime, &input),
    );
    router.add_typed_tool(
        "annum_calendar_get",
        "Get one deterministic cached Outlook calendar event.",
        |runtime, input: GetInput| calendar_get(runtime, &input),
    );
    router.add_typed_tool(
        "annum_chat_list",
        "List deterministic cached Teams chats.",
        |runtime, input: ListInput| chat_list(runtime, &input),
    );
    router.add_typed_tool(
        "annum_chat_get",
        "Get one Teams chat and cached messages.",
        |runtime, input: GetInput| chat_get(runtime, &input),
    );
    router.add_typed_tool(
        "annum_teams_list",
        "List joined Teams.",
        |runtime, input: ListInput| teams(runtime, &input),
    );
    router.add_typed_tool(
        "annum_channel_list",
        "List cached channels for one joined Team.",
        |runtime, input: ChannelListInput| channel_list(runtime, &input),
    );
    router.add_typed_tool(
        "annum_channel_get",
        "Get one Teams channel and deterministic cached messages.",
        |runtime, input: ChannelGetInput| channel_get(runtime, &input),
    );
    router.add_typed_tool(
        "annum_search",
        "Deterministically search the local Outlook/Teams cache.",
        |runtime, input: SearchInput| search(runtime, &input),
    );
    router.add_typed_tool(
        "annum_email_send",
        "Send Outlook mail. Requires confirmed=true.",
        |runtime, input: SendMailInput| send_mail(runtime, &input),
    );
    router.add_typed_tool(
        "annum_email_reply",
        "Reply to Outlook mail. Requires confirmed=true.",
        |runtime, input: ReplyMailInput| reply_mail(runtime, &input),
    );
    router.add_typed_tool(
        "annum_email_mark_read",
        "Mark Outlook mail read/unread. Requires confirmed=true.",
        |runtime, input: MarkReadInput| mark_read(runtime, &input),
    );
    router.add_typed_tool(
        "annum_calendar_create",
        "Create an Outlook event. Requires confirmed=true.",
        |runtime, input: CreateEventInput| create_event(runtime, &input),
    );
    router.add_typed_tool(
        "annum_calendar_respond",
        "Respond to an Outlook event. Requires confirmed=true.",
        |runtime, input: RespondEventInput| respond_event(runtime, &input),
    );
    router.add_typed_tool(
        "annum_chat_send",
        "Send a Teams chat message. Requires confirmed=true.",
        |runtime, input: SendChatInput| send_chat(runtime, &input),
    );
    router.add_typed_tool(
        "annum_copilot_ask",
        "Explicitly ask Microsoft 365 Copilot; not used by deterministic sync/query surfaces.",
        |runtime, input: CopilotAskInput| copilot_ask(runtime, &input),
    );
    router.add_typed_tool(
        "annum_semantic_search",
        "Explicit WorkIQ semantic M365 retrieval with citations.",
        |runtime, input: SemanticSearchInput| semantic_search(runtime, &input),
    );
    configurable_cli::register_config_tools(&mut router, |_runtime: &QueryRuntime| {
        crate::config::manager()
    });
    McpServer::new(
        StdioServerConfig {
            server_name: "annum".into(),
            server_version: env!("CARGO_PKG_VERSION").into(),
        },
        router,
    )
}

pub fn serve_mcp(runtime: &QueryRuntime) -> Result<(), QueryError> {
    build_mcp_server()
        .serve_stdio(runtime)
        .map_err(|error| QueryError::Mcp(error.to_string()))
}

pub fn json_output<T: Serialize>(command: &str, output: &T) -> Result<String, QueryError> {
    serde_json::to_string_pretty(&JsonEnvelope::success_for(command, output))
        .map_err(|error| QueryError::Validation(error.to_string()))
}

#[must_use]
pub fn render_mail(output: &MailListOutput) -> String {
    let mut text = String::new();
    for message in &output.messages {
        let _ = writeln!(
            text,
            "{}\t{}\t{}\t{}",
            message.id,
            if message.is_read { "read" } else { "unread" },
            if message.from.name.is_empty() {
                &message.from.address
            } else {
                &message.from.name
            },
            message.subject
        );
    }
    if text.is_empty() {
        text.push_str("No email.\n");
    }
    text
}

#[must_use]
pub fn render_events(output: &CalendarListOutput) -> String {
    let mut text = String::new();
    for event in &output.events {
        let _ = writeln!(
            text,
            "{}\t{}\t{}\t{}",
            event.id, event.start, event.subject, event.location
        );
    }
    if text.is_empty() {
        text.push_str("No events.\n");
    }
    text
}

#[must_use]
pub fn render_chats(output: &ChatListOutput) -> String {
    let mut text = String::new();
    for chat in &output.chats {
        let _ = writeln!(text, "{}\t{}\t{}", chat.id, chat.chat_type, chat.label());
    }
    if text.is_empty() {
        text.push_str("No chats.\n");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Address, MailMessage};

    fn runtime_with(state: CacheState) -> (tempfile::TempDir, QueryRuntime) {
        let dir = tempfile::tempdir().unwrap();
        let store = CacheStore::new(dir.path().join("state.json"));
        store.save(&state).unwrap();
        let runtime = QueryRuntime::new(
            store,
            true,
            false,
            "http://127.0.0.1:1".into(),
            dir.path().join("token"),
            false,
            dir.path().join("lease"),
            WorkIqConfig::default(),
            CollectorConfig::default(),
        );
        (dir, runtime)
    }

    #[test]
    fn deterministic_mail_filter_never_calls_workiq() {
        let mut state = CacheState::default();
        state.mail.push(MailMessage {
            id: "m1".into(),
            subject: "Quarterly plan".into(),
            from: Address {
                name: "Ada".into(),
                ..Address::default()
            },
            ..MailMessage::default()
        });
        let (_dir, runtime) = runtime_with(state);
        let output = mail_list(
            &runtime,
            &ListInput {
                query: Some("quarter".into()),
                ..ListInput::default()
            },
        )
        .unwrap();
        assert_eq!(output.messages.len(), 1);
    }

    #[test]
    fn channel_queries_keep_team_provenance() {
        let mut state = CacheState::default();
        state.teams.push(Team {
            id: "t1".into(),
            display_name: "Engineering".into(),
            ..Team::default()
        });
        state.channels.insert(
            "t1".into(),
            vec![crate::model::Channel {
                id: "c1".into(),
                team_id: "t1".into(),
                display_name: "General".into(),
                ..crate::model::Channel::default()
            }],
        );
        let (_dir, runtime) = runtime_with(state);
        let output = channel_get(
            &runtime,
            &ChannelGetInput {
                team_id: "t1".into(),
                channel_id: "c1".into(),
            },
        )
        .unwrap();
        assert_eq!(output.team.display_name, "Engineering");
        assert_eq!(output.channel.display_name, "General");
    }

    #[test]
    fn writes_fail_closed_without_confirmation() {
        let (_dir, runtime) = runtime_with(CacheState::default());
        let error = send_mail(
            &runtime,
            &SendMailInput {
                to: vec!["a@example.com".into()],
                subject: "Hi".into(),
                body: "Body".into(),
                confirmed: false,
            },
        )
        .unwrap_err();
        assert!(matches!(error, QueryError::ConfirmationRequired));
    }

    #[test]
    fn mcp_router_has_deterministic_and_explicit_copilot_tools() {
        let names = build_mcp_server()
            .tool_metadata()
            .into_iter()
            .map(|tool| tool.name)
            .collect::<Vec<_>>();
        for expected in [
            "annum_email_list",
            "annum_calendar_list",
            "annum_chat_list",
            "annum_channel_list",
            "annum_channel_get",
            "annum_search",
            "annum_copilot_ask",
            "config_validate",
        ] {
            assert!(
                names.iter().any(|name| name == expected),
                "missing {expected}"
            );
        }
    }
}
