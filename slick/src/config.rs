//! User configuration for Slick.
//!
//! Slick reads `~/.config/slick/config.yaml` (or `$SLICK_CONFIG`). Everything
//! is optional: an absent or partial file yields defaults, so the client always
//! starts. The file also owns the *local favourites overlay* — Slick is
//! read-only against Slack, so starring inside the TUI is persisted here and
//! unioned with Slack's own `stars.list` rather than written back to Slack.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// Named colour palette.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
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

/// Persisted user configuration.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
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
    /// Conversation ids favourited inside Slick; unioned with Slack stars.
    pub favorites: BTreeSet<String>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            theme: ThemeName::default(),
            graphics: true,
            start_page: "activity".to_string(),
            sidebar_width: 32,
            detail_percent: 64,
            favorites: BTreeSet::new(),
        }
    }
}

impl Config {
    /// Default config path: `$SLICK_CONFIG`, else `$XDG_CONFIG_HOME/slick/config.yaml`,
    /// else `~/.config/slick/config.yaml`.
    #[must_use]
    pub fn default_path() -> PathBuf {
        if let Ok(explicit) = std::env::var("SLICK_CONFIG") {
            return PathBuf::from(explicit);
        }
        let base = std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .ok()
            .or_else(|| dirs::home_dir().map(|home| home.join(".config")))
            .unwrap_or_else(|| PathBuf::from("."));
        base.join("slick").join("config.yaml")
    }

    /// Load configuration, returning defaults when the file is absent.
    ///
    /// A malformed file is an error rather than a silent reset so a typo does
    /// not quietly discard the operator's favourites.
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("read Slick config {}", path.display()))?;
        if raw.trim().is_empty() {
            return Ok(Self::default());
        }
        serde_yaml::from_str(&raw).with_context(|| format!("parse Slick config {}", path.display()))
    }

    /// Persist configuration, creating parent directories as needed.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create Slick config dir {}", parent.display()))?;
        }
        let body = serde_yaml::to_string(self).context("serialize Slick config")?;
        std::fs::write(path, body).with_context(|| format!("write Slick config {}", path.display()))
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
