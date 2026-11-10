//! Fleet Cursive canvases: what every node's boards show, in one live view.
//!
//! The gateway (a Cursive >= 0.6 daemon that knows the fleet, by default this
//! machine's on 127.0.0.1:7685) lists every node's canvases in one HTTP call
//! and serves `GET /v1/hosts/NODE/canvases/ID/export` (Cursive >= 0.7) for
//! the ones whose revision changed. Older daemons answer through their
//! `cursive_export` tool; nodes the gateway cannot reach, or exports beyond an
//! old daemon, use this machine's `cursive --remote` over SSH. Each node's own
//! Cursive renders; ag never interprets canvas objects. Renders land in a
//! private cache with a per-node manifest and one generated viewer (also the
//! dash's Canvases tab, which follows the gateway's change stream). A node
//! that cannot be reached keeps its cached renders.
use crate::{
    Error, Result,
    config::{self, CanvasConfig, CanvasFormat, Config, Host},
    model::Selection,
    service::Service,
};
use nix::fcntl::{Flock, FlockArg};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncReadExt, process::Command, sync::Semaphore, task::JoinSet};

const PAGE: &str = include_str!("../canvas.html");
/// Cursive caps SVG at 64 MiB and PNG at 16 megapixels.
pub const MAX_RENDER_BYTES: usize = 80 * 1024 * 1024;
const MAX_LIST_BYTES: usize = 4 * 1024 * 1024;
const MAX_INDEX_BYTES: usize = 64 * 1024 * 1024;
/// Cursive's history page limit.
const HISTORY_PAGE: usize = 200;
/// Searchable text kept per canvas (from the SVG's text runs).
const MAX_SEARCH_CHARS: usize = 4096;
const MAX_WARNING_CHARS: usize = 400;

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct CanvasInput {
    #[serde(flatten)]
    pub selection: Selection,
    /// Cache directory (default canvases.cache_dir or ~/.cache/ag/canvases).
    pub cache_dir: Option<String>,
    /// Rebuild the viewer from the cache only: no SSH or cursive.
    pub offline: bool,
    /// Re-export every listed canvas, changed or not.
    pub force: bool,
    pub confirmed: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct CanvasListInput {
    #[serde(flatten)]
    pub selection: Selection,
    pub cache_dir: Option<String>,
    /// Case-insensitive match on canvas id or its text.
    pub query: Option<String>,
    pub limit: Option<usize>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CanvasHost {
    pub host: String,
    /// synced, cached (offline) or unavailable (cached renders kept).
    pub state: String,
    /// How this pull reached the node: daemon, ssh, local, cache or none.
    #[serde(default)]
    pub via: String,
    pub last_sync_ms: Option<u64>,
    pub canvases: usize,
    /// Exported during this pull (new or changed).
    pub rendered: usize,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CanvasEntry {
    pub host: String,
    pub id: String,
    pub kind: String,
    pub revision: u64,
    /// Revision of the cached render (may lag `revision` after a failed export).
    pub rendered_revision: Option<u64>,
    pub objects: u64,
    pub updated_ms: u64,
    pub rendered_ms: Option<u64>,
    pub format: Option<String>,
    pub bytes: u64,
    pub sha256: Option<String>,
    /// Cache-relative render path (with a revision query for browsers).
    pub src: Option<String>,
    /// Cursive's cached OCR preview, when one exists for this revision.
    pub ocr: Option<String>,
    /// Text drawn on the canvas (from the SVG), bounded, for search.
    pub text: String,
    /// Command to open this board from here.
    pub open: String,
    /// The board in the gateway's live web view: a `#/NODE/ID` fragment for
    /// the manifest's `live` base (None for nodes outside the fleet).
    pub live: Option<String>,
    pub error: Option<String>,
}
/// The gateway as this pull found it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct GatewayStatus {
    pub url: String,
    /// live, unreachable, off (no gateway configured) or cached (offline).
    pub state: String,
    pub name: Option<String>,
    pub version: Option<String>,
    pub hosts: usize,
    pub hosts_online: usize,
    /// Browser base for live links (`web_url`, else the gateway).
    pub web: Option<String>,
    /// The gateway is on this machine: a browser elsewhere uses its own host.
    pub loopback: bool,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CanvasReceipt {
    pub gateway: GatewayStatus,
    pub index: PathBuf,
    pub cache_dir: PathBuf,
    pub canvases: usize,
    pub rendered: usize,
    pub bytes: u64,
    pub pulled_ms: u64,
    pub hosts: Vec<CanvasHost>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct CanvasList {
    pub cache_dir: PathBuf,
    pub canvases: Vec<CanvasEntry>,
    pub hosts: Vec<CanvasHost>,
}

/// One node's canvases as last seen and rendered.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct HostManifest {
    version: u32,
    host: String,
    last_sync_ms: Option<u64>,
    last_state: Option<String>,
    warnings: Vec<String>,
    /// When this node's cursive last refused `--format svg` (PNG until re-probed).
    svg_unsupported_ms: Option<u64>,
    /// This node's name in the Cursive fleet, for live links.
    fleet: Option<String>,
    via: Option<String>,
    canvases: Vec<Stored>,
}
/// How long a node that lacks SVG export renders PNG before SVG is tried again.
const SVG_REPROBE_MS: u64 = 6 * 60 * 60 * 1000;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Stored {
    id: String,
    kind: String,
    revision: u64,
    objects: u64,
    updated_ms: u64,
    ocr: Option<String>,
    rendered_revision: Option<u64>,
    rendered_ms: Option<u64>,
    /// What produced the render: format and theme.
    format: Option<String>,
    theme: Option<String>,
    file: Option<String>,
    bytes: u64,
    sha256: Option<String>,
    text: String,
    error: Option<String>,
}
/// `cursive --json history --list` rows (unknown fields are ignored).
#[derive(Clone, Debug, Deserialize)]
struct Summary {
    id: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    objects: u64,
    #[serde(default)]
    updated_ms: u64,
    #[serde(default)]
    text: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn bounded(text: &str, max: usize) -> String {
    let mut out: String = text.chars().take(max).collect();
    if text.chars().nth(max).is_some() {
        out.push('…');
    }
    out
}
fn private_dir(path: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    if !fs::symlink_metadata(path)?.is_dir() {
        return Err(Error::Invalid(
            "canvas cache directories must not be symlinks".into(),
        ));
    }
    Ok(())
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().expect("file parent"))?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|error| Error::Io(error.error))?;
    Ok(())
}
/// Cursive's own id rule; anything else never becomes a cache path.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
}

/// The value passed to `cursive --remote` for a node.
pub fn destination(host: &Host) -> String {
    if let Some(remote) = &host.cursive.remote {
        return remote.clone();
    }
    let user = host
        .username
        .as_ref()
        .map(|u| format!("{u}@"))
        .unwrap_or_default();
    let address = if host.address.contains(':') {
        format!("[{}]", host.address)
    } else {
        host.address.clone()
    };
    if host.port == 22 && !host.address.contains(':') {
        format!("{user}{address}")
    } else {
        format!("ssh://{user}{address}:{}", host.port)
    }
}
fn base_args(host: &Host) -> Vec<String> {
    if host.local {
        vec![]
    } else {
        vec![format!("--remote={}", destination(host))]
    }
}
/// Shell-safe command to open a board from this machine.
pub fn open_command(program: &str, host: &Host, id: &str) -> String {
    let quote = crate::transport::shell_quote;
    let mut words = vec![quote(program)];
    if !host.local {
        words.push(quote(&format!("--remote={}", destination(host))));
    }
    words.extend(["canvas".into(), quote(id)]);
    words.join(" ")
}
pub fn host_key(host: &Host) -> String {
    hash(
        serde_json::to_vec(&(
            "canvas",
            host.name.as_str(),
            host.address.as_str(),
            &host.username,
            host.port,
            host.local,
            &host.cursive.remote,
        ))
        .expect("serializable target"),
    )
}
pub fn cache_path(config: &Config, cache_dir: Option<&String>) -> Result<PathBuf> {
    let path = cache_dir
        .or(config.canvases.cache_dir.as_ref())
        .cloned()
        .unwrap_or_else(|| {
            PathBuf::from(
                std::env::var_os("XDG_CACHE_HOME")
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| {
                        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                            .join(".cache")
                            .into_os_string()
                    }),
            )
            .join("ag/canvases")
            .to_string_lossy()
            .into()
        });
    config::expand_home(&path)
}
fn cache_root(config: &Config, cache_dir: Option<&String>) -> Result<PathBuf> {
    let path = cache_path(config, cache_dir)?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&path)?;
    Ok(fs::canonicalize(path)?)
}
fn enabled(host: &Host) -> bool {
    host.cursive.enabled != Some(false)
}

