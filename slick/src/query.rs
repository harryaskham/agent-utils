//! Shared terse query surface for CLI commands and MCP tools.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::thread;
use std::time::{Duration, Instant};

use mcp_cli::{
    ErrorCategory, JsonEnvelope, McpServer, StdioServerConfig, StructuredError, ToolRouter,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::cache::CacheStore;
use crate::client::FallbackLease;
use crate::model::{
    CacheState, Conversation, ConversationKind, Message, Notification, RefreshState, SlackFile,
};
use crate::slack::{IncompleteCoverage, SlackService};

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 5_000;
const DAEMON_WAIT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug)]
pub struct QueryRuntime {
    pub cache_store: CacheStore,
    pub use_cache: bool,
    pub use_daemon: bool,
    pub endpoint: String,
    pub token_path: std::path::PathBuf,
    pub fallback: bool,
    pub fallback_lease_path: std::path::PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Surface {
    Feed,
    Activity,
    Dms,
    Channels,
    Files,
    Conversation(String),
    File(String),
}

impl Surface {
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::Feed => "feed",
            Self::Activity => "activity",
            Self::Dms => "dms",
            Self::Channels => "channels",
            Self::Files => "files",
            Self::Conversation(_) => "conversation",
            Self::File(_) => "file",
        }
    }

    fn snapshot_path(&self) -> String {
        match self {
            Self::Conversation(id) => format!("/snapshot/conversation?id={}", encode(id)),
            Self::File(id) => format!("/snapshot/file?id={}", encode(id)),
            _ => format!("/snapshot/{}", self.name()),
        }
    }

    fn refresh_domain(&self) -> String {
        match self {
            Self::Feed | Self::Activity => "notifications".into(),
            Self::Dms | Self::Channels => "sidebar".into(),
            Self::Files => "files".into(),
            Self::Conversation(id) => format!("conversation:{id}"),
            Self::File(id) => format!("file-content:{id}"),
        }
    }
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ProjectionSnapshot {
    pub surface: String,
    pub state: CacheState,
}

#[derive(Debug, Error)]
pub enum QueryError {
    #[error("cache error: {0}")]
    Cache(String),
    #[error("daemon error: {0}")]
    Daemon(String),
    #[error("{kind} not found: {id}")]
    NotFound { kind: &'static str, id: String },
    #[error("invalid query: {0}")]
    Validation(String),
    #[error("MCP error: {0}")]
    Mcp(String),
}

impl StructuredError for QueryError {
    fn category(&self) -> ErrorCategory {
        match self {
            Self::NotFound { .. } => ErrorCategory::TargetNotFound,
            Self::Validation(_) => ErrorCategory::Validation,
            Self::Cache(_) | Self::Mcp(_) => ErrorCategory::ExecutionFailure,
            Self::Daemon(_) => ErrorCategory::PlatformAdapterFailure,
        }
    }

    fn code(&self) -> String {
        match self {
            Self::Cache(_) => "slick_cache_error",
            Self::Daemon(_) => "slick_daemon_error",
            Self::NotFound { .. } => "slick_not_found",
            Self::Validation(_) => "slick_validation_error",
            Self::Mcp(_) => "slick_mcp_error",
        }
        .into()
    }

