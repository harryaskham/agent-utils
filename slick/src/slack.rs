use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use reqwest::blocking::{Client, Response};
use reqwest::header::{
    ACCEPT, AUTHORIZATION, CONTENT_TYPE, COOKIE, ORIGIN, REFERER, RETRY_AFTER, USER_AGENT,
};
use reqwest::StatusCode;
use serde_json::{Map, Value};
use url::Url;

use crate::model::{
    CacheState, Conversation, ConversationKind, Message, Notification, SearchProgress, SlackFile,
    User,
};

const API_ROOT: &str = "https://www.slack.com/api";
const USER_AGENT_VALUE: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Slack/4.41.30 Slick/0.1";
const MAX_AUTOMATIC_DMS: usize = 12;
const MAX_HISTORY_MESSAGES: usize = 100;
const MAX_FILE_RESULTS: usize = 100;
const MAX_BACKFILL_CONVERSATIONS: usize = 24;
const MAX_CANVAS_MARKDOWN_CHARS: usize = 24_000;
/// Slack throttles hard (search.* is roughly 20/min), so a burst refresh must
/// wait rather than surface a bare failure. Bounded so a wedged workspace can
/// never hang the worker thread indefinitely.
const MAX_RATE_LIMIT_ATTEMPTS: u32 = 4;
const MAX_RATE_LIMIT_WAIT: Duration = Duration::from_secs(45);

/// Structured degradation notice emitted while a Slack call is in progress.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlackNotice {
    pub message: String,
    pub rate_limited: bool,
    pub retry_after_secs: Option<u64>,
    pub partial: bool,
}

/// Expected, durable incompleteness while a paginated cache window is filled.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct IncompleteCoverage(pub String);

/// Most recent degradation notice (throttling, partial results), drained by
/// the legacy in-TUI worker into the status line.
static NOTICE: Mutex<Option<SlackNotice>> = Mutex::new(None);

/// Take the pending notice, if any. Clears it.
pub fn take_notice() -> Option<String> {
    NOTICE
        .lock()
        .ok()
        .and_then(|mut slot| slot.take())
        .map(|notice| notice.message)
}

fn record_notice(notice: SlackNotice) {
    if let Ok(mut slot) = NOTICE.lock() {
        *slot = Some(notice);
    }
}

/// Outcome of one Slack HTTP attempt.
enum ApiOutcome {
    Value(Box<Value>),
    RateLimited,
}

/// Whether a response means "throttled, try again later".
///
/// Slack signals this either as HTTP 429 or as a 200 with `ok:false` and
/// `error:"ratelimited"`, so both must be treated the same.
fn is_rate_limited(status: StatusCode, error: Option<&str>) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || error == Some("ratelimited")
}

/// How long to wait before retrying a throttled call.
///
/// Slack's `Retry-After` (seconds) is authoritative when present; otherwise
/// back off exponentially. Both are capped, and a little jitter keeps several
/// refreshers from retrying in lockstep.
fn rate_limit_delay(attempt: u32, retry_after: Option<u64>, jitter_millis: u64) -> Duration {
    let base = match retry_after {
        Some(seconds) => Duration::from_secs(seconds),
        None => Duration::from_secs(1 << attempt.min(5)),
    };
    let capped = base.min(MAX_RATE_LIMIT_WAIT);
    capped.saturating_add(Duration::from_millis(jitter_millis % 250))
}

fn jitter_seed() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| u64::from(elapsed.subsec_millis()))
}

#[derive(Clone, Debug)]
struct Tokens {
    token: String,
    cookie: String,
}

#[derive(Clone)]
pub struct SlackClient {
    http: Client,
    tokens: Tokens,
    notice: Option<Arc<dyn Fn(SlackNotice) + Send + Sync>>,
}

impl SlackClient {
    pub fn from_environment() -> Result<Self> {
        let tokens = load_tokens()?;
        let http = Client::builder()
            .timeout(Duration::from_secs(45))
            .build()
            .context("build Slack HTTP client")?;
        Ok(Self {
            http,
            tokens,
            notice: None,
        })
    }

    fn with_notice(mut self, notice: Arc<dyn Fn(SlackNotice) + Send + Sync>) -> Self {
        self.notice = Some(notice);
        self
    }

    fn emit_notice(&self, notice: SlackNotice) {
        record_notice(notice.clone());
        if let Some(callback) = &self.notice {
            callback(notice);
        }
    }

    pub fn call(&self, method: &str, params: &BTreeMap<String, String>) -> Result<Value> {
        for attempt in 0..MAX_RATE_LIMIT_ATTEMPTS {
            let response = self
                .http
                .post(format!("{API_ROOT}/{method}"))
                .header(AUTHORIZATION, format!("Bearer {}", self.tokens.token))
                .header(COOKIE, format!("d={}", self.tokens.cookie))
                .header(
                    CONTENT_TYPE,
                    "application/x-www-form-urlencoded;charset=utf-8",
                )
                .header(USER_AGENT, USER_AGENT_VALUE)
                .header(ORIGIN, "https://app.slack.com")
                .header(REFERER, "https://app.slack.com/")
                .header(ACCEPT, "application/json")
                .form(params)
                .send()
                .with_context(|| format!("call Slack {method}"))?;
            let retry_after = retry_after_seconds(&response);
            match parse_api_response(method, response)? {
                ApiOutcome::Value(value) => return Ok(*value),
                ApiOutcome::RateLimited => {
                    let last = attempt + 1 == MAX_RATE_LIMIT_ATTEMPTS;
                    if last {
                        self.emit_notice(SlackNotice {
                            message: format!(
                                "Slack rate-limited {method}; giving up after {MAX_RATE_LIMIT_ATTEMPTS} attempts"
                            ),
                            rate_limited: true,
                            retry_after_secs: retry_after,
                            partial: false,
                        });
                        bail!(
                            "Slack {method} failed: ratelimited (retried {MAX_RATE_LIMIT_ATTEMPTS} times)"
                        );
                    }
                    let delay = rate_limit_delay(attempt, retry_after, jitter_seed());
                    self.emit_notice(SlackNotice {
                        message: format!(
                            "Slack rate-limited {method}; retrying in {}s",
                            delay.as_secs().max(1)
                        ),
                        rate_limited: true,
                        retry_after_secs: Some(delay.as_secs().max(1)),
                        partial: false,
                    });
                    std::thread::sleep(delay);
                }
            }
        }
        bail!("Slack {method} failed: ratelimited")
    }

