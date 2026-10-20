//! Fleet elicitations through each node's Paratenic AHP host.
//!
//! Paratenic's `SessionState.inputNeeded` is the single source of truth for
//! pending questions (blocking `interactive_choice`, async `async_choice`, and
//! Pi-daemon RPC dialogs alike). `ag` keeps no second choices database: it lists
//! input-needed sessions, reads their authoritative snapshots, and answers with
//! the standard `chat/inputCompleted` action. The settlement is the host's echo
//! of our exact `clientId`/`clientSeq`; a missing echo is reported as
//! indeterminate and never retried automatically.
use crate::{
    Error, Result,
    config::{self, Config, Host},
};
use ahp::{Client, ClientConfig, ClientEvent, SubscriptionEvent};
use ahp_types::{
    actions::{ChatInputCompletedAction, StateAction},
    commands::{ListSessionsParams, ListSessionsResult, SubscribeView},
    state::{
        ChatInputAnswer, ChatInputAnswerValue, ChatInputAnswered, ChatInputBooleanAnswerValue,
        ChatInputNumberAnswerValue, ChatInputQuestion, ChatInputResponseKind,
        ChatInputSelectedAnswerValue, ChatInputSelectedManyAnswerValue, ChatInputTextAnswerValue,
        ChatInteractivity, SessionInputRequest, SessionLifecycle, SessionState, SessionStatus,
        SnapshotState,
    },
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{sync::Semaphore, task::JoinSet};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig,
};

const MAX_PAGES: usize = 200;
const MAX_SESSIONS: usize = 10_000;
const MAX_TEXT: usize = 64 * 1024;
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_TOKEN_BYTES: u64 = 16 * 1024;
const MAX_CULTURE_CONFIG_BYTES: u64 = 1024 * 1024;

pub fn validate_url(url: &str, allow_plaintext: bool) -> std::result::Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid paratenic url: {e}"))?;
    if !matches!(parsed.scheme(), "ws" | "wss") {
        return Err("paratenic url scheme must be ws or wss".into());
    }
    let loopback = match parsed.host() {
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => return Err("paratenic url needs a host".into()),
    };
    if parsed.scheme() == "ws" && !loopback && !allow_plaintext {
        return Err(
            "ws:// away from loopback needs allow_plaintext_non_loopback (or use wss://)".into(),
        );
    }
    Ok(())
}

// ---- endpoint resolution -------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Endpoint {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_file: Option<PathBuf>,
    pub allow_plaintext_non_loopback: bool,
    /// `ag` (explicit node config) or `culture` (imported host entry).
    pub source: String,
}
impl Endpoint {
    /// HTTP base of the same listener, for the unauthenticated /status probe.
    pub fn http_base(&self) -> Option<String> {
        let mut url = url::Url::parse(&self.url).ok()?;
        let scheme = if url.scheme() == "wss" {
            "https"
        } else {
            "http"
        };
        url.set_scheme(scheme).ok()?;
        url.set_path("");
        url.set_query(None);
        Some(url.as_str().trim_end_matches('/').to_owned())
    }
}

#[derive(Default, Deserialize)]
struct CultureFile {
    #[serde(default)]
    hosts: Vec<CultureHost>,
}
#[derive(Deserialize)]
struct CultureHost {
    id: String,
    url: String,
    #[serde(default)]
    token_file: Option<String>,
    #[serde(default)]
    allow_plaintext_non_loopback: bool,
}

/// pi-client's host list (`client` in Pi's settings.json): each node's
/// pi-daemon, whose `/ahp` serves its Durable sessions (and TUI Pis).
#[derive(Default, Deserialize)]
struct PiSettingsFile {
    #[serde(default)]
    client: PiClientSettings,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiClientSettings {
    #[serde(default)]
    hosts: Vec<PiClientHost>,
    #[serde(default)]
    token_file: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PiClientHost {
    name: String,
    url: String,
    /// The node's `pi-daemon bridge` (TUI Pis), e.g. `ws://node:7464`.
    #[serde(default)]
    bridge: Option<String>,
    #[serde(default)]
    token_file: Option<String>,
}

fn pi_settings_path(config: &Config) -> Result<PathBuf> {
    if let Some(path) = &config.paratenic.pi_settings {
        return config::expand_home(path);
    }
    let dir = std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".pi/agent")
        });
    Ok(dir.join("settings.json"))
}

/// pi-client's hosts and default token file; empty when Pi is not configured.
fn pi_client_hosts(config: &Config) -> Result<(Vec<PiClientHost>, Option<String>)> {
    let path = pi_settings_path(config)?;
    let meta = match std::fs::metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((vec![], None)),
        Err(error) => return Err(error.into()),
    };
    if meta.len() > MAX_CULTURE_CONFIG_BYTES {
        return Err(Error::Limit("Pi settings exceed 1 MiB".into()));
    }
    // Pi's settings hold much else; only `client` is read, and a file that
    // does not parse is ignored rather than failing every choices query.
    let file: PiSettingsFile = serde_json::from_slice(&std::fs::read(&path)?).unwrap_or_default();
    Ok((file.client.hosts, file.client.token_file))
}

/// `ws://host:7463` → `ws://host:7463/ahp` (a URL already naming a path is kept).
fn ahp_url(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(parsed) if parsed.path().is_empty() || parsed.path() == "/" => {
            format!("{}/ahp", url.trim_end_matches('/'))
        }
        _ => url.to_owned(),
    }
}

fn culture_hosts(config: &Config) -> Result<Vec<CultureHost>> {
    let path = match &config.paratenic.culture_config {
        Some(path) => config::expand_home(path)?,
        None => std::env::var_os("XDG_CONFIG_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config")
            })
            .join("culture/config.yaml"),
    };
    let meta = match std::fs::metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(error.into()),
    };
    if meta.len() > MAX_CULTURE_CONFIG_BYTES {
        return Err(Error::Limit("culture config exceeds 1 MiB".into()));
    }
    let file: CultureFile = serde_yaml::from_slice(&std::fs::read(&path)?)
        .map_err(|e| Error::Config(format!("{}: {e}", path.display())))?;
    Ok(file.hosts)
}

fn local_names() -> Vec<String> {
    let mut names = vec![];
    if let Ok(name) = nix::unistd::gethostname() {
        let name = name.to_string_lossy().to_lowercase();
        if let Some(short) = name.split('.').next() {
            names.push(short.to_owned());
        }
        names.push(name);
    }
    names
}