    fn message(&self) -> String {
        self.to_string()
    }
}

#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct ListInput {
    /// Maximum records to return (default 100, maximum 5000).
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct GetInput {
    /// Slack conversation or file id.
    pub id: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct QueryMeta {
    pub surface: String,
    pub team_id: String,
    pub team_name: String,
    pub revision: u64,
    pub saved_at: Option<i64>,
    pub refreshed_at: Option<i64>,
    pub refresh_state: RefreshState,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConversationSummary {
    pub id: String,
    pub name: String,
    pub kind: ConversationKind,
    pub unread: u32,
    pub mentions: u32,
    pub favorite: bool,
    pub latest_ts: Option<String>,
    pub cached_messages: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct TerseMessage {
    pub ts: String,
    pub time: String,
    pub from: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_ts: Option<String>,
    #[serde(skip_serializing_if = "is_zero")]
    pub replies: u32,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub permalink: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub file_ids: Vec<String>,
}

#[allow(clippy::trivially_copy_pass_by_ref)]
const fn is_zero(value: &u32) -> bool {
    *value == 0
}

#[derive(Clone, Debug, Serialize)]
pub struct ActivityGroup {
    pub conversation: ConversationSummary,
    pub messages: Vec<TerseMessage>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ActivityOutput {
    pub meta: QueryMeta,
    pub groups: Vec<ActivityGroup>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FeedRecord {
    pub key: String,
    pub time: String,
    pub source: String,
    pub summary: String,
    pub mention: bool,
    pub unread: bool,
    pub target_kind: String,
    pub target_id: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct FeedOutput {
    pub meta: QueryMeta,
    pub items: Vec<FeedRecord>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConversationListOutput {
    pub meta: QueryMeta,
    pub conversations: Vec<ConversationSummary>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConversationGetOutput {
    pub meta: QueryMeta,
    pub conversation: ConversationSummary,
    pub messages: Vec<TerseMessage>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FileSummary {
    pub id: String,
    pub title: String,
    pub file_type: String,
    pub author: String,
    pub updated_at: String,
    pub size_bytes: u64,
    pub provenance: Vec<String>,
    pub content_status: String,
    pub permalink: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct FileListOutput {
    pub meta: QueryMeta,
    pub files: Vec<FileSummary>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FileGetOutput {
    pub meta: QueryMeta,
    pub file: FileSummary,
    pub markdown: String,
}

pub fn resolve_state(runtime: &QueryRuntime, surface: &Surface) -> Result<CacheState, QueryError> {
    let cached = if runtime.use_cache && runtime.cache_store.path().exists() {
        Some(
            runtime
                .cache_store
                .load()
                .map_err(|error| QueryError::Cache(error.to_string()))?,
        )
    } else {
        None
    };
    if cached
        .as_ref()
        .is_some_and(|state| surface_available(state, surface))
    {
        return Ok(cached.expect("checked above"));
    }

    let daemon_result = if runtime.use_daemon {
        resolve_from_daemon(runtime, surface, cached.clone())
    } else {
        Err(QueryError::Daemon("daemon disabled".into()))
    };
    match daemon_result {
        Ok(state) => Ok(state),
        Err(error) if runtime.fallback && (!runtime.use_cache || runtime.use_daemon) => {
            resolve_from_fallback(runtime, surface, cached).map_err(|fallback| {
                QueryError::Daemon(format!("{error}; fallback failed: {fallback}"))
            })
        }
        Err(error) => Err(error),
    }
}

fn resolve_from_daemon(
    runtime: &QueryRuntime,
    surface: &Surface,
    cached: Option<CacheState>,
) -> Result<CacheState, QueryError> {
    let mut projection = fetch_projection(runtime, surface)?;
    if !surface_available(&projection.state, surface) {
        request_daemon_refresh(runtime, surface)?;
        let deadline = Instant::now() + DAEMON_WAIT;
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(250));
            projection = fetch_projection(runtime, surface)?;
            if surface_available(&projection.state, surface) {
                break;
            }
        }
    }
    if !surface_available(&projection.state, surface) {
        return Err(QueryError::Daemon(format!(
            "{} remained unavailable after daemon refresh timeout",
            surface.name()
        )));
    }
    if runtime.use_cache {
        let mut merged = cached.unwrap_or_default();
        apply_projection(&mut merged, &projection);
        runtime
            .cache_store
            .save_exact(&merged)
            .map_err(|error| QueryError::Cache(error.to_string()))?;
        Ok(merged)
    } else {
        Ok(projection.state)
    }
}

fn resolve_from_fallback(
    runtime: &QueryRuntime,
    surface: &Surface,
    cached: Option<CacheState>,
) -> Result<CacheState, QueryError> {
    let _lease = FallbackLease::try_acquire(&runtime.fallback_lease_path)
        .map_err(|error| QueryError::Cache(error.to_string()))?
        .ok_or_else(|| {
            QueryError::Daemon("fallback collector is leased by another client".into())
        })?;
    let service =
        SlackService::from_environment().map_err(|error| QueryError::Daemon(error.to_string()))?;
    let mut state = cached.unwrap_or_default();
    if state.self_user_id.is_empty() {
        service
            .refresh_identity(&mut state)
            .map_err(|error| QueryError::Daemon(error.to_string()))?;
    }
    if (state.conversations.is_empty() && !matches!(surface, Surface::Files | Surface::File(_)))
        || matches!(surface, Surface::Conversation(id) if state.conversation(id).is_none())
    {
        service
            .refresh_sidebar(&mut state)
            .map_err(|error| QueryError::Daemon(error.to_string()))?;
    }
    match surface {
        Surface::Activity => run_paged(|| service.refresh_notifications(&mut state))?,
        Surface::Feed => {
            run_paged(|| service.refresh_notifications(&mut state))?;
            run_paged(|| service.refresh_files(&mut state))?;
        }
        Surface::Dms | Surface::Channels => service
            .refresh_sidebar(&mut state)
            .map_err(|error| QueryError::Daemon(error.to_string()))?,
        Surface::Files => run_paged(|| service.refresh_files(&mut state))?,
        Surface::Conversation(id) => run_paged(|| service.refresh_conversation(&mut state, id))?,
        Surface::File(id) => {
            if !state.files.iter().any(|file| file.id == *id) {
                run_paged(|| service.refresh_files(&mut state))?;
            }
            service
                .load_file_content(&mut state, id)
                .map_err(|error| QueryError::Daemon(error.to_string()))?;
        }
    }
    state.normalize();
    state.saved_at = Some(CacheState::now());
    if runtime.use_cache {
        runtime
            .cache_store
            .save(&state)
            .map_err(|error| QueryError::Cache(error.to_string()))?;
    }
    Ok(state)
}

fn run_paged(mut refresh: impl FnMut() -> anyhow::Result<()>) -> Result<(), QueryError> {
    let deadline = Instant::now() + DAEMON_WAIT;
    loop {
        match refresh() {
            Ok(()) => return Ok(()),
            Err(error) if error.downcast_ref::<IncompleteCoverage>().is_some() => {
                if Instant::now() >= deadline {
                    return Err(QueryError::Daemon(error.to_string()));
                }
                thread::sleep(Duration::from_secs(2));
            }
            Err(error) => return Err(QueryError::Daemon(error.to_string())),
        }
    }
}

fn fetch_projection(
    runtime: &QueryRuntime,
    surface: &Surface,
) -> Result<ProjectionSnapshot, QueryError> {
    remote_cli::fetch_json(
        &runtime.endpoint,
        &runtime.token_path,
        &surface.snapshot_path(),
    )
    .map_err(|error| QueryError::Daemon(error.to_string()))
}

fn request_daemon_refresh(runtime: &QueryRuntime, surface: &Surface) -> Result<(), QueryError> {
    remote_cli::request_refresh(
        &runtime.endpoint,
        &runtime.token_path,
        &surface.refresh_domain(),
    )
    .map_err(|error| QueryError::Daemon(error.to_string()))
}

#[must_use]
pub fn project_state(state: &CacheState, surface: &Surface) -> ProjectionSnapshot {
    let mut projected = state.clone();
    projected.users.clear();
    projected.search_progress.clear();
    match surface {
        Surface::Activity => {
            projected.files.clear();
            projected.messages.clear();
            projected.threads.clear();
            retain_notification_conversations(&mut projected);
        }
        Surface::Feed => {
            projected.messages.clear();
            projected.threads.clear();
            retain_notification_conversations(&mut projected);
        }
        Surface::Dms => {
            projected
                .conversations
                .retain(|conversation| conversation.kind.is_dm());
            let ids: std::collections::HashSet<_> = projected
                .conversations
                .iter()
                .map(|conversation| conversation.id.clone())
                .collect();
            projected.messages.retain(|id, _| ids.contains(id));
            projected.notifications.clear();
            projected.files.clear();
        }
        Surface::Channels => {
            projected
                .conversations
                .retain(|conversation| !conversation.kind.is_dm());
            let ids: std::collections::HashSet<_> = projected
                .conversations
                .iter()
                .map(|conversation| conversation.id.clone())
                .collect();
            projected.messages.retain(|id, _| ids.contains(id));
            projected.notifications.clear();
            projected.files.clear();
        }
        Surface::Files => {
            projected.conversations.clear();
            projected.messages.clear();
            projected.threads.clear();
            projected.notifications.clear();
        }
        Surface::Conversation(id) => {
            projected
                .conversations
                .retain(|conversation| conversation.id == *id);
            projected.messages.retain(|key, _| key == id);
            projected
                .threads
                .retain(|key, _| key.starts_with(&format!("{id}:")));
            projected.notifications.clear();
            projected.files.clear();
        }
        Surface::File(id) => {
            projected.files.retain(|file| file.id == *id);
            projected.conversations.clear();
            projected.messages.clear();
            projected.threads.clear();
            projected.notifications.clear();
        }
    }
    ProjectionSnapshot {
        surface: surface.name().into(),
        state: projected,
    }
}

fn retain_notification_conversations(state: &mut CacheState) {
    let ids: std::collections::HashSet<_> = state
        .notifications
        .iter()
        .map(|notification| notification.conversation_id.clone())
        .collect();
    state
        .conversations
        .retain(|conversation| ids.contains(&conversation.id));
}

pub fn apply_projection(target: &mut CacheState, projection: &ProjectionSnapshot) {
    let incoming = &projection.state;
    if !incoming.team_id.is_empty() {
        target.team_id.clone_from(&incoming.team_id);
        target.team_name.clone_from(&incoming.team_name);
        target.self_user_id.clone_from(&incoming.self_user_id);
        target.self_username.clone_from(&incoming.self_username);
    }
    target.collector = incoming.collector.clone();
    target.saved_at = incoming.saved_at;
    target.last_refresh.extend(incoming.last_refresh.clone());
    match projection.surface.as_str() {
        "activity" => {
            target.notifications.clone_from(&incoming.notifications);
            upsert_conversations(&mut target.conversations, &incoming.conversations);
        }
        "feed" => {
            target.notifications.clone_from(&incoming.notifications);
            target.files.clone_from(&incoming.files);
            upsert_conversations(&mut target.conversations, &incoming.conversations);
        }
        "dms" => {
            target
                .conversations
                .retain(|conversation| !conversation.kind.is_dm());
            target.conversations.extend(incoming.conversations.clone());
            target.messages.extend(incoming.messages.clone());
        }
        "channels" => {
            target
                .conversations
                .retain(|conversation| conversation.kind.is_dm());
            target.conversations.extend(incoming.conversations.clone());
            target.messages.extend(incoming.messages.clone());
        }
        "files" => target.files.clone_from(&incoming.files),
        "conversation" => {
            upsert_conversations(&mut target.conversations, &incoming.conversations);
            target.messages.extend(incoming.messages.clone());
            target.threads.extend(incoming.threads.clone());
        }
        "file" => upsert_files(&mut target.files, &incoming.files),
        _ => {}
    }
    target.normalize();
}

fn upsert_conversations(target: &mut Vec<Conversation>, incoming: &[Conversation]) {
    for conversation in incoming {
        if let Some(existing) = target.iter_mut().find(|item| item.id == conversation.id) {
            existing.clone_from(conversation);
        } else {
            target.push(conversation.clone());
        }
    }
}

fn upsert_files(target: &mut Vec<SlackFile>, incoming: &[SlackFile]) {
    for file in incoming {
        if let Some(existing) = target.iter_mut().find(|item| item.id == file.id) {
            existing.clone_from(file);
        } else {
            target.push(file.clone());
        }
    }
}

fn surface_available(state: &CacheState, surface: &Surface) -> bool {
    match surface {
        Surface::Feed => {
            state.refreshed_at("notifications").is_some()
                || !state.notifications.is_empty()
                || !state.files.is_empty()
        }
        Surface::Activity => {
            state.refreshed_at("notifications").is_some() || !state.notifications.is_empty()
        }
        Surface::Dms => {
            state.refreshed_at("sidebar").is_some()
                || state
                    .conversations
                    .iter()
                    .any(|conversation| conversation.kind.is_dm())
        }
        Surface::Channels => {
            state.refreshed_at("sidebar").is_some()
                || state
                    .conversations
                    .iter()
                    .any(|conversation| !conversation.kind.is_dm())
        }
        Surface::Files => state.refreshed_at("files").is_some() || !state.files.is_empty(),
        Surface::Conversation(id) => {
            state.messages.contains_key(id)
                || state.refreshed_at(&format!("conversation:{id}")).is_some()
        }
        Surface::File(id) => state.files.iter().any(|file| {
            file.id == *id && !matches!(file.content_status.as_str(), "" | "not_loaded")
        }),
    }
}

fn limit(input: &ListInput) -> Result<usize, QueryError> {
    let limit = input.limit.unwrap_or(DEFAULT_LIMIT);
    if limit == 0 || limit > MAX_LIMIT {
        return Err(QueryError::Validation(format!(
            "limit must be between 1 and {MAX_LIMIT}"
        )));
    }
    Ok(limit)
}

fn meta(state: &CacheState, surface: &Surface) -> QueryMeta {
    let refresh_key = surface.refresh_domain();
    QueryMeta {
        surface: surface.name().into(),
        team_id: state.team_id.clone(),
        team_name: state.team_name.clone(),
        revision: state.collector.revision,
        saved_at: state.saved_at,
        refreshed_at: state.refreshed_at(&refresh_key),
        refresh_state: state
            .collector
            .domains
            .get(&refresh_key)
            .map_or(RefreshState::Unknown, |health| health.state.clone()),
    }
}

fn conversation_summary(state: &CacheState, conversation: &Conversation) -> ConversationSummary {
    ConversationSummary {
        id: conversation.id.clone(),
        name: conversation.name.clone(),
        kind: conversation.kind,
        unread: conversation.unread_count,
        mentions: conversation.mention_count,
        favorite: conversation.is_favorite,
        latest_ts: conversation.latest_ts.clone(),
        cached_messages: state.messages.get(&conversation.id).map_or(0, Vec::len),
    }
}

fn terse_message(message: &Message) -> TerseMessage {
    TerseMessage {
        ts: message.ts.clone(),
        time: message.timestamp.clone(),
        from: if message.author.is_empty() {
            message.user_id.clone()
        } else {
            message.author.clone()
        },
        text: message.text.clone(),
        thread_ts: message.thread_ts.clone(),
        replies: message.reply_count,
        permalink: message.permalink.clone(),
        file_ids: message.file_ids.clone(),
    }
}

fn file_summary(file: &SlackFile) -> FileSummary {
    FileSummary {
        id: file.id.clone(),
        title: file.title.clone(),
        file_type: file.file_type.clone(),
        author: file.author.clone(),
        updated_at: file.updated_at.clone(),
        size_bytes: file.size_bytes,
        provenance: file.provenance.clone(),
        content_status: file.content_status.clone(),
        permalink: file.permalink.clone(),
    }
}

pub fn activity(runtime: &QueryRuntime, input: &ListInput) -> Result<ActivityOutput, QueryError> {
    let maximum = limit(input)?;
    let surface = Surface::Activity;
    let state = resolve_state(runtime, &surface)?;
    let mut groups = Vec::<ActivityGroup>::new();
    let mut positions = HashMap::<String, usize>::new();
    for notification in state.notifications.iter().take(maximum) {
        let position = *positions
            .entry(notification.conversation_id.clone())
            .or_insert_with(|| {
                let conversation = state
                    .conversation(&notification.conversation_id)
                    .cloned()
                    .unwrap_or_else(|| notification_conversation(notification));
                groups.push(ActivityGroup {
                    conversation: conversation_summary(&state, &conversation),
                    messages: Vec::new(),
                });
                groups.len() - 1
            });
        groups[position]
            .messages
            .push(terse_message(&notification.message));
    }
    Ok(ActivityOutput {
        meta: meta(&state, &surface),
        groups,
    })
}

fn notification_conversation(notification: &Notification) -> Conversation {
    Conversation {
        id: notification.conversation_id.clone(),
        name: notification.conversation_name.clone(),
        kind: notification.kind,
        latest_ts: Some(notification.message.ts.clone()),
        ..Conversation::default()
    }
}

pub fn feed(runtime: &QueryRuntime, input: &ListInput) -> Result<FeedOutput, QueryError> {
    let maximum = limit(input)?;
    let surface = Surface::Feed;
    let state = resolve_state(runtime, &surface)?;
    let mut items: Vec<FeedRecord> = state
        .notifications
        .iter()
        .map(|notification| FeedRecord {
            key: format!(
                "msg:{}:{}",
                notification.conversation_id, notification.message.ts
            ),
            time: notification.message.timestamp.clone(),
            source: notification.conversation_name.clone(),
            summary: crate::markdown::preview(&notification.message.text, 240),
            mention: notification.mention,
            unread: notification.unread,
            target_kind: "conversation".into(),
            target_id: notification.conversation_id.clone(),
        })
        .chain(state.files.iter().map(|file| FeedRecord {
            key: format!("file:{}", file.id),
            time: file.updated_at.clone(),
            source: file.file_type.clone(),
            summary: format!("{} · {}", file.title, file.author),
            mention: false,
            unread: false,
            target_kind: "file".into(),
            target_id: file.id.clone(),
        }))
        .collect();
    items.sort_by(|left, right| right.time.cmp(&left.time));
    items.truncate(maximum);
    Ok(FeedOutput {
        meta: meta(&state, &surface),
        items,
    })
}

pub fn conversations(
    runtime: &QueryRuntime,
    input: &ListInput,
    dms: bool,
) -> Result<ConversationListOutput, QueryError> {
    let maximum = limit(input)?;
    let surface = if dms { Surface::Dms } else { Surface::Channels };
    let state = resolve_state(runtime, &surface)?;
    let conversations = state
        .conversations
        .iter()
        .filter(|conversation| conversation.kind.is_dm() == dms)
        .take(maximum)
        .map(|conversation| conversation_summary(&state, conversation))
        .collect();
    Ok(ConversationListOutput {
        meta: meta(&state, &surface),
        conversations,
    })
}

pub fn conversation_get(
    runtime: &QueryRuntime,
    input: &GetInput,
) -> Result<ConversationGetOutput, QueryError> {
    if input.id.trim().is_empty() {
        return Err(QueryError::Validation("id must not be empty".into()));
    }
    let surface = Surface::Conversation(input.id.clone());
    let state = resolve_state(runtime, &surface)?;
    let conversation = state
        .conversation(&input.id)
        .ok_or_else(|| QueryError::NotFound {
            kind: "conversation",
            id: input.id.clone(),
        })?;
    Ok(ConversationGetOutput {
        meta: meta(&state, &surface),
        conversation: conversation_summary(&state, conversation),
        messages: state
            .messages
            .get(&input.id)
            .into_iter()
            .flatten()
            .map(terse_message)
            .collect(),
    })
}

pub fn files(runtime: &QueryRuntime, input: &ListInput) -> Result<FileListOutput, QueryError> {
    let maximum = limit(input)?;
    let surface = Surface::Files;
    let state = resolve_state(runtime, &surface)?;
    Ok(FileListOutput {
        meta: meta(&state, &surface),
        files: state.files.iter().take(maximum).map(file_summary).collect(),
    })
}

pub fn file_get(runtime: &QueryRuntime, input: &GetInput) -> Result<FileGetOutput, QueryError> {
    if input.id.trim().is_empty() {
        return Err(QueryError::Validation("id must not be empty".into()));
    }
    let surface = Surface::File(input.id.clone());
    let state = resolve_state(runtime, &surface)?;
    let file = state
        .files
        .iter()
        .find(|file| file.id == input.id)
        .ok_or_else(|| QueryError::NotFound {
            kind: "file",
            id: input.id.clone(),
        })?;
    Ok(FileGetOutput {
        meta: meta(&state, &surface),
        file: file_summary(file),
        markdown: file.content_markdown.clone(),
    })
}

#[must_use]
pub fn build_mcp_server() -> McpServer<QueryRuntime> {
    let mut router = ToolRouter::new();
    router.add_typed_tool(
        "slick_feed",
        "List terse cached Slack feed records.",
        |runtime, input: ListInput| feed(runtime, &input),
    );
    router.add_typed_tool(
        "slick_activity_list",
        "List Slack activity grouped by conversation provenance.",
        |runtime, input: ListInput| activity(runtime, &input),
    );
    router.add_typed_tool(
        "slick_dm_list",
        "List cached direct messages.",
        |runtime, input: ListInput| conversations(runtime, &input, true),
    );
    router.add_typed_tool(
        "slick_dm_get",
        "Get one DM and its cached messages.",
        |runtime, input: GetInput| conversation_get(runtime, &input),
    );
    router.add_typed_tool(
        "slick_channel_list",
        "List cached Slack channels.",
        |runtime, input: ListInput| conversations(runtime, &input, false),
    );
    router.add_typed_tool(
        "slick_channel_get",
        "Get one channel and its cached messages.",
        |runtime, input: GetInput| conversation_get(runtime, &input),
    );
    router.add_typed_tool(
        "slick_files_list",
        "List terse cached Slack files and canvases.",
        |runtime, input: ListInput| files(runtime, &input),
    );
    router.add_typed_tool(
        "slick_files_get",
        "Get one Slack file; Canvas content is bounded Markdown.",
        |runtime, input: GetInput| file_get(runtime, &input),
    );
    configurable_cli::register_config_tools(&mut router, |_runtime: &QueryRuntime| {
        crate::config::manager()
    });
    McpServer::new(
        StdioServerConfig {
            server_name: "slick".into(),
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
pub fn render_activity(output: &ActivityOutput) -> String {
    let mut text = String::new();
    for group in &output.groups {
        let _ = writeln!(
            text,
            "# {} ({})",
            group.conversation.name, group.conversation.id
        );
        for message in &group.messages {
            let _ = writeln!(text, "{} {}: {}", message.time, message.from, message.text);
        }
    }
    if text.is_empty() {
        text.push_str("No activity.\n");
    }
    text
}

#[must_use]
pub fn render_feed(output: &FeedOutput) -> String {
    let mut text = String::new();
    for item in &output.items {
        let _ = writeln!(text, "{} {:<18} {}", item.time, item.source, item.summary);
    }
    if text.is_empty() {
        text.push_str("No feed items.\n");
    }
    text
}

#[must_use]
pub fn render_conversations(output: &ConversationListOutput) -> String {
    let mut text = String::new();
    for conversation in &output.conversations {
        let _ = writeln!(
            text,
            "{}\t{}\t{} unread\t{} cached",
            conversation.id, conversation.name, conversation.unread, conversation.cached_messages
        );
    }
    if text.is_empty() {
        text.push_str("No conversations.\n");
    }
    text
}

#[must_use]
pub fn render_conversation(output: &ConversationGetOutput) -> String {
    let mut text = format!(
        "# {} ({})\n",
        output.conversation.name, output.conversation.id
    );
    for message in &output.messages {
        let _ = writeln!(text, "{} {}: {}", message.time, message.from, message.text);
    }
    text
}

#[must_use]
pub fn render_files(output: &FileListOutput) -> String {
    let mut text = String::new();
    for file in &output.files {
        let _ = writeln!(
            text,
            "{}\t{}\t{}\t{}",
            file.id, file.file_type, file.updated_at, file.title
        );
    }
    if text.is_empty() {
        text.push_str("No files.\n");
    }
    text
}

#[must_use]
pub fn render_file(output: &FileGetOutput) -> String {
    format!(
        "# {} ({})\n\n{}\n\n{}",
        output.file.title, output.file.id, output.file.permalink, output.markdown
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_projection_contains_only_requested_conversation_family() {
        let state = crate::slack::demo_state();
        let dms = project_state(&state, &Surface::Dms);
        assert!(dms.state.conversations.iter().all(|item| item.kind.is_dm()));
        assert!(dms.state.files.is_empty());
        let channels = project_state(&state, &Surface::Channels);
        assert!(channels
            .state
            .conversations
            .iter()
            .all(|item| !item.kind.is_dm()));
    }

    #[test]
    fn projections_merge_without_erasing_other_surfaces() {
        let state = crate::slack::demo_state();
        let mut target = CacheState::default();
        apply_projection(&mut target, &project_state(&state, &Surface::Dms));
        let dm_count = target.conversations.len();
        apply_projection(&mut target, &project_state(&state, &Surface::Channels));
        assert!(target.conversations.len() > dm_count);
        assert!(target.conversations.iter().any(|item| item.kind.is_dm()));
        assert!(target.conversations.iter().any(|item| !item.kind.is_dm()));
    }

    fn cached_runtime(name: &str) -> (QueryRuntime, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "slick-query-{name}-{}-{}",
            std::process::id(),
            CacheState::now()
        ));
        let runtime = QueryRuntime {
            cache_store: CacheStore::new(dir.join("state.json")),
            use_cache: true,
            use_daemon: false,
            endpoint: "http://127.0.0.1:1".into(),
            token_path: dir.join("token"),
            fallback: false,
            fallback_lease_path: dir.join("fallback.lock"),
        };
        runtime
            .cache_store
            .save_exact(&crate::slack::demo_state())
            .unwrap();
        (runtime, dir)
    }

    #[test]
    fn terse_activity_groups_repeated_conversation_provenance_once() {
        let (runtime, dir) = cached_runtime("activity");
        let output = activity(&runtime, &ListInput { limit: Some(100) }).unwrap();
        let message_count: usize = output.groups.iter().map(|group| group.messages.len()).sum();
        assert!(output.groups.len() <= message_count);
        assert_eq!(
            message_count,
            crate::slack::demo_state().notifications.len()
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn file_get_returns_cached_canvas_markdown() {
        let (runtime, dir) = cached_runtime("file");
        let output = file_get(
            &runtime,
            &GetInput {
                id: "F_CANVAS".into(),
            },
        )
        .unwrap();
        assert!(output.markdown.contains("Slick Product Brief"));
        assert_eq!(output.file.content_status, "ok");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn mcp_router_exposes_stable_slick_tool_names() {
        let names: Vec<_> = build_mcp_server()
            .tool_metadata()
            .into_iter()
            .map(|tool| tool.name)
            .collect();
        for name in [
            "slick_feed",
            "slick_activity_list",
            "slick_dm_list",
            "slick_dm_get",
            "slick_channel_list",
            "slick_channel_get",
            "slick_files_list",
            "slick_files_get",
        ] {
            assert!(
                names.iter().any(|candidate| candidate == name),
                "missing {name}"
            );
        }
    }
}