    fn get_canvas_html(&self, file: &SlackFile) -> Result<String> {
        if file.download_url.is_empty() {
            bail!("canvas {} has no content URL", file.id);
        }
        let url = Url::parse(&file.download_url).context("parse Slack canvas URL")?;
        if url.scheme() != "https" || url.host_str() != Some("files.slack.com") {
            bail!(
                "refusing unexpected canvas host {}",
                url.host_str().unwrap_or("unknown")
            );
        }
        let response = self
            .http
            .get(url)
            .header(AUTHORIZATION, format!("Bearer {}", self.tokens.token))
            .header(COOKIE, format!("d={}", self.tokens.cookie))
            .header(USER_AGENT, USER_AGENT_VALUE)
            .header(ACCEPT, "text/html")
            .send()
            .context("download Slack canvas")?;
        if !response.status().is_success() {
            bail!(
                "Slack canvas download failed with HTTP {}",
                response.status()
            );
        }
        response.text().context("read Slack canvas HTML")
    }

    fn paginate(
        &self,
        method: &str,
        base: &BTreeMap<String, String>,
        key: &str,
    ) -> Result<Vec<Value>> {
        let mut items = Vec::new();
        let mut cursor = String::new();
        for _ in 0..25 {
            let mut params = base.clone();
            params.insert("limit".into(), "200".into());
            if !cursor.is_empty() {
                params.insert("cursor".into(), cursor.clone());
            }
            let result = self.call(method, &params)?;
            items.extend(
                result
                    .get(key)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            );
            cursor = result
                .pointer("/response_metadata/next_cursor")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if cursor.is_empty() {
                break;
            }
        }
        Ok(items)
    }
}

