use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::model::CacheState;

#[derive(Clone, Debug)]
pub struct CacheStore {
    path: PathBuf,
}

impl CacheStore {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    #[must_use]
    pub fn default_path() -> PathBuf {
        if let Some(path) = std::env::var_os("SLICK_CACHE_DIR") {
            return PathBuf::from(path).join("state.json");
        }
        dirs::cache_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("slick")
            .join("state.json")
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<CacheState> {
        if !self.path.exists() {
            return Ok(CacheState::default());
        }
        let bytes = fs::read(&self.path)
            .with_context(|| format!("read Slick cache {}", self.path.display()))?;
        let mut state: CacheState = serde_json::from_slice(&bytes)
            .with_context(|| format!("parse Slick cache {}", self.path.display()))?;
        state.normalize();
        Ok(state)
    }

    pub fn save(&self, state: &CacheState) -> Result<()> {
        self.save_inner(state, true)
    }

    /// Persist a received authoritative snapshot without replacing its source
    /// timestamp. Smart clients use this so cache and SSE carry the same
    /// revision identity.
    pub fn save_exact(&self, state: &CacheState) -> Result<()> {
        self.save_inner(state, false)
    }

    fn save_inner(&self, state: &CacheState, stamp_now: bool) -> Result<()> {
        let parent = self
            .path
            .parent()
            .context("Slick cache path has no parent directory")?;
        fs::create_dir_all(parent)
            .with_context(|| format!("create Slick cache directory {}", parent.display()))?;
        let mut snapshot = state.clone();
        snapshot.normalize();
        if stamp_now {
            snapshot.saved_at = Some(CacheState::now());
        }
        let bytes = serde_json::to_vec_pretty(&snapshot).context("serialize Slick cache")?;
        let temporary = self
            .path
            .with_extension(format!("json.{}.tmp", std::process::id()));

        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .with_context(|| format!("create temporary Slick cache {}", temporary.display()))?;
        file.write_all(&bytes)
            .with_context(|| format!("write temporary Slick cache {}", temporary.display()))?;
        file.sync_all().context("sync temporary Slick cache")?;
        fs::rename(&temporary, &self.path).with_context(|| {
            format!(
                "atomically replace Slick cache {} with {}",
                self.path.display(),
                temporary.display()
            )
        })?;
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        if self.path.exists() {
            fs::remove_file(&self.path)
                .with_context(|| format!("remove Slick cache {}", self.path.display()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Conversation;

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "slick-cache-test-{}-{name}-{}.json",
            std::process::id(),
            CacheState::now()
        ))
    }

    #[test]
    fn cache_round_trip_and_clear() {
        let path = test_path("round-trip");
        let store = CacheStore::new(path.clone());
        let mut state = CacheState {
            team_name: "Example".into(),
            ..CacheState::default()
        };
        state.conversations.push(Conversation {
            id: "C1".into(),
            name: "general".into(),
            ..Conversation::default()
        });
        store.save(&state).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.team_name, "Example");
        assert_eq!(loaded.conversations[0].name, "general");
        assert!(loaded.saved_at.is_some());
        store.clear().unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn exact_save_preserves_authoritative_snapshot_timestamp() {
        let path = test_path("exact");
        let store = CacheStore::new(path.clone());
        let state = CacheState {
            saved_at: Some(123_456),
            ..CacheState::default()
        };
        store.save_exact(&state).unwrap();
        assert_eq!(store.load().unwrap().saved_at, Some(123_456));
        store.clear().unwrap();
    }

    #[test]
    fn missing_cache_is_empty_state() {
        let path = test_path("missing");
        let _ = fs::remove_file(&path);
        let state = CacheStore::new(path).load().unwrap();
        assert!(state.conversations.is_empty());
    }
}