struct Output {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}
/// Run this machine's cursive with bounded output and a deadline. Only spawn
/// failures, timeouts and oversized output are errors; exit status is the
/// caller's to interpret.
async fn cursive(config: &CanvasConfig, args: &[String], max: usize) -> Result<Output> {
    let mut child = Command::new(&config.program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            Error::Transport(format!(
                "cannot run {:?} on this machine ({e}); install Cursive or set canvases.program",
                config.program
            ))
        })?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");
    let work = async {
        let out = async {
            let mut bytes = Vec::new();
            (&mut stdout)
                .take(max as u64 + 1)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() > max {
                return Err(Error::Limit(format!("cursive output exceeds {max} bytes")));
            }
            Ok(bytes)
        };
        let err = async {
            let mut tail = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                let n = stderr.read(&mut buffer).await?;
                if n == 0 {
                    return Ok::<_, Error>(tail);
                }
                tail.extend_from_slice(&buffer[..n]);
                if tail.len() > 8192 {
                    tail.drain(..tail.len() - 8192);
                }
            }
        };
        let (bytes, errors, status) =
            tokio::try_join!(out, err, async { child.wait().await.map_err(Error::from) })?;
        Ok::<_, Error>(Output {
            code: status.code(),
            stdout: bytes,
            stderr: String::from_utf8_lossy(&errors).trim().to_string(),
        })
    };
    match tokio::time::timeout(Duration::from_secs(config.timeout_seconds), work).await {
        Ok(result) => result,
        Err(_) => Err(Error::Transport(format!(
            "cursive timed out after {}s",
            config.timeout_seconds
        ))),
    }
}
fn failure(output: &Output) -> String {
    // A JSON error envelope (--json) carries the useful message.
    let message = serde_json::from_slice::<serde_json::Value>(&output.stdout)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_owned))
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| {
            let tail = output.stderr.lines().rev().find(|l| !l.trim().is_empty());
            tail.unwrap_or("no diagnostics").to_string()
        });
    let code = output
        .code
        .map_or_else(|| "a signal".to_string(), |c| c.to_string());
    bounded(
        &format!("cursive exited {code}: {message}"),
        MAX_WARNING_CHARS,
    )
}

