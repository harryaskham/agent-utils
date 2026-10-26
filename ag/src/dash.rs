//! `ag dash`: one live local web view of speech, choices, health, images and
//! shared audio.
//!
//! A real server, not a static generator: choices are re-read from Paratenic
//! while the page is open (stale-while-revalidate), doctor and the merged media
//! sync (images + audio, one cadence) run on intervals for the lifetime of the
//! command. Answers go through the same
//! `paratenic::answer` path as the TUI/CLI/MCP.
//!
//! Security: on a loopback or Tailscale address the network is the boundary and
//! no token is needed (`dash.access: auto`, the default). Elsewhere (wildcard
//! or LAN binds), or with `access: token`, every route requires a random token
//! (per-run, or from a private persistent file), exchanged once for an HttpOnly
//! SameSite=Strict cookie. Either way, mutations need a custom header (blocks
//! cross-site forms) and a same-origin Origin, and a bound address pins the
//! Host header (its address, this machine's names, the public origin) against
//! DNS rebinding.
use crate::{
    Error, Result,
    config::{Config, DashAccess, Host},
    dash_tts::{self, Delivery, Feed},
    doctor::{self, DoctorReport},
    gallery::{self, SyncInput, SyncReceipt},
    model::MediaKind,
    paratenic::{self, AnswerInput, AnswerReceipt, Endpoint, FleetChoices, NodeEndpoints},
    service::Service,
};
use axum::{
    Json, Router,
    extract::{Path as UrlPath, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{
        IntoResponse, Redirect, Response, Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    net::SocketAddr,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

const PAGE: &str = include_str!("../dash.html");
const MAX_FILE: u64 = 64 * 1024 * 1024;
/// While someone is looking, choices older than this are refreshed in the background.
const CHOICES_STALE_MS: u64 = 20_000;

#[derive(Clone, Debug)]
pub struct DashOptions {
    pub selection: crate::model::Selection,
    pub bind: SocketAddr,
    pub public_origin: Option<String>,
    pub access: DashAccess,
    pub token_file: Option<PathBuf>,
    pub refresh: Duration,
    pub image_refresh: Duration,
    pub images: bool,
    pub audio: bool,
    pub tts: bool,
    pub tts_lines: usize,
    pub cache_dir: Option<String>,
    pub audio_cache_dir: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ImageStatus {
    pub enabled: bool,
    pub running: bool,
    pub available: bool,
    pub images: usize,
    pub finished_ms: Option<u64>,
    pub error: Option<String>,
    pub hosts: Vec<gallery::GalleryHost>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct AudioStatus {
    pub enabled: bool,
    pub running: bool,
    pub available: bool,
    pub clips: usize,
    pub duration_ms: u64,
    pub finished_ms: Option<u64>,
    pub error: Option<String>,
    pub hosts: Vec<gallery::AudioHost>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Snapshot {
    pub choices: Option<FleetChoices>,
    pub choices_ms: Option<u64>,
    pub choices_refreshing: bool,
    pub doctor: Option<DoctorReport>,
    pub doctor_ms: Option<u64>,
    pub doctor_refreshing: bool,
    pub images: ImageStatus,
    pub audio: AudioStatus,
    pub receipts: VecDeque<AnswerReceipt>,
    pub refresh_seconds: u64,
    pub image_refresh_seconds: u64,
    pub tts: Option<dash_tts::Summary>,
}

struct Dash {
    config: Config,
    /// One per node with its Paratenic, pi-daemon and bridge: doctor and speech.
    targets: Vec<(Host, NodeEndpoints)>,
    /// Nodes plus their pi-daemons: choices and answers.
    choice_targets: Vec<(Host, Option<Endpoint>)>,
    endpoints: HashMap<String, Endpoint>,
    options: DashOptions,
    /// None: open access (tailnet or loopback); no cookie is checked.
    token: Option<String>,
    cookie: String,
    secure_cookie: bool,
    hosts: Option<Vec<String>>,
    snapshot: Mutex<Snapshot>,
    choices_busy: AtomicBool,
    doctor_busy: AtomicBool,
    images_busy: Arc<AtomicBool>,
    audio_busy: Arc<AtomicBool>,
    inflight: Mutex<HashSet<String>>,
    tts: Arc<Feed>,
    shutdown: tokio_util::sync::CancellationToken,
}
type Shared = Arc<Dash>;

fn lock(dash: &Dash) -> std::sync::MutexGuard<'_, Snapshot> {
    dash.snapshot.lock().unwrap_or_else(|e| e.into_inner())
}

fn eq(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// Only an origin: a path prefix, query, credentials or fragment would misroute
/// authentication/relative gallery URLs. Binding and public naming are separate.
pub fn validate_public_origin(value: &str) -> Result<url::Url> {
    let invalid = || {
        Error::Config("dash.public_origin must be an HTTP(S) origin without credentials, path, query or fragment".into())
    };
    if value.chars().any(char::is_control) || value.trim() != value {
        return Err(invalid());
    }
    let url = url::Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(url)
}

/// Runtime secret, never a Nix-store value. Existing managed symlinks are read
/// normally; a dangling link is an error, not permission to replace it.
fn persistent_token(path: &Path) -> Result<String> {
    match std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => {
            let meta = file.metadata()?;
            if !meta.is_file() || meta.permissions().mode() & 0o077 != 0 || meta.len() > 514 {
                return Err(Error::Config("dash token must be an owner-private regular file (managed symlinks are allowed)".into()));
            }
            let mut token = String::new();
            file.take(514).read_to_string(&mut token)?;
            let token = token.trim();
            if !(32..=512).contains(&token.len())
                || !token
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.~+/=".contains(&b))
            {
                return Err(Error::Config(
                    "dash token must contain 32–512 cookie-safe ASCII characters on one line"
                        .into(),
                ));
            }
            Ok(token.to_owned())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                _ => {
                    return Err(Error::Config(
                        "dash token target is unavailable; existing link left intact".into(),
                    ));
                }
            }
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)?;
            let token = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            let mut temp = tempfile::NamedTempFile::new_in(parent)?;
            writeln!(temp, "{token}")?;
            temp.as_file().sync_all()?;
            match temp.persist_noclobber(path) {
                Ok(_) => {
                    std::fs::File::open(parent)?.sync_all()?;
                    Ok(token)
                }
                Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    persistent_token(path)
                }
                Err(e) => Err(e.error.into()),
            }
        }
        Err(e) => Err(e.into()),
    }
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_owned())
}

impl Dash {
    fn host_ok(&self, headers: &HeaderMap) -> bool {
        let Some(allowed) = &self.hosts else {
            return true;
        };
        headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|h| allowed.iter().any(|a| a.eq_ignore_ascii_case(h)))
    }
    fn authorized(&self, headers: &HeaderMap) -> std::result::Result<(), Box<Response>> {
        if !self.host_ok(headers) {
            return Err(Box::new(
                (StatusCode::MISDIRECTED_REQUEST, "unexpected Host").into_response(),
            ));
        }
        let Some(token) = &self.token else {
            return Ok(());
        };
        match cookie(headers, &self.cookie) {
            Some(value) if eq(&value, token) => Ok(()),
            _ => Err(Box::new(
                (
                    StatusCode::UNAUTHORIZED,
                    "open the URL printed by `ag dash`",
                )
                    .into_response(),
            )),
        }
    }
    fn mutation(&self, headers: &HeaderMap) -> std::result::Result<(), Box<Response>> {
        self.authorized(headers)?;
        let header_ok = headers.get("x-ag-dash").is_some_and(|v| v == "1");
        let origin_ok = match (headers.get(header::ORIGIN), headers.get(header::HOST)) {
            (None, _) => true,
            (Some(origin), Some(host)) => origin
                .to_str()
                .ok()
                .and_then(|o| o.split_once("://").map(|(_, rest)| rest.to_owned()))
                .is_some_and(|o| host.to_str().is_ok_and(|h| o.eq_ignore_ascii_case(h))),
            _ => false,
        };
        if header_ok && origin_ok {
            Ok(())
        } else {
            Err(Box::new(
                (StatusCode::FORBIDDEN, "cross-origin request refused").into_response(),
            ))
        }
    }
}

