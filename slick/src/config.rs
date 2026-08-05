//! User configuration for Slick.
//!
//! Slick reads `~/.config/slick/config.yaml` (or `$SLICK_CONFIG`). Everything
//! is optional: an absent or partial file yields defaults, so the client always
//! starts. The file also owns the *local favourites overlay* — Slick is
//! read-only against Slack, so starring inside the TUI is persisted here and
//! unioned with Slack's own `stars.list` rather than written back to Slack.

use anyhow::Result;
use configurable_cli::{AppConfig, ConfigManager, ConfigSpec};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// How Slick announces a new mention or unread DM.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum AlertMode {
    /// Never announce.
    #[default]
    Off,
    /// Terminal bell only.
    Bell,
    /// Desktop notification (OSC 777) plus the bell as a fallback.
    Notify,
}

impl AlertMode {
    /// Parse an alert mode, falling back to the default for unknown values.
    #[must_use]
    pub fn parse(value: &str) -> Self {
        match value.trim().to_lowercase().as_str() {
            "bell" | "true" => Self::Bell,
            "notify" | "desktop" => Self::Notify,
            _ => Self::Off,
        }
    }
}

/// Named colour palette.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum ThemeName {
    /// Slick's original aubergine palette.
    #[default]
    Slick,
    /// Nord (<https://www.nordtheme.com>).
    Nord,
    /// Low-saturation grey/blue palette.
    Slate,
}

impl ThemeName {
    /// Parse a theme name, falling back to the default for unknown values.
    #[must_use]
    pub fn parse(value: &str) -> Self {
        match value.trim().to_lowercase().as_str() {
            "nord" => Self::Nord,
            "slate" => Self::Slate,
            _ => Self::Slick,
        }
    }

    /// Stable identifier used in config files and the UI.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Slick => "slick",
            Self::Nord => "nord",
            Self::Slate => "slate",
        }
    }

    /// Themes in cycle order for runtime switching.
    pub const ALL: [Self; 3] = [Self::Slick, Self::Nord, Self::Slate];

    /// Next theme in cycle order.
    #[must_use]
    pub fn next(self) -> Self {
        let index = Self::ALL.iter().position(|item| *item == self).unwrap_or(0);
        Self::ALL[(index + 1) % Self::ALL.len()]
    }
}

/// Canonical smart-client and daemon transport policy from `remote-cli`.
pub use remote_cli::{ClientConfig, DaemonConfig};

/// Persisted user configuration.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
#[serde(default, rename_all = "kebab-case")]
pub struct Config {
    /// Colour palette name.
    pub theme: ThemeName,
    /// Whether Kitty graphics chrome is used when the terminal supports it.
    pub graphics: bool,
    /// Page shown at startup (`activity`, `favorites`, `dms`, `channels`, `files`, `feed`).
    pub start_page: String,
    /// Sidebar width in cells.
    pub sidebar_width: u16,
    /// Percentage of the content area given to the Markdown detail pane.
    pub detail_percent: u16,
    /// Seconds between automatic background refreshes; `0` disables them and
    /// leaves Slick manual-refresh-only (Ctrl-R).
    ///
    /// This applies only while the smart client's embedded fallback collector
    /// is active; `slick daemon` owns its independent gap scheduler.
    pub refresh_interval_secs: u64,
    /// Smart-client source/fallback settings.
    pub client: ClientConfig,
    /// Central collector/service settings.
    pub daemon: DaemonConfig,
    /// Conversation ids favourited inside Slick; unioned with Slack stars.
    pub favorites: BTreeSet<String>,
    /// Local read markers: conversation id -> newest message timestamp the
    /// operator has seen inside Slick.
    ///
    /// Slick is read-only against Slack, so it never sends `conversations.mark`.
    /// Without this overlay a conversation read in Slick stays badged forever,
    /// because `unread_count` only ever clears when Slack itself is told.
    pub read_markers: BTreeMap<String, String>,
    /// How to announce a newly arrived mention or unread DM.
    pub alerts: AlertMode,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            theme: ThemeName::default(),
            graphics: true,
            start_page: "activity".to_string(),
            sidebar_width: 32,
            detail_percent: 64,
            refresh_interval_secs: 60,
            client: ClientConfig::default(),
            daemon: DaemonConfig::default(),
            favorites: BTreeSet::new(),
            read_markers: BTreeMap::new(),
            alerts: AlertMode::default(),
        }
    }
}

