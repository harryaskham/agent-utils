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
}
impl Paths {
    pub fn over(&self, base: &Self) -> Self {
        Self {
            tts_feed: self.tts_feed.clone().or_else(|| base.tts_feed.clone()),
            image_dir: self.image_dir.clone().or_else(|| base.image_dir.clone()),
            tts_mute: self.tts_mute.clone().or_else(|| base.tts_mute.clone()),
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
pub struct Config {
    pub version: u32,
    pub paths: Paths,
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
        let mut names = HashSet::new();
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
                &self.paths.tts_feed,
                &self.paths.image_dir,
                &self.paths.tts_mute,
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