/// Resolve every selected node to an endpoint, `None` when unconfigured.
pub fn endpoints(config: &Config, hosts: &[Host]) -> Result<Vec<(Host, Option<Endpoint>)>> {
    let culture = if config.paratenic.enabled {
        culture_hosts(config)?
    } else {
        vec![]
    };
    hosts
        .iter()
        .map(|host| {
            let p = &host.paratenic;
            if !config.paratenic.enabled || p.enabled == Some(false) {
                return Ok((host.clone(), None));
            }
            let candidates = culture_candidates(host);
            let imported = culture
                .iter()
                .find(|c| candidates.iter().any(|n| c.id.eq_ignore_ascii_case(n)));
            let (url, token, plaintext, source) = match (&p.url, imported) {
                (Some(url), _) => (
                    url.clone(),
                    p.token_file
                        .clone()
                        .or_else(|| imported.and_then(|c| c.token_file.clone())),
                    p.allow_plaintext_non_loopback == Some(true),
                    "ag",
                ),
                (None, Some(c)) => (
                    c.url.clone(),
                    p.token_file.clone().or_else(|| c.token_file.clone()),
                    p.allow_plaintext_non_loopback
                        .unwrap_or(c.allow_plaintext_non_loopback),
                    "culture",
                ),
                (None, None) => return Ok((host.clone(), None)),
            };
            validate_url(&url, plaintext)
                .map_err(|e| Error::Config(format!("host {}: {e}", host.name)))?;
            let token_file = token
                .or_else(|| config.paratenic.token_file.clone())
                .map(|t| config::expand_home(&t))
                .transpose()?;
            Ok((
                host.clone(),
                Some(Endpoint {
                    url,
                    token_file,
                    allow_plaintext_non_loopback: plaintext,
                    source: source.into(),
                }),
            ))
        })
        .collect()
}

/// Culture host ids that name this node.
fn culture_candidates(host: &Host) -> Vec<String> {
    if let Some(name) = &host.paratenic.culture_host {
        vec![name.to_lowercase()]
    } else if host.local {
        local_names()
    } else {
        vec![host.name.to_lowercase()]
    }
}

/// pi-daemon serves AHP beside Paratenic; Culture names it `<node>-pi-daemon`.
pub const PI_DAEMON_SUFFIX: &str = "-pi-daemon";
/// The node's `pi-daemon bridge` serves its TUI Pis over AHP (pi-daemon 1.11).
pub const PI_BRIDGE_SUFFIX: &str = "-pi-bridge";
/// Targets that are a node's other AHP endpoints, not configured nodes.
pub const ENDPOINT_SUFFIXES: [&str; 2] = [PI_DAEMON_SUFFIX, PI_BRIDGE_SUFFIX];

/// Endpoints to list and answer choices on: each node's Paratenic endpoint
/// (as [`endpoints`]) plus the node's pi-daemon `/ahp` as a target of its own
/// named `<node>-pi-daemon` (answers route by that name). pi-daemon's
/// `ask_user` questions, and the TUI Pis it serves, are AHP `chatInput`
/// entries like Paratenic's, so they list and answer the same way. The daemon
/// comes from pi-client's `client.hosts` (bearer: the host's `tokenFile`,
/// else `client.tokenFile`), else from Culture's `<node>-pi-daemon` host.
/// Doctor, speech and media stay per node and use [`endpoints`].
pub fn choice_endpoints(config: &Config, hosts: &[Host]) -> Result<Vec<(Host, Option<Endpoint>)>> {
    let mut targets = endpoints(config, hosts)?;
    if !config.paratenic.enabled || !config.paratenic.pi_daemon {
        return Ok(targets);
    }
    let culture = culture_hosts(config)?;
    let (pi_hosts, pi_token) = pi_client_hosts(config)?;
    for host in hosts {
        let p = &host.paratenic;
        if p.enabled == Some(false)
            || p.pi_daemon == Some(false)
            || ENDPOINT_SUFFIXES
                .iter()
                .any(|suffix| host.name.ends_with(suffix))
        {
            continue;
        }
        let candidates = culture_candidates(host);
        let from_pi = pi_hosts
            .iter()
            .find(|h| candidates.iter().any(|n| h.name.eq_ignore_ascii_case(n)))
            .map(|h| {
                (
                    ahp_url(&h.url),
                    h.token_file.clone().or_else(|| pi_token.clone()),
                    // pi-client's hosts are the operator's own tailnet daemons;
                    // pi-client itself connects to them over ws://.
                    true,
                    "pi-client",
                )
            });
        let names: Vec<String> = candidates
            .iter()
            .map(|n| format!("{n}{PI_DAEMON_SUFFIX}"))
            .collect();
        let from_culture = || {
            culture
                .iter()
                .find(|c| names.iter().any(|n| c.id.eq_ignore_ascii_case(n)))
                .map(|c| {
                    (
                        c.url.clone(),
                        c.token_file.clone(),
                        c.allow_plaintext_non_loopback,
                        "culture",
                    )
                })
        };
        let Some((url, token, plaintext, source)) = from_pi.or_else(from_culture) else {
            continue;
        };
        validate_url(&url, plaintext)
            .map_err(|e| Error::Config(format!("host {}{PI_DAEMON_SUFFIX}: {e}", host.name)))?;
        let token_file = token
            .or_else(|| config.paratenic.token_file.clone())
            .map(|t| config::expand_home(&t))
            .transpose()?;
        let mut daemon = host.clone();
        daemon.name = format!("{}{PI_DAEMON_SUFFIX}", host.name);
        targets.push((
            daemon,
            Some(Endpoint {
                url,
                token_file: token_file.clone(),
                allow_plaintext_non_loopback: plaintext,
                source: source.into(),
            }),
        ));
        // The node's TUI Pis, through its pi-daemon bridge's /ahp (same bearer).
        let bridge = pi_hosts
            .iter()
            .find(|h| candidates.iter().any(|n| h.name.eq_ignore_ascii_case(n)))
            .and_then(|h| h.bridge.clone());
        if let Some(bridge) = bridge {
            let url = ahp_url(&bridge);
            validate_url(&url, true)
                .map_err(|e| Error::Config(format!("host {}{PI_BRIDGE_SUFFIX}: {e}", host.name)))?;
            let mut tui = host.clone();
            tui.name = format!("{}{PI_BRIDGE_SUFFIX}", host.name);
            targets.push((
                tui,
                Some(Endpoint {
                    url,
                    token_file,
                    allow_plaintext_non_loopback: true,
                    source: "pi-client".into(),
                }),
            ));
        }
    }
    Ok(targets)
}