/// Every canvas on a node, most recently updated first, up to `max_per_host`.
async fn list(config: &CanvasConfig, host: &Host, gate: &Semaphore) -> Result<Vec<Summary>> {
    let mut all = vec![];
    for page in 0..50 {
        let mut args = base_args(host);
        args.extend([
            "--json".into(),
            "history".into(),
            "--list".into(),
            "--limit".into(),
            HISTORY_PAGE.to_string(),
            "--offset".into(),
            (page * HISTORY_PAGE).to_string(),
        ]);
        let output = {
            let _permit = gate
                .acquire()
                .await
                .map_err(|e| Error::Transport(e.to_string()))?;
            cursive(config, &args, MAX_LIST_BYTES).await?
        };
        if output.code != Some(0) {
            return Err(Error::Transport(failure(&output)));
        }
        let rows =
            match serde_json::from_slice::<mcp_cli::JsonEnvelope<Vec<Summary>>>(&output.stdout) {
                Ok(mcp_cli::JsonEnvelope::Success { data, .. }) => data,
                Ok(mcp_cli::JsonEnvelope::Error { error, .. }) => {
                    return Err(Error::Transport(bounded(&error.message, MAX_WARNING_CHARS)));
                }
                Err(error) => {
                    return Err(Error::Transport(format!(
                        "unexpected cursive history output: {error}"
                    )));
                }
            };
        let full = rows.len() == HISTORY_PAGE;
        all.extend(rows);
        if !full || keep(config, all.clone()).len() >= config.max_per_host {
            break;
        }
    }
    Ok(keep(config, all))
}
/// Canvases (and notes when wanted), newest first, unique, at most `max_per_host`.
fn keep(config: &CanvasConfig, rows: Vec<Summary>) -> Vec<Summary> {
    let mut rows: Vec<Summary> = rows
        .into_iter()
        .filter(|r| r.kind == "canvas" || (config.include_notes && r.kind == "note"))
        .collect();
    rows.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then(a.id.cmp(&b.id)));
    rows.dedup_by(|a, b| a.id == b.id);
    rows.truncate(config.max_per_host);
    rows
}

/// How one pull reaches one node.
#[derive(Clone, Debug)]
enum Via {
    /// `cursive [--remote]` (SSH, or the local CLI for local hosts).
    Ssh,
    /// The gateway: `base` is its `/v1` for its own node, else
    /// `/v1/hosts/NODE`. `listed` is this node's part of the fleet listing
    /// (None when that listing may be truncated: page the node). `ssh` allows
    /// SSH when the daemon cannot serve an export.
    Daemon {
        base: String,
        listed: Option<Vec<Summary>>,
        ssh: bool,
    },
    /// Neither the gateway nor SSH: keep the cache and report why. `quiet`
    /// for nodes known only from the fleet (phones that sleep, say): offline,
    /// not a fault.
    Unreachable { reason: String, quiet: bool },
}
impl Via {
    fn name(&self, host: &Host) -> &'static str {
        match self {
            Self::Ssh if host.local => "local",
            Self::Ssh => "ssh",
            Self::Daemon { .. } => "daemon",
            Self::Unreachable { .. } => "none",
        }
    }
}
/// `GET /v1/info` of a daemon.
#[derive(Deserialize)]
struct Info {
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    peers: Vec<String>,
}
/// `GET /v1/fleet/canvases`.
#[derive(Deserialize)]
struct FleetCanvases {
    #[serde(default)]
    canvases: Vec<FleetSummary>,
    #[serde(default)]
    hosts: std::collections::BTreeMap<String, FleetHost>,
}
#[derive(Deserialize)]
struct FleetSummary {
    host: String,
    #[serde(flatten)]
    summary: Summary,
}
#[derive(Deserialize, Default)]
struct FleetHost {
    #[serde(default)]
    online: bool,
    #[serde(default)]
    error: Option<String>,
}
/// The gateway's fleet listing limit: a full page may be truncated.
const FLEET_PAGE: usize = 200;
const GATEWAY_INFO_TIMEOUT: Duration = Duration::from_secs(5);

