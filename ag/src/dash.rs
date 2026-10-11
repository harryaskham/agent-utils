//! `ag dash`: one live local web view of fleet choices, health and images.
//!
//! A real server, not a static generator: choices are re-read from Paratenic
//! while the page is open (stale-while-revalidate), doctor and image pulls run
//! on intervals for the lifetime of the command. Answers go through the same
//! `paratenic::answer` path as the TUI/CLI/MCP.
//!
//! Security: every route requires a random token (per-run, or from a private
//! persistent file), exchanged once for an HttpOnly SameSite=Strict cookie. Mutations also need a
//! custom header (blocks cross-site forms) and a same-origin Origin. Loopback
//! binds additionally pin the Host header against DNS rebinding.
use crate::{
    Error, Result,
    config::{Config, Host},
    doctor::{self, DoctorReport},
    gallery::{self, GalleryInput, GalleryReceipt},
    paratenic::{self, AnswerInput, AnswerReceipt, Endpoint, FleetChoices},
    service::Service,
};
use axum::{
    Json, Router,
    extract::{Path as UrlPath, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
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
    pub token_file: Option<PathBuf>,
    pub refresh: Duration,
    pub image_refresh: Duration,
    pub images: bool,
    pub cache_dir: Option<String>,
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
pub struct Snapshot {
    pub choices: Option<FleetChoices>,
    pub choices_ms: Option<u64>,
    pub choices_refreshing: bool,
    pub doctor: Option<DoctorReport>,
    pub doctor_ms: Option<u64>,
    pub doctor_refreshing: bool,
    pub images: ImageStatus,
    pub receipts: VecDeque<AnswerReceipt>,
    pub refresh_seconds: u64,
    pub image_refresh_seconds: u64,
}

struct Dash {
    config: Config,
    targets: Vec<(Host, Option<Endpoint>)>,
    endpoints: HashMap<String, Endpoint>,
    options: DashOptions,
    token: String,
    cookie: String,
    secure_cookie: bool,
    hosts: Option<Vec<String>>,
    snapshot: Mutex<Snapshot>,
    choices_busy: AtomicBool,
    doctor_busy: AtomicBool,
    images_busy: Arc<AtomicBool>,
    inflight: Mutex<HashSet<String>>,
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
        match cookie(headers, &self.cookie) {
            Some(value) if eq(&value, &self.token) => Ok(()),
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
        let fleet = paratenic::fleet_choices(&dash.config, dash.targets.clone(), false).await;
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
    let Some((h, e)) = dash.targets.iter().find(|(h, _)| h.name == host).cloned() else {
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

fn refresh_images(dash: &Shared) {
    if !dash.options.images || dash.images_busy.swap(true, Ordering::AcqRel) {
        return;
    }
    lock(dash).images.running = true;
    let dash = dash.clone();
    let runtime = tokio::runtime::Handle::current();
    // Gallery pulls own their own runtime (rsync children, Ctrl-C handling); a
    // dedicated thread keeps them off the server's runtime.
    std::thread::spawn(move || {
        let selection = dash.options.selection.clone();
        let result: Result<GalleryReceipt> =
            Service::new(dash.config.clone(), None).and_then(|service| {
                service.image_gallery(GalleryInput {
                    selection,
                    cache_dir: dash.options.cache_dir.clone(),
                    offline: false,
                    checksum: false,
                    confirmed: true,
                })
            });
        {
            let mut snapshot = lock(&dash);
            let images = &mut snapshot.images;
            images.running = false;
            images.finished_ms = Some(now_ms());
            match result {
                Ok(receipt) => {
                    images.available = true;
                    images.images = receipt.images;
                    images.hosts = receipt.hosts;
                    images.error = None;
                }
                Err(error) => images.error = Some(error.to_string()),
            }
        }
        dash.images_busy.store(false, Ordering::Release);
        // Gallery freshness is part of node health.
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
        if !eq(token, &dash.token) {
            return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
        }
        let mut response = Redirect::to("/").into_response();
        if let Ok(value) = HeaderValue::from_str(&format!(
            "{}={}; Path=/; HttpOnly; SameSite=Strict{}",
            dash.cookie,
            dash.token,
            if dash.secure_cookie { "; Secure" } else { "" }
        )) {
            response.headers_mut().insert(header::SET_COOKIE, value);
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
    let csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
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
    snapshot.images.available = snapshot.images.available
        || dash
            .gallery_root()
            .is_some_and(|r| r.join("index.html").is_file());
    let mut response = Json(snapshot).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
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
    if request.what.iter().any(|w| w == "images") {
        refresh_images(&dash);
    }
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
    let result = match dash.endpoints.get(&host) {
        Some(endpoint) => paratenic::answer(&dash.config, endpoint, input).await,
        None => Err(Error::Config(format!("no Paratenic endpoint for {host}"))),
    };
    dash.inflight
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&key);
    match result {
        Ok(receipt) => {
            {
                let mut snapshot = lock(&dash);
                snapshot.receipts.push_front(receipt.clone());
                snapshot.receipts.truncate(20);
            }
            refresh_node(&dash, &host).await;
            Json(receipt).into_response()
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": error.to_string()})),
        )
            .into_response(),
    }
}

impl Dash {
    fn gallery_root(&self) -> Option<PathBuf> {
        gallery::cache_path(&self.config, self.options.cache_dir.as_ref())
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
        _ => "application/octet-stream",
    }
}

async fn gallery_file(
    State(dash): State<Shared>,
    headers: HeaderMap,
    UrlPath(path): UrlPath<String>,
) -> Response {
    if let Err(response) = dash.authorized(&headers) {
        return *response;
    }
    let Some(root) = dash.gallery_root() else {
        return (StatusCode::NOT_FOUND, "no gallery yet").into_response();
    };
    let relative = PathBuf::from(&path);
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
    if !full.starts_with(&root)
        || tokio::fs::metadata(&full)
            .await
            .map(|m| !m.is_file() || m.len() > MAX_FILE)
            .unwrap_or(true)
    {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    let Ok(bytes) = tokio::fs::read(&full).await else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let (content_type, csp) = if index {
        (
            "text/html; charset=utf-8",
            "default-src 'none'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'self'",
        )
    } else {
        // Navigated-to images (including SVG) render sandboxed and inert.
        (
            mime(&full),
            "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        )
    };
    let mut response = ([(header::CONTENT_TYPE, content_type)], bytes).into_response();
    let h = response.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(csp),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if index {
            "no-store"
        } else {
            "private, max-age=3600"
        }),
    );
    response
}

pub struct Started {
    /// With a persistent token this is the bare public URL: never log the secret.
    pub url: String,
    pub address: SocketAddr,
    pub token_file: Option<PathBuf>,
}

/// Bind, start background refreshers, then serve until Ctrl-C or service SIGTERM.
pub async fn run(
    config: Config,
    targets: Vec<(Host, Option<Endpoint>)>,
    options: DashOptions,
    ready: impl FnOnce(&Started),
) -> Result<()> {
    let public_origin = options
        .public_origin
        .as_deref()
        .map(validate_public_origin)
        .transpose()?;
    let token = match &options.token_file {
        Some(path) => persistent_token(path)?,
        None => uuid::Uuid::new_v4().simple().to_string(),
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
        }
        if let Some(origin) = &public_origin {
            names.push(origin[url::Position::BeforeHost..url::Position::AfterPort].to_owned());
        }
        names
    });
    let secure_cookie = public_origin
        .as_ref()
        .is_some_and(|u| u.scheme() == "https");
    let public_url = public_origin
        .map(|u| u.origin().ascii_serialization())
        .unwrap_or_else(|| format!("http://{display_host}:{}", address.port()));
    let endpoints = targets
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
        ..Snapshot::default()
    };
    let dash: Shared = Arc::new(Dash {
        config,
        targets,
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
        inflight: Mutex::new(HashSet::new()),
    });
    let router = Router::new()
        .route("/", get(index))
        .route("/api/state", get(state))
        .route("/api/refresh", post(refresh))
        .route("/api/answer", post(answer))
        .route("/gallery/{*path}", get(gallery_file))
        .with_state(dash.clone());
    ready(&Started {
        url: if options.token_file.is_some() {
            format!("{public_url}/")
        } else {
            format!("{public_url}/?token={token}")
        },
        address,
        token_file: options.token_file.clone(),
    });
    let background = {
        let dash = dash.clone();
        tokio::spawn(async move {
            let mut status = tokio::time::interval(options.refresh);
            let mut images = tokio::time::interval(options.image_refresh);
            loop {
                tokio::select! {
                    _ = status.tick() => { refresh_choices(&dash); refresh_doctor(&dash); }
                    _ = images.tick() => refresh_images(&dash),
                }
            }
        })
    };
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => (),
                _ = terminate.recv() => (),
            }
        })
        .await
        .map_err(|e| Error::Transport(e.to_string()));
    background.abort();
    result
}