fn read_token(path: &PathBuf) -> Result<String> {
    // Managed (sops/Collective) symlinks resolve normally; content is bounded.
    let meta = std::fs::metadata(path)
        .map_err(|e| Error::Config(format!("token file {}: {e}", path.display())))?;
    if meta.len() > MAX_TOKEN_BYTES {
        return Err(Error::Config("token file exceeds 16 KiB".into()));
    }
    let token = std::fs::read_to_string(path)?;
    let token = token.trim();
    if token.is_empty() || token.lines().count() != 1 {
        return Err(Error::Config(
            "token file must contain exactly one non-empty line".into(),
        ));
    }
    Ok(token.to_owned())
}

// ---- connection ---------------------------------------------------------

pub struct Connection {
    pub client: Client,
    pub client_id: String,
    pub connect_ms: u64,
    lease: IdentityLease,
}

/// A stable logical AHP client id leased from a small per-host pool.
///
/// Paratenic persists every logical client id it has seen, so a fresh id per
/// run would leak host state. Slots are flock-leased so concurrent `ag`
/// processes never share a live id (sharing replaces the older connection),
/// and each slot's `clientSeq` is persisted monotonically so a reused id can
/// never collide with a retained dispatch from an earlier run.
struct IdentityLease {
    _lock: Option<nix::fcntl::Flock<std::fs::File>>,
    seq_path: Option<PathBuf>,
    fallback_seq: i64,
}
const IDENTITY_SLOTS: usize = 16;

fn identity_root() -> PathBuf {
    std::env::var_os("AG_STATE_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("XDG_STATE_HOME")
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state")
                })
                .join("ag")
        })
        .join("paratenic")
}

impl IdentityLease {
    fn acquire(url: &str) -> (String, Self) {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        let key = format!("{:x}", Sha256::digest(url.as_bytes()));
        let dir = identity_root().join(&key[..16]);
        let ok = std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .is_ok();
        if ok {
            for slot in 0..IDENTITY_SLOTS {
                let Ok(file) = std::fs::OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .mode(0o600)
                    .custom_flags(nix::libc::O_NOFOLLOW)
                    .open(dir.join(format!("slot-{slot}.lock")))
                else {
                    continue;
                };
                if let Ok(lock) =
                    nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock)
                {
                    let id = format!("ag-{}-{slot}", &key[..12]);
                    return (
                        id,
                        Self {
                            _lock: Some(lock),
                            seq_path: Some(dir.join(format!("slot-{slot}.seq"))),
                            fallback_seq: 0,
                        },
                    );
                }
            }
        }
        // Pool exhausted or state unwritable: an unpooled id still works.
        (
            format!("ag-{}", uuid::Uuid::new_v4().simple()),
            Self {
                _lock: None,
                seq_path: None,
                fallback_seq: 0,
            },
        )
    }
    /// Next clientSeq: strictly above any persisted value and the wall clock.
    fn next(&mut self) -> Result<i64> {
        let now = doctor_now_ms() as i64;
        let Some(path) = &self.seq_path else {
            self.fallback_seq = (self.fallback_seq + 1).max(now);
            return Ok(self.fallback_seq);
        };
        let previous = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(0);
        let next = (previous + 1).max(now);
        // Persist before dispatch: a crash can skip a number, never reuse one.
        let temp = path.with_extension("seq.tmp");
        std::fs::write(&temp, next.to_string())?;
        std::fs::rename(&temp, path)?;
        Ok(next)
    }
}
fn doctor_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
impl Connection {
    pub async fn open(endpoint: &Endpoint, timeout: Duration) -> Result<Self> {
        Self::open_with(endpoint, timeout, timeout).await
    }
    pub async fn open_with(
        endpoint: &Endpoint,
        connect: Duration,
        timeout: Duration,
    ) -> Result<Self> {
        let started = Instant::now();
        let mut request = endpoint
            .url
            .as_str()
            .into_client_request()
            .map_err(|e| Error::Config(format!("paratenic url: {e}")))?;
        if let Some(path) = &endpoint.token_file {
            let token = read_token(path)?;
            let value = HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| Error::Config("token contains invalid header characters".into()))?;
            request.headers_mut().insert("authorization", value);
        }
        let websocket = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_MESSAGE_BYTES));
        let (stream, _) = tokio::time::timeout(
            connect,
            tokio_tungstenite::connect_async_with_config(request, Some(websocket), true),
        )
        .await
        .map_err(|_| Error::Transport("paratenic connect timed out".into()))?
        .map_err(|e| Error::Transport(format!("paratenic connect: {}", redact(&e.to_string()))))?;
        let client = Client::connect(
            ahp_ws::WebSocketTransport::from_stream(stream),
            ClientConfig {
                default_request_timeout: Some(timeout),
                subscription_buffer: 1024,
            },
        )
        .await
        .map_err(rpc)?;
        let (client_id, lease) = IdentityLease::acquire(&endpoint.url);
        tokio::time::timeout(
            timeout,
            client.initialize(
                client_id.clone(),
                ahp_types::SUPPORTED_PROTOCOL_VERSIONS
                    .iter()
                    .map(|v| (*v).to_owned())
                    .collect(),
                vec![],
            ),
        )
        .await
        .map_err(|_| Error::Transport("paratenic initialize timed out".into()))?
        .map_err(rpc)?;
        Ok(Self {
            client,
            client_id,
            connect_ms: started.elapsed().as_millis() as u64,
            lease,
        })
    }
    pub async fn sessions(&self) -> Result<Vec<ahp_types::state::SessionSummary>> {
        let mut cursor: Option<String> = None;
        let mut seen = std::collections::HashSet::new();
        let mut items = vec![];
        for _ in 0..MAX_PAGES {
            let page: ListSessionsResult = self
                .client
                .request(
                    "listSessions",
                    ListSessionsParams {
                        channel: ahp_types::ROOT_RESOURCE_URI.into(),
                        meta: None,
                        limit: Some(500),
                        cursor: cursor.clone(),
                    },
                )
                .await
                .map_err(rpc)?;
            items.extend(page.items);
            if items.len() > MAX_SESSIONS {
                return Err(Error::Limit(
                    "paratenic session catalogue exceeds 10000".into(),
                ));
            }
            match page.next_cursor {
                Some(next) if seen.insert(next.clone()) => cursor = Some(next),
                Some(_) => {
                    return Err(Error::Transport(
                        "paratenic session catalogue repeated a cursor".into(),
                    ));
                }
                None => return Ok(items),
            }
        }
        Err(Error::Limit(
            "paratenic session catalogue exceeds 200 pages".into(),
        ))
    }
    pub async fn session(&self, uri: &str) -> Result<SessionState> {
        let (result, _subscription) = self.client.subscribe(uri.to_owned()).await.map_err(rpc)?;
        let _ = self.client.unsubscribe(uri.to_owned()).await;
        match result.snapshot.map(|s| s.state) {
            Some(SnapshotState::Session(state)) => Ok(*state),
            _ => Err(Error::Transport(format!(
                "paratenic returned no session snapshot for {uri}"
            ))),
        }
    }
    pub async fn close(self) {
        self.client.shutdown().await;
    }
}

