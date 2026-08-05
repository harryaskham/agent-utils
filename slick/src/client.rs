//! Slick specialization of the canonical `remote-cli` smart-client substrate.
//!
//! All cache/SSE/Unix-socket coordination, source health, reconnect policy, and
//! fallback leasing live in `remote-cli`; these aliases deliberately preserve
//! Slick's public Rust API and enum variants.

use crate::model::CacheState;

pub type ClientOptions = remote_cli::ClientOptions<CacheState>;
pub type ClientSubscription = remote_cli::ClientSubscription<CacheState>;
pub type ClientUpdate = remote_cli::ClientUpdate<CacheState>;
pub use remote_cli::{fetch_json, read_token, request_refresh, ClientHealth, FallbackLease};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::CacheStore;
    use std::time::Duration;

    #[test]
    fn aliases_keep_slick_source_contract() {
        let dir = tempfile_path("aliases");
        let options = ClientOptions {
            cache_store: CacheStore::new(dir.join("state.json")),
            use_cache: false,
            use_daemon: false,
            endpoint: "http://127.0.0.1:1".into(),
            token_path: dir.join("token"),
            fallback: true,
            fallback_timeout: Duration::from_millis(10),
            fallback_lease_path: dir.join("fallback.lock"),
        };
        let subscription = ClientSubscription::spawn(options);
        assert!(matches!(
            subscription
                .rx
                .recv_timeout(Duration::from_secs(2))
                .unwrap(),
            ClientUpdate::FallbackRequired(_)
        ));
        subscription.stop();
        std::fs::remove_dir_all(dir).ok();
    }

    fn tempfile_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "slick-client-{name}-{}-{}",
            std::process::id(),
            CacheState::now()
        ))
    }
}
