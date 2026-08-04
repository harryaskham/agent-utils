//! Cache-only client followers for the Slick TUI.
//!
//! Local clients watch atomic cache replacements. Remote clients fetch one
//! authenticated snapshot then follow the daemon's SSE stream. Neither path
//! constructs `SlackService`, so `slick --client` cannot consume Slack quota.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};

use anyhow::{bail, Context, Result};
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION};

use crate::cache::CacheStore;
use crate::model::CacheState;

const MAX_SSE_LINE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct ClientOptions {
    pub cache_store: CacheStore,
    pub endpoint: Option<String>,
    pub token_path: PathBuf,
}

#[derive(Clone, Debug)]
pub enum ClientUpdate {
    State(Box<CacheState>, String),
    Error(String),
}

pub struct ClientSubscription {
    pub rx: Receiver<ClientUpdate>,
    stop: Arc<AtomicBool>,
}

impl ClientSubscription {
    #[must_use]
    pub fn spawn(options: ClientOptions) -> Self {
        let (tx, rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        thread::spawn(move || {
            if let Some(endpoint) = options.endpoint.filter(|value| !value.trim().is_empty()) {
                follow_remote(
                    &options.cache_store,
                    &endpoint,
                    &options.token_path,
                    &tx,
                    &thread_stop,
                );
            } else {
                follow_local(&options.cache_store, &tx, &thread_stop);
            }
        });
        Self { rx, stop }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }
}

impl Drop for ClientSubscription {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Fingerprint {
    modified: Option<SystemTime>,
    len: u64,
    file_identity: u64,
}

fn fingerprint(store: &CacheStore) -> Option<Fingerprint> {
    let metadata = fs::metadata(store.path()).ok()?;
    #[cfg(unix)]
    let file_identity = {
        use std::os::unix::fs::MetadataExt;
        metadata.ino()
    };
    #[cfg(not(unix))]
    let file_identity = 0;
    Some(Fingerprint {
        modified: metadata.modified().ok(),
        len: metadata.len(),
        // CacheStore uses atomic rename, so inode/file-id catches two
        // same-size writes inside a coarse filesystem timestamp bucket.
        file_identity,
    })
}

fn follow_local(store: &CacheStore, tx: &Sender<ClientUpdate>, stop: &AtomicBool) {
    if let Ok(state) = store.load() {
        let _ = tx.send(ClientUpdate::State(
            Box::new(state),
            "client · local cache".into(),
        ));
    }
    let mut seen = fingerprint(store);
    while !stop.load(Ordering::Acquire) {
        thread::sleep(Duration::from_millis(350));
        let current = fingerprint(store);
        if current == seen {
            continue;
        }
        seen = current;
        match store.load() {
            Ok(state) => {
                let _ = tx.send(ClientUpdate::State(
                    Box::new(state),
                    "client · local cache update".into(),
                ));
            }
            Err(error) => {
                let _ = tx.send(ClientUpdate::Error(format!(
                    "local cache update failed: {error:#}"
                )));
            }
        }
    }
}

fn follow_remote(
    store: &CacheStore,
    endpoint: &str,
    token_path: &Path,
    tx: &Sender<ClientUpdate>,
    stop: &AtomicBool,
) {
    let base = endpoint.trim_end_matches('/').to_string();
    let client = match Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            let _ = tx.send(ClientUpdate::Error(format!("build daemon client: {error}")));
            return;
        }
    };
    // SSE is deliberately unbounded; the daemon emits keepalives, and process
    // shutdown flips the stop flag which is observed at the next line. A
    // request-wide timeout would manufacture a disconnect every N seconds.
    let event_client = match Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(None)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            let _ = tx.send(ClientUpdate::Error(format!(
                "build daemon event client: {error}"
            )));
            return;
        }
    };
    let mut failures = 0_u32;
    while !stop.load(Ordering::Acquire) {
        let token = match read_token(token_path) {
            Ok(token) => token,
            Err(error) => {
                failures = failures.saturating_add(1);
                let _ = tx.send(ClientUpdate::Error(format!(
                    "daemon auth unavailable: {error:#}"
                )));
                interruptible_sleep(stop, reconnect_delay(failures));
                continue;
            }
        };
        match remote_session(&client, &event_client, &base, &token, store, tx, stop) {
            Ok(()) => failures = 0,
            Err(error) if !stop.load(Ordering::Acquire) => {
                failures = failures.saturating_add(1);
                let delay = reconnect_delay(failures);
                let _ = tx.send(ClientUpdate::Error(format!(
                    "daemon disconnected; reconnecting in {}s: {error:#}",
                    delay.as_secs()
                )));
                interruptible_sleep(stop, delay);
            }
            Err(_) => break,
        }
    }
}