fn retry_after_seconds(response: &Response) -> Option<u64> {
    response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

fn parse_api_response(method: &str, response: Response) -> Result<ApiOutcome> {
    let status = response.status();
    let text = response.text().context("read Slack API response")?;
    // A throttled response is not always JSON (429 bodies can be plain text),
    // so classify before insisting on a JSON body.
    let value: Option<Value> = serde_json::from_str(&text).ok();
    let error = value
        .as_ref()
        .and_then(|value| value.get("error"))
        .and_then(Value::as_str);
    if is_rate_limited(status, error) {
        return Ok(ApiOutcome::RateLimited);
    }
    let Some(value) = value else {
        bail!(
            "Slack {method} returned non-JSON HTTP {status}: {}",
            text.chars().take(240).collect::<String>()
        );
    };
    if !status.is_success() || value.get("ok").and_then(Value::as_bool) == Some(false) {
        let error = value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown_error");
        if matches!(
            error,
            "invalid_auth" | "not_authed" | "token_revoked" | "cookie_not_found"
        ) {
            bail!("Slack authentication failed ({error}); refresh ~/.slack-mcp-tokens.json with /slack-refresh");
        }
        bail!("Slack {method} failed: {error}");
    }
    Ok(ApiOutcome::Value(Box::new(value)))
}

fn load_tokens() -> Result<Tokens> {
    if let (Ok(token), Ok(cookie)) = (std::env::var("SLACK_TOKEN"), std::env::var("SLACK_COOKIE")) {
        if !token.is_empty() && !cookie.is_empty() {
            return Ok(Tokens { token, cookie });
        }
    }
    let path = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".slack-mcp-tokens.json");
    let content = fs::read_to_string(&path).with_context(|| {
        format!(
            "read Slack tokens {}; run /slack-refresh first",
            path.display()
        )
    })?;
    let value: Value = serde_json::from_str(&content).context("parse Slack token file")?;
    let token = value
        .get("SLACK_TOKEN")
        .or_else(|| value.get("slack_token"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let cookie = value
        .get("SLACK_COOKIE")
        .or_else(|| value.get("slack_cookie"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if token.is_empty() || cookie.is_empty() {
        bail!(
            "Slack token file {} is missing SLACK_TOKEN or SLACK_COOKIE",
            path.display()
        );
    }
    Ok(Tokens { token, cookie })
}

#[derive(Clone)]
pub struct SlackService {
    client: SlackClient,
}

impl SlackService {
    pub fn from_environment() -> Result<Self> {
        Ok(Self {
            client: SlackClient::from_environment()?,
        })
    }

    /// Construct a service that reports in-flight rate-limit/partial progress.
    /// The daemon uses this to publish backoff state while a Slack call sleeps;
    /// the legacy in-TUI worker continues to use the global one-shot notice.
    pub fn from_environment_with_notice(
        notice: Arc<dyn Fn(SlackNotice) + Send + Sync>,
    ) -> Result<Self> {
        Ok(Self {
            client: SlackClient::from_environment()?.with_notice(notice),
        })
    }

    pub fn bootstrap(&self, state: &mut CacheState) -> Result<()> {
        self.refresh_identity(state)?;
        self.refresh_sidebar(state)?;
        self.backfill_dm_names(state);
        let notifications_error = self.refresh_notifications(state).err();
        let _ = self.refresh_self_activity(state);
        let files_error = self.refresh_files(state).err();
        self.refresh_active_dms(state)?;
        rebuild_dm_notifications(state);
        state.normalize();
        if let Some(error) = notifications_error {
            state
                .last_refresh
                .insert("notifications_error".into(), CacheState::now());
            if state.notifications.is_empty() {
                return Err(error.context("refresh notifications"));
            }
        }
        if files_error.is_some() && state.files.is_empty() {
            // Files are an independent tab; keep the usable sidebar/messages even
            // when workspace search permissions do not include files.
        }
        Ok(())
    }

    pub fn refresh_sidebar(&self, state: &mut CacheState) -> Result<()> {
        let users = self
            .client
            .paginate("users.list", &BTreeMap::new(), "members")?;
        state.users = users
            .iter()
            .filter_map(compact_user)
            .map(|user| (user.id.clone(), user))
            .collect();

        // Slack's browser-session API can return only channel rows when all
        // conversation kinds are mixed in one request. Fetch the Slack sidebar
        // families separately (matching the native Pi tool) and normalize them
        // into one ordered list.
        let mut conversations = Vec::new();
        for types in ["im,mpim", "public_channel,private_channel"] {
            let mut params = BTreeMap::new();
            params.insert("types".into(), types.into());
            params.insert("exclude_archived".into(), "true".into());
            conversations.extend(self.client.paginate(
                "conversations.list",
                &params,
                "channels",
            )?);
        }
        let mut seen = HashSet::new();
        state.conversations = conversations
            .into_iter()
            .filter(|value| seen.insert(value_string(value, "id")))
            .filter_map(|value| compact_conversation(&value, &state.users))
            .collect();
        self.refresh_favorites(state)?;
        state.mark_refreshed("sidebar");
        state.normalize();
        Ok(())
    }

    pub fn refresh_conversation(
        &self,
        state: &mut CacheState,
        conversation_id: &str,
    ) -> Result<()> {
        let key = format!("conversation:{conversation_id}");
        let progress_key = format!("history:{conversation_id}");
        let fallback = state.since_for(&key).max(CacheState::seven_days_ago());
        let progress = state
            .search_progress
            .entry(progress_key.clone())
            .or_insert_with(|| SearchProgress {
                window_start: fallback,
                next_page: 1,
                cursor: String::new(),
                complete: false,
            })
            .clone();
        let mut params = BTreeMap::new();
        params.insert("channel".into(), conversation_id.to_string());
        params.insert("oldest".into(), progress.window_start.to_string());
        params.insert("limit".into(), MAX_HISTORY_MESSAGES.to_string());
        if !progress.cursor.is_empty() {
            params.insert("cursor".into(), progress.cursor.clone());
        }
        let result = self.client.call("conversations.history", &params)?;
        let conversation = state.conversation(conversation_id).cloned();
        let messages = result
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|value| compact_message(value, conversation.as_ref(), &state.users))
            .collect();
        state.merge_messages(conversation_id, messages);
        rebuild_dm_notifications(state);
        state.normalize();
        let next_cursor = result
            .pointer("/response_metadata/next_cursor")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let at_capacity = state
            .messages
            .get(conversation_id)
            .is_some_and(|messages| messages.len() >= 500);
        if !next_cursor.is_empty() && !at_capacity {
            let page = progress.next_page.max(1);
            state.search_progress.insert(
                progress_key,
                SearchProgress {
                    next_page: page.saturating_add(1),
                    cursor: next_cursor,
                    ..progress
                },
            );
            return Err(IncompleteCoverage(format!(
                "conversation coverage incomplete: loaded page {page}"
            ))
            .into());
        }
        state.search_progress.remove(&progress_key);
        state.mark_refreshed(key);
        Ok(())
    }

    /// Resolve DM display names whose user was missing from `users.list`.
    ///
    /// Slack omits some users (deactivated, cross-workspace, app/bot DMs) from
    /// the bulk listing, which previously left rows rendered as `DM <id>`.
    fn backfill_dm_names(&self, state: &mut CacheState) {
        let missing: Vec<(String, String)> = state
            .conversations
            .iter()
            .filter(|conversation| conversation.name.starts_with("DM "))
            .filter_map(|conversation| {
                conversation
                    .user_id
                    .clone()
                    .map(|user| (conversation.id.clone(), user))
            })
            .filter(|(_, user)| !state.users.contains_key(user))
            .take(MAX_BACKFILL_CONVERSATIONS)
            .collect();
        for (conversation_id, user_id) in missing {
            let mut params = BTreeMap::new();
            params.insert("user".into(), user_id.clone());
            let Ok(result) = self.client.call("users.info", &params) else {
                continue;
            };
            let Some(user) = result.get("user").and_then(compact_user) else {
                continue;
            };
            let label = user.label().to_string();
            state.users.insert(user_id, user);
            if let Some(conversation) = state
                .conversations
                .iter_mut()
                .find(|item| item.id == conversation_id)
            {
                conversation.name = label;
            }
        }
    }

    pub fn refresh_self_activity(&self, state: &mut CacheState) -> Result<()> {
        let progress_key = "search:self_activity";
        let fallback = state
            .since_for("self_activity")
            .max(CacheState::seven_days_ago());
        let progress = state
            .search_progress
            .entry(progress_key.into())
            .or_insert_with(|| SearchProgress {
                window_start: fallback,
                next_page: 1,
                cursor: String::new(),
                complete: false,
            })
            .clone();
        let page = progress.next_page.max(1);
        let mut params = BTreeMap::new();
        params.insert(
            "query".into(),
            format!("from:me after:{}", date_filter(progress.window_start)),
        );
        params.insert("count".into(), "100".into());
        params.insert("page".into(), page.to_string());
        let result = self.client.call("search.messages", &params)?;
        for value in result
            .pointer("/messages/matches")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = value.pointer("/channel/id").and_then(value_as_id) else {
                continue;
            };
            let ts = value_string(value, "ts");
            let entry = state.self_activity.entry(id).or_default();
            if ts.parse::<f64>().unwrap_or(0.0) > entry.parse::<f64>().unwrap_or(0.0) {
                *entry = ts;
            }
        }
        let pages = search_page_count(&result, "messages").max(1);
        if page < pages {
            state.search_progress.insert(
                progress_key.into(),
                SearchProgress {
                    next_page: page.saturating_add(1),
                    ..progress
                },
            );
            return Err(IncompleteCoverage(format!(
                "self-activity coverage incomplete: page {page} of {pages}"
            ))
            .into());
        }
        state.search_progress.remove(progress_key);
        state.mark_refreshed("self_activity");
        self.backfill_conversations(state);
        Ok(())
    }

    /// Send a Slack read marker for `conversation_id` up to `ts`.
    ///
    /// This is the ONLY Slack mutation Slick can perform, and it is reached
    /// only when the operator sets `mark-read-in-slack: true`. It clears the
    /// unread badge in every Slack client, which is why it is opt-in: the
    /// client is otherwise strictly read-only.
    pub fn mark_conversation_read(&self, conversation_id: &str, ts: &str) -> Result<()> {
        if conversation_id.is_empty() || ts.is_empty() {
            return Ok(());
        }
        let mut params = BTreeMap::new();
        params.insert("channel".into(), conversation_id.to_string());
        params.insert("ts".into(), ts.to_string());
        self.client.call("conversations.mark", &params)?;
        Ok(())
    }

    /// Add conversations referenced by recent self-activity that the
    /// membership listings did not return, so "channels you're active in"
    /// shows names rather than raw ids.
    fn backfill_conversations(&self, state: &mut CacheState) {
        let missing: Vec<String> = state
            .self_activity
            .keys()
            .filter(|id| !state.conversations.iter().any(|item| item.id == **id))
            .take(MAX_BACKFILL_CONVERSATIONS)
            .cloned()
            .collect();
        for id in missing {
            let mut params = BTreeMap::new();
            params.insert("channel".into(), id);
            if let Ok(result) = self.client.call("conversations.info", &params) {
                if let Some(conversation) = result
                    .get("channel")
                    .and_then(|value| compact_conversation(value, &state.users))
                {
                    state.conversations.push(conversation);
                }
            }
        }
    }

    pub fn refresh_thread(
        &self,
        state: &mut CacheState,
        conversation_id: &str,
        thread_ts: &str,
    ) -> Result<()> {
        let mut params = BTreeMap::new();
        params.insert("channel".into(), conversation_id.to_string());
        params.insert("ts".into(), thread_ts.to_string());
        params.insert("limit".into(), MAX_HISTORY_MESSAGES.to_string());
        let result = self.client.call("conversations.replies", &params)?;
        let conversation = state.conversation(conversation_id).cloned();
        let mut messages: Vec<Message> = result
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|value| compact_message(value, conversation.as_ref(), &state.users))
            .collect();
        messages.sort_by(|left, right| {
            left.unix_ts()
                .partial_cmp(&right.unix_ts())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        messages.dedup_by(|left, right| left.ts == right.ts);
        state
            .threads
            .insert(CacheState::thread_key(conversation_id, thread_ts), messages);
        state.mark_refreshed(format!("thread:{conversation_id}:{thread_ts}"));
        Ok(())
    }

    pub fn refresh_notifications(&self, state: &mut CacheState) -> Result<()> {
        let prefix = "search:notifications:";
        let fallback = state
            .since_for("notifications")
            .max(CacheState::seven_days_ago());
        let window_start = state
            .search_progress
            .iter()
            .find(|(key, _)| key.starts_with(prefix))
            .map_or(fallback, |(_, progress)| progress.window_start);
        let after = date_filter(window_start);
        let mut queries = vec![("to_me", format!("to:me after:{after}"))];
        if !state.self_username.is_empty() {
            queries.push(("mention", format!("@{} after:{after}", state.self_username)));
        }
        let keys: Vec<String> = queries
            .iter()
            .map(|(name, _)| format!("{prefix}{name}"))
            .collect();
        let mut notifications = Vec::new();
        let mut discovered_conversations = Vec::new();
        let mut failures = Vec::new();
        let total_queries = queries.len();
        for ((_, query), progress_key) in queries.into_iter().zip(&keys) {
            let progress = state
                .search_progress
                .entry(progress_key.clone())
                .or_insert_with(|| SearchProgress {
                    window_start,
                    next_page: 1,
                    cursor: String::new(),
                    complete: false,
                })
                .clone();
            if progress.complete {
                continue;
            }
            let page = progress.next_page.max(1);
            let mut params = BTreeMap::new();
            params.insert("query".into(), query);
            params.insert("count".into(), "100".into());
            params.insert("page".into(), page.to_string());
            let result = match self.client.call("search.messages", &params) {
                Ok(result) => result,
                Err(error) => {
                    failures.push(error.to_string());
                    continue;
                }
            };
            let embedded_users = result
                .get("users")
                .and_then(Value::as_object)
                .map(compact_embedded_users)
                .unwrap_or_default();
            let mut users = state.users.clone();
            users.extend(embedded_users);
            for value in result
                .pointer("/messages/matches")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(notification) =
                    compact_search_notification(value, &users, &state.self_user_id)
                {
                    discovered_conversations.push(Conversation {
                        id: notification.conversation_id.clone(),
                        name: notification.conversation_name.clone(),
                        kind: notification.kind,
                        latest_ts: Some(notification.message.ts.clone()),
                        ..Conversation::default()
                    });
                    notifications.push(notification);
                }
            }
            let pages = search_page_count(&result, "messages").max(1);
            state.search_progress.insert(
                progress_key.clone(),
                SearchProgress {
                    window_start,
                    next_page: page.saturating_add(1),
                    cursor: String::new(),
                    complete: page >= pages,
                },
            );
        }
        let failed_queries = failures.len();
        if failed_queries > 0 {
            self.client.emit_notice(SlackNotice {
                message: format!(
                    "partial activity: {failed_queries} of {total_queries} mention/DM searches failed; some mentions may be missing"
                ),
                rate_limited: failures.iter().any(|error| error.contains("ratelimited")),
                retry_after_secs: None,
                partial: true,
            });
        }
        let mut known_ids: HashSet<String> = state
            .conversations
            .iter()
            .map(|conversation| conversation.id.clone())
            .collect();
        state.conversations.extend(
            discovered_conversations
                .into_iter()
                .filter(|conversation| known_ids.insert(conversation.id.clone())),
        );
        state.notifications = merge_notifications(
            std::mem::take(&mut state.notifications),
            notifications,
            CacheState::seven_days_ago() as f64,
        );
        rebuild_dm_notifications(state);
        state.normalize();
        if failed_queries > 0 {
            bail!(
                "partial activity: {failed_queries} of {total_queries} searches failed ({})",
                failures.join("; ")
            );
        }
        let complete = keys.iter().all(|key| {
            state
                .search_progress
                .get(key)
                .is_some_and(|progress| progress.complete)
        });
        if !complete {
            return Err(IncompleteCoverage(
                "activity coverage incomplete; continuing paginated searches".into(),
            )
            .into());
        }
        state
            .search_progress
            .retain(|key, _| !key.starts_with(prefix));
        state.mark_refreshed("notifications");
        Ok(())
    }

    pub fn refresh_files(&self, state: &mut CacheState) -> Result<()> {
        let progress_key = "search:files";
        let fallback = state.since_for("files").max(CacheState::seven_days_ago());
        let progress = state
            .search_progress
            .entry(progress_key.into())
            .or_insert_with(|| SearchProgress {
                window_start: fallback,
                next_page: 1,
                cursor: String::new(),
                complete: false,
            })
            .clone();
        let page = progress.next_page.max(1);
        let mut params = BTreeMap::new();
        params.insert(
            "query".into(),
            format!("after:{}", date_filter(progress.window_start)),
        );
        params.insert("count".into(), MAX_FILE_RESULTS.to_string());
        params.insert("page".into(), page.to_string());
        let result = self.client.call("search.files", &params)?;
        let embedded_users = result
            .get("users")
            .and_then(Value::as_object)
            .map(compact_embedded_users)
            .unwrap_or_default();
        state.users.extend(embedded_users);
        let incoming: Vec<SlackFile> = result
            .pointer("/files/matches")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|value| compact_file(value, &state.users))
            .collect();
        state.files = merge_files(std::mem::take(&mut state.files), incoming);
        state.normalize();
        let pages = search_page_count(&result, "files").max(1);
        if page < pages {
            state.search_progress.insert(
                progress_key.into(),
                SearchProgress {
                    next_page: page.saturating_add(1),
                    ..progress
                },
            );
            return Err(IncompleteCoverage(format!(
                "file coverage incomplete: page {page} of {pages}"
            ))
            .into());
        }
        state.search_progress.remove(progress_key);
        state.mark_refreshed("files");
        Ok(())
    }

    pub fn load_file_content(&self, state: &mut CacheState, file_id: &str) -> Result<()> {
        let index = state
            .files
            .iter()
            .position(|file| file.id == file_id)
            .with_context(|| format!("unknown Slack file {file_id}"))?;
        if !state.files[index].is_canvas() {
            state.files[index].content_status = "metadata_only".into();
            if state.files[index].content_markdown.is_empty() {
                state.files[index].content_markdown = format!(
                    "# {}\n\nThis is a `{}` Slack file. Slick's first read-only release renders full content for Slack Canvas documents; use the permalink to open this file.\n\n[Open in Slack]({})",
                    state.files[index].title,
                    state.files[index].file_type,
                    state.files[index].permalink,
                );
            }
            state.files[index].content_fetched_at = Some(CacheState::now());
            return Ok(());
        }
        let html = self.client.get_canvas_html(&state.files[index])?;
        let markdown = html2md::parse_html(&html);
        let (markdown, truncated) = truncate_chars(&markdown, MAX_CANVAS_MARKDOWN_CHARS);
        state.files[index].content_markdown = markdown;
        state.files[index].content_status = if truncated { "truncated" } else { "ok" }.into();
        state.files[index].content_fetched_at = Some(CacheState::now());
        Ok(())
    }

    fn refresh_favorites(&self, state: &mut CacheState) -> Result<()> {
        let items = self
            .client
            .paginate("stars.list", &BTreeMap::new(), "items")?;
        let favorite_ids: HashSet<String> = items
            .iter()
            .filter_map(|item| {
                item.get("channel")
                    .and_then(value_as_id)
                    .or_else(|| item.pointer("/channel/id").and_then(value_as_id))
                    .or_else(|| item.get("group").and_then(value_as_id))
            })
            .collect();
        for conversation in &mut state.conversations {
            conversation.is_favorite |= favorite_ids.contains(&conversation.id);
        }
        let missing: Vec<String> = favorite_ids
            .into_iter()
            .filter(|id| !state.conversations.iter().any(|item| item.id == *id))
            .collect();
        for id in missing {
            let mut params = BTreeMap::new();
            params.insert("channel".into(), id);
            let result = self.client.call("conversations.info", &params)?;
            if let Some(mut conversation) = result
                .get("channel")
                .and_then(|value| compact_conversation(value, &state.users))
            {
                conversation.is_favorite = true;
                state.conversations.push(conversation);
            }
        }
        Ok(())
    }

    pub fn refresh_identity(&self, state: &mut CacheState) -> Result<()> {
        let result = self.client.call("auth.test", &BTreeMap::new())?;
        state.team_id = value_string(&result, "team_id");
        state.team_name = value_string(&result, "team");
        state.self_user_id = value_string(&result, "user_id");
        state.self_username = value_string(&result, "user");
        state.mark_refreshed("identity");
        Ok(())
    }

    fn refresh_active_dms(&self, state: &mut CacheState) -> Result<()> {
        let since = CacheState::seven_days_ago() as f64;
        let mut dms: Vec<Conversation> = state
            .conversations
            .iter()
            .filter(|conversation| conversation.kind.is_dm())
            .filter(|conversation| {
                conversation.unread_count > 0 || conversation.activity_ts() >= since
            })
            .cloned()
            .collect();
        if dms.is_empty() {
            dms = state
                .conversations
                .iter()
                .filter(|conversation| conversation.kind.is_dm())
                .take(8)
                .cloned()
                .collect();
        }
        dms.sort_by(|left, right| {
            right.unread_count.cmp(&left.unread_count).then_with(|| {
                right
                    .activity_ts()
                    .partial_cmp(&left.activity_ts())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        });
        let mut first_error = None;
        for conversation in dms.into_iter().take(MAX_AUTOMATIC_DMS) {
            if let Err(error) = self.refresh_conversation(state, &conversation.id) {
                first_error.get_or_insert(error);
            }
        }
        if state.messages.is_empty() {
            if let Some(error) = first_error {
                return Err(error);
            }
        }
        Ok(())
    }
}

fn compact_embedded_users(values: &Map<String, Value>) -> BTreeMap<String, User> {
    values
        .iter()
        .filter_map(|(id, value)| {
            let mut user = compact_user(value)?;
            if user.id.is_empty() {
                user.id.clone_from(id);
            }
            Some((user.id.clone(), user))
        })
        .collect()
}

fn compact_user(value: &Value) -> Option<User> {
    let id = value_string(value, "id");
    if id.is_empty() {
        return None;
    }
    Some(User {
        id,
        username: first_string(value, &["name", "username"]),
        display_name: value_pointer_string(value, "/profile/display_name"),
        real_name: first_pointer_string(value, &["/profile/real_name", "/real_name"]),
        title: value_pointer_string(value, "/profile/title"),
        is_bot: value
            .get("is_bot")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        deleted: value
            .get("deleted")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn compact_conversation(value: &Value, users: &BTreeMap<String, User>) -> Option<Conversation> {
    let id = value_string(value, "id");
    if id.is_empty() {
        return None;
    }
    let kind = if value_bool(value, "is_im") {
        ConversationKind::Dm
    } else if value_bool(value, "is_mpim") {
        ConversationKind::GroupDm
    } else if value_bool(value, "is_private") || value_bool(value, "is_group") {
        ConversationKind::PrivateChannel
    } else {
        ConversationKind::Channel
    };
    let user_id = value
        .get("user")
        .and_then(Value::as_str)
        .map(str::to_string);
    let purpose = value_pointer_string(value, "/purpose/value");
    let raw_name = first_string(value, &["name_normalized", "name"]);
    let name = if kind == ConversationKind::Dm {
        user_id
            .as_deref()
            .and_then(|user| users.get(user))
            .map_or_else(|| format!("DM {id}"), |user| user.label().to_string())
    } else if kind == ConversationKind::GroupDm && raw_name.starts_with("mpdm-") {
        purpose
            .strip_prefix("Group messaging with:")
            .map(|members| members.trim().replace(" @", ", ").replace('@', ""))
            .filter(|members| !members.is_empty())
            .unwrap_or(raw_name)
    } else {
        raw_name
    };
    Some(Conversation {
        id,
        name,
        kind,
        user_id,
        topic: value_pointer_string(value, "/topic/value"),
        purpose,
        unread_count: value_u32(value, "unread_count_display")
            .max(value_u32(value, "unread_count")),
        mention_count: value_u32(value, "mention_count"),
        is_favorite: value_bool(value, "is_starred") || value_bool(value, "is_favorite"),
        latest_ts: value
            .pointer("/latest/ts")
            .or_else(|| value.get("updated"))
            .and_then(value_as_timestamp),
        is_member: value
            .get("is_member")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        is_archived: value_bool(value, "is_archived"),
    })
}

fn compact_message(
    value: &Value,
    conversation: Option<&Conversation>,
    users: &BTreeMap<String, User>,
) -> Option<Message> {
    let ts = value_string(value, "ts");
    if ts.is_empty() {
        return None;
    }
    let user_id = first_string(value, &["user", "bot_id"]);
    let author = users.get(&user_id).map_or_else(
        || value_string(value, "username"),
        |user| user.label().to_string(),
    );
    let raw_text = value
        .get("text")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map_or_else(|| flatten_blocks(value.get("blocks")), str::to_string);
    let text = slack_text_to_markdown(&raw_text, users);
    Some(Message {
        timestamp: timestamp_to_iso(&ts),
        ts,
        user_id,
        author,
        text,
        permalink: value_string(value, "permalink"),
        thread_ts: value
            .get("thread_ts")
            .and_then(Value::as_str)
            .map(str::to_string),
        reply_count: value_u32(value, "reply_count"),
        file_ids: value
            .get("files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|file| file.get("id").and_then(Value::as_str).map(str::to_string))
            .collect(),
        attachment_ids: value
            .get("attachments")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|attachment| {
                ["id", "file_id", "callback_id"]
                    .into_iter()
                    .find_map(|key| attachment.get(key).and_then(value_as_id))
            })
            .collect(),
    })
    .map(|mut message| {
        if message.permalink.is_empty() {
            if let Some(conversation) = conversation {
                message.permalink = format!("slack://channel?team=&id={}", conversation.id);
            }
        }
        message
    })
}

fn compact_search_notification(
    value: &Value,
    users: &BTreeMap<String, User>,
    self_user_id: &str,
) -> Option<Notification> {
    let channel = value.get("channel")?;
    let conversation = compact_conversation(channel, users)?;
    let message = compact_message(value, Some(&conversation), users)?;
    let mention = value_string(value, "text").contains(&format!("<@{self_user_id}>"));
    Some(Notification {
        key: format!("{}:{}", conversation.id, message.ts),
        conversation_id: conversation.id.clone(),
        conversation_name: conversation.name,
        kind: conversation.kind,
        message,
        unread: value_bool(value, "is_unread") || value_bool(value, "unread"),
        mention,
    })
}

fn compact_file(value: &Value, users: &BTreeMap<String, User>) -> Option<SlackFile> {
    let id = value_string(value, "id");
    if id.is_empty() {
        return None;
    }
    let user_id = value_string(value, "user");
    let mut provenance = Vec::new();
    for visibility in ["public", "private"] {
        if let Some(shares) = value
            .pointer(&format!("/shares/{visibility}"))
            .and_then(Value::as_object)
        {
            for (channel_id, entries) in shares {
                let name = entries
                    .as_array()
                    .and_then(|items| items.first())
                    .map(|entry| value_string(entry, "channel_name"))
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| channel_id.clone());
                if !provenance.contains(&name) {
                    provenance.push(name);
                }
            }
        }
    }
    Some(SlackFile {
        id,
        title: first_string(value, &["title", "name"]),
        file_type: first_string(value, &["pretty_type", "filetype", "mimetype"]),
        author: users
            .get(&user_id)
            .map_or_else(|| user_id.clone(), |user| user.label().to_string()),
        user_id,
        created_at: timestamp_to_iso(&first_string(value, &["created", "timestamp"])),
        updated_at: timestamp_to_iso(&value_string(value, "updated")),
        size_bytes: value.get("size").and_then(Value::as_u64).unwrap_or(0),
        permalink: value_string(value, "permalink"),
        provenance,
        access: value_string(value, "access"),
        download_url: first_string(value, &["url_private_download", "url_private"]),
        content_markdown: String::new(),
        content_status: "not_loaded".into(),
        content_fetched_at: None,
    })
}

fn flatten_blocks(blocks: Option<&Value>) -> String {
    blocks
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(flatten_rich_value)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn flatten_rich_value(value: &Value) -> String {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "text" => value_string(value, "text"),
        "link" => {
            let url = value_string(value, "url");
            let label = value_string(value, "text");
            if label.is_empty() {
                url
            } else {
                format!("[{label}]({url})")
            }
        }
        "user" => format!("<@{}>", value_string(value, "user_id")),
        "channel" => format!("<#{}>", value_string(value, "channel_id")),
        "emoji" => format!(":{}:", value_string(value, "name")),
        "rich_text_list" => {
            let marker = if value_string(value, "style") == "ordered" {
                "1. "
            } else {
                "• "
            };
            value
                .get("elements")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|element| format!("{marker}{}", flatten_rich_value(element)))
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => value
            .get("elements")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(flatten_rich_value)
            .collect::<String>(),
    }
}

fn slack_text_to_markdown(value: &str, users: &BTreeMap<String, User>) -> String {
    let decoded = decode_entities(value);
    let mut output = String::with_capacity(decoded.len());
    let mut rest = decoded.as_str();
    while let Some(start) = rest.find('<') {
        output.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('>') else {
            output.push_str(&rest[start..]);
            return output;
        };
        let token = &after[..end];
        let rendered = if let Some(user_id) = token.strip_prefix('@') {
            users.get(user_id).map_or_else(
                || format!("@{user_id}"),
                |user| format!("@{}", user.label()),
            )
        } else if let Some(channel) = token.strip_prefix('#') {
            let (_, label) = channel.split_once('|').unwrap_or((channel, channel));
            format!("#{label}")
        } else {
            let (url, label) = token.split_once('|').unwrap_or((token, token));
            if url.starts_with("http://") || url.starts_with("https://") {
                format!("[{label}]({url})")
            } else {
                label.to_string()
            }
        };
        output.push_str(&rendered);
        rest = &after[end + 1..];
    }
    output.push_str(rest);
    output
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn rebuild_dm_notifications(state: &mut CacheState) {
    let mut notifications = state.notifications.clone();
    let since = CacheState::seven_days_ago() as f64;
    for conversation in state
        .conversations
        .iter()
        .filter(|conversation| conversation.kind.is_dm())
    {
        for message in state
            .messages
            .get(&conversation.id)
            .into_iter()
            .flatten()
            .filter(|message| message.unix_ts() >= since)
        {
            notifications.push(Notification {
                key: format!("{}:{}", conversation.id, message.ts),
                conversation_id: conversation.id.clone(),
                conversation_name: conversation.name.clone(),
                kind: conversation.kind,
                message: message.clone(),
                unread: conversation.unread_count > 0,
                mention: false,
            });
        }
    }
    dedup_notifications(&mut notifications);
    state.notifications = notifications;
}

fn dedup_notifications(notifications: &mut Vec<Notification>) {
    let mut seen = HashSet::new();
    notifications.retain(|notification| seen.insert(notification.key.clone()));
}

fn merge_notifications(
    mut cached: Vec<Notification>,
    incoming: Vec<Notification>,
    oldest: f64,
) -> Vec<Notification> {
    cached.extend(incoming);
    cached.retain(|notification| notification.message.unix_ts() >= oldest);
    dedup_notifications(&mut cached);
    cached
}

fn merge_files(cached: Vec<SlackFile>, incoming: Vec<SlackFile>) -> Vec<SlackFile> {
    let mut merged: HashMap<String, SlackFile> = cached
        .into_iter()
        .map(|file| (file.id.clone(), file))
        .collect();
    for mut file in incoming {
        if let Some(previous) = merged.get(&file.id) {
            file.content_markdown.clone_from(&previous.content_markdown);
            file.content_status.clone_from(&previous.content_status);
            file.content_fetched_at = previous.content_fetched_at;
        }
        merged.insert(file.id.clone(), file);
    }
    merged.into_values().collect()
}

fn search_page_count(value: &Value, family: &str) -> u32 {
    [
        format!("/{family}/pagination/page_count"),
        format!("/{family}/paging/pages"),
    ]
    .iter()
    .find_map(|pointer| {
        value.pointer(pointer).and_then(|value| match value {
            Value::Number(number) => number.as_u64(),
            Value::String(number) => number.parse().ok(),
            _ => None,
        })
    })
    .and_then(|pages| u32::try_from(pages).ok())
    .unwrap_or(1)
}

fn value_string(value: &Value, key: &str) -> String {
    value.get(key).and_then(value_as_id).unwrap_or_default()
}

fn first_string(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| {
            value
                .get(*key)
                .and_then(value_as_id)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_default()
}

fn value_pointer_string(value: &Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(value_as_id)
        .unwrap_or_default()
}

fn first_pointer_string(value: &Value, pointers: &[&str]) -> String {
    pointers
        .iter()
        .find_map(|pointer| {
            value
                .pointer(pointer)
                .and_then(value_as_id)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_default()
}

fn value_as_id(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn value_as_timestamp(value: &Value) -> Option<String> {
    value_as_id(value).map(|value| {
        let mut seconds = value.parse::<f64>().unwrap_or(0.0);
        // Slack's `updated` conversation field is milliseconds, while message
        // `ts` and file timestamps are seconds.
        if seconds > 100_000_000_000.0 {
            seconds /= 1000.0;
        }
        format!("{seconds:.6}")
    })
}

fn value_bool(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn value_u32(value: &Value, key: &str) -> u32 {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(0)
}

fn timestamp_to_iso(value: &str) -> String {
    value
        .parse::<f64>()
        .ok()
        .and_then(|seconds| DateTime::from_timestamp(seconds as i64, 0))
        .map_or_else(
            || value.to_string(),
            |date: DateTime<Utc>| date.to_rfc3339(),
        )
}

fn date_filter(timestamp: i64) -> String {
    DateTime::from_timestamp(timestamp, 0).map_or_else(
        || "1970-01-01".to_string(),
        |date: DateTime<Utc>| date.format("%Y-%m-%d").to_string(),
    )
}

fn truncate_chars(value: &str, max: usize) -> (String, bool) {
    if value.chars().count() <= max {
        return (value.to_string(), false);
    }
    let mut result: String = value.chars().take(max.saturating_sub(1)).collect();
    result.push('…');
    (result, true)
}

#[must_use]
pub fn demo_state() -> CacheState {
    let mut state = CacheState {
        team_id: "T_DEMO".into(),
        team_name: "Slick Workspace".into(),
        self_user_id: "U_ME".into(),
        self_username: "you".into(),
        ..CacheState::default()
    };
    for (id, username, display, title) in [
        ("U_ADA", "ada", "Ada Lovelace", "Research"),
        ("U_GRACE", "grace", "Grace Hopper", "Engineering"),
        ("U_LINUS", "linus", "Linus", "Platform"),
    ] {
        state.users.insert(
            id.into(),
            User {
                id: id.into(),
                username: username.into(),
                display_name: display.into(),
                real_name: display.into(),
                title: title.into(),
                ..User::default()
            },
        );
    }
    state.conversations = vec![
        Conversation {
            id: "D_ADA".into(),
            name: "Ada Lovelace".into(),
            kind: ConversationKind::Dm,
            user_id: Some("U_ADA".into()),
            unread_count: 2,
            latest_ts: Some("1784901498.0".into()),
            ..Conversation::default()
        },
        Conversation {
            id: "G_TEAM".into(),
            name: "health-design".into(),
            kind: ConversationKind::GroupDm,
            unread_count: 1,
            latest_ts: Some("1784898963.0".into()),
            ..Conversation::default()
        },
        Conversation {
            id: "C_GENERAL".into(),
            name: "general".into(),
            kind: ConversationKind::Channel,
            is_member: true,
            topic: "Company-wide announcements and work-based matters".into(),
            latest_ts: Some("1784898000.0".into()),
            ..Conversation::default()
        },
        Conversation {
            id: "C_SLICK".into(),
            name: "proj-slick".into(),
            kind: ConversationKind::PrivateChannel,
            is_member: true,
            topic: "Building a better Slack terminal".into(),
            latest_ts: Some("1784897000.0".into()),
            ..Conversation::default()
        },
    ];
    let messages = vec![
        Message { ts: "1784897000.0".into(), timestamp: "2026-07-24T12:03:20Z".into(), user_id: "U_GRACE".into(), author: "Grace Hopper".into(), reply_count: 2, text: "## Welcome to Slick\n\nA **read-only** Slack TUI with:\n\n- compact message views\n- cached seven-day activity\n- rich Canvas Markdown\n- keyboard *and* mouse navigation".into(), permalink: "https://example.slack.com/demo/1".into(), ..Message::default() },
        Message { ts: "1784898000.0".into(), timestamp: "2026-07-24T12:20:00Z".into(), user_id: "U_ADA".into(), author: "Ada Lovelace".into(), text: "The analytical engine weaves algebraic patterns just as the Jacquard loom weaves flowers and leaves.\n\n> Ctrl-R refreshes only this visible conversation and the DM list.".into(), permalink: "https://example.slack.com/demo/2".into(), ..Message::default() },
    ];
    state.messages.insert("D_ADA".into(), messages.clone());
    state.messages.insert("C_GENERAL".into(), messages.clone());
    state.threads.insert(
        CacheState::thread_key("D_ADA", "1784897000.0"),
        vec![
            messages[0].clone(),
            Message {
                ts: "1784897100.0".into(),
                timestamp: "2026-07-24T12:05:00Z".into(),
                user_id: "U_ADA".into(),
                author: "Ada Lovelace".into(),
                text: "Threads keep the main conversation compact.".into(),
                ..Message::default()
            },
            Message {
                ts: "1784897200.0".into(),
                timestamp: "2026-07-24T12:06:40Z".into(),
                user_id: "U_GRACE".into(),
                author: "Grace Hopper".into(),
                text: "Press `q` to pop back to the channel.".into(),
                ..Message::default()
            },
        ],
    );
    state.notifications = vec![
        Notification {
            key: "D_ADA:1784898000".into(),
            conversation_id: "D_ADA".into(),
            conversation_name: "Ada Lovelace".into(),
            kind: ConversationKind::Dm,
            message: messages[1].clone(),
            unread: true,
            mention: false,
        },
        Notification {
            key: "G_TEAM:1784897000".into(),
            conversation_id: "G_TEAM".into(),
            conversation_name: "health-design".into(),
            kind: ConversationKind::GroupDm,
            message: messages[0].clone(),
            unread: true,
            mention: true,
        },
    ];
    state.files = vec![
        SlackFile { id: "F_CANVAS".into(), title: "Slick Product Brief".into(), file_type: "Canvas".into(), user_id: "U_ADA".into(), author: "Ada Lovelace".into(), created_at: "2026-07-20T09:00:00Z".into(), updated_at: "2026-07-24T12:00:00Z".into(), size_bytes: 8192, permalink: "https://example.slack.com/docs/F_CANVAS".into(), provenance: vec!["proj-slick".into(), "health-design".into()], access: "read".into(), download_url: "https://files.slack.com/files-pri/T_DEMO-F_CANVAS/download/canvas".into(), content_markdown: "# Slick Product Brief\n\nSlick mirrors Slack's familiar layout while keeping the signal compact.\n\n## Interaction\n\n| Action | Shortcut |\n|---|---|\n| Refresh active view | `Ctrl-R` |\n| Move focus | `Tab` |\n| Open item | `Enter` |\n| Search locally | `/` |\n\n## Principles\n\n- **Read-only by design**\n- Cache first, then refresh incrementally\n- Canvas documents become rich Markdown\n- Ratakittui chrome uses Kitty graphics when available\n\n```rust\nfn refresh(scope: VisibleView, since: Timestamp) {\n    // no full-history redownload\n}\n```\n".into(), content_status: "ok".into(), content_fetched_at: Some(CacheState::now()) },
        SlackFile { id: "F_PDF".into(), title: "Architecture.pdf".into(), file_type: "PDF".into(), user_id: "U_GRACE".into(), author: "Grace Hopper".into(), created_at: "2026-07-21T10:00:00Z".into(), updated_at: "2026-07-21T10:00:00Z".into(), size_bytes: 65536, permalink: "https://example.slack.com/files/F_PDF".into(), provenance: vec!["proj-slick".into()], access: "read".into(), content_markdown: "# Architecture.pdf\n\nMetadata-only in Slick 0.1. Open the permalink in Slack for binary content.".into(), content_status: "metadata_only".into(), ..SlackFile::default() },
    ];
    state.saved_at = Some(CacheState::now());
    state.normalize();
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_round_trip_and_clear_on_take() {
        // The worker drains this into the status line, so a stale notice must
        // not repeat on the next successful refresh.
        record_notice(SlackNotice {
            message: "partial activity: 1 of 2 mention/DM searches failed".into(),
            rate_limited: false,
            retry_after_secs: None,
            partial: true,
        });
        assert_eq!(
            take_notice().as_deref(),
            Some("partial activity: 1 of 2 mention/DM searches failed")
        );
        assert_eq!(take_notice(), None, "taking a notice must clear it");
    }

    #[test]
    fn rate_limited_detects_both_slack_throttle_shapes() {
        // HTTP 429 with no JSON body.
        assert!(is_rate_limited(StatusCode::TOO_MANY_REQUESTS, None));
        // Slack also answers 200 with ok:false / error:"ratelimited".
        assert!(is_rate_limited(StatusCode::OK, Some("ratelimited")));
        assert!(!is_rate_limited(StatusCode::OK, Some("invalid_auth")));
        assert!(!is_rate_limited(StatusCode::OK, None));
    }

    #[test]
    fn retry_after_is_authoritative_and_capped() {
        // Slack's Retry-After wins over the exponential schedule.
        let delay = rate_limit_delay(0, Some(7), 0);
        assert_eq!(delay.as_secs(), 7);
        // An absurd Retry-After must not wedge the worker thread.
        let delay = rate_limit_delay(0, Some(6000), 0);
        assert_eq!(delay.as_secs(), MAX_RATE_LIMIT_WAIT.as_secs());
    }

    #[test]
    fn backoff_grows_and_jitters_without_retry_after() {
        assert_eq!(rate_limit_delay(0, None, 0).as_secs(), 1);
        assert_eq!(rate_limit_delay(1, None, 0).as_secs(), 2);
        assert_eq!(rate_limit_delay(2, None, 0).as_secs(), 4);
        // Jitter is additive, bounded, and never collapses the base wait.
        let jittered = rate_limit_delay(1, None, 1_234);
        assert!(jittered >= Duration::from_secs(2));
        assert!(jittered < Duration::from_millis(2_250));
    }

    #[test]
    fn search_pagination_accepts_modern_and_legacy_slack_shapes() {
        let modern = serde_json::json!({
            "messages": { "pagination": { "page_count": 85 } }
        });
        assert_eq!(search_page_count(&modern, "messages"), 85);
        let legacy = serde_json::json!({
            "files": { "paging": { "pages": "12" } }
        });
        assert_eq!(search_page_count(&legacy, "files"), 12);
        assert_eq!(search_page_count(&serde_json::json!({}), "messages"), 1);
    }

    #[test]
    fn rich_blocks_flatten_with_list_boundaries() {
        let value = serde_json::json!({
          "type": "rich_text_list", "style": "bullet", "elements": [
            {"type":"rich_text_section","elements":[{"type":"text","text":"one"}]},
            {"type":"rich_text_section","elements":[{"type":"text","text":"two"}]}
          ]
        });
        assert_eq!(flatten_rich_value(&value), "• one\n• two");
    }

    #[test]
    fn slack_markup_becomes_markdown_and_names() {
        let mut users = BTreeMap::new();
        users.insert(
            "U1".into(),
            User {
                id: "U1".into(),
                display_name: "Ada".into(),
                ..User::default()
            },
        );
        assert_eq!(
            slack_text_to_markdown(
                "Hi <@U1> see <https://example.com|docs> &amp; <#C1|general>",
                &users
            ),
            "Hi @Ada see [docs](https://example.com) & #general"
        );
    }

    #[test]
    fn compact_conversation_names_dm_from_user() {
        let mut users = BTreeMap::new();
        users.insert(
            "U1".into(),
            User {
                id: "U1".into(),
                real_name: "Ada Lovelace".into(),
                ..User::default()
            },
        );
        let value = serde_json::json!({"id":"D1","is_im":true,"user":"U1","unread_count":2});
        let conversation = compact_conversation(&value, &users).unwrap();
        assert_eq!(conversation.name, "Ada Lovelace");
        assert_eq!(conversation.kind, ConversationKind::Dm);
        assert_eq!(conversation.unread_count, 2);
    }

    #[test]
    fn incremental_file_refresh_keeps_cached_content() {
        let cached = SlackFile {
            id: "F1".into(),
            title: "Old title".into(),
            content_markdown: "# Cached body".into(),
            content_status: "ok".into(),
            content_fetched_at: Some(7),
            ..SlackFile::default()
        };
        let incoming = SlackFile {
            id: "F1".into(),
            title: "New title".into(),
            ..SlackFile::default()
        };
        let merged = merge_files(vec![cached], vec![incoming]);
        assert_eq!(merged[0].title, "New title");
        assert_eq!(merged[0].content_markdown, "# Cached body");
        assert_eq!(merged[0].content_fetched_at, Some(7));
    }

    #[test]
    fn incremental_notification_refresh_deduplicates_and_keeps_window() {
        let notification = |key: &str, ts: &str| Notification {
            key: key.into(),
            message: Message {
                ts: ts.into(),
                ..Message::default()
            },
            ..Notification::default()
        };
        let merged = merge_notifications(
            vec![notification("same", "10"), notification("old", "1")],
            vec![notification("same", "10"), notification("new", "20")],
            5.0,
        );
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().any(|item| item.key == "same"));
        assert!(merged.iter().any(|item| item.key == "new"));
    }

    #[test]
    fn demo_has_all_primary_surfaces() {
        let demo = demo_state();
        assert!(!demo.notifications.is_empty());
        assert!(demo.conversations.iter().any(|item| item.kind.is_dm()));
        assert!(demo.conversations.iter().any(|item| !item.kind.is_dm()));
        assert!(demo.files.iter().any(SlackFile::is_canvas));
    }
}