fn now_ms() -> u64 {
    doctor::now_ms()
}

fn refresh_choices(dash: &Shared) {
    if dash.choices_busy.swap(true, Ordering::AcqRel) {
        return;
    }
    lock(dash).choices_refreshing = true;
    let dash = dash.clone();
    tokio::spawn(async move {
        let fleet =
            paratenic::fleet_choices(&dash.config, dash.choice_targets.clone(), false).await;
        {
            let mut snapshot = lock(&dash);
            snapshot.choices = Some(fleet);
            snapshot.choices_ms = Some(now_ms());
            snapshot.choices_refreshing = false;
        }
        dash.choices_busy.store(false, Ordering::Release);
    });
}

async fn refresh_node(dash: &Shared, host: &str) {
    let Some((h, e)) = dash
        .choice_targets
        .iter()
        .find(|(h, _)| h.name == host)
        .cloned()
    else {
        return;
    };
    let node = paratenic::node_choices(&dash.config, h, e, false).await;
    let mut snapshot = lock(dash);
    if let Some(fleet) = snapshot.choices.as_mut() {
        if let Some(slot) = fleet.nodes.iter_mut().find(|n| n.host == node.host) {
            *slot = node;
        }
        fleet.actionable = fleet
            .nodes
            .iter()
            .flat_map(|n| &n.agents)
            .flat_map(|a| &a.choices)
            .filter(|c| c.actionable)
            .count();
        fleet.observed_at = paratenic::now_rfc3339();
    }
}