fn remote_session(
    client: &Client,
    event_client: &Client,
    base: &str,
    token: &str,
    store: &CacheStore,
    tx: &Sender<ClientUpdate>,
    stop: &AtomicBool,
) -> Result<()> {
    let authorization = format!("Bearer {token}");
    let initial: CacheState = client
        .get(format!("{base}/snapshot"))
        .header(AUTHORIZATION, &authorization)
        .header(ACCEPT, "application/json")
        .send()
        .context("fetch daemon snapshot")?
        .error_for_status()
        .context("daemon snapshot rejected")?
        .json()
        .context("decode daemon snapshot")?;
    publish_remote_state(store, tx, initial, "client · daemon snapshot")?;

    let response = event_client
        .get(format!("{base}/events"))
        .header(AUTHORIZATION, authorization)
        .header(ACCEPT, "text/event-stream")
        .send()
        .context("connect daemon events")?
        .error_for_status()
        .context("daemon event stream rejected")?;
    let mut reader = BufReader::new(response);
    let mut line = String::new();
    let mut data = String::new();
    while !stop.load(Ordering::Acquire) {
        line.clear();
        let read = reader.read_line(&mut line).context("read daemon event")?;
        if read == 0 {
            bail!("daemon event stream ended");
        }
        if line.len() > MAX_SSE_LINE_BYTES {
            bail!("daemon event exceeds {MAX_SSE_LINE_BYTES} byte safety limit");
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if let Some(fragment) = trimmed.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(fragment.trim_start());
        } else if trimmed.is_empty() && !data.is_empty() {
            let state: CacheState = serde_json::from_str(&data).context("decode daemon event")?;
            publish_remote_state(store, tx, state, "client · daemon live")?;
            data.clear();
        }
    }
    Ok(())
}

fn publish_remote_state(
    store: &CacheStore,
    tx: &Sender<ClientUpdate>,
    mut state: CacheState,
    status: &str,
) -> Result<()> {
    state.saved_at = Some(CacheState::now());
    store.save(&state)?;
    tx.send(ClientUpdate::State(Box::new(state), status.to_string()))
        .context("deliver daemon snapshot to TUI")
}

fn read_token(path: &Path) -> Result<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(path)
            .with_context(|| format!("inspect daemon token {}", path.display()))?
            .permissions()
            .mode()
            & 0o777;
        if mode & 0o077 != 0 {
            bail!(
                "daemon token {} has unsafe mode {mode:o}; require 0600 or stricter",
                path.display()
            );
        }
    }
    let token = fs::read_to_string(path)
        .with_context(|| format!("read daemon token {}", path.display()))?
        .trim()
        .to_string();
    if token.len() < 32 {
        bail!("daemon token {} is empty or too short", path.display());
    }
    Ok(token)
}

fn reconnect_delay(failures: u32) -> Duration {
    Duration::from_secs((1_u64 << failures.min(5)).min(30))
}

fn interruptible_sleep(stop: &AtomicBool, duration: Duration) {
    let ticks = duration.as_millis().div_ceil(100);
    for _ in 0..ticks {
        if stop.load(Ordering::Acquire) {
            break;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_backoff_is_bounded() {
        assert_eq!(reconnect_delay(0), Duration::from_secs(1));
        assert_eq!(reconnect_delay(1), Duration::from_secs(2));
        assert_eq!(reconnect_delay(100), Duration::from_secs(30));
    }

    #[test]
    fn fingerprint_changes_for_atomic_replacement() {
        let dir = std::env::temp_dir().join(format!(
            "slick-client-watch-{}-{}",
            std::process::id(),
            CacheState::now()
        ));
        let store = CacheStore::new(dir.join("state.json"));
        store.save(&CacheState::default()).unwrap();
        let first = fingerprint(&store).unwrap();
        let state = CacheState {
            team_name: "larger replacement".into(),
            ..CacheState::default()
        };
        store.save(&state).unwrap();
        assert_ne!(fingerprint(&store).unwrap(), first);
        fs::remove_dir_all(dir).ok();
    }
}
