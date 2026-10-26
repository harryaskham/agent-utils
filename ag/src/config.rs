use crate::{Error, Result};
use configurable_cli::{AppConfig, ConfigError, ConfigManager, ConfigSpec};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Paths {
    /// Local path, or a path on the remote node (~/ expands on that node).
    pub tts_feed: Option<String>,
    pub image_dir: Option<String>,
    /// Runtime mute policy consumed by Agent Utils on the target node.
    pub tts_mute: Option<String>,
    /// Explicitly shared audio archive (audio_share / /audio-add).
    pub audio_dir: Option<String>,
}
impl Paths {
    pub fn over(&self, base: &Self) -> Self {
        Self {
            tts_feed: self.tts_feed.clone().or_else(|| base.tts_feed.clone()),
            image_dir: self.image_dir.clone().or_else(|| base.image_dir.clone()),
            tts_mute: self.tts_mute.clone().or_else(|| base.tts_mute.clone()),
            audio_dir: self.audio_dir.clone().or_else(|| base.audio_dir.clone()),
        }
    }
    pub fn tts(&self) -> Result<PathBuf> {
        expand_home(
            &self
                .tts_feed
                .clone()
                .or_else(|| std::env::var("PI_TTS_FEED_PATH").ok())
                .unwrap_or_else(|| {
                    state_root()
                        .join("tts/speech.jsonl")
                        .to_string_lossy()
                        .into()
                }),
        )
    }
    pub fn mute(&self) -> Result<PathBuf> {
        let path = self
            .tts_mute
            .clone()
            .or_else(|| {
                std::env::var("PI_TTS_MUTE_PATH")
                    .ok()
                    .filter(|value| !value.is_empty())
            })
            .unwrap_or_else(|| state_root().join("tts/mute.json").to_string_lossy().into());
        if !safe(&path, 4096) {
            return Err(Error::Invalid("invalid speech mute state path".into()));
        }
        expand_home(&path)
    }
    pub fn images(&self) -> Result<PathBuf> {
        expand_home(
            &self
                .image_dir
                .clone()
                .or_else(|| std::env::var("PI_SHARED_IMAGES_DIR").ok())
                .unwrap_or_else(|| state_root().join("images").to_string_lossy().into()),
        )
    }
    pub fn audio(&self) -> Result<PathBuf> {
        expand_home(
            &self
                .audio_dir
                .clone()
                .or_else(|| {
                    std::env::var("PI_SHARED_AUDIO_DIR")
                        .ok()
                        .filter(|v| !v.is_empty())
                })
                .unwrap_or_else(|| state_root().join("audio").to_string_lossy().into()),
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Host {
    pub name: String,
    pub address: String,
    pub username: Option<String>,
    pub port: u16,
    pub local: bool,
    pub enabled: bool,
    /// Installed executable name or absolute path, not a shell snippet.
    pub command: String,
    pub paths: Paths,
    /// Optional Paratenic AHP endpoint for live choices and health.
    pub paratenic: HostParatenic,
    /// This node's pi-daemon and pi-daemon bridge (independent of Paratenic).
    pub pi_daemon: HostPiDaemon,
}

/// Per-node pi-daemon switches; unset follows the fleet's `pi_daemon` section.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct HostPiDaemon {
    /// Set false to skip this node's pi-daemon (Durable sessions).
    pub enabled: Option<bool>,
    /// Set false to skip this node's pi-daemon bridge (TUI Pis).
    pub bridge: Option<bool>,
}

/// Per-node Paratenic endpoint. Omitted fields fall back to the Culture host
/// with the same id (`culture_host`, then the node name), so existing Culture
/// configuration works without duplication.
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct HostParatenic {
    /// Set false to skip AHP queries for this node.
    pub enabled: Option<bool>,
    /// AHP WebSocket URL, for example ws://node:7788/ahp.
    pub url: Option<String>,
    /// Owner-only bearer token file (managed symlinks are supported).
    pub token_file: Option<String>,
    /// Explicit opt-in for ws:// away from loopback (for example over a tailnet).
    pub allow_plaintext_non_loopback: Option<bool>,
    /// Culture host id when it differs from this node name.
    pub culture_host: Option<String>,
    /// Legacy switch: false skips this node's pi-daemon and its bridge (prefer
    /// `pi_daemon.enabled` / `pi_daemon.bridge` on the host).
    pub pi_daemon: Option<bool>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct ParatenicConfig {
    /// Query Paratenic hosts for elicitations and health.
    pub enabled: bool,
    /// Culture configuration used for zero-config endpoints; missing is fine.
    pub culture_config: Option<String>,
    /// Default bearer token file when neither the node nor Culture names one.
    pub token_file: Option<String>,
    pub request_timeout_seconds: u64,
    /// Deadline for the authoritative accept/reject of a submitted answer.
    pub answer_timeout_seconds: u64,
    /// Concurrent session snapshots per node while listing choices.
    pub parallelism: usize,
    /// Legacy switch: false skips every pi-daemon and bridge (prefer
    /// `pi_daemon.enabled` / `pi_daemon.bridge`). pi-daemon no longer
    /// depends on Paratenic being enabled.
    pub pi_daemon: bool,
    /// Legacy alias of `pi_daemon.settings`.
    pub pi_settings: Option<String>,
}

/// Each node's pi-daemon (`/ahp` on :7463, Durable sessions) and its bridge
/// (`/ahp` on :7464, the node's TUI Pis): choices and health, independently of
/// Paratenic. Endpoints come from pi-client's `client.hosts` (Pi settings,
/// bearer `hosts[].tokenFile`, else `client.tokenFile`), else Culture's
/// `<node>-pi-daemon` and `<node>-pi` hosts. Request timeouts and parallelism
/// are shared with Paratenic (`paratenic.request_timeout_seconds`, ...).
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct PiDaemonConfig {
    pub enabled: bool,
    pub bridge: bool,
    /// Pi settings file holding `client.hosts` and `client.tokenFile`
    /// (default `$PI_CODING_AGENT_DIR/settings.json`, else
    /// `~/.pi/agent/settings.json`).
    pub settings: Option<String>,
}
impl Default for PiDaemonConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            bridge: true,
            settings: None,
        }
    }
}
impl Default for ParatenicConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            culture_config: None,
            token_file: None,
            request_timeout_seconds: 15,
            answer_timeout_seconds: 30,
            parallelism: 8,
            pi_daemon: true,
            pi_settings: None,
        }
    }
}