/// One node's canvases from its daemon, paged.
async fn list_daemon(config: &CanvasConfig, base: &str, gate: &Semaphore) -> Result<Vec<Summary>> {
    let mut all = vec![];
    for page in 0..50 {
        let rows: Vec<Summary> = {
            let _permit = gate
                .acquire()
                .await
                .map_err(|e| Error::Transport(e.to_string()))?;
            crate::http::get_json(
                &format!(
                    "{base}/canvases?limit={HISTORY_PAGE}&offset={}",
                    page * HISTORY_PAGE
                ),
                MAX_LIST_BYTES,
                Duration::from_secs(config.timeout_seconds),
            )
            .await?
        };
        let full = rows.len() == HISTORY_PAGE;
        all.extend(rows);
        if !full || keep(config, all.clone()).len() >= config.max_per_host {
            break;
        }
    }
    Ok(keep(config, all))
}
async fn list_via(
    config: &CanvasConfig,
    host: &Host,
    via: &Via,
    gate: &Semaphore,
) -> Result<Vec<Summary>> {
    match via {
        Via::Ssh => list(config, host, gate).await,
        Via::Daemon {
            listed: Some(rows), ..
        } => Ok(keep(config, rows.clone())),
        Via::Daemon { base, .. } => list_daemon(config, base, gate).await,
        Via::Unreachable { reason, .. } => Err(Error::Transport(reason.clone())),
    }
}
fn percent(text: &str) -> String {
    text.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
/// An export from the daemon. `Err((error, true))` means SSH may still
/// succeed: the daemon is unreachable, predates `/export` for this format, or
/// its tool cannot carry this export.
async fn export_daemon(
    config: &CanvasConfig,
    base: &str,
    id: &str,
    format: CanvasFormat,
    gate: &Semaphore,
) -> std::result::Result<Render, (Error, bool)> {
    let timeout = Duration::from_secs(config.timeout_seconds);
    let theme = (format == CanvasFormat::Svg)
        .then_some(config.theme.as_deref())
        .flatten();
    let mut url = format!("{base}/canvases/{id}/export?format={}", format.name());
    if let Some(theme) = theme {
        url.push_str(&format!("&theme={}", percent(theme)));
    }
    let _permit = gate
        .acquire()
        .await
        .map_err(|e| (Error::Transport(e.to_string()), false))?;
    let reply = crate::http::request("GET", &url, None, &[], MAX_RENDER_BYTES, timeout)
        .await
        .map_err(|e| (e, true))?;
    if reply.status == 200 {
        let header_revision = reply
            .header("x-cursive-revision")
            .and_then(|r| r.parse().ok());
        let mut render = check(reply.body, format).map_err(|e| (e, false))?;
        render.revision = render.revision.or(header_revision);
        return Ok(render);
    }
    let message = crate::http::error_message(&reply.body).unwrap_or_default();
    if !(reply.status == 404 && message.starts_with("no such endpoint")) {
        // 5xx is the gateway failing to reach the node.
        return Err((
            Error::Transport(bounded(
                &format!("daemon export: HTTP {} {message}", reply.status),
                MAX_WARNING_CHARS,
            )),
            reply.status >= 500,
        ));
    }
    // A daemon before Cursive 0.7: its tool carries SVG text up to 3 MiB.
    if format != CanvasFormat::Svg {
        return Err((
            Error::Transport("the daemon predates /export (Cursive 0.7); PNG needs SSH".into()),
            true,
        ));
    }
    let mut input = serde_json::json!({"canvas": id, "format": "svg"});
    if let Some(theme) = theme {
        input["theme"] = theme.into();
    }
    let body = serde_json::to_vec(&input).map_err(|e| (e.into(), false))?;
    let reply = crate::http::request(
        "POST",
        &format!("{base}/call/cursive_export"),
        Some(&body),
        &[],
        MAX_RENDER_BYTES,
        timeout,
    )
    .await
    .map_err(|e| (e, true))?;
    match serde_json::from_slice::<mcp_cli::JsonEnvelope<serde_json::Value>>(&reply.body) {
        Ok(mcp_cli::JsonEnvelope::Success { data, .. }) => {
            let svg = data["data"]
                .as_str()
                .unwrap_or_default()
                .as_bytes()
                .to_vec();
            check(svg, format).map_err(|e| (e, false))
        }
        Ok(mcp_cli::JsonEnvelope::Error { error, .. }) => Err((
            Error::Transport(bounded(&error.message, MAX_WARNING_CHARS)),
            error.message.contains("MiB"),
        )),
        Err(error) => Err((
            Error::Transport(format!(
                "daemon export tool: HTTP {}: {error}",
                reply.status
            )),
            true,
        )),
    }
}
async fn export_via(
    config: &CanvasConfig,
    host: &Host,
    id: &str,
    format: CanvasFormat,
    gate: &Semaphore,
    via: &Via,
) -> std::result::Result<Render, (Error, bool)> {
    match via {
        Via::Daemon { base, ssh, .. } => {
            match export_daemon(config, base, id, format, gate).await {
                Err((error, true)) if *ssh => export(config, host, id, format, gate).await.map_err(
                    |(ssh_error, unsupported)| {
                        (
                            Error::Transport(bounded(
                                &format!("{error}; ssh: {ssh_error}"),
                                MAX_WARNING_CHARS,
                            )),
                            unsupported,
                        )
                    },
                ),
                // Not an SVG refusal: that probe is about an old CLI over SSH.
                other => other.map_err(|(error, _)| (error, false)),
            }
        }
        _ => export(config, host, id, format, gate).await,
    }
}

/// The rendered document, its revision (SVG names the one it drew) and text.
struct Render {
    bytes: Vec<u8>,
    format: CanvasFormat,
    revision: Option<u64>,
    text: String,
}
fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}
/// Text drawn on the canvas: the SVG's text runs, in order, bounded.
pub fn svg_text(svg: &str) -> String {
    let mut out = String::new();
    for part in svg.split("<text").skip(1) {
        let Some((_, rest)) = part.split_once('>') else {
            continue;
        };
        let Some((content, _)) = rest.split_once("</text>") else {
            continue;
        };
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&unescape(content));
        if out.chars().count() >= MAX_SEARCH_CHARS {
            break;
        }
    }
    bounded(&out, MAX_SEARCH_CHARS)
}
fn svg_revision(svg: &str) -> Option<u64> {
    // Only the root element's attributes; '>' is ASCII, so this is a char
    // boundary (a fixed byte cut can land inside a glyph like '─').
    let head = &svg[..svg.find('>')?];
    let start = head.find("data-cursive-revision=\"")? + "data-cursive-revision=\"".len();
    let digits: String = head[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}
fn check(bytes: Vec<u8>, format: CanvasFormat) -> Result<Render> {
    match format {
        CanvasFormat::Svg => {
            let text = std::str::from_utf8(&bytes)
                .map_err(|_| Error::Invalid("cursive SVG export is not UTF-8".into()))?;
            let trimmed = text.trim();
            if !trimmed.starts_with("<svg") || !trimmed.ends_with("</svg>") {
                return Err(Error::Invalid(
                    "cursive export is not an SVG document".into(),
                ));
            }
            let revision = svg_revision(trimmed);
            let text = svg_text(trimmed);
            Ok(Render {
                bytes,
                format,
                revision,
                text,
            })
        }
        CanvasFormat::Png => {
            if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Err(Error::Invalid("cursive export is not a PNG image".into()));
            }
            Ok(Render {
                bytes,
                format,
                revision: None,
                text: String::new(),
            })
        }
    }
}
/// A node whose cursive has no `--format svg` (before 0.5.0) says so in clap's usage error.
fn svg_unsupported(output: &Output) -> bool {
    output.code == Some(2)
        && output.stderr.contains("svg")
        && (output.stderr.contains("invalid value") || output.stderr.contains("possible values"))
}
async fn export(
    config: &CanvasConfig,
    host: &Host,
    id: &str,
    format: CanvasFormat,
    gate: &Semaphore,
) -> std::result::Result<Render, (Error, bool)> {
    let mut args = base_args(host);
    if format == CanvasFormat::Svg
        && let Some(theme) = &config.theme
    {
        args.push(format!("--theme={theme}"));
    }
    args.extend([
        "export".into(),
        id.into(),
        "--format".into(),
        format.name().into(),
    ]);
    let output = {
        let _permit = gate
            .acquire()
            .await
            .map_err(|e| (Error::Transport(e.to_string()), false))?;
        cursive(config, &args, MAX_RENDER_BYTES)
            .await
            .map_err(|e| (e, false))?
    };
    if output.code != Some(0) {
        let unsupported = format == CanvasFormat::Svg && svg_unsupported(&output);
        return Err((Error::Transport(failure(&output)), unsupported));
    }
    check(output.stdout, format).map_err(|e| (e, false))
}
fn extension(format: &str) -> &'static str {
    if format == "png" { "png" } else { "svg" }
}