fn refresh_doctor(dash: &Shared) {
    if dash.doctor_busy.swap(true, Ordering::AcqRel) {
        return;
    }
    lock(dash).doctor_refreshing = true;
    let dash = dash.clone();
    tokio::spawn(async move {
        let report = doctor::report(&dash.config, dash.targets.clone()).await;
        {
            let mut snapshot = lock(&dash);
            snapshot.doctor = Some(report);
            snapshot.doctor_ms = Some(now_ms());
            snapshot.doctor_refreshing = false;
        }
        dash.doctor_busy.store(false, Ordering::Release);
    });
}

/// One merged media sync (the same code path as `ag sync`) for the requested,
/// enabled and idle pathways. Each pathway keeps its own status and busy flag.
fn refresh_media(dash: &Shared, images: bool, audio: bool) {
    let images = images && dash.options.images && !dash.images_busy.swap(true, Ordering::AcqRel);
    let audio = audio && dash.options.audio && !dash.audio_busy.swap(true, Ordering::AcqRel);
    if !images && !audio {
        return;
    }
    {
        let mut snapshot = lock(dash);
        snapshot.images.running |= images;
        snapshot.audio.running |= audio;
    }
    let dash = dash.clone();
    let runtime = tokio::runtime::Handle::current();
    // Pulls own their own runtime (rsync children, Ctrl-C handling); a
    // dedicated thread keeps them off the server's runtime.
    std::thread::spawn(move || {
        let kinds = [(images, MediaKind::Image), (audio, MediaKind::Audio)]
            .into_iter()
            .filter_map(|(on, kind)| on.then_some(kind))
            .collect();
        let result: Result<SyncReceipt> =
            Service::new(dash.config.clone(), None).and_then(|service| {
                service.sync(SyncInput {
                    selection: dash.options.selection.clone(),
                    kinds,
                    image_cache_dir: dash.options.cache_dir.clone(),
                    audio_cache_dir: dash.options.audio_cache_dir.clone(),
                    offline: false,
                    checksum: false,
                    confirmed: true,
                })
            });
        {
            let mut snapshot = lock(&dash);
            let finished = Some(now_ms());
            let failure = result.as_ref().err().map(|e| e.to_string());
            let receipt = result.ok().unwrap_or_default();
            if images {
                let status = &mut snapshot.images;
                status.running = false;
                status.finished_ms = finished;
                match &receipt.images {
                    Some(r) => {
                        status.available = true;
                        status.images = r.images;
                        status.hosts = r.hosts.clone();
                        status.error = None;
                    }
                    None => {
                        status.error = failure
                            .clone()
                            .or_else(|| receipt.errors.get("image").cloned())
                    }
                }
            }
            if audio {
                let status = &mut snapshot.audio;
                status.running = false;
                status.finished_ms = finished;
                match &receipt.audio {
                    Some(r) => {
                        status.available = true;
                        status.clips = r.clips;
                        status.duration_ms = r.duration_ms;
                        status.hosts = r.hosts.clone();
                        status.error = None;
                    }
                    None => status.error = failure.or_else(|| receipt.errors.get("audio").cloned()),
                }
            }
        }
        if images {
            dash.images_busy.store(false, Ordering::Release);
        }
        if audio {
            dash.audio_busy.store(false, Ordering::Release);
        }
        // Media freshness is part of node health.
        runtime.spawn(async move { refresh_doctor(&dash) });
    });
}

