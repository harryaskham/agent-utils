use std::path::{Path, PathBuf};

use configurable_cli::{AppConfig, ConfigError, ConfigManager, ConfigSpec};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct WorkIqConfig {
    /// `WorkIQ` executable. `npx` is the portable default.
    pub command: String,
    /// Arguments before `--account`; defaults to the pinned official MCP server.
    pub args: Vec<String>,
    /// Cached `WorkIQ` account identity.
    pub account: Option<String>,
    /// MCP initialization/request timeout.
    pub timeout_secs: u64,
}

impl Default for WorkIqConfig {
    fn default() -> Self {
        Self {
            command: "npx".into(),
            args: vec![
                "-y".into(),
                "@microsoft/workiq@1.0.0".into(),
                "mcp".into(),
                "--log-level".into(),
                "None".into(),
            ],
            account: None,
            timeout_secs: 90,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct CollectorConfig {
    pub mail_refresh_secs: u64,
    pub calendar_refresh_secs: u64,
    pub chats_refresh_secs: u64,
    pub teams_refresh_secs: u64,
    pub identity_refresh_secs: u64,
    pub mail_backfill_days: u32,
    pub calendar_past_days: u32,
    pub calendar_future_days: u32,
    pub max_chats_per_cycle: usize,
    pub include_teams_channels: bool,
}

impl Default for CollectorConfig {
    fn default() -> Self {
        Self {
            mail_refresh_secs: 30,
            calendar_refresh_secs: 60,
            chats_refresh_secs: 30,
            teams_refresh_secs: 120,
            identity_refresh_secs: 6 * 60 * 60,
            mail_backfill_days: 30,
            calendar_past_days: 14,
            calendar_future_days: 90,
            max_chats_per_cycle: 8,
            include_teams_channels: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct Config {
    pub graphics: bool,
    pub start_page: String,
    pub sidebar_width: u16,
    pub detail_percent: u16,
    pub workiq: WorkIqConfig,
    pub collector: CollectorConfig,
    pub client: remote_cli::ClientConfig,
    pub daemon: remote_cli::DaemonConfig,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            graphics: true,
            start_page: "email".into(),
            sidebar_width: 34,
            detail_percent: 62,
            workiq: WorkIqConfig::default(),
            collector: CollectorConfig::default(),
            client: remote_cli::ClientConfig::default().with_daemon_url("http://127.0.0.1:7621"),
            daemon: remote_cli::DaemonConfig {
                bind: "127.0.0.1:7621".into(),
                ..remote_cli::DaemonConfig::default()
            },
        }
    }
}

impl AppConfig for Config {
    fn validate(&self) -> Result<(), ConfigError> {
        if self.sidebar_width < 18 {
            return Err(ConfigError::validation("sidebar-width must be at least 18"));
        }
        if !(30..=85).contains(&self.detail_percent) {
            return Err(ConfigError::validation(
                "detail-percent must be between 30 and 85",
            ));
        }
        if self.workiq.command.trim().is_empty() {
            return Err(ConfigError::validation("workiq.command cannot be empty"));
        }
        if self.workiq.timeout_secs < 10 {
            return Err(ConfigError::validation(
                "workiq.timeout-secs must be at least 10",
            ));
        }
        if self.daemon.bind.is_empty() && self.daemon.unix_socket.is_none() {
            return Err(ConfigError::validation(
                "daemon requires bind or unix-socket",
            ));
        }
        Ok(())
    }
}

#[must_use]
pub fn manager() -> ConfigManager<Config> {
    ConfigManager::new(ConfigSpec::new("annum").with_env_var("ANNUM_CONFIG"))
}

impl Config {
    #[must_use]
    pub fn default_path() -> PathBuf {
        manager().default_path()
    }

    pub fn load(path: &Path) -> anyhow::Result<Self> {
        Ok(manager().load(Some(path))?.config)
    }

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        Ok(manager().save(path, self)?)
    }

    #[must_use]
    pub fn daemon_token_path(&self, config_path: &Path) -> PathBuf {
        self.daemon
            .token_path(config_path.parent().unwrap_or_else(|| Path::new(".")))
    }

    #[must_use]
    pub fn client_token_path(&self, config_path: &Path) -> PathBuf {
        self.client.token_path(&self.daemon_token_path(config_path))
    }

    #[must_use]
    pub fn fallback_lease_path(&self, config_path: &Path) -> PathBuf {
        self.client
            .fallback_lease_path(config_path.parent().unwrap_or_else(|| Path::new(".")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_daemon_and_client_defaults_match() {
        let config = Config::default();
        assert_eq!(config.client.daemon_url, "http://127.0.0.1:7621");
        assert_eq!(config.daemon.bind, "127.0.0.1:7621");
        assert!(config.client.cache && config.client.daemon && config.client.fallback);
    }

    #[test]
    fn partial_yaml_keeps_safe_defaults() {
        let config: Config = serde_yaml::from_str("graphics: false\n").unwrap();
        assert!(!config.graphics);
        assert_eq!(config.collector.mail_refresh_secs, 30);
        assert_eq!(config.workiq.command, "npx");
    }
}
