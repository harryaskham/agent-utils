//! Long-running cache collector and authenticated snapshot/SSE server.
//!
//! One daemon owns Slack API consumption. It refreshes one independently-aged
//! domain at a time, chooses the largest overdue coverage gap, persists every
//! outcome atomically, and publishes the same state to smart clients.

use std::collections::{BTreeMap, VecDeque};
use std::fmt::Write as FmtWrite;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

use crate::cache::CacheStore;
use crate::model::{CacheState, CollectorHealth, ConversationKind, RefreshState, SEVEN_DAYS_SECS};
use crate::query::{project_state, Surface};
use crate::slack::{IncompleteCoverage, SlackNotice, SlackService};
use anyhow::{bail, Context, Result};

const HTTP_READ_LIMIT: usize = 16 * 1024;
const SSE_KEEPALIVE_SECS: u64 = 15;
const MAX_FAILURE_BACKOFF_SECS: i64 = 60 * 60;
const COVERAGE_CONTINUE_SECS: i64 = 8;

/// Runtime inputs resolved by the CLI/config layer.
#[derive(Clone, Debug)]
pub struct DaemonOptions {
    pub cache_store: CacheStore,
    pub bind: String,
    pub token_path: PathBuf,
    pub min_refresh_secs: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RefreshKind {
    Identity,
    Sidebar,
    Notifications,
    SelfActivity,
    Files,
    Conversation(String),
    Thread {
        conversation_id: String,
        thread_ts: String,
    },
    FileContent(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RefreshTask {
    key: String,
    kind: RefreshKind,
    interval_secs: i64,
    priority: i64,
}

impl RefreshTask {
    fn identity() -> Self {
        Self {
            key: "identity".into(),
            kind: RefreshKind::Identity,
            interval_secs: 6 * 60 * 60,
            priority: 20,
        }
    }

    fn sidebar() -> Self {
        Self {
            key: "sidebar".into(),
            kind: RefreshKind::Sidebar,
            interval_secs: 5 * 60,
            priority: 80,
        }
    }
}

/// Single-writer state shared with HTTP connection threads.
struct SharedCache {
    state: Mutex<CacheState>,
    changed: Condvar,
    store: CacheStore,
    refresh_requests: Mutex<VecDeque<String>>,
}

impl SharedCache {
    fn new(state: CacheState, store: CacheStore) -> Self {
        Self {
            state: Mutex::new(state),
            changed: Condvar::new(),
            store,
            refresh_requests: Mutex::new(VecDeque::new()),
        }
    }

    fn snapshot(&self) -> CacheState {
        self.state.lock().map_or_else(
            |poisoned| poisoned.into_inner().clone(),
            |state| state.clone(),
        )
    }

    fn request_refresh(&self, domain: String) {
        let mut requests = self
            .refresh_requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !requests.contains(&domain) {
            requests.push_back(domain);
        }
    }

    fn take_refresh_request(&self) -> Option<String> {
        self.refresh_requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pop_front()
    }

    fn update(&self, mutate: impl FnOnce(&mut CacheState)) {
        let snapshot = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            mutate(&mut state);
            state.collector.revision = state.collector.revision.saturating_add(1);
            state.saved_at = Some(CacheState::now());
            state.clone()
        };
        if let Err(error) = self.store.save(&snapshot) {
            eprintln!("slick daemon: cache save failed: {error:#}");
        }
        self.changed.notify_all();
    }

    fn replace_payload(&self, mut state: CacheState, mutate: impl FnOnce(&mut CacheState)) {
        let snapshot = {
            let mut current = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // In-flight notices may have updated collector health while the
            // Slack call modified an unlocked payload clone.
            state.collector = current.collector.clone();
            mutate(&mut state);
            state.collector.revision = state.collector.revision.saturating_add(1);
            state.saved_at = Some(CacheState::now());
            *current = state.clone();
            state
        };
        if let Err(error) = self.store.save(&snapshot) {
            eprintln!("slick daemon: cache save failed: {error:#}");
        }
        self.changed.notify_all();
    }
}

/// Run the collector until the process is stopped by its supervisor.
pub fn run(options: DaemonOptions) -> Result<()> {
    let token = load_or_create_token(&options.token_path)?;
    let mut initial = options.cache_store.load().unwrap_or_default();
    initial.collector.running = true;
    initial.collector.last_error.clear();
    let shared = Arc::new(SharedCache::new(initial, options.cache_store));
    let address = start_http_server(&options.bind, Arc::clone(&shared), token)?;
    eprintln!(
        "slick daemon: serving authenticated snapshots at http://{address} (token file {})",
        options.token_path.display()
    );
    shared.update(|state| state.collector.running = true);

    let notice_shared = Arc::clone(&shared);
    let service = SlackService::from_environment_with_notice(Arc::new(move |notice| {
        publish_notice(&notice_shared, &notice);
    }))?;
    let spacing = Duration::from_secs(options.min_refresh_secs.max(1));

    loop {
        let now = CacheState::now();
        let snapshot = shared.snapshot();
        if let Some(until) = snapshot
            .collector
            .rate_limited_until
            .filter(|until| *until > now)
        {
            thread::sleep(Duration::from_secs(
                u64::try_from((until - now).clamp(1, 30)).unwrap_or(1),
            ));
            continue;
        }

        let requested = shared
            .take_refresh_request()
            .and_then(|key| requested_task(&snapshot, &key));
        let Some(task) = requested.or_else(|| select_task(&snapshot, now)) else {
            thread::sleep(Duration::from_secs(2));
            continue;
        };
        shared.update(|state| {
            state.collector.current_domain = Some(task.key.clone());
            state.collector.last_cycle_at = Some(now);
            let domain = state.domain_health_mut(&task.key);
            domain.state = RefreshState::Refreshing;
            domain.last_attempt_at = Some(now);
            domain.detail = format!("refreshing {}", task_label(&task));
        });

        let mut working = shared.snapshot();
        let before = working.clone();
        let result = run_task(&service, &mut working, &task);
        let changed = payload_changed(&before, &working);
        let finished = CacheState::now();
        shared.replace_payload(working, |state| {
            state.collector.current_domain = None;
            state.collector.last_cycle_at = Some(finished);
            let domain = state.domain_health_mut(&task.key);
            match &result {
                Ok(()) => {
                    domain.state = RefreshState::Healthy;
                    domain.last_success_at = Some(finished);
                    domain.next_attempt_at = Some(finished.saturating_add(task.interval_secs));
                    domain.consecutive_failures = 0;
                    domain.detail = format!("complete {}", task_label(&task));
                    state.collector.rate_limited_until = None;
                    state.collector.last_error.clear();
                }
                Err(error) if error.downcast_ref::<IncompleteCoverage>().is_some() => {
                    domain.state = RefreshState::Partial;
                    domain.next_attempt_at = Some(finished.saturating_add(COVERAGE_CONTINUE_SECS));
                    domain.consecutive_failures = 0;
                    domain.detail = error.to_string();
                    state.collector.rate_limited_until = None;
                    state.collector.last_error.clear();
                }
                Err(error) => {
                    let failures = domain.consecutive_failures.saturating_add(1);
                    domain.consecutive_failures = failures;
                    let backoff = failure_backoff(failures);
                    domain.next_attempt_at = Some(finished.saturating_add(backoff));
                    domain.state = if error.to_string().contains("ratelimited") {
                        RefreshState::Backoff
                    } else if changed || error.to_string().contains("partial") {
                        RefreshState::Partial
                    } else {
                        RefreshState::Error
                    };
                    domain.detail = format!("{error:#}");
                    let is_backoff = domain.state == RefreshState::Backoff;
                    let next_attempt_at = domain.next_attempt_at;
                    state.collector.last_error = format!("{}: {error:#}", task.key);
                    if is_backoff {
                        state.collector.rate_limited_until = next_attempt_at;
                    }
                }
            }
        });
        let status = shared.snapshot();
        match &result {
            Ok(()) => eprintln!(
                "slick daemon: complete domain={} conversations={} activity={} files={} streams={} next={}s",
                task.key,
                status.conversations.len(),
                status.notifications.len(),
                status.files.len(),
                status.messages.len(),
                task.interval_secs,
            ),
            Err(error) if error.downcast_ref::<IncompleteCoverage>().is_some() => eprintln!(
                "slick daemon: progress domain={} detail={} next={}s",
                task.key, error, COVERAGE_CONTINUE_SECS,
            ),
            Err(error) => eprintln!("slick daemon: failed domain={} error={error:#}", task.key),
        }
        thread::sleep(spacing);
    }
}

fn run_task(service: &SlackService, state: &mut CacheState, task: &RefreshTask) -> Result<()> {
    match &task.kind {
        RefreshKind::Identity => service.refresh_identity(state),
        RefreshKind::Sidebar => service.refresh_sidebar(state),
        RefreshKind::Notifications => service.refresh_notifications(state),
        RefreshKind::SelfActivity => service.refresh_self_activity(state),
        RefreshKind::Files => service.refresh_files(state),
        RefreshKind::Conversation(id) => service.refresh_conversation(state, id),
        RefreshKind::Thread {
            conversation_id,
            thread_ts,
        } => service.refresh_thread(state, conversation_id, thread_ts),
        RefreshKind::FileContent(id) => service.load_file_content(state, id),
    }
}

fn task_label(task: &RefreshTask) -> &str {
    match task.kind {
        RefreshKind::Identity => "identity",
        RefreshKind::Sidebar => "conversation inventory",
        RefreshKind::Notifications => "activity feed",
        RefreshKind::SelfActivity => "recent self activity",
        RefreshKind::Files => "files",
        RefreshKind::Conversation(_) => "conversation messages",
        RefreshKind::Thread { .. } => "thread replies",
        RefreshKind::FileContent(_) => "file content",
    }
}

fn requested_task(state: &CacheState, key: &str) -> Option<RefreshTask> {
    let (kind, interval_secs, priority) = match key {
        "identity" => (RefreshKind::Identity, 6 * 60 * 60, 200),
        "sidebar" => (RefreshKind::Sidebar, 5 * 60, 200),
        "notifications" => (RefreshKind::Notifications, 30, 200),
        "self_activity" => (RefreshKind::SelfActivity, 15 * 60, 200),
        "files" => (RefreshKind::Files, 10 * 60, 200),
        _ if key.starts_with("conversation:") => {
            let id = key.strip_prefix("conversation:")?.to_string();
            if !state.conversations.iter().any(|item| item.id == id) {
                return None;
            }
            (RefreshKind::Conversation(id), 5 * 60, 200)
        }
        _ if key.starts_with("thread:") => {
            let value = key.strip_prefix("thread:")?;
            let (conversation_id, thread_ts) = value.split_once(':')?;
            (
                RefreshKind::Thread {
                    conversation_id: conversation_id.to_string(),
                    thread_ts: thread_ts.to_string(),
                },
                5 * 60,
                200,
            )
        }
        _ if key.starts_with("file-content:") => (
            RefreshKind::FileContent(key.strip_prefix("file-content:")?.to_string()),
            24 * 60 * 60,
            200,
        ),
        _ => return None,
    };
    Some(RefreshTask {
        key: key.to_string(),
        kind,
        interval_secs,
        priority,
    })
}

/// Pick the most overdue eligible domain. Missing coverage sorts before stale
/// coverage; among similarly-sized gaps, higher-value activity wins.
fn select_task(state: &CacheState, now: i64) -> Option<RefreshTask> {
    let mut tasks = Vec::new();
    if state.self_user_id.is_empty() || state.team_id.is_empty() {
        tasks.push(RefreshTask::identity());
    } else if state.conversations.is_empty() {
        tasks.push(RefreshTask::sidebar());
        tasks.push(RefreshTask::identity());
    } else {
        tasks.extend([
            RefreshTask {
                key: "notifications".into(),
                kind: RefreshKind::Notifications,
                interval_secs: 30,
                priority: 100,
            },
            RefreshTask::sidebar(),
            RefreshTask {
                key: "files".into(),
                kind: RefreshKind::Files,
                interval_secs: 10 * 60,
                priority: 35,
            },
            RefreshTask {
                key: "self_activity".into(),
                kind: RefreshKind::SelfActivity,
                interval_secs: 15 * 60,
                priority: 40,
            },
            RefreshTask::identity(),
        ]);
        let recent = now.saturating_sub(SEVEN_DAYS_SECS) as f64;
        tasks.extend(
            state
                .conversations
                .iter()
                .filter(|conversation| conversation.kind.is_dm() || conversation.is_member)
                .map(|conversation| {
                    let (interval_secs, priority) = if conversation.unread_count > 0 {
                        (45, 95)
                    } else if conversation.is_favorite {
                        (2 * 60, 75)
                    } else if conversation.kind != ConversationKind::Channel
                        || conversation.activity_ts() >= recent
                    {
                        (5 * 60, 60)
                    } else {
                        (60 * 60, 10)
                    };
                    RefreshTask {
                        key: format!("conversation:{}", conversation.id),
                        kind: RefreshKind::Conversation(conversation.id.clone()),
                        interval_secs,
                        priority,
                    }
                }),
        );
    }

    tasks
        .into_iter()
        .filter(|task| {
            state
                .collector
                .domains
                .get(&task.key)
                .and_then(|domain| domain.next_attempt_at)
                .is_none_or(|next| next <= now)
        })
        .filter_map(|task| {
            let refreshed = state.refreshed_at(&task.key);
            let due =
                refreshed.map_or(i64::MIN / 4, |last| last.saturating_add(task.interval_secs));
            if due > now {
                return None;
            }
            // A never-covered domain gets a large fixed gap. Otherwise score
            // absolute overdue seconds plus priority, so a genuinely old quiet
            // conversation eventually beats a repeatedly refreshed hot page.
            let score = refreshed.map_or(i64::MAX / 4, |_| {
                now.saturating_sub(due)
                    .saturating_mul(100)
                    .saturating_add(task.priority)
            });
            Some((score, task.priority, task))
        })
        .max_by_key(|(score, priority, _)| (*score, *priority))
        .map(|(_, _, task)| task)
}

fn failure_backoff(failures: u32) -> i64 {
    (5_i64.saturating_mul(1_i64 << failures.min(10))).min(MAX_FAILURE_BACKOFF_SECS)
}

fn payload_changed(before: &CacheState, after: &CacheState) -> bool {
    let mut before = before.clone();
    let mut after = after.clone();
    before.collector = CollectorHealth::default();
    after.collector = CollectorHealth::default();
    before.saved_at = None;
    after.saved_at = None;
    before != after
}

fn publish_notice(shared: &SharedCache, notice: &SlackNotice) {
    eprintln!("slick daemon: notice {}", notice.message);
    let now = CacheState::now();
    shared.update(|state| {
        let key = state.collector.current_domain.clone();
        if notice.rate_limited {
            let seconds = i64::try_from(notice.retry_after_secs.unwrap_or(1)).unwrap_or(1);
            state.collector.rate_limited_until = Some(now.saturating_add(seconds));
        }
        if let Some(key) = key {
            let domain = state.domain_health_mut(&key);
            domain.state = if notice.rate_limited {
                RefreshState::Backoff
            } else if notice.partial {
                RefreshState::Partial
            } else {
                domain.state.clone()
            };
            domain.detail.clone_from(&notice.message);
        }
        state.collector.last_error.clone_from(&notice.message);
    });
}

fn load_or_create_token(path: &Path) -> Result<String> {
    if path.exists() {
        let token = fs::read_to_string(path)
            .with_context(|| format!("read Slick daemon token {}", path.display()))?
            .trim()
            .to_string();
        if token.len() < 32 {
            bail!(
                "Slick daemon token {} is empty or too short",
                path.display()
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(path)?.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                bail!(
                    "Slick daemon token {} has unsafe mode {mode:o}; require 0600 or stricter",
                    path.display()
                );
            }
        }
        return Ok(token);
    }
    let parent = path.parent().context("daemon token path has no parent")?;
    fs::create_dir_all(parent)
        .with_context(|| format!("create Slick config directory {}", parent.display()))?;
    let mut random = [0_u8; 32];
    fs::File::open("/dev/urandom")
        .context("open operating-system random source")?
        .read_exact(&mut random)
        .context("read operating-system random source")?;
    let mut token = String::with_capacity(random.len() * 2);
    for byte in random {
        write!(&mut token, "{byte:02x}").expect("writing to String cannot fail");
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("create Slick daemon token {}", path.display()))?;
    writeln!(file, "{token}")?;
    file.sync_all()?;
    Ok(token)
}

fn start_http_server(bind: &str, shared: Arc<SharedCache>, token: String) -> Result<SocketAddr> {
    let listener = TcpListener::bind(bind)
        .with_context(|| format!("bind Slick daemon HTTP server at {bind}"))?;
    let address = listener.local_addr().context("read Slick daemon address")?;
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let shared = Arc::clone(&shared);
                    let token = token.clone();
                    thread::spawn(move || {
                        if let Err(error) = serve_connection(stream, &shared, &token) {
                            eprintln!("slick daemon: client connection failed: {error:#}");
                        }
                    });
                }
                Err(error) => eprintln!("slick daemon: accept failed: {error}"),
            }
        }
    });
    Ok(address)
}