struct HostResult {
    status: CanvasHost,
    entries: Vec<CanvasEntry>,
}
fn read_manifest(directory: &Path) -> HostManifest {
    fs::read(directory.join("manifest.json"))
        .ok()
        .filter(|b| b.len() < MAX_INDEX_BYTES)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn entries(
    config: &CanvasConfig,
    host: &Host,
    key: &str,
    directory: &Path,
    manifest: &HostManifest,
) -> Vec<CanvasEntry> {
    manifest
        .canvases
        .iter()
        .map(|s| {
            // Only a render that is still on disk is offered to the viewer.
            let present = s.file.as_ref().filter(|f| directory.join(f).is_file());
            CanvasEntry {
                host: host.name.clone(),
                id: s.id.clone(),
                kind: s.kind.clone(),
                revision: s.revision,
                rendered_revision: present.and(s.rendered_revision),
                objects: s.objects,
                updated_ms: s.updated_ms,
                rendered_ms: present.and(s.rendered_ms),
                format: present.and(s.format.clone()),
                bytes: if present.is_some() { s.bytes } else { 0 },
                sha256: present.and(s.sha256.clone()),
                src: present.map(|f| {
                    format!(
                        "hosts/{key}/{f}?v={}",
                        s.rendered_revision.unwrap_or(s.revision)
                    )
                }),
                ocr: s.ocr.clone(),
                text: s.text.clone(),
                open: open_command(&config.program, host, &s.id),
                live: manifest
                    .fleet
                    .as_ref()
                    .map(|node| format!("#/{}/{}", percent(node), percent(&s.id))),
                error: s.error.clone(),
            }
        })
        .collect()
}

/// One node in a pull: its configuration, transport and fleet name.
struct Job {
    host: Host,
    via: Via,
    fleet: Option<String>,
}
/// Pull one node: list, export what changed, prune what disappeared.
async fn pull_host(
    config: Config,
    job: Job,
    root: PathBuf,
    offline: bool,
    force: bool,
    gate: Arc<Semaphore>,
) -> Result<HostResult> {
    let Job { host, via, fleet } = job;
    let key = host_key(&host);
    let directory = root.join("hosts").join(&key);
    private_dir(&directory)?;
    let mut manifest = read_manifest(&directory);
    manifest.version = 1;
    manifest.host = host.name.clone();
    if !offline {
        manifest.fleet = fleet;
        manifest.via = Some(via.name(&host).into());
    }
    let canvas = &config.canvases;
    let mut rendered = 0;
    let mut warnings = vec![];
    let state = if offline {
        "cached"
    } else {
        match list_via(canvas, &host, &via, &gate).await {
            Err(_) if matches!(via, Via::Unreachable { quiet: true, .. }) => "offline",
            Err(error) => {
                warnings.push(bounded(&error.to_string(), MAX_WARNING_CHARS));
                "unavailable"
            }
            Ok(listed) => {
                let previous: HashMap<String, Stored> = manifest
                    .canvases
                    .drain(..)
                    .map(|s| (s.id.clone(), s))
                    .collect();
                let mut format = canvas.format;
                if format == CanvasFormat::Svg
                    && manifest
                        .svg_unsupported_ms
                        .is_some_and(|ms| now_ms().saturating_sub(ms) < SVG_REPROBE_MS)
                {
                    format = CanvasFormat::Png;
                    warnings.push(
                        "cursive on this node predates SVG export (0.5.0); rendering PNG".into(),
                    );
                }
                let mut next = vec![];
                let mut invalid = 0;
                for summary in listed {
                    if !valid_id(&summary.id) {
                        invalid += 1;
                        continue;
                    }
                    let mut stored = previous.get(&summary.id).cloned().unwrap_or_default();
                    let file_ok = stored
                        .file
                        .as_ref()
                        .is_some_and(|f| directory.join(f).is_file());
                    let theme = (format == CanvasFormat::Svg)
                        .then(|| canvas.theme.clone())
                        .flatten();
                    let current = stored.rendered_revision == Some(summary.revision)
                        && file_ok
                        && stored.format.as_deref() == Some(format.name())
                        && stored.theme == theme
                        && stored.error.is_none();
                    stored.id = summary.id.clone();
                    stored.kind = summary.kind.clone();
                    stored.revision = summary.revision;
                    stored.objects = summary.objects;
                    stored.updated_ms = summary.updated_ms;
                    stored.ocr = summary.text.clone().map(|t| bounded(&t, 400));
                    if current && !force {
                        next.push(stored);
                        continue;
                    }
                    let mut result =
                        export_via(canvas, &host, &summary.id, format, &gate, &via).await;
                    if let Err((_, true)) = &result {
                        warnings.push(
                            "cursive on this node predates SVG export (0.5.0); rendering PNG"
                                .into(),
                        );
                        manifest.svg_unsupported_ms = Some(now_ms());
                        format = CanvasFormat::Png;
                        result = export_via(canvas, &host, &summary.id, format, &gate, &via).await;
                    } else if result.is_ok() && format == CanvasFormat::Svg {
                        manifest.svg_unsupported_ms = None;
                    }
                    match result {
                        Ok(render) => {
                            let file =
                                format!("{}.{}", summary.id, extension(render.format.name()));
                            atomic(&directory.join(&file), &render.bytes)?;
                            if let Some(old) = &stored.file
                                && old != &file
                            {
                                let _ = fs::remove_file(directory.join(old));
                            }
                            stored.sha256 = Some(hash(&render.bytes));
                            stored.bytes = render.bytes.len() as u64;
                            stored.file = Some(file);
                            stored.format = Some(render.format.name().into());
                            stored.theme = (render.format == CanvasFormat::Svg)
                                .then(|| canvas.theme.clone())
                                .flatten();
                            // The SVG names the revision it drew; it may be newer than the list.
                            let drawn = render.revision.unwrap_or(summary.revision);
                            stored.rendered_revision = Some(drawn);
                            stored.revision = drawn.max(summary.revision);
                            stored.rendered_ms = Some(now_ms());
                            stored.text = render.text;
                            stored.error = None;
                            rendered += 1;
                        }
                        Err((error, _)) => {
                            // Keep the previous render, marked stale.
                            stored.error = Some(bounded(&error.to_string(), MAX_WARNING_CHARS));
                        }
                    }
                    next.push(stored);
                }
                // Canvases no longer listed: drop their renders.
                for (id, gone) in previous {
                    if !next.iter().any(|s| s.id == id)
                        && let Some(file) = gone.file
                    {
                        let _ = fs::remove_file(directory.join(file));
                    }
                }
                if invalid > 0 {
                    warnings.push(format!("{invalid} canvases with unsafe ids skipped"));
                }
                let failed = next.iter().filter(|s| s.error.is_some()).count();
                if failed > 0 {
                    warnings.push(format!(
                        "{failed} canvases could not be exported; previous renders kept"
                    ));
                }
                manifest.canvases = next;
                manifest.last_sync_ms = Some(now_ms());
                "synced"
            }
        }
    };
    if !offline {
        manifest.last_state = Some(state.into());
        manifest.warnings = warnings.clone();
        atomic(
            &directory.join("manifest.json"),
            &serde_json::to_vec(&manifest)?,
        )?;
    } else {
        warnings = manifest.warnings.clone();
    }
    let entries = entries(canvas, &host, &key, &directory, &manifest);
    Ok(HostResult {
        status: CanvasHost {
            host: host.name.clone(),
            state: state.into(),
            via: if offline {
                "cache".into()
            } else {
                via.name(&host).into()
            },
            last_sync_ms: manifest.last_sync_ms,
            canvases: entries.len(),
            rendered,
            warnings,
        },
        entries,
    })
}

#[derive(Serialize)]
struct Manifest<'a> {
    version: u32,
    pulled_ms: u64,
    gateway: &'a GatewayStatus,
    canvases: &'a [CanvasEntry],
    hosts: &'a [CanvasHost],
}
fn write_index(root: &Path, manifest: &Manifest<'_>) -> Result<PathBuf> {
    let json = serde_json::to_string(manifest)?;
    if json.len() > MAX_INDEX_BYTES {
        return Err(Error::Limit(
            "canvas index exceeds 64 MiB; select fewer hosts".into(),
        ));
    }
    let encoded = json.replace('<', "\\u003c").replace('&', "\\u0026");
    let index = root.join("index.html");
    atomic(&index, PAGE.replace("__MANIFEST__", &encoded).as_bytes())?;
    // The dash updates an open viewer in place from this copy.
    atomic(&root.join("index.json"), json.as_bytes())?;
    Ok(index)
}