/// Who may use `ag dash`.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, clap::ValueEnum,
)]
#[serde(rename_all = "snake_case")]
pub enum DashAccess {
    /// No token on loopback and Tailscale addresses (100.64.0.0/10,
    /// fd7a:115c:a1e0::/48): the network is the boundary. A token elsewhere
    /// (wildcard and LAN binds).
    #[default]
    Auto,
    /// No token: anyone who can reach the listener may read and answer.
    Open,
    /// A token, exchanged once for an HttpOnly cookie.
    Token,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct DashConfig {
    /// Listener address. A tailnet or loopback address needs no token (see
    /// `access`); a wildcard bind does unless `access: open`.
    pub bind: String,
    /// Token policy: auto (default), open or token.
    pub access: DashAccess,
    /// Public HTTP(S) origin; also permits this hostname in the Host header.
    pub public_origin: Option<String>,
    /// Optional persistent access-token file (token access only). Created
    /// privately when missing.
    pub token_file: Option<String>,
    /// Background refresh for choices and node health.
    pub refresh_seconds: u64,
    /// Background incremental media sync (images and audio share one cadence).
    pub image_refresh_seconds: u64,
    /// Sync shared audio and serve the Audio tab.
    pub audio: bool,
    /// One process-owned speech collector, shared by all dashboard browsers.
    pub tts: bool,
    /// Recent lines per host on collector startup (not per browser).
    pub tts_lines: usize,
}
impl Default for DashConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:7795".into(),
            access: DashAccess::Auto,
            public_origin: None,
            token_file: None,
            refresh_seconds: 300,
            image_refresh_seconds: 300,
            audio: true,
            tts: true,
            tts_lines: 20,
        }
    }
}
impl Default for Host {
    fn default() -> Self {
        Self {
            name: "local".into(),
            address: String::new(),
            username: None,
            port: 22,
            local: false,
            enabled: true,
            command: "ag".into(),
            paths: Paths::default(),
            paratenic: HostParatenic::default(),
            pi_daemon: HostPiDaemon::default(),
        }
    }
}
impl Host {
    pub fn local() -> Self {
        Self {
            local: true,
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct GalleryConfig {
    pub cache_dir: Option<String>,
    /// Shared-audio cache (default ~/.cache/ag/audio).
    pub audio_cache_dir: Option<String>,
    pub rsync_command: String,
    pub sync_timeout_seconds: u64,
    pub parallelism: usize,
}
impl Default for GalleryConfig {
    fn default() -> Self {
        Self {
            cache_dir: None,
            audio_cache_dir: None,
            rsync_command: "rsync".into(),
            sync_timeout_seconds: 300,
            parallelism: 4,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub paths: Paths,
    pub gallery: GalleryConfig,
    pub paratenic: ParatenicConfig,
    pub pi_daemon: PiDaemonConfig,
    pub dash: DashConfig,
    pub hosts: Vec<Host>,
    /// SSH executable (primarily useful for an isolated transport fixture).
    pub ssh_command: String,
    pub connect_timeout_seconds: u64,
    pub command_timeout_seconds: u64,
    pub reconnect_seconds: u64,
    pub poll_ms: u64,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            paths: Paths::default(),
            hosts: vec![Host::local()],
            gallery: GalleryConfig::default(),
            paratenic: ParatenicConfig::default(),
            pi_daemon: PiDaemonConfig::default(),
            dash: DashConfig::default(),
            ssh_command: "ssh".into(),
            connect_timeout_seconds: 10,
            command_timeout_seconds: 20,
            reconnect_seconds: 3,
            poll_ms: 500,
        }
    }
}
fn safe(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
impl AppConfig for Config {
    fn validate(&self) -> std::result::Result<(), ConfigError> {
        let invalid = |s: &str| ConfigError::validation(s);
        if self.version != 1 {
            return Err(invalid("version must be 1"));
        }
        if self.hosts.is_empty() || self.hosts.len() > 128 {
            return Err(invalid("configure 1–128 hosts"));
        }
        if !safe(&self.ssh_command, 4096) {
            return Err(invalid("ssh_command must be an executable name/path"));
        }
        if !(1..=60).contains(&self.connect_timeout_seconds)
            || !(1..=300).contains(&self.command_timeout_seconds)
            || !(1..=300).contains(&self.reconnect_seconds)
            || !(100..=60_000).contains(&self.poll_ms)
        {
            return Err(invalid(
                "timeouts: connect 1–60s, command/reconnect 1–300s, poll 100–60000ms",
            ));
        }
        if !safe(&self.gallery.rsync_command, 4096)
            || [&self.gallery.cache_dir, &self.gallery.audio_cache_dir]
                .into_iter()
                .flatten()
                .any(|p| !safe(p, 4096))
            || !(1..=3600).contains(&self.gallery.sync_timeout_seconds)
            || !(1..=16).contains(&self.gallery.parallelism)
        {
            return Err(invalid(
                "gallery: executable/path required; timeout 1–3600s, parallelism 1–16",
            ));
        }
        let mut names = HashSet::new();
        if !(1..=120).contains(&self.paratenic.request_timeout_seconds)
            || !(1..=300).contains(&self.paratenic.answer_timeout_seconds)
            || !(1..=64).contains(&self.paratenic.parallelism)
            || [
                &self.paratenic.culture_config,
                &self.paratenic.token_file,
                &self.paratenic.pi_settings,
                &self.pi_daemon.settings,
            ]
            .into_iter()
            .flatten()
            .any(|p| !safe(p, 4096))
        {
            return Err(invalid(
                "paratenic: request 1–120s, answer 1–300s, parallelism 1–64, paths without control characters",
            ));
        }
        if !safe(&self.dash.bind, 256)
            || self.dash.bind.parse::<std::net::SocketAddr>().is_err()
            || !(30..=86_400).contains(&self.dash.refresh_seconds)
            || !(60..=86_400).contains(&self.dash.image_refresh_seconds)
            || self.dash.tts_lines > crate::model::MAX_ITEMS
        {
            return Err(invalid(
                "dash: bind must be ip:port; refresh 30–86400s, image refresh 60–86400s, tts_lines 0–1000",
            ));
        }
        if let Some(origin) = &self.dash.public_origin {
            crate::dash::validate_public_origin(origin).map_err(|e| invalid(&e.to_string()))?;
        }
        if self
            .dash
            .token_file
            .as_ref()
            .is_some_and(|p| !safe(p, 4096))
        {
            return Err(invalid(
                "dash.token_file must be a nonempty path without controls",
            ));
        }
        for host in &self.hosts {
            let p = &host.paratenic;
            if [&p.url, &p.token_file, &p.culture_host]
                .into_iter()
                .flatten()
                .any(|v| !safe(v, 4096))
            {
                return Err(invalid(
                    "paratenic url/token_file/culture_host must be nonempty",
                ));
            }
            if let Some(url) = &p.url {
                crate::paratenic::validate_url(url, p.allow_plaintext_non_loopback == Some(true))
                    .map_err(|e| invalid(&format!("host {}: {e}", host.name)))?;
            }
        }
        for host in &self.hosts {
            if !safe(&host.name, 128) || !names.insert(&host.name) {
                return Err(invalid(
                    "host names must be nonempty and unique (≤128 characters)",
                ));
            }
            if !host.local
                && (!safe(&host.address, 253)
                    || host.address.starts_with('-')
                    || host
                        .address
                        .chars()
                        .any(|c| c.is_whitespace() || matches!(c, '/' | '@')))
            {
                return Err(invalid(
                    "remote address must be a hostname/IP, not a shell/SSH argument",
                ));
            }
            if host.port == 0 {
                return Err(invalid("host port must be 1–65535"));
            }
            if host.username.as_ref().is_some_and(|u| {
                !safe(u, 128)
                    || u.starts_with('-')
                    || !u
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
            }) {
                return Err(invalid("invalid SSH username"));
            }
            if !safe(&host.command, 4096) || host.command.starts_with('-') {
                return Err(invalid("host command must be an executable name/path"));
            }
            for path in [
                &host.paths.tts_feed,
                &host.paths.image_dir,
                &host.paths.tts_mute,
                &host.paths.audio_dir,
                &self.paths.tts_feed,
                &self.paths.image_dir,
                &self.paths.tts_mute,
                &self.paths.audio_dir,
            ]
            .into_iter()
            .flatten()
            {
                if !safe(path, 4096) {
                    return Err(invalid(
                        "storage paths must be nonempty without control characters",
                    ));
                }
            }
        }
        Ok(())
    }
}
pub fn manager() -> ConfigManager<Config> {
    ConfigManager::new(ConfigSpec::new("ag"))
}
pub fn load(path: Option<&Path>) -> Result<Config> {
    let manager = manager();
    let resolved = manager.resolve_path(path);
    if let Ok(meta) = std::fs::symlink_metadata(&resolved) {
        if meta.is_symlink() {
            std::fs::canonicalize(&resolved)?;
        }
        if std::fs::metadata(&resolved)?.len() > 1024 * 1024 {
            return Err(Error::Limit("config exceeds 1 MiB".into()));
        }
    }
    let config = manager
        .load(path)
        .map_err(|e| Error::Config(e.to_string()))?
        .config;
    config
        .validate()
        .map_err(|e| Error::Config(e.to_string()))?;
    Ok(config)
}
pub fn state_root() -> PathBuf {
    if let Ok(root) = std::env::var("PI_AGENT_UTILS_STATE_DIR") {
        if !root.is_empty() {
            return expand_home(&root).unwrap_or_else(|_| root.into());
        }
    }
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state")
        });
    base.join("agent-utils")
}
pub fn expand_home(path: &str) -> Result<PathBuf> {
    if path == "~" || path.starts_with("~/") {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| Error::Config("HOME is required for ~/ paths".into()))?;
        Ok(PathBuf::from(home).join(path.strip_prefix("~/").unwrap_or("")))
    } else {
        Ok(path.into())
    }
}