async fn index(
    State(dash): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if let Some(token) = query.get("token") {
        if !dash.host_ok(&headers) {
            return (StatusCode::MISDIRECTED_REQUEST, "unexpected Host").into_response();
        }
        let mut response = Redirect::to("/").into_response();
        // Open access ignores old bookmarked ?token= links: just drop it.
        if let Some(expected) = &dash.token {
            if !eq(token, expected) {
                return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
            }
            if let Ok(value) = HeaderValue::from_str(&format!(
                "{}={}; Path=/; HttpOnly; SameSite=Strict{}",
                dash.cookie,
                expected,
                if dash.secure_cookie { "; Secure" } else { "" }
            )) {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
        }
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response.headers_mut().insert(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        );
        return response;
    }
    if let Err(response) = dash.authorized(&headers) {
        return *response;
    }
    let mut response = ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], PAGE).into_response();
    let csp = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(csp),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn state(State(dash): State<Shared>, headers: HeaderMap) -> Response {
    if let Err(response) = dash.authorized(&headers) {
        return *response;
    }
    let stale = lock(&dash)
        .choices_ms
        .is_none_or(|ms| now_ms().saturating_sub(ms) > CHOICES_STALE_MS);
    if stale {
        refresh_choices(&dash);
    }
    let mut snapshot = lock(&dash).clone();
    snapshot.tts = Some(dash.tts.summary());
    snapshot.images.available = snapshot.images.available
        || dash
            .media_root(MediaKind::Image)
            .is_some_and(|r| r.join("index.html").is_file());
    snapshot.audio.available = snapshot.audio.available
        || dash
            .media_root(MediaKind::Audio)
            .is_some_and(|r| r.join("index.html").is_file());
    let mut response = Json(snapshot).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn tts_script(State(dash): State<Shared>, headers: HeaderMap) -> Response {
    if let Err(response) = dash.authorized(&headers) {
        return *response;
    }
    (
        [
            (header::CONTENT_TYPE, "text/javascript; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        include_str!("../dash-tts.js"),
    )
        .into_response()
}

async fn tts_snapshot(State(dash): State<Shared>, headers: HeaderMap) -> Response {
    if let Err(response) = dash.authorized(&headers) {
        return *response;
    }
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(dash.tts.snapshot()),
    )
        .into_response()
}

/// Cookie-authenticated EventSource. Only event cursors (never bearer tokens)
/// appear in reconnect URLs. Slow readers pull from the bounded shared journal.
async fn tts_events(
    State(dash): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if let Err(response) = dash.authorized(&headers) {
        return *response;
    }
    if headers.get(header::ORIGIN).is_some_and(|origin| {
        origin
            .to_str()
            .ok()
            .and_then(|o| o.split_once("://").map(|(_, h)| h))
            .zip(headers.get(header::HOST).and_then(|h| h.to_str().ok()))
            .is_none_or(|(o, h)| !o.eq_ignore_ascii_case(h))
    }) {
        return (StatusCode::FORBIDDEN, "cross-origin request refused").into_response();
    }
    let Ok(permit) = dash.tts.clients.clone().try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::RETRY_AFTER, "5")],
            "too many speech viewers",
        )
            .into_response();
    };
    let after = headers
        .get("last-event-id")
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned)
        .or_else(|| query.get("after").cloned())
        .filter(|id| id.len() <= 96);
    let changed = dash.tts.changed.subscribe();
    let stream = futures_util::stream::unfold(
        (dash, changed, after, permit),
        |(dash, mut changed, mut after, permit)| async move {
            loop {
                if dash.shutdown.is_cancelled() {
                    return None;
                }
                changed.borrow_and_update();
                let event = match dash.tts.next(after.as_deref()) {
                    Some(Delivery::Reset(snapshot)) => {
                        after = Some(snapshot.summary.event_id.clone());
                        Some(
                            Event::default()
                                .event("snapshot")
                                .id(&snapshot.summary.event_id)
                                .retry(Duration::from_secs(2))
                                .json_data(snapshot)
                                .expect("speech snapshot serializes"),
                        )
                    }
                    Some(Delivery::Event { id, json }) => {
                        after = Some(id.clone());
                        Some(Event::default().event("feed").id(id).data(json.as_ref()))
                    }
                    None => None,
                };
                if let Some(event) = event {
                    return Some((
                        Ok::<_, std::convert::Infallible>(event),
                        (dash, changed, after, permit),
                    ));
                }
                tokio::select! {
                    _ = dash.shutdown.cancelled() => return None,
                    result = changed.changed() => if result.is_err() { return None; },
                }
            }
        },
    );
    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert("x-accel-buffering", HeaderValue::from_static("no"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[derive(Deserialize)]
struct RefreshRequest {
    #[serde(default)]
    what: Vec<String>,
}

async fn refresh(
    State(dash): State<Shared>,
    headers: HeaderMap,
    Json(request): Json<RefreshRequest>,
) -> Response {
    if let Err(response) = dash.mutation(&headers) {
        return *response;
    }
    let all = request.what.is_empty();
    if all || request.what.iter().any(|w| w == "choices") {
        refresh_choices(&dash);
    }
    if all || request.what.iter().any(|w| w == "doctor") {
        refresh_doctor(&dash);
    }
    let media = request.what.iter().any(|w| w == "media" || w == "sync");
    refresh_media(
        &dash,
        media || request.what.iter().any(|w| w == "images"),
        media || request.what.iter().any(|w| w == "audio"),
    );
    StatusCode::ACCEPTED.into_response()
}

async fn answer(
    State(dash): State<Shared>,
    headers: HeaderMap,
    Json(mut input): Json<AnswerInput>,
) -> Response {
    if let Err(response) = dash.mutation(&headers) {
        return *response;
    }
    // The click is the operator's explicit confirmation.
    input.confirmed = true;
    let key = format!(
        "{}\u{1f}{}\u{1f}{}",
        input.host, input.session, input.request_id
    );
    if !dash
        .inflight
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key.clone())
    {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": "an answer for this question is already in flight"})),
        )
            .into_response();
    }
    let host = input.host.clone();
    let (session, request_id) = (input.session.clone(), input.request_id.clone());
    let result = match dash.endpoints.get(&host) {
        Some(endpoint) => paratenic::answer(&dash.config, endpoint, input).await,
        None => Err(Error::Config(format!("no AHP endpoint for {host}"))),
    };
    dash.inflight
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&key);
    // Every outcome is kept (recent receipts in /api/state) and logged for
    // the service journal; answers themselves are never logged.
    let (receipt, failed) = match result {
        Ok(receipt) => (receipt, false),
        Err(error) => (
            AnswerReceipt {
                host: host.clone(),
                session,
                request_id,
                state: paratenic::AnswerState::Failed,
                reason: Some(error.to_string()),
                client_id: None,
                client_seq: None,
            },
            true,
        ),
    };
    eprintln!(
        "ag dash: answer {} {} {}: {:?}{}",
        receipt.host,
        receipt.session,
        receipt.request_id,
        receipt.state,
        receipt
            .reason
            .as_deref()
            .map(|r| format!(" · {r}"))
            .unwrap_or_default()
    );
    {
        let mut snapshot = lock(&dash);
        snapshot.receipts.push_front(receipt.clone());
        snapshot.receipts.truncate(20);
    }
    if failed {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": receipt.reason, "receipt": receipt})),
        )
            .into_response();
    }
    refresh_node(&dash, &host).await;
    Json(receipt).into_response()
}