fn serve_connection(mut stream: TcpStream, shared: &SharedCache, token: &str) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let request = read_http_request(&mut stream)?;
    if !authorized(&request.headers, token) {
        return write_http_response(
            &mut stream,
            "401 Unauthorized",
            "text/plain",
            b"unauthorized\n",
        );
    }
    let route = request.path.split('?').next().unwrap_or_default();
    match (request.method.as_str(), route) {
        ("GET", "/snapshot") => {
            let body = serde_json::to_vec(&shared.snapshot()).context("serialize snapshot")?;
            write_http_response(&mut stream, "200 OK", "application/json", &body)
        }
        ("GET", route) if route.starts_with("/snapshot/") => {
            let Some(surface) = snapshot_surface(route, &request.path) else {
                return write_http_response(
                    &mut stream,
                    "404 Not Found",
                    "text/plain",
                    b"unknown snapshot surface\n",
                );
            };
            let body = serde_json::to_vec(&project_state(&shared.snapshot(), &surface))
                .context("serialize partial snapshot")?;
            write_http_response(&mut stream, "200 OK", "application/json", &body)
        }
        ("GET", "/health") => {
            let body = serde_json::to_vec(&shared.snapshot().collector)
                .context("serialize collector health")?;
            write_http_response(&mut stream, "200 OK", "application/json", &body)
        }
        ("GET", "/events") => serve_sse(stream, shared),
        ("POST", "/refresh") => {
            let domain = request
                .path
                .split_once('?')
                .and_then(|(_, query)| {
                    url::form_urlencoded::parse(query.as_bytes())
                        .find(|(name, _)| name == "domain")
                        .map(|(_, value)| value.into_owned())
                })
                .unwrap_or_default();
            if domain.is_empty() || requested_task(&shared.snapshot(), &domain).is_none() {
                return write_http_response(
                    &mut stream,
                    "400 Bad Request",
                    "text/plain",
                    b"unknown refresh domain\n",
                );
            }
            shared.request_refresh(domain);
            write_http_response(
                &mut stream,
                "202 Accepted",
                "application/json",
                b"{\"queued\":true}\n",
            )
        }
        _ => write_http_response(&mut stream, "404 Not Found", "text/plain", b"not found\n"),
    }
}

