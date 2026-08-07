use std::path::{Path, PathBuf};

use configurable_cli::{AppConfig, ConfigError, ConfigManager, ConfigSpec};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct HistoryConfig {
    /// Optional JSONL location; defaults beside the atomic state cache.
    pub file: Option<PathBuf>,
    /// UTC history retained during compaction.
    pub retention_days: u32,
    /// Hard per-account sample cap after retention filtering.
    pub max_samples_per_account: usize,
    /// Points embedded per account in cache/SSE snapshots for graph clients.
    pub chart_points: usize,
    /// Successful collection cycles between atomic compactions.
    pub compact_every_cycles: u64,
}

impl Default for HistoryConfig {
    fn default() -> Self {
        Self {
            file: None,
            retention_days: 400,
            max_samples_per_account: 120_000,
            chart_points: 576,
            compact_every_cycles: 288,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct Config {
    pub graphics: bool,
    /// Empty means daemon-side discovery through `gh auth status`.
    pub accounts: Vec<String>,
    pub refresh_secs: u64,
    pub history: HistoryConfig,
    pub client: remote_cli::ClientConfig,
    pub daemon: remote_cli::DaemonConfig,
}

impl Default for Config {
    fn default() -> Self {
        let mut client =
            remote_cli::ClientConfig::default().with_daemon_url("http://127.0.0.1:7622");
        // Direct gh collection is deliberately opt-in through --standalone or
        // explicit sync/once commands.
        client.fallback = false;
        Self {
            graphics: true,
            accounts: Vec::new(),
            refresh_secs: 300,
            history: HistoryConfig::default(),
            client,
            daemon: remote_cli::DaemonConfig {
                bind: "127.0.0.1:7622".into(),
                min_refresh_secs: 2,
                ..remote_cli::DaemonConfig::default()
            },
        }
    }
}

impl AppConfig for Config {
    fn validate(&self) -> Result<(), ConfigError> {
        if self.refresh_secs < 10 {
            return Err(ConfigError::validation("refresh-secs must be at least 10"));
        }
        if self.history.retention_days < 28 {
            return Err(ConfigError::validation(
                "history.retention-days must be at least 28",
            ));
        }
        if self.history.max_samples_per_account < 100 {
            return Err(ConfigError::validation(
                "history.max-samples-per-account must be at least 100",
            ));
        }
        if self.history.chart_points < 12 {
            return Err(ConfigError::validation(
                "history.chart-points must be at least 12",
            ));
        }
        if self.history.compact_every_cycles == 0 {
            return Err(ConfigError::validation(
                "history.compact-every-cycles must be positive",
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
    ConfigManager::new(ConfigSpec::new("cost-tui").with_env_var("COST_TUI_CONFIG"))
}

impl Config {
    #[must_use]
    pub fn default_path() -> PathBuf {
        manager().default_path()
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

    #[must_use]
    pub fn history_path(&self, cache_path: &Path) -> PathBuf {
        self.history.file.clone().unwrap_or_else(|| {
            cache_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("history.jsonl")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_daemon_authoritative() {
        let config = Config::default();
        assert_eq!(config.client.daemon_url, "http://127.0.0.1:7622");
        assert_eq!(config.daemon.bind, "127.0.0.1:7622");
        assert!(config.client.cache && config.client.daemon);
        assert!(!config.client.fallback);
        assert!(config.history.retention_days >= 28);
    }

    #[test]
    fn partial_yaml_retains_history_policy() {
        let config: Config = serde_yaml::from_str("graphics: false\n").unwrap();
        assert!(!config.graphics);
        assert_eq!(config.refresh_secs, 300);
        assert_eq!(config.history.chart_points, 576);
    }
}