impl Dash {
    fn media_root(&self, kind: MediaKind) -> Option<PathBuf> {
        let cache_dir = match kind {
            MediaKind::Image => self.options.cache_dir.as_ref(),
            MediaKind::Audio => self.options.audio_cache_dir.as_ref(),
        };
        gallery::media_cache_path(&self.config, kind, cache_dir)
            .ok()?
            .canonicalize()
            .ok()
    }
}

fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        Some("tif" | "tiff") => "image/tiff",
        Some("heic") => "image/heic",
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("ogg" | "oga") => "audio/ogg",
        Some("opus") => "audio/ogg; codecs=opus",
        Some("flac") => "audio/flac",
        Some("m4a" | "mp4") => "audio/mp4",
        Some("aac") => "audio/aac",
        Some("webm") => "audio/webm",
        Some("mka") => "audio/x-matroska",
        Some("aif" | "aiff") => "audio/aiff",
        Some("mid" | "midi") => "audio/midi",
        _ => "application/octet-stream",
    }
}

/// Single `bytes=` range (players seek with these). None serves the whole
/// file; Some(Err) is unsatisfiable (416).
fn byte_range(headers: &HeaderMap, len: u64) -> Option<std::result::Result<(u64, u64), ()>> {
    let spec = headers
        .get(header::RANGE)?
        .to_str()
        .ok()?
        .trim()
        .strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (first, last) = spec.split_once('-')?;
    let range = if first.is_empty() {
        let suffix: u64 = last.parse().ok()?;
        (suffix > 0 && len > 0).then(|| (len.saturating_sub(suffix), len - 1))
    } else {
        let start: u64 = first.parse().ok()?;
        let end = if last.is_empty() {
            len.checked_sub(1)
        } else {
            last.parse::<u64>()
                .ok()
                .map(|e| e.min(len.saturating_sub(1)))
        };
        end.filter(|end| len > 0 && start <= *end && start < len)
            .map(|end| (start, end))
    };
    Some(range.ok_or(()))
}