impl AppConfig for Config {}

#[must_use]
pub fn manager() -> ConfigManager<Config> {
    ConfigManager::new(ConfigSpec::new("slick").with_env_var("SLICK_CONFIG"))
}

impl Config {
    /// Default config path: `$SLICK_CONFIG`, else `$XDG_CONFIG_HOME/slick/config.yaml`,
    /// else `~/.config/slick/config.yaml`.
    #[must_use]
    pub fn default_path() -> PathBuf {
        manager().default_path()
    }

    /// Load and validate configuration, returning defaults when absent/empty.
    pub fn load(path: &Path) -> Result<Self> {
        Ok(manager().load(Some(path))?.config)
    }

    /// Validate and atomically persist owner-only configuration.
    pub fn save(&self, path: &Path) -> Result<()> {
        Ok(manager().save(path, self)?)
    }

    /// Bearer-token path for the daemon/client protocol.
    #[must_use]
    pub fn daemon_token_path(&self, config_path: &Path) -> PathBuf {
        self.daemon.token_file.clone().unwrap_or_else(|| {
            config_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("daemon-token")
        })
    }

    /// Client token path; local deployments share the daemon token by default.
    #[must_use]
    pub fn client_token_path(&self, config_path: &Path) -> PathBuf {
        self.client
            .token_file
            .clone()
            .unwrap_or_else(|| self.daemon_token_path(config_path))
    }

    /// Per-host lease that prevents several local clients entering fallback.
    #[must_use]
    pub fn fallback_lease_path(&self, config_path: &Path) -> PathBuf {
        self.client.fallback_lease_file.clone().unwrap_or_else(|| {
            config_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("fallback-collector.lock")
        })
    }

    /// Toggle a local favourite, returning the new state.
    pub fn toggle_favorite(&mut self, conversation_id: &str) -> bool {
        if self.favorites.remove(conversation_id) {
            false
        } else {
            self.favorites.insert(conversation_id.to_string());
            true
        }
    }

    /// Whether this conversation is locally favourited.
    #[must_use]
    pub fn is_local_favorite(&self, conversation_id: &str) -> bool {
        self.favorites.contains(conversation_id)
    }

    /// Record that everything up to `ts` has been read in `conversation_id`.
    ///
    /// Returns whether the marker moved, so callers only persist on a real
    /// change. Never moves a marker backwards: re-opening an older view must
    /// not resurrect already-read conversations.
    pub fn mark_read(&mut self, conversation_id: &str, ts: &str) -> bool {
        if ts.is_empty() {
            return false;
        }
        let current = self.read_markers.get(conversation_id);
        if current.is_some_and(|current| !timestamp_is_newer(ts, current)) {
            return false;
        }
        self.read_markers
            .insert(conversation_id.to_string(), ts.to_string());
        true
    }

    /// Whether the local marker already covers `ts` for this conversation.
    #[must_use]
    pub fn has_read_through(&self, conversation_id: &str, ts: &str) -> bool {
        self.read_markers
            .get(conversation_id)
            .is_some_and(|marker| !timestamp_is_newer(ts, marker))
    }
}