/// Fleet-only nodes the cache knows (pulled from the gateway before).
fn cached_fleet_hosts(root: &Path, known: &[Host]) -> Vec<Host> {
    let Ok(dirs) = fs::read_dir(root.join("hosts")) else {
        return vec![];
    };
    let mut found = vec![];
    for dir in dirs.flatten() {
        let manifest = read_manifest(&dir.path());
        if manifest.fleet.is_none() || known.iter().any(|h| h.name == manifest.host) {
            continue;
        }
        let host = fleet_host(&manifest.host);
        if dir.file_name().to_str() == Some(host_key(&host).as_str()) {
            found.push(host);
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}
/// A node known only from the Cursive fleet.
fn fleet_host(name: &str) -> Host {
    Host {
        name: name.into(),
        address: name.into(),
        ..Host::default()
    }
}

/// Which nodes this pull covers and how it reaches each: the gateway's info
/// and fleet listing decide; configured nodes keep SSH as a fallback.
async fn plan(
    config: &Config,
    hosts: Vec<Host>,
    all: bool,
) -> (GatewayStatus, Vec<(Host, Via, Option<String>)>) {
    let canvas = &config.canvases;
    let hosts: Vec<Host> = hosts.into_iter().filter(enabled).collect();
    let gw = canvas.gateway.trim_end_matches('/').to_owned();
    let mut status = GatewayStatus {
        url: gw.clone(),
        web: canvas
            .web_url
            .clone()
            .or_else(|| (!gw.is_empty()).then(|| gw.clone())),
        loopback: !gw.is_empty() && crate::http::loopback(&gw),
        ..GatewayStatus::default()
    };
    let over_ssh = |hosts: Vec<Host>| {
        hosts
            .into_iter()
            .map(|h| (h, Via::Ssh, None))
            .collect::<Vec<_>>()
    };
    if gw.is_empty() {
        status.state = "off".into();
        return (status, over_ssh(hosts));
    }
    let fail = |mut status: GatewayStatus, error: Error, hosts: Vec<Host>| {
        status.state = "unreachable".into();
        status.error = Some(bounded(&error.to_string(), MAX_WARNING_CHARS));
        (status, over_ssh(hosts))
    };
    let info: Info = match crate::http::get_json(
        &format!("{gw}/v1/info"),
        MAX_LIST_BYTES,
        GATEWAY_INFO_TIMEOUT,
    )
    .await
    {
        Ok(info) => info,
        Err(error) => return fail(status, error, hosts),
    };
    // The gateway asks its peers within its own deadline.
    let fleet: FleetCanvases = match crate::http::get_json(
        &format!("{gw}/v1/fleet/canvases?limit={FLEET_PAGE}"),
        16 * 1024 * 1024,
        Duration::from_secs(canvas.timeout_seconds),
    )
    .await
    {
        Ok(fleet) => fleet,
        Err(error) => return fail(status, error, hosts),
    };
    let mut names: Vec<String> = std::iter::once(info.name.clone())
        .chain(info.peers.iter().cloned())
        .chain(fleet.hosts.keys().cloned())
        .collect();
    names.sort();
    names.dedup();
    let online = |node: &str| node == info.name || fleet.hosts.get(node).is_some_and(|h| h.online);
    status.state = "live".into();
    status.name = Some(info.name.clone());
    status.version = Some(info.version.clone());
    status.hosts = names.len();
    status.hosts_online = names.iter().filter(|n| online(n)).count();
    // The listing stops at FLEET_PAGE across the fleet: then page each node.
    let truncated = fleet.canvases.len() >= FLEET_PAGE;
    let mut listed: HashMap<String, Vec<Summary>> = HashMap::new();
    for row in fleet.canvases {
        listed.entry(row.host).or_default().push(row.summary);
    }
    let via = |node: &str, configured: bool, listed: &mut HashMap<String, Vec<Summary>>| {
        if online(node) {
            Via::Daemon {
                base: if node == info.name {
                    format!("{gw}/v1")
                } else {
                    format!("{gw}/v1/hosts/{}", percent(node))
                },
                listed: (!truncated).then(|| listed.remove(node).unwrap_or_default()),
                ssh: configured && canvas.ssh_fallback,
            }
        } else if configured && canvas.ssh_fallback {
            Via::Ssh
        } else {
            Via::Unreachable {
                reason: fleet
                    .hosts
                    .get(node)
                    .and_then(|h| h.error.clone())
                    .unwrap_or_else(|| "not answering the gateway".into()),
                quiet: !configured,
            }
        }
    };
    let mut plan = vec![];
    let mut covered = std::collections::HashSet::new();
    // Hosts named as fleet nodes claim them first; then a local host is the
    // gateway's own node when the gateway runs here and no host claimed it.
    let (named, rest): (Vec<Host>, Vec<Host>) =
        hosts.into_iter().partition(|h| names.contains(&h.name));
    for host in named {
        if covered.insert(host.name.clone()) {
            let node = host.name.clone();
            let via = via(&node, true, &mut listed);
            plan.push((host, via, Some(node)));
        }
    }
    for host in rest {
        if host.local && status.loopback && covered.insert(info.name.clone()) {
            let node = info.name.clone();
            let via = via(&node, true, &mut listed);
            plan.push((host, via, Some(node)));
        } else if host.local && status.loopback {
            // The gateway's node is already listed under its own name.
        } else {
            plan.push((host, Via::Ssh, None));
        }
    }
    if all {
        for node in &names {
            if covered.insert(node.clone()) {
                let via = via(node, false, &mut listed);
                plan.push((fleet_host(node), via, Some(node.clone())));
            }
        }
    }
    (status, plan)
}

async fn pull(
    config: Config,
    hosts: Vec<Host>,
    all: bool,
    input: CanvasInput,
) -> Result<CanvasReceipt> {
    let root = cache_root(&config, input.cache_dir.as_ref())?;
    private_dir(&root.join("hosts"))?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(root.join("canvas.lock"))?;
    let _lock: Flock<File> = Flock::lock(lock, FlockArg::LockExclusiveNonblock)
        .map_err(|_| Error::Invalid("another canvas pull is using this cache".into()))?;
    let started = now_ms();
    let (gateway, plan) = if input.offline {
        let mut hosts: Vec<Host> = hosts.into_iter().filter(enabled).collect();
        if all {
            let cached = cached_fleet_hosts(&root, &hosts);
            hosts.extend(cached);
        }
        let status = GatewayStatus {
            url: config.canvases.gateway.clone(),
            state: "cached".into(),
            web: config.canvases.web_url.clone().or_else(|| {
                (!config.canvases.gateway.is_empty()).then(|| config.canvases.gateway.clone())
            }),
            loopback: crate::http::loopback(&config.canvases.gateway),
            ..GatewayStatus::default()
        };
        (
            status,
            hosts.into_iter().map(|h| (h, Via::Ssh, None)).collect(),
        )
    } else {
        plan(&config, hosts, all).await
    };
    let gate = Arc::new(Semaphore::new(config.canvases.parallelism));
    let mut jobs = JoinSet::new();
    for (host, via, fleet) in plan {
        let (config, root, gate) = (config.clone(), root.clone(), gate.clone());
        let (offline, force) = (input.offline, input.force);
        jobs.spawn(async move {
            // A fault in one node's pull must not cost the fleet its view:
            // that node keeps its cached renders and reports the fault.
            let job = Job {
                host: host.clone(),
                via,
                fleet,
            };
            let pulled = tokio::spawn(pull_host(
                config.clone(),
                job,
                root.clone(),
                offline,
                force,
                gate,
            ))
            .await;
            match pulled {
                Ok(result) => result,
                Err(fault) => {
                    let job = Job {
                        host,
                        via: Via::Ssh,
                        fleet: None,
                    };
                    let mut cached =
                        pull_host(config, job, root, true, false, Arc::new(Semaphore::new(1)))
                            .await?;
                    cached.status.state = "unavailable".into();
                    cached.status.warnings.insert(
                        0,
                        bounded(
                            &format!("internal error while pulling: {fault}"),
                            MAX_WARNING_CHARS,
                        ),
                    );
                    Ok(cached)
                }
            }
        });
    }
    let mut hosts = vec![];
    let mut canvases = vec![];
    while let Some(result) = tokio::select! {
        result = jobs.join_next() => result,
        _ = tokio::signal::ctrl_c() => {
            jobs.abort_all();
            while jobs.join_next().await.is_some() {}
            return Err(Error::Transport("canvas pull cancelled; existing cache retained".into()));
        }
    } {
        let result = result.map_err(|e| Error::Transport(e.to_string()))??;
        hosts.push(result.status);
        canvases.extend(result.entries);
    }
    hosts.sort_by(|a, b| a.host.cmp(&b.host));
    canvases.sort_by(|a, b| {
        b.updated_ms
            .cmp(&a.updated_ms)
            .then(a.host.cmp(&b.host))
            .then(a.id.cmp(&b.id))
    });
    let index = write_index(
        &root,
        &Manifest {
            version: 1,
            pulled_ms: started,
            gateway: &gateway,
            canvases: &canvases,
            hosts: &hosts,
        },
    )?;
    Ok(CanvasReceipt {
        gateway,
        index,
        cache_dir: root,
        canvases: canvases.len(),
        rendered: hosts.iter().map(|h| h.rendered).sum(),
        bytes: canvases.iter().map(|c| c.bytes).sum(),
        pulled_ms: started,
        hosts,
    })
}

impl Service {
    /// Pull new or changed canvases from selected/all enabled nodes and
    /// regenerate the viewer. Unreachable nodes keep their cached renders.
    pub fn canvas_pull(&self, input: CanvasInput) -> Result<CanvasReceipt> {
        if !input.confirmed {
            return Err(Error::Invalid(
                "canvas pull writes a local cache; confirmed=true is required".into(),
            ));
        }
        if !self.config.canvases.enabled && !input.offline {
            return Err(Error::Invalid(
                "canvases are disabled (canvases.enabled: false); --offline reads the cache".into(),
            ));
        }
        let all = input.selection.hosts.is_empty() && !input.selection.local;
        let hosts = self.hosts(&input.selection)?;
        self.runtime
            .block_on(pull(self.config.clone(), hosts, all, input))
    }
    /// Cached canvases (no network): what each node's boards showed at the last pull.
    pub fn canvas_list(&self, input: CanvasListInput) -> Result<CanvasList> {
        let root = cache_path(&self.config, input.cache_dir.as_ref())?;
        let query = input.query.as_deref().map(str::to_lowercase);
        let mut canvases = vec![];
        let mut hosts = vec![];
        let mut selected: Vec<Host> = self
            .hosts(&input.selection)?
            .into_iter()
            .filter(enabled)
            .collect();
        if input.selection.hosts.is_empty() && !input.selection.local {
            let cached = cached_fleet_hosts(&root, &selected);
            selected.extend(cached);
        }
        for host in selected {
            let key = host_key(&host);
            let directory = root.join("hosts").join(&key);
            let manifest = read_manifest(&directory);
            let found = entries(&self.config.canvases, &host, &key, &directory, &manifest);
            hosts.push(CanvasHost {
                host: host.name.clone(),
                via: manifest.via.clone().unwrap_or_default(),
                state: manifest
                    .last_state
                    .clone()
                    .unwrap_or_else(|| "not pulled".into()),
                last_sync_ms: manifest.last_sync_ms,
                canvases: found.len(),
                rendered: 0,
                warnings: manifest.warnings.clone(),
            });
            canvases.extend(found.into_iter().filter(|c| {
                query.as_ref().is_none_or(|q| {
                    c.id.to_lowercase().contains(q)
                        || c.text.to_lowercase().contains(q)
                        || c.ocr.as_ref().is_some_and(|o| o.to_lowercase().contains(q))
                })
            }));
        }
        canvases.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then(a.host.cmp(&b.host)));
        canvases.truncate(input.limit.unwrap_or(1000).min(10_000));
        Ok(CanvasList {
            cache_dir: root,
            canvases,
            hosts,
        })
    }
    /// Path of a cached render for one node's canvas.
    pub fn canvas_render_path(
        &self,
        selection: &Selection,
        id: &str,
        cache_dir: Option<&String>,
    ) -> Result<PathBuf> {
        if !valid_id(id) {
            return Err(Error::Invalid("invalid canvas id".into()));
        }
        // A node known only from the fleet is addressed by its fleet name.
        let hosts = match (self.hosts(selection), selection.hosts.as_slice()) {
            (Ok(hosts), _) => hosts,
            (Err(_), [name]) if !selection.local => vec![fleet_host(name)],
            (Err(error), _) => return Err(error),
        };
        if hosts.len() != 1 {
            return Err(Error::Invalid(
                "select exactly one --host (or --local)".into(),
            ));
        }
        let root = cache_path(&self.config, cache_dir)?;
        let directory = root.join("hosts").join(host_key(&hosts[0]));
        let manifest = read_manifest(&directory);
        let stored = manifest
            .canvases
            .iter()
            .find(|s| s.id == id)
            .ok_or_else(|| {
                Error::Invalid(format!(
                    "no cached canvas {id} on {}; run ag canvas pull",
                    hosts[0].name
                ))
            })?;
        let file = stored
            .file
            .as_ref()
            .filter(|f| directory.join(f).is_file())
            .ok_or_else(|| Error::Invalid(format!("canvas {id} has no cached render yet")))?;
        Ok(directory.join(file))
    }
}