async fn gallery_file(
    State(dash): State<Shared>,
    headers: HeaderMap,
    UrlPath(path): UrlPath<String>,
) -> Response {
    media_file(&dash, MediaKind::Image, &headers, &path).await
}

async fn audio_file(
    State(dash): State<Shared>,
    headers: HeaderMap,
    UrlPath(path): UrlPath<String>,
) -> Response {
    media_file(&dash, MediaKind::Audio, &headers, &path).await
}

/// Serve only a cache's generated index and archive files inside it (no
/// traversal, sidecars or symlink escape). Media bytes stream with Range.
async fn media_file(dash: &Shared, kind: MediaKind, headers: &HeaderMap, path: &str) -> Response {
    if let Err(response) = dash.authorized(headers) {
        return *response;
    }
    let Some(root) = dash.media_root(kind) else {
        return (StatusCode::NOT_FOUND, "no cache yet").into_response();
    };
    let relative = PathBuf::from(path);
    let index = path == "index.html";
    let safe = index
        || (path.starts_with("hosts/")
            && relative
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
            && relative
                .components()
                .nth(2)
                .is_some_and(|c| c.as_os_str() == "archive")
            && !path.ends_with(".json"));
    if !safe {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let Ok(full) = root.join(&relative).canonicalize() else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let Some(len) = tokio::fs::metadata(&full)
        .await
        .ok()
        .filter(|m| m.is_file() && m.len() <= MAX_FILE.max(kind.max_bytes() as u64))
        .map(|m| m.len())
    else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if !full.starts_with(&root) {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    if index {
        let Ok(bytes) = tokio::fs::read(&full).await else {
            return (StatusCode::NOT_FOUND, "not found").into_response();
        };
        let csp = match kind {
            MediaKind::Image => {
                "default-src 'none'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'self'"
            }
            MediaKind::Audio => {
                "default-src 'none'; media-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'self'"
            }
        };
        let mut response =
            ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], bytes).into_response();
        let h = response.headers_mut();
        h.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(csp),
        );
        h.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return response;
    }
    let (status, start, end) = match byte_range(headers, len) {
        Some(Ok((start, end))) => (StatusCode::PARTIAL_CONTENT, start, end),
        Some(Err(())) => {
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{len}")) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            return response;
        }
        None => (StatusCode::OK, 0, len.saturating_sub(1)),
    };
    let Ok(mut file) = tokio::fs::File::open(&full).await else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let length = if len == 0 { 0 } else { end - start + 1 };
    let stream = futures_util::stream::unfold(Some(file.take(length)), |reader| async move {
        let mut reader = reader?;
        let mut buffer = vec![0u8; 64 * 1024];
        match reader.read(&mut buffer).await {
            Ok(0) => None,
            Ok(n) => {
                buffer.truncate(n);
                Some((Ok(axum::body::Bytes::from(buffer)), Some(reader)))
            }
            Err(error) => Some((Err::<axum::body::Bytes, _>(error), None)),
        }
    });
    let mut response = axum::body::Body::from_stream(stream).into_response();
    *response.status_mut() = status;
    let h = response.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime(&full)));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if status == StatusCode::PARTIAL_CONTENT {
        if let Ok(value) = HeaderValue::from_str(&format!("bytes {start}-{end}/{len}")) {
            h.insert(header::CONTENT_RANGE, value);
        }
    }
    // Navigated-to media (including SVG) render sandboxed and inert.
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox",
        ),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=3600"),
    );
    response
}