fn snapshot_surface(route: &str, path: &str) -> Option<Surface> {
    let id = || {
        path.split_once('?').and_then(|(_, query)| {
            url::form_urlencoded::parse(query.as_bytes())
                .find(|(name, _)| name == "id")
                .map(|(_, value)| value.into_owned())
        })
    };
    match route {
        "/snapshot/feed" => Some(Surface::Feed),
        "/snapshot/activity" => Some(Surface::Activity),
        "/snapshot/dms" => Some(Surface::Dms),
        "/snapshot/channels" => Some(Surface::Channels),
        "/snapshot/files" => Some(Surface::Files),
        "/snapshot/conversation" => id().map(Surface::Conversation),
        "/snapshot/file" => id().map(Surface::File),
        _ => None,
    }
}

struct HttpRequest {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 1024];
    while bytes.len() < HTTP_READ_LIMIT {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    if bytes.len() >= HTTP_READ_LIMIT {
        bail!("HTTP request headers exceed {HTTP_READ_LIMIT} bytes");
    }
    let text = std::str::from_utf8(&bytes).context("HTTP request is not UTF-8")?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().context("missing HTTP request line")?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .context("missing HTTP method")?
        .to_string();
    if !matches!(method.as_str(), "GET" | "POST") {
        bail!("only GET and POST are supported");
    }
    let path = request_parts
        .next()
        .context("missing HTTP path")?
        .to_string();
    let headers = lines
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    Ok(HttpRequest {
        method,
        path,
        headers,
    })
}