/// Whether Slack timestamp `candidate` is strictly newer than `baseline`.
///
/// Slack timestamps are decimal seconds ("1717171717.123456"). Compare
/// numerically: lexical comparison breaks the moment the integer part changes
/// width, and silently mis-ordering read state would hide real messages.
fn timestamp_is_newer(candidate: &str, baseline: &str) -> bool {
    match (candidate.parse::<f64>(), baseline.parse::<f64>()) {
        (Ok(candidate), Ok(baseline)) => candidate > baseline,
        _ => candidate > baseline,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alerts_are_off_by_default() {
        // Alerts ship silent by default.
        assert_eq!(AlertMode::default(), AlertMode::Off);
        assert_eq!(AlertMode::parse("off"), AlertMode::Off);
        assert_eq!(AlertMode::parse("bell"), AlertMode::Bell);
        assert_eq!(AlertMode::parse("notify"), AlertMode::Notify);
        // Unknown values fall back to the safe default, not to ringing.
        assert_eq!(AlertMode::parse("wat"), AlertMode::Off);
    }

    #[test]
    fn read_markers_never_move_backwards() {
        let mut config = Config::default();
        assert!(config.mark_read("C1", "1717171717.000200"));
        // Re-opening an older view must not resurrect already-read messages.
        assert!(!config.mark_read("C1", "1717171717.000100"));
        assert_eq!(
            config.read_markers.get("C1").map(String::as_str),
            Some("1717171717.000200")
        );
        // Numeric, not lexical: a wider integer part is newer.
        assert!(config.mark_read("C1", "9999999999.000000"));
        assert!(config.has_read_through("C1", "9999999999.000000"));
        assert!(config.has_read_through("C1", "1717171717.000200"));
        assert!(!config.has_read_through("C1", "99999999999.000000"));
        // An empty ts is not a marker.
        assert!(!config.mark_read("C2", ""));
        assert!(!config.has_read_through("C2", "1717171717.000100"));
    }

    #[test]
    fn absent_and_empty_files_yield_defaults() {
        let dir = std::env::temp_dir().join(format!("slick-config-{}", std::process::id()));
        let missing = dir.join("missing.yaml");
        assert_eq!(Config::load(&missing).unwrap(), Config::default());

        std::fs::create_dir_all(&dir).unwrap();
        let empty = dir.join("empty.yaml");
        std::fs::write(&empty, "\n").unwrap();
        assert_eq!(Config::load(&empty).unwrap(), Config::default());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn smart_client_and_daemon_sections_have_compatible_local_defaults() {
        let config = Config::default();
        assert!(config.client.cache);
        assert!(config.client.daemon);
        assert!(config.client.fallback);
        assert_eq!(config.client.daemon_url, "http://127.0.0.1:7612");
        assert_eq!(config.daemon.bind, "127.0.0.1:7612");
        assert_eq!(config.client.fallback_timeout_secs, 90);
    }

    #[test]
    fn nested_client_and_daemon_config_parses() {
        let config: Config = serde_yaml::from_str(
            "client:\n  cache: false\n  daemon: true\n  fallback-timeout-secs: 12\ndaemon:\n  bind: 127.0.0.1:9001\n  min-refresh-secs: 4\n",
        )
        .unwrap();
        assert!(!config.client.cache);
        assert!(config.client.daemon);
        assert_eq!(config.client.fallback_timeout_secs, 12);
        assert_eq!(config.daemon.bind, "127.0.0.1:9001");
        assert_eq!(config.daemon.min_refresh_secs, 4);
    }

    #[test]
    fn partial_config_keeps_defaults_for_absent_keys() {
        let dir = std::env::temp_dir().join(format!("slick-config-partial-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.yaml");
        std::fs::write(&path, "theme: nord\nfavorites:\n  - C123\n").unwrap();
        let config = Config::load(&path).unwrap();
        assert_eq!(config.theme, ThemeName::Nord);
        assert!(config.is_local_favorite("C123"));
        assert_eq!(config.sidebar_width, Config::default().sidebar_width);
        assert!(config.graphics);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn favourites_round_trip_through_save_and_load() {
        let dir = std::env::temp_dir().join(format!("slick-config-rt-{}", std::process::id()));
        let path = dir.join("config.yaml");
        let mut config = Config::default();
        assert!(config.toggle_favorite("C999"));
        config.save(&path).unwrap();
        let loaded = Config::load(&path).unwrap();
        assert!(loaded.is_local_favorite("C999"));

        let mut loaded = loaded;
        assert!(!loaded.toggle_favorite("C999"));
        assert!(!loaded.is_local_favorite("C999"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn theme_names_parse_and_cycle() {
        assert_eq!(ThemeName::parse("Nord"), ThemeName::Nord);
        assert_eq!(ThemeName::parse("unknown"), ThemeName::Slick);
        assert_eq!(ThemeName::Slick.next(), ThemeName::Nord);
        assert_eq!(ThemeName::Nord.next(), ThemeName::Slate);
        assert_eq!(ThemeName::Slate.next(), ThemeName::Slick);
    }
}