pub struct Started {
    /// With a persistent token or open access this is the bare public URL:
    /// never log the secret.
    pub url: String,
    pub address: SocketAddr,
    /// `open` (no token) or `token`.
    pub access: &'static str,
    pub token_file: Option<PathBuf>,
}

/// Loopback and Tailscale addresses (100.64.0.0/10, fd7a:115c:a1e0::/48):
/// reachable only from this machine or the tailnet.
pub fn private_reach(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback() || (v4.octets()[0] == 100 && v4.octets()[1] & 0xc0 == 64)
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback() || v6.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0]
        }
    }
}

/// Resolved access for a bind: true when no token is required.
pub fn open_access(access: DashAccess, bind: SocketAddr) -> bool {
    match access {
        DashAccess::Open => true,
        DashAccess::Token => false,
        DashAccess::Auto => private_reach(bind.ip()),
    }
}

/// Bind, start background refreshers, then serve until Ctrl-C or service SIGTERM.
pub async fn run(
    mut config: Config,
    targets: Vec<(Host, NodeEndpoints)>,
    options: DashOptions,
    ready: impl FnOnce(&Started),
) -> Result<()> {
    // Health reads the caches this dashboard syncs.
    if let Some(dir) = &options.cache_dir {
        config.gallery.cache_dir = Some(dir.clone());
    }
    if let Some(dir) = &options.audio_cache_dir {
        config.gallery.audio_cache_dir = Some(dir.clone());
    }
    let public_origin = options
        .public_origin
        .as_deref()
        .map(validate_public_origin)
        .transpose()?;
    let open = open_access(options.access, options.bind);
    let token = if open {
        None
    } else {
        Some(match &options.token_file {
            Some(path) => persistent_token(path)?,
            None => uuid::Uuid::new_v4().simple().to_string(),
        })
    };
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    let listener = tokio::net::TcpListener::bind(options.bind)
        .await
        .map_err(|e| {
            Error::Transport(format!(
                "dash cannot listen on {}: {e} (use --bind)",
                options.bind
            ))
        })?;
    let address = listener.local_addr()?;
    let display_host = if address.ip().is_unspecified() {
        "localhost".to_owned()
    } else if address.is_ipv6() {
        format!("[{}]", address.ip())
    } else {
        address.ip().to_string()
    };
    let hosts = (!address.ip().is_unspecified() || public_origin.is_some()).then(|| {
        let port = address.port();
        let mut names = vec![
            format!("{display_host}:{port}"),
            format!("localhost:{port}"),
        ];
        if address.ip().is_loopback() {
            names.extend([format!("127.0.0.1:{port}"), format!("[::1]:{port}")]);
        } else {
            // This machine's names (`helsinki`, `helsinki.<tailnet>.ts.net`), as
            // MagicDNS serves them; a rebinding attacker's domain is never one.
            if let Ok(name) = nix::unistd::gethostname() {
                let name = name.to_string_lossy().to_lowercase();
                if let Some(short) = name.split('.').next().filter(|s| !s.is_empty()) {
                    names.push(format!("{short}:{port}"));
                }
                names.push(format!("{name}:{port}"));
            }
        }
        if let Some(origin) = &public_origin {
            names.push(origin[url::Position::BeforeHost..url::Position::AfterPort].to_owned());
            if let Some(short) = origin
                .host_str()
                .and_then(|h| h.split('.').next())
                .filter(|s| !s.is_empty() && s.parse::<std::net::Ipv4Addr>().is_err())
            {
                let port = origin.port_or_known_default().unwrap_or(port);
                names.push(format!("{short}:{port}"));
            }
        }
        names
    });
    if open && hosts.is_none() {
        eprintln!(
            "ag dash: open access on a wildcard bind ({}): anyone who can reach this port can read and answer agents",
            options.bind
        );
    }
    let secure_cookie = public_origin
        .as_ref()
        .is_some_and(|u| u.scheme() == "https");
    let public_url = public_origin
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_else(|| format!("http://{display_host}:{}", address.port()));
    let nodes: Vec<Host> = targets.iter().map(|(h, _)| h.clone()).collect();
    let choice_targets = paratenic::choice_endpoints(&config, &nodes)?;
    let endpoints = choice_targets
        .iter()
        .filter_map(|(h, e)| Some((h.name.clone(), e.clone()?)))
        .collect();
    let snapshot = Snapshot {
        refresh_seconds: options.refresh.as_secs(),
        image_refresh_seconds: options.image_refresh.as_secs(),
        images: ImageStatus {
            enabled: options.images,
            ..ImageStatus::default()
        },
        audio: AudioStatus {
            enabled: options.audio,
            ..AudioStatus::default()
        },
        ..Snapshot::default()
    };
    crate::store::check_limit(options.tts_lines)?;
    let speech_hosts: Vec<_> = targets.iter().map(|(h, _)| h.clone()).collect();
    let tts = Feed::new(options.tts, &speech_hosts);
    let shutdown = tokio_util::sync::CancellationToken::new();
    let mut collector = tokio::spawn(tts.clone().run(
        config.clone(),
        speech_hosts,
        options.tts_lines,
        shutdown.child_token(),
    ));
    let dash: Shared = Arc::new(Dash {
        config,
        targets,
        choice_targets,
        endpoints,
        cookie: format!("ag_dash_{}", address.port()),
        secure_cookie,
        token: token.clone(),
        hosts,
        options: options.clone(),
        snapshot: Mutex::new(snapshot),
        choices_busy: AtomicBool::new(false),
        doctor_busy: AtomicBool::new(false),
        images_busy: Arc::new(AtomicBool::new(false)),
        audio_busy: Arc::new(AtomicBool::new(false)),
        inflight: Mutex::new(HashSet::new()),
        tts,
        shutdown: shutdown.clone(),
    });
    let router = Router::new()
        .route("/", get(index))
        .route("/api/state", get(state))
        .route("/tts.js", get(tts_script))
        .route("/api/tts", get(tts_snapshot))
        .route("/api/tts/events", get(tts_events))
        .route("/api/refresh", post(refresh))
        .route("/api/answer", post(answer))
        .route("/gallery/{*path}", get(gallery_file))
        .route("/audio/{*path}", get(audio_file))
        .with_state(dash.clone());
    ready(&Started {
        url: match &token {
            Some(token) if options.token_file.is_none() => format!("{public_url}/?token={token}"),
            _ => format!("{public_url}/"),
        },
        address,
        access: if open { "open" } else { "token" },
        token_file: if open {
            None
        } else {
            options.token_file.clone()
        },
    });
    let background = {
        let dash = dash.clone();
        tokio::spawn(async move {
            let mut status = tokio::time::interval(options.refresh);
            let mut images = tokio::time::interval(options.image_refresh);
            loop {
                tokio::select! {
                    _ = status.tick() => { refresh_choices(&dash); refresh_doctor(&dash); }
                    _ = images.tick() => refresh_media(&dash, true, true),
                }
            }
        })
    };
    let stopping = shutdown.clone();
    let serving = axum::serve(listener, router).with_graceful_shutdown(async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => (),
            _ = terminate.recv() => (),
        }
        // Close streaming responses before waiting for graceful HTTP drain.
        stopping.cancel();
    });
    // A peer that stopped reading can have an already-buffered SSE frame in
    // the HTTP writer. Do not let it hold the foreground service open forever.
    // The process-owned runtime drops any remaining connections on return.
    let result = tokio::select! {
        result = serving => result.map_err(|e| Error::Transport(e.to_string())),
        _ = async { shutdown.cancelled().await; tokio::time::sleep(Duration::from_secs(4)).await; } => Ok(()),
    };
    background.abort();
    shutdown.cancel();
    if tokio::time::timeout(Duration::from_secs(4), &mut collector)
        .await
        .is_err()
    {
        collector.abort();
        let _ = collector.await;
    }
    result
}
