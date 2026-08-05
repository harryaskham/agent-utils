//! Slick cache specialization of the canonical `remote-cli` atomic store.

use crate::model::CacheState;

pub type CacheStore = remote_cli::CacheStore<CacheState>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Conversation;
    use std::fs;
    use std::path::PathBuf;

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "slick-cache-test-{}-{name}-{}.json",
            std::process::id(),
            CacheState::now()
        ))
    }

    #[test]
    fn cache_round_trip_and_clear_preserves_slick_contract() {
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

    #[test]
    fn default_path_keeps_slick_identity() {
        let path = CacheStore::default_path();
        assert!(path.ends_with("slick/state.json"));
    }
}