fn authorized(headers: &BTreeMap<String, String>, expected: &str) -> bool {
    let Some(candidate) = headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    constant_time_eq(candidate.as_bytes(), expected.as_bytes())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn write_http_response(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()?;
    Ok(())
}

fn serve_sse(mut stream: TcpStream, shared: &SharedCache) -> Result<()> {
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-store\r\nConnection: keep-alive\r\nX-Accel-Buffering: no\r\n\r\n"
    )?;
    let mut revision = u64::MAX;
    loop {
        let mut guard = shared
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard.collector.revision == revision {
            let waited = shared
                .changed
                .wait_timeout(guard, Duration::from_secs(SSE_KEEPALIVE_SECS))
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard = waited.0;
            if waited.1.timed_out() {
                drop(guard);
                stream.write_all(b": keepalive\n\n")?;
                stream.flush()?;
                continue;
            }
        }
        let snapshot = guard.clone();
        revision = snapshot.collector.revision;
        drop(guard);
        let data = serde_json::to_string(&snapshot).context("serialize SSE snapshot")?;
        write!(stream, "id: {revision}\nevent: snapshot\ndata: {data}\n\n")?;
        stream.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::{ClientOptions, ClientSubscription, ClientUpdate};
    use crate::model::{Conversation, DomainHealth};

    #[test]
    fn missing_prerequisites_schedule_identity_then_sidebar() {
        let state = CacheState::default();
        assert_eq!(select_task(&state, 1).unwrap().kind, RefreshKind::Identity);

        let mut state = CacheState {
            team_id: "T1".into(),
            self_user_id: "U1".into(),
            ..CacheState::default()
        };
        assert_eq!(select_task(&state, 1).unwrap().kind, RefreshKind::Sidebar);
        state.conversations.push(Conversation {
            id: "C1".into(),
            is_member: true,
            ..Conversation::default()
        });
        assert!(select_task(&state, 1).is_some());
    }

    #[test]
    fn oldest_overdue_gap_eventually_beats_hot_priority() {
        let now = 10_000;
        let mut state = CacheState {
            team_id: "T1".into(),
            self_user_id: "U1".into(),
            conversations: vec![Conversation {
                id: "C-old".into(),
                is_member: true,
                ..Conversation::default()
            }],
            ..CacheState::default()
        };
        for key in [
            "identity",
            "sidebar",
            "notifications",
            "files",
            "self_activity",
        ] {
            state.collector.domains.insert(
                key.into(),
                DomainHealth {
                    last_success_at: Some(now),
                    next_attempt_at: Some(now + 100),
                    ..DomainHealth::default()
                },
            );
        }
        state.collector.domains.insert(
            "conversation:C-old".into(),
            DomainHealth {
                last_success_at: Some(1),
                ..DomainHealth::default()
            },
        );
        assert_eq!(
            select_task(&state, now).unwrap().kind,
            RefreshKind::Conversation("C-old".into())
        );
    }

    #[test]
    fn failure_backoff_is_bounded_and_exponential() {
        assert_eq!(failure_backoff(1), 10);
        assert_eq!(failure_backoff(2), 20);
        assert_eq!(failure_backoff(3), 40);
        assert_eq!(failure_backoff(100), MAX_FAILURE_BACKOFF_SECS);
    }

    fn http_request(
        address: SocketAddr,
        method: &str,
        authorization: Option<&str>,
        path: &str,
    ) -> String {
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n{}\r\n",
            authorization.map_or_else(String::new, |token| format!(
                "Authorization: Bearer {token}\r\n"
            ))
        )
        .unwrap();
        stream.flush().unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn http_get(address: SocketAddr, authorization: Option<&str>, path: &str) -> String {
        http_request(address, "GET", authorization, path)
    }

    #[test]
    fn refresh_endpoint_authenticates_and_queues_domain() {
        let dir = std::env::temp_dir().join(format!(
            "slick-refresh-http-test-{}-{}",
            std::process::id(),
            CacheState::now()
        ));
        let shared = Arc::new(SharedCache::new(
            CacheState::default(),
            CacheStore::new(dir.join("state.json")),
        ));
        let token = "r".repeat(64);
        let address = start_http_server("127.0.0.1:0", Arc::clone(&shared), token.clone()).unwrap();
        assert!(
            http_request(address, "POST", None, "/refresh?domain=notifications")
                .starts_with("HTTP/1.1 401")
        );
        assert!(http_request(
            address,
            "POST",
            Some(&token),
            "/refresh?domain=notifications"
        )
        .starts_with("HTTP/1.1 202"));
        assert_eq!(
            shared.take_refresh_request().as_deref(),
            Some("notifications")
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn snapshot_endpoint_requires_bearer_and_returns_cache() {
        let dir = std::env::temp_dir().join(format!(
            "slick-http-test-{}-{}",
            std::process::id(),
            CacheState::now()
        ));
        let state = CacheState {
            team_name: "Authenticated workspace".into(),
            ..CacheState::default()
        };
        let shared = Arc::new(SharedCache::new(
            state,
            CacheStore::new(dir.join("state.json")),
        ));
        let address = start_http_server("127.0.0.1:0", shared, "x".repeat(64)).unwrap();
        assert!(http_get(address, None, "/snapshot").starts_with("HTTP/1.1 401"));
        let response = http_get(address, Some(&"x".repeat(64)), "/snapshot");
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("Authenticated workspace"), "{response}");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn partial_snapshot_routes_return_only_requested_surface() {
        let dir = std::env::temp_dir().join(format!(
            "slick-partial-http-test-{}-{}",
            std::process::id(),
            CacheState::now()
        ));
        let shared = Arc::new(SharedCache::new(
            crate::slack::demo_state(),
            CacheStore::new(dir.join("state.json")),
        ));
        let token = "p".repeat(64);
        let address = start_http_server("127.0.0.1:0", shared, token.clone()).unwrap();
        let response = http_get(address, Some(&token), "/snapshot/dms");
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        let body = response.split_once("\r\n\r\n").unwrap().1;
        let projection: crate::query::ProjectionSnapshot = serde_json::from_str(body).unwrap();
        assert_eq!(projection.surface, "dms");
        assert!(projection
            .state
            .conversations
            .iter()
            .all(|conversation| conversation.kind.is_dm()));
        assert!(projection.state.files.is_empty());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn cache_only_remote_client_receives_initial_and_live_sse_snapshots() {
        let dir = std::env::temp_dir().join(format!(
            "slick-sse-test-{}-{}",
            std::process::id(),
            CacheState::now()
        ));
        let server_store = CacheStore::new(dir.join("server.json"));
        let shared = Arc::new(SharedCache::new(
            CacheState {
                team_name: "initial".into(),
                ..CacheState::default()
            },
            server_store,
        ));
        let token_path = dir.join("daemon-token");
        let token = load_or_create_token(&token_path).unwrap();
        let address = start_http_server("127.0.0.1:0", Arc::clone(&shared), token).unwrap();
        let client_store = CacheStore::new(dir.join("client.json"));
        let subscription = ClientSubscription::spawn(ClientOptions {
            cache_store: client_store.clone(),
            use_cache: true,
            use_daemon: true,
            endpoint: format!("http://{address}"),
            token_path,
            fallback: false,
            fallback_timeout: Duration::from_secs(30),
            fallback_lease_path: dir.join("fallback.lock"),
        });
        let mut received_initial = false;
        for _ in 0..3 {
            let update = subscription
                .rx
                .recv_timeout(Duration::from_secs(3))
                .unwrap();
            if matches!(update, ClientUpdate::State(state, _) if state.team_name == "initial") {
                received_initial = true;
                break;
            }
        }
        assert!(
            received_initial,
            "initial daemon snapshot did not reach client"
        );
        assert!(subscription.request_refresh("notifications".into()));
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut queued = None;
        while std::time::Instant::now() < deadline && queued.is_none() {
            queued = shared.take_refresh_request();
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(queued.as_deref(), Some("notifications"));

        shared.update(|state| state.team_name = "live".into());
        let mut received_live = false;
        for _ in 0..3 {
            let update = subscription
                .rx
                .recv_timeout(Duration::from_secs(3))
                .unwrap();
            if matches!(update, ClientUpdate::State(state, _) if state.team_name == "live") {
                received_live = true;
                break;
            }
        }
        assert!(received_live, "SSE update did not reach cache-only client");
        assert_eq!(client_store.load().unwrap().team_name, "live");
        subscription.stop();
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn bearer_comparison_is_exact() {
        let mut headers = BTreeMap::new();
        headers.insert("authorization".into(), "Bearer secret-token".into());
        assert!(authorized(&headers, "secret-token"));
        assert!(!authorized(&headers, "secret-tokeN"));
        assert!(!authorized(&headers, "secret-token-long"));
    }

    #[test]
    fn generated_token_is_private_and_reusable() {
        let dir = std::env::temp_dir().join(format!(
            "slick-daemon-token-{}-{}",
            std::process::id(),
            CacheState::now()
        ));
        let path = dir.join("token");
        let first = load_or_create_token(&path).unwrap();
        let second = load_or_create_token(&path).unwrap();
        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_dir_all(dir).ok();
    }
}