fn rpc(error: ahp::ClientError) -> Error {
    Error::Transport(format!("paratenic: {}", redact(&error.to_string())))
}

/// A node that is simply down is a fact, not a fault: classify connection-level
/// failures (refused, timed out, unknown host, unreachable) so callers can show
/// one quiet "offline" line instead of a raw transport error.
/// The WebSocket upgrade was answered 404: the endpoint does not exist there.
fn not_found(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    m.contains("404") || m.contains("not found")
}

pub fn offline_reason(message: &str) -> Option<&'static str> {
    let m = message.to_ascii_lowercase();
    if m.contains("connection refused") {
        Some("not listening")
    } else if m.contains("timed out") || m.contains("operation timed out") {
        Some("timed out")
    } else if m.contains("nodename nor servname")
        || m.contains("name or service not known")
        || m.contains("could not resolve")
        || m.contains("failed to lookup address")
        || m.contains("no address associated")
    {
        Some("unknown host")
    } else if m.contains("no route to host")
        || m.contains("network is unreachable")
        || m.contains("host is down")
        || m.contains("connection reset")
        || m.contains("broken pipe")
        || m.contains("connection closed")
    {
        Some("unreachable")
    } else {
        None
    }
}
fn redact(message: &str) -> String {
    // Never echo Authorization material from transport diagnostics.
    message
        .split_whitespace()
        .map(|w| {
            if w.len() > 40 && !w.contains('/') {
                "…"
            } else {
                w
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(400)
        .collect()
}

// ---- view model ---------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct ChoicesInput {
    #[serde(flatten)]
    pub selection: crate::model::Selection,
    /// Include non-actionable entries (stale, tool confirmations, auth).
    pub all: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct FleetChoices {
    pub observed_at: String,
    pub nodes: Vec<NodeChoices>,
    pub actionable: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct NodeChoices {
    /// Where answers go: the node, or `<node>-pi-daemon` for its pi-daemon.
    pub host: String,
    /// The node this endpoint belongs to (group by this).
    #[serde(default)]
    pub node: String,
    /// paratenic | pi-daemon
    #[serde(default)]
    pub source: String,
    /// ok | offline | unconfigured | disabled | error
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    pub sessions: usize,
    pub input_needed_sessions: usize,
    pub latency_ms: Option<u64>,
    pub agents: Vec<AgentChoices>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AgentChoices {
    pub session: String,
    pub title: String,
    pub provider: String,
    /// daemon (a pi-daemon Durable session) | tui (a TUI Pi, through
    /// Paratenic or pi-daemon's `tui-…` sessions)
    #[serde(default)]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub modified_at: String,
    pub choices: Vec<Choice>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Choice {
    pub host: String,
    pub session: String,
    pub chat: String,
    /// Opaque `inputNeeded` entry id.
    pub entry: String,
    /// The id answered by chat/inputCompleted (chat input only).
    pub request_id: String,
    /// chatInput | toolConfirmation | toolClientExecution | toolAuthentication | unknown
    pub kind: String,
    /// Digest of the authoritative entry; answers are refused if it changed.
    pub revision: String,
    /// Headline: the request message, or only its question when the message
    /// is the question followed by context (Pi choices send `question\n\ncontext`).
    pub title: String,
    /// Context to show under the title, when the request carried any beyond
    /// the title (never a repeat of the title or of the question).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub questions: Vec<Question>,
    pub actionable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_reason: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Question {
    pub id: String,
    /// text | number | integer | boolean | single-select | multi-select | unknown
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub message: String,
    pub required: bool,
    pub allow_freeform: bool,
    pub options: Vec<QuestionOption>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub recommended: bool,
}

fn bounded(text: &str) -> String {
    text.chars().take(MAX_TEXT).collect()
}

/// Split a request message into (title, context). Pi choices send the
/// question, a blank line and agent context as the request message, and the
/// same question again as the single question's prompt; showing both repeats
/// the question. When the message starts with the (only) question, the title
/// is the question and the rest is context.
fn headline(message: Option<&str>, questions: &[Question]) -> (String, Option<String>) {
    let Some(message) = message.map(str::trim).filter(|m| !m.is_empty()) else {
        return ("Input requested".into(), None);
    };
    if let [question] = questions {
        let prompt = question.message.trim();
        if !prompt.is_empty() {
            if let Some(rest) = message.strip_prefix(prompt) {
                let rest = rest.trim();
                // Only at a boundary: "Ship it?" must not split "Ship it?!"
                let boundary =
                    rest.is_empty() || message[prompt.len()..].starts_with(char::is_whitespace);
                if boundary {
                    return (bounded(prompt), (!rest.is_empty()).then(|| bounded(rest)));
                }
            }
        }
    }
    (bounded(message), None)
}

fn question_view(question: &ChatInputQuestion) -> Question {
    let opts = |options: &[ahp_types::state::ChatInputOption]| {
        options
            .iter()
            .map(|o| QuestionOption {
                id: o.id.clone(),
                label: bounded(&o.label),
                description: o.description.as_deref().map(bounded),
                recommended: o.recommended == Some(true),
            })
            .collect()
    };
    let base = |id: &str, kind: &str, title: &Option<String>, message: &str, required| Question {
        id: id.into(),
        kind: kind.into(),
        title: title.as_deref().map(bounded),
        message: bounded(message),
        required: required == Some(true),
        allow_freeform: false,
        options: vec![],
    };
    match question {
        ChatInputQuestion::Text(q) => base(&q.id, "text", &q.title, &q.message, q.required),
        ChatInputQuestion::Number(q) => base(&q.id, "number", &q.title, &q.message, q.required),
        ChatInputQuestion::Integer(q) => base(&q.id, "integer", &q.title, &q.message, q.required),
        ChatInputQuestion::Boolean(q) => base(&q.id, "boolean", &q.title, &q.message, q.required),
        ChatInputQuestion::SingleSelect(q) => Question {
            allow_freeform: q.allow_freeform_input == Some(true),
            options: opts(&q.options),
            ..base(&q.id, "single-select", &q.title, &q.message, q.required)
        },
        ChatInputQuestion::MultiSelect(q) => Question {
            allow_freeform: q.allow_freeform_input == Some(true),
            options: opts(&q.options),
            ..base(&q.id, "multi-select", &q.title, &q.message, q.required)
        },
        ChatInputQuestion::Unknown(_) => Question {
            id: String::new(),
            kind: "unknown".into(),
            title: None,
            message: "Unsupported question".into(),
            required: true,
            allow_freeform: false,
            options: vec![],
        },
    }
}

pub fn revision(request: &SessionInputRequest) -> String {
    let bytes = serde_json::to_vec(request).unwrap_or_default();
    format!("{:x}", Sha256::digest(bytes))[..16].to_owned()
}

/// Mirrors Culture's actionability rules so `ag` never answers what Culture
/// would refuse (stale catalogue, unavailable backend, read-only chat).
fn stale_reason(
    state: &SessionState,
    catalogued: bool,
    chat: &str,
    paratenic_meta: Option<&Value>,
) -> Option<String> {
    let status = SessionStatus::from_bits(state.status);
    let flag_off = |meta: Option<&Value>| {
        meta.is_some_and(|m| {
            ["backendOnline", "inputAvailable"]
                .iter()
                .any(|f| m.get(*f).and_then(Value::as_bool) == Some(false))
        })
    };
    let session_meta = state.meta.as_ref().and_then(|m| m.get("paratenic"));
    let chat_ok = state.chats.iter().any(|c| {
        c.resource == chat
            && c.interactivity.unwrap_or(ChatInteractivity::Full) == ChatInteractivity::Full
            && !SessionStatus::from_bits(c.status).contains(SessionStatus::Error)
    });
    if !catalogued {
        Some("session is absent from the fresh input-needed catalogue".into())
    } else if flag_off(session_meta) || flag_off(paratenic_meta) {
        Some("session backend or input authority is unavailable".into())
    } else if state.lifecycle != SessionLifecycle::Ready {
        Some("session is not ready".into())
    } else if !status.contains(SessionStatus::InputNeeded) {
        Some("session no longer reports input-needed".into())
    } else if status.contains(SessionStatus::Error) {
        Some("session is in an error state".into())
    } else if !chat_ok {
        Some("request chat is read-only or unavailable".into())
    } else {
        None
    }
}

pub fn choices_for(
    host: &str,
    session: &str,
    state: &SessionState,
    catalogued: bool,
    catalogue_meta: Option<&Value>,
) -> Vec<Choice> {
    state
        .input_needed
        .iter()
        .flatten()
        .map(|entry| {
            let raw = serde_json::to_value(entry).unwrap_or(Value::Null);
            let label = |fallback: &str| {
                raw.pointer("/toolCall/displayName")
                    .and_then(Value::as_str)
                    .map(bounded)
                    .unwrap_or_else(|| fallback.into())
            };
            let (id, chat, kind, title, message, url, questions, request_id) = match entry {
                SessionInputRequest::ChatInput(e) => {
                    let questions: Vec<Question> = e
                        .request
                        .questions
                        .iter()
                        .flatten()
                        .map(question_view)
                        .collect();
                    let (title, context) = headline(e.request.message.as_deref(), &questions);
                    (
                        e.id.clone(),
                        e.chat.clone(),
                        "chatInput",
                        title,
                        context,
                        e.request.url.clone(),
                        questions,
                        e.request.id.clone(),
                    )
                }
                SessionInputRequest::ToolConfirmation(e) => (
                    e.id.clone(),
                    e.chat.clone(),
                    "toolConfirmation",
                    label("Tool confirmation"),
                    None,
                    None,
                    vec![],
                    e.id.clone(),
                ),
                SessionInputRequest::ToolClientExecution(e) => (
                    e.id.clone(),
                    e.chat.clone(),
                    "toolClientExecution",
                    label("Client tool execution"),
                    None,
                    None,
                    vec![],
                    e.id.clone(),
                ),
                SessionInputRequest::ToolAuthentication(e) => (
                    e.id.clone(),
                    e.chat.clone(),
                    "toolAuthentication",
                    label("Authentication required"),
                    None,
                    None,
                    vec![],
                    e.id.clone(),
                ),
                SessionInputRequest::Unknown(v) => {
                    let id = v
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_owned();
                    let chat = v
                        .get("chat")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    (
                        id.clone(),
                        chat,
                        "unknown",
                        "Unknown input request".into(),
                        None,
                        None,
                        vec![],
                        id,
                    )
                }
            };
            let mut reason = stale_reason(state, catalogued, &chat, catalogue_meta);
            if reason.is_none() && kind != "chatInput" {
                reason = Some(format!("{kind} must be answered in Culture"));
            }
            if reason.is_none() && questions.iter().any(|q: &Question| q.kind == "unknown") {
                reason = Some("request contains an unsupported question kind".into());
            }
            Choice {
                host: host.into(),
                session: session.into(),
                chat,
                entry: id,
                request_id,
                kind: kind.into(),
                revision: revision(entry),
                title,
                message,
                url,
                questions,
                actionable: reason.is_none(),
                stale_reason: reason,
            }
        })
        .collect()
}

pub fn now_rfc3339() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    // Civil-from-days (Howard Hinnant), avoiding a date dependency.
    let secs = now.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        now.subsec_millis()
    )
}

pub async fn node_choices(
    config: &Config,
    host: Host,
    endpoint: Option<Endpoint>,
    all: bool,
) -> NodeChoices {
    let (node, source) = node_and_source(&host.name);
    let empty = |state: &str, error: Option<String>, endpoint: Option<String>| NodeChoices {
        host: host.name.clone(),
        node: node.clone(),
        source: source.clone(),
        state: state.into(),
        error,
        endpoint,
        sessions: 0,
        input_needed_sessions: 0,
        latency_ms: None,
        agents: vec![],
    };
    let Some(endpoint) = endpoint else {
        return empty(
            if config.paratenic.enabled && host.paratenic.enabled != Some(false) {
                "unconfigured"
            } else {
                "disabled"
            },
            None,
            None,
        );
    };
    let timeout = Duration::from_secs(config.paratenic.request_timeout_seconds);
    let connect = Duration::from_secs(config.connect_timeout_seconds).min(timeout);
    let started = Instant::now();
    let work = async {
        let connection = Connection::open_with(&endpoint, connect, timeout).await?;
        let result = collect_node(&connection, &host.name, config.paratenic.parallelism, all).await;
        connection.close().await;
        result
    };
    match tokio::time::timeout(timeout * 4, work).await {
        Ok(Ok((sessions, waiting, agents))) => NodeChoices {
            host: host.name.clone(),
            node: node.clone(),
            source: source.clone(),
            state: "ok".into(),
            error: None,
            endpoint: Some(endpoint.url.clone()),
            sessions,
            input_needed_sessions: waiting,
            latency_ms: Some(started.elapsed().as_millis() as u64),
            agents,
        },
        Ok(Err(error)) => {
            let text = error.to_string();
            match offline_reason(&text) {
                Some(reason) => empty("offline", Some(reason.into()), Some(endpoint.url.clone())),
                // A pi-daemon bridge before 1.11 has no /ahp: nothing to list, not a failure.
                None if source == "pi-bridge" && not_found(&text) => empty(
                    "unsupported",
                    Some("this pi-daemon bridge has no /ahp (needs pi-daemon 1.11)".into()),
                    Some(endpoint.url.clone()),
                ),
                None => empty("error", Some(text), Some(endpoint.url.clone())),
            }
        }
        Err(_) => empty(
            "offline",
            Some("timed out".into()),
            Some(endpoint.url.clone()),
        ),
    }
}

async fn collect_node(
    connection: &Connection,
    host: &str,
    parallelism: usize,
    all: bool,
) -> Result<(usize, usize, Vec<AgentChoices>)> {
    let sessions = connection.sessions().await?;
    let total = sessions.len();
    let waiting: Vec<_> = sessions
        .into_iter()
        .filter(|s| SessionStatus::from_bits(s.status).contains(SessionStatus::InputNeeded))
        .collect();
    let count = waiting.len();
    let gate = Arc::new(Semaphore::new(parallelism));
    let mut jobs = JoinSet::new();
    for summary in waiting {
        let client = connection.client.clone();
        let gate = gate.clone();
        let host = host.to_owned();
        jobs.spawn(async move {
            let _permit = gate.acquire_owned().await.ok()?;
            let (result, _sub) = client.subscribe(summary.resource.clone()).await.ok()?;
            let _ = client.unsubscribe(summary.resource.clone()).await;
            let Some(SnapshotState::Session(state)) = result.snapshot.map(|s| s.state) else {
                return None;
            };
            let meta = summary.meta.as_ref().and_then(|m| m.get("paratenic"));
            let mut choices = choices_for(&host, &summary.resource, &state, true, meta);
            if !all {
                choices.retain(|c| c.actionable);
            }
            let daemon = host.ends_with(PI_DAEMON_SUFFIX)
                && !summary
                    .resource
                    .trim_start_matches("ahp-session:/")
                    .starts_with("tui-");
            (!choices.is_empty()).then(|| AgentChoices {
                session: summary.resource.clone(),
                title: bounded(&summary.title),
                provider: summary.provider.clone(),
                kind: if daemon { "daemon" } else { "tui" }.into(),
                project: summary.project.as_ref().map(|p| bounded(&p.display_name)),
                cwd: summary
                    .working_directories
                    .as_ref()
                    .and_then(|d| d.first())
                    .map(|d| d.trim_start_matches("file://").to_owned()),
                modified_at: summary.modified_at.clone(),
                choices,
            })
        });
    }
    let mut agents = vec![];
    while let Some(result) = jobs.join_next().await {
        if let Ok(Some(agent)) = result {
            agents.push(agent);
        }
    }
    agents.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then(a.title.cmp(&b.title))
    });
    Ok((total, count, agents))
}

pub async fn fleet_choices(
    config: &Config,
    targets: Vec<(Host, Option<Endpoint>)>,
    all: bool,
) -> FleetChoices {
    let mut jobs = JoinSet::new();
    for (host, endpoint) in targets {
        let config = config.clone();
        jobs.spawn(async move { node_choices(&config, host, endpoint, all).await });
    }
    let mut nodes = vec![];
    while let Some(result) = jobs.join_next().await {
        if let Ok(node) = result {
            nodes.push(node);
        }
    }
    // A node's Paratenic and pi-daemon sit together.
    nodes.sort_by(|a, b| a.node.cmp(&b.node).then(a.source.cmp(&b.source)));
    dedupe(&mut nodes);
    FleetChoices {
        observed_at: now_rfc3339(),
        actionable: nodes
            .iter()
            .flat_map(|n| &n.agents)
            .flat_map(|a| &a.choices)
            .filter(|c| c.actionable)
            .count(),
        nodes,
    }
}

/// `ms-dev-pi-daemon` → (`ms-dev`, `pi-daemon`); `ms-dev-pi-bridge` →
/// (`ms-dev`, `pi-bridge`); `ms-dev` → (`ms-dev`, `paratenic`).
fn node_and_source(host: &str) -> (String, String) {
    for (suffix, source) in [
        (PI_DAEMON_SUFFIX, "pi-daemon"),
        (PI_BRIDGE_SUFFIX, "pi-bridge"),
    ] {
        if let Some(node) = host.strip_suffix(suffix).filter(|node| !node.is_empty()) {
            return (node.to_owned(), source.to_owned());
        }
    }
    (host.to_owned(), "paratenic".to_owned())
}

/// A TUI Pi's question can be seen twice on one node: through Paratenic and
/// through pi-daemon (its bridge, or the daemon, serves TUI Pis as
/// `tui-<piSessionId>`). Both carry the same request id (agent-utils choice
/// ids are unique), so keep pi-daemon's copy and drop Paratenic's. Agents left
/// without choices go too.
fn dedupe(nodes: &mut [NodeChoices]) {
    let mut daemon: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for node in nodes.iter().filter(|n| n.source != "paratenic") {
        for choice in node.agents.iter().flat_map(|a| &a.choices) {
            daemon.insert((node.node.clone(), choice.request_id.clone()));
        }
    }
    if daemon.is_empty() {
        return;
    }
    for node in nodes.iter_mut().filter(|n| n.source == "paratenic") {
        for agent in &mut node.agents {
            agent.choices.retain(|c| {
                c.request_id.is_empty()
                    || !daemon.contains(&(node.node.clone(), c.request_id.clone()))
            });
        }
        node.agents.retain(|a| !a.choices.is_empty());
    }
}

// ---- answering ----------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct AnswerInput {
    pub host: String,
    pub session: String,
    pub request_id: String,
    /// accept (default) | decline | cancel
    pub response: Option<String>,
    /// Answers by question id. single-select: option id/label/1-based index;
    /// multi-select: array; boolean: bool or yes/no; number: number; text: string.
    pub answers: BTreeMap<String, Value>,
    /// Shorthand for a single-question select: option id, label or 1-based index.
    pub option: Option<String>,
    /// Shorthand freeform reply (text question or a freeform-capable select).
    pub text: Option<String>,
    /// Refuse if the authoritative request changed since it was listed.
    pub revision: Option<String>,
    /// Required for MCP/automation: answering mutates the remote agent.
    pub confirmed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AnswerState {
    /// The host echoed our exact action with no rejection.
    Accepted,
    /// The host echoed our action with a rejection reason.
    Rejected,
    /// No authoritative echo before the deadline; it may still apply. Not retried.
    Indeterminate,
    /// The request is no longer pending (answered elsewhere or withdrawn).
    Gone,
    /// The request was replaced since it was listed; re-read before answering.
    Changed,
    /// Not answerable now (stale catalogue, read-only chat, backend offline).
    Unavailable,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AnswerReceipt {
    pub host: String,
    pub session: String,
    pub request_id: String,
    pub state: AnswerState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_seq: Option<i64>,
}

fn resolve_option<'a>(question: &'a Question, value: &str) -> Option<&'a QuestionOption> {
    let value = value.trim();
    question
        .options
        .iter()
        .find(|o| o.id == value)
        .or_else(|| {
            value
                .parse::<usize>()
                .ok()
                .filter(|n| *n >= 1)
                .and_then(|n| question.options.get(n - 1))
        })
        .or_else(|| {
            let matches: Vec<_> = question
                .options
                .iter()
                .filter(|o| o.label.eq_ignore_ascii_case(value))
                .collect();
            (matches.len() == 1).then(|| matches[0])
        })
}

fn truthy(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(b) => Some(*b),
        Value::String(s) => match s.trim().to_lowercase().as_str() {
            "y" | "yes" | "true" | "1" | "on" | "approve" => Some(true),
            "n" | "no" | "false" | "0" | "off" | "deny" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// Validate and convert user answers exactly as Paratenic will, so mistakes
/// fail locally with a precise message instead of as a remote rejection.
pub fn build_answers(
    choice: &Choice,
    input: &AnswerInput,
) -> Result<HashMap<String, ChatInputAnswer>> {
    let mut supplied = input.answers.clone();
    if input.option.is_some() || input.text.is_some() {
        let [question] = choice.questions.as_slice() else {
            return Err(Error::Invalid(
                "option/text shorthand needs exactly one question; use answers by question id"
                    .into(),
            ));
        };
        if let Some(option) = &input.option {
            supplied.insert(question.id.clone(), Value::String(option.clone()));
        }
        if let Some(text) = &input.text {
            if question.kind.ends_with("select") {
                supplied.insert(
                    format!("{}#freeform", question.id),
                    Value::String(text.clone()),
                );
            } else {
                supplied.insert(question.id.clone(), Value::String(text.clone()));
            }
        }
    }
    let mut out = HashMap::new();
    for question in &choice.questions {
        let freeform = supplied
            .remove(&format!("{}#freeform", question.id))
            .and_then(|v| v.as_str().map(str::trim).map(str::to_owned))
            .filter(|s| !s.is_empty());
        let raw = supplied.remove(&question.id);
        let invalid = |why: &str| Error::Invalid(format!("question {}: {why}", question.id));
        let value = match (question.kind.as_str(), raw, freeform) {
            (_, None, None) => {
                if question.required {
                    return Err(invalid("an answer is required"));
                }
                continue;
            }
            ("single-select", raw, freeform) => {
                if freeform.is_some() && !question.allow_freeform {
                    return Err(invalid("this question does not accept a freeform reply"));
                }
                let selected = match raw {
                    Some(Value::String(s)) => Some(
                        resolve_option(question, &s)
                            .ok_or_else(|| invalid(&format!("no option matches {s:?}")))?
                            .id
                            .clone(),
                    ),
                    Some(Value::Number(n)) => Some(
                        resolve_option(question, &n.to_string())
                            .ok_or_else(|| invalid("option index out of range"))?
                            .id
                            .clone(),
                    ),
                    Some(_) => return Err(invalid("expected an option id, label or index")),
                    None => None,
                };
                let freeform_values = freeform.clone().map(|t| vec![bounded(&t)]);
                ChatInputAnswerValue::Selected(ChatInputSelectedAnswerValue {
                    value: selected.unwrap_or_else(|| freeform.unwrap_or_default()),
                    freeform_values,
                })
            }
            ("multi-select", raw, freeform) => {
                if freeform.is_some() && !question.allow_freeform {
                    return Err(invalid("this question does not accept a freeform reply"));
                }
                let items: Vec<String> = match raw {
                    Some(Value::Array(items)) => items
                        .iter()
                        .map(|v| match v {
                            Value::String(s) => Ok(s.clone()),
                            Value::Number(n) => Ok(n.to_string()),
                            _ => Err(invalid("expected option ids")),
                        })
                        .collect::<Result<_>>()?,
                    Some(Value::String(s)) => s
                        .split(',')
                        .map(|s| s.trim().to_owned())
                        .filter(|s| !s.is_empty())
                        .collect(),
                    Some(_) => return Err(invalid("expected an array of options")),
                    None => vec![],
                };
                let mut ids = vec![];
                for item in items {
                    let id = resolve_option(question, &item)
                        .ok_or_else(|| invalid(&format!("no option matches {item:?}")))?
                        .id
                        .clone();
                    if !ids.contains(&id) {
                        ids.push(id);
                    }
                }
                ChatInputAnswerValue::SelectedMany(ChatInputSelectedManyAnswerValue {
                    value: ids,
                    freeform_values: freeform.map(|t| vec![bounded(&t)]),
                })
            }
            ("boolean", Some(raw), _) => {
                ChatInputAnswerValue::Boolean(ChatInputBooleanAnswerValue {
                    value: truthy(&raw).ok_or_else(|| invalid("expected yes/no"))?,
                })
            }
            (kind @ ("number" | "integer"), Some(raw), _) => {
                let value = match &raw {
                    Value::Number(n) => n.as_f64(),
                    Value::String(s) => s.trim().parse::<f64>().ok(),
                    _ => None,
                }
                .filter(|v| v.is_finite())
                .ok_or_else(|| invalid("expected a number"))?;
                if kind == "integer" && value.fract() != 0.0 {
                    return Err(invalid("expected an integer"));
                }
                ChatInputAnswerValue::Number(ChatInputNumberAnswerValue { value })
            }
            ("text", Some(Value::String(text)), _) => {
                if text.trim().is_empty() {
                    return Err(invalid("text answer is empty"));
                }
                ChatInputAnswerValue::Text(ChatInputTextAnswerValue {
                    value: bounded(&text),
                })
            }
            ("text", Some(_), _) => return Err(invalid("expected text")),
            (_, _, _) => return Err(invalid("unsupported question kind or missing value")),
        };
        out.insert(
            question.id.clone(),
            ChatInputAnswer::Submitted(ChatInputAnswered { value }),
        );
    }
    if let Some(extra) = supplied.keys().next() {
        return Err(Error::Invalid(format!("unknown question id {extra:?}")));
    }
    Ok(out)
}

pub fn response_kind(input: &AnswerInput) -> Result<ChatInputResponseKind> {
    match input.response.as_deref().unwrap_or("accept") {
        "accept" => Ok(ChatInputResponseKind::Accept),
        "decline" => Ok(ChatInputResponseKind::Decline),
        "cancel" => Ok(ChatInputResponseKind::Cancel),
        other => Err(Error::Invalid(format!(
            "response must be accept, decline or cancel, not {other:?}"
        ))),
    }
}

pub async fn answer(
    config: &Config,
    endpoint: &Endpoint,
    input: AnswerInput,
) -> Result<AnswerReceipt> {
    let response = response_kind(&input)?;
    let receipt = |state, reason: Option<String>, seq: Option<(String, i64)>| AnswerReceipt {
        host: input.host.clone(),
        session: input.session.clone(),
        request_id: input.request_id.clone(),
        state,
        reason,
        client_id: seq.as_ref().map(|s| s.0.clone()),
        client_seq: seq.map(|s| s.1),
    };
    let timeout = Duration::from_secs(config.paratenic.request_timeout_seconds);
    let mut connection = Connection::open(endpoint, timeout).await?;
    let outcome = async {
        let state = connection.session(&input.session).await?;
        let entry = state.input_needed.iter().flatten().find(|e| {
            matches!(e, SessionInputRequest::ChatInput(c) if c.request.id == input.request_id)
        });
        let Some(entry) = entry else {
            return Ok(receipt(AnswerState::Gone, Some("request is no longer pending".into()), None));
        };
        if input.revision.as_ref().is_some_and(|r| *r != revision(entry)) {
            return Ok(receipt(AnswerState::Changed, Some("request changed since it was listed".into()), None));
        }
        let choice = choices_for(&input.host, &input.session, &state, true, None)
            .into_iter()
            .find(|c| c.request_id == input.request_id)
            .expect("entry exists");
        if let Some(reason) = choice.stale_reason.clone() {
            return Ok(receipt(AnswerState::Unavailable, Some(reason), None));
        }
        let answers = if response == ChatInputResponseKind::Accept {
            Some(build_answers(&choice, &input)?)
        } else {
            None
        };
        // Observe our own echo on the chat channel before dispatching it. The
        // snapshot is unused, so ask for the smallest one Paratenic accepts
        // (view.turns must be positive; 0 is rejected with -32602).
        let mut events = connection.client.events();
        let (_, _chat) = connection
            .client
            .subscribe_with_options(choice.chat.clone(), None, Some(SubscribeView { turns: Some(1) }))
            .await
            .map_err(rpc)?;
        let client_seq = connection.lease.next()?;
        connection
            .client
            .notify(
                "dispatchAction",
                ahp_types::commands::DispatchActionParams {
                    channel: choice.chat.clone(),
                    client_seq,
                    action: StateAction::ChatInputCompleted(ChatInputCompletedAction {
                        request_id: input.request_id.clone(),
                        response,
                        answers,
                    }),
                },
            )
            .await
            .map_err(rpc)?;
        let seq = Some((connection.client_id.clone(), client_seq));
        let deadline = tokio::time::sleep(Duration::from_secs(config.paratenic.answer_timeout_seconds));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => return Ok(receipt(AnswerState::Indeterminate, Some("no authoritative echo before the deadline; it may still apply — re-list before retrying".into()), seq)),
                event = events.recv() => match event {
                    None => return Ok(receipt(AnswerState::Indeterminate, Some("connection closed before the authoritative echo".into()), seq)),
                    Some(ClientEvent { event: SubscriptionEvent::Action(envelope), .. }) => {
                        let ours = envelope.origin.as_ref().is_some_and(|o| o.client_id == connection.client_id && o.client_seq == client_seq);
                        if ours {
                            return Ok(match envelope.rejection_reason {
                                Some(reason) => receipt(AnswerState::Rejected, Some(bounded(&reason)), seq),
                                None => receipt(AnswerState::Accepted, None, seq),
                            });
                        }
                    }
                    Some(_) => {}
                }
            }
        }
    }
    .await;
    connection.close().await;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn select(message: &str) -> Question {
        Question {
            id: "choice".into(),
            kind: "single-select".into(),
            title: None,
            message: message.into(),
            required: true,
            allow_freeform: true,
            options: vec![],
        }
    }

    #[test]
    fn pi_choice_message_splits_into_question_and_context() {
        // agent-utils async choices: request message = question \n\n context,
        // question prompt = question.
        let q = "Can I run a 3-minute docked X11 GPU test now?";
        let message = format!("{q}\n\nReleased .67 native tools are prepared on sgu24.");
        let (title, context) = headline(Some(&message), &[select(q)]);
        assert_eq!(title, q);
        assert_eq!(
            context.as_deref(),
            Some("Released .67 native tools are prepared on sgu24.")
        );
    }

    #[test]
    fn pi_client_urls_gain_the_ahp_path() {
        assert_eq!(
            ahp_url("ws://ms-dev.ts.net:7463"),
            "ws://ms-dev.ts.net:7463/ahp"
        );
        assert_eq!(
            ahp_url("ws://ms-dev.ts.net:7463/"),
            "ws://ms-dev.ts.net:7463/ahp"
        );
        assert_eq!(
            ahp_url("wss://proxy.example/agents/a/ahp"),
            "wss://proxy.example/agents/a/ahp"
        );
        assert_eq!(
            node_and_source("ms-dev-pi-daemon"),
            ("ms-dev".into(), "pi-daemon".into())
        );
        assert_eq!(
            node_and_source("ms-dev"),
            ("ms-dev".into(), "paratenic".into())
        );
        assert_eq!(
            node_and_source("ms-dev-pi-bridge"),
            ("ms-dev".into(), "pi-bridge".into())
        );
        assert!(not_found("HTTP error: 404 Not Found"));
        assert!(!not_found("HTTP error: 401 Unauthorized"));
    }

    #[test]
    fn identical_message_has_no_context_and_unrelated_message_is_kept() {
        let (title, context) = headline(Some("Ship it?"), &[select("Ship it?")]);
        assert_eq!((title.as_str(), context), ("Ship it?", None));
        // Not at a word boundary: keep the message whole.
        let (title, context) = headline(Some("Ship it?!"), &[select("Ship it?")]);
        assert_eq!((title.as_str(), context), ("Ship it?!", None));
        // Several questions: the message is the form's title.
        let (title, context) = headline(Some("Deploy form"), &[select("Where?"), select("When?")]);
        assert_eq!((title.as_str(), context), ("Deploy form", None));
        assert_eq!(headline(None, &[]).0, "Input requested");
    }
}
