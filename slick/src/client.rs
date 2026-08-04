//! Smart client source orchestration.
//!
//! Plain `slick` and `slick client` merge two equivalent authoritative inputs:
//! atomic cache replacements and authenticated daemon snapshots/SSE. If both
//! stop making progress for a configured timeout, one local client may acquire
//! an owner-only lease and ask the UI to start its embedded read-only collector.

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT, AUTHORIZATION};

use crate::cache::CacheStore;
use crate::model::CacheState;

const MAX_SSE_LINE_BYTES: usize = 32 * 1024 * 1024;
const FALLBACK_LEASE_TTL: Duration = Duration::from_secs(120);
const FALLBACK_LEASE_RENEW: Duration = Duration::from_secs(30);
const FALLBACK_LEASE_RETRY: Duration = Duration::from_secs(10);

#[derive(Clone, Debug)]
pub struct ClientOptions {
    pub cache_store: CacheStore,
    pub use_cache: bool,
    pub use_daemon: bool,
    pub endpoint: String,
    pub token_path: PathBuf,
    pub fallback: bool,
    pub fallback_timeout: Duration,
    pub fallback_lease_path: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientHealth {
    pub daemon_enabled: bool,
    pub daemon_connected: bool,
    pub daemon_age_secs: Option<u64>,
    pub cache_enabled: bool,
    pub cache_live: bool,
    pub cache_age_secs: Option<u64>,
    pub fallback_active: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub enum ClientUpdate {
    State(Box<CacheState>, String),
    Health(ClientHealth),
    Status(String),
    Error(String),
    FallbackRequired(String),
    DaemonRecovered,
}

pub struct ClientSubscription {
    pub rx: Receiver<ClientUpdate>,
    refresh_tx: Option<Sender<String>>,
    stop: Arc<AtomicBool>,
}

impl ClientSubscription {
    #[must_use]
    pub fn spawn(options: ClientOptions) -> Self {
        let (updates_tx, updates_rx) = mpsc::channel();
        let (source_tx, source_rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));

        if options.use_cache {
            let cache_store = options.cache_store.clone();
            let source_tx = source_tx.clone();
            let source_stop = Arc::clone(&stop);
            thread::spawn(move || follow_local(&cache_store, &source_tx, &source_stop));
        }
        let (refresh_tx, refresh_rx) = mpsc::channel();
        let refresh_tx = if options.use_daemon {
            let endpoint = options.endpoint.clone();
            let token_path = options.token_path.clone();
            let source_tx = source_tx.clone();
            let source_stop = Arc::clone(&stop);
            thread::spawn(move || {
                follow_refresh_commands(
                    &endpoint,
                    &token_path,
                    &refresh_rx,
                    &source_tx,
                    &source_stop,
                );
            });
            Some(refresh_tx)
        } else {
            drop(refresh_rx);
            None
        };
        if options.use_daemon {
            let endpoint = options.endpoint.clone();
            let token_path = options.token_path.clone();
            let source_tx = source_tx.clone();
            let source_stop = Arc::clone(&stop);
            thread::spawn(move || {
                follow_remote(&endpoint, &token_path, &source_tx, &source_stop);
            });
        }
        drop(source_tx);

        let coordinator_stop = Arc::clone(&stop);
        thread::spawn(move || {
            coordinate_sources(&options, &source_rx, &updates_tx, &coordinator_stop);
        });
        Self {
            rx: updates_rx,
            refresh_tx,
            stop,
        }
    }

    #[must_use]
    pub fn request_refresh(&self, domain: String) -> bool {
        self.refresh_tx
            .as_ref()
            .is_some_and(|tx| tx.send(domain).is_ok())
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
enum Source {
    Cache,
    Daemon,
}

#[derive(Debug)]
enum SourceEvent {
    State(Box<CacheState>, Source),
    DaemonUp,
    DaemonHeartbeat,
    DaemonDown(String),
    CacheError(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SnapshotVersion {
    revision: u64,
    saved_at: Option<i64>,
    latest_refresh: Option<i64>,
}

impl SnapshotVersion {
    fn of(state: &CacheState) -> Self {
        Self {
            revision: state.collector.revision,
            saved_at: state.saved_at,
            latest_refresh: state.last_refresh.values().copied().max(),
        }
    }
}

fn coordinate_sources(
    options: &ClientOptions,
    source_rx: &Receiver<SourceEvent>,
    updates: &Sender<ClientUpdate>,
    stop: &AtomicBool,
) {
    let started = Instant::now();
    let timeout = options.fallback_timeout.max(Duration::from_secs(1));
    let mut daemon_alive = false;
    let mut last_daemon_signal = None;
    let mut daemon_outage_since = options.use_daemon.then_some(started);
    let mut last_cache_progress = None;
    let mut last_cache_version = None;
    let mut delivered_version = None;
    let mut fallback_revision = 0_u64;
    let mut fallback_active = false;
    let mut last_error = None;
    let mut last_health = None;
    let mut fallback_disabled_reported = false;
    let mut fallback_lease: Option<FallbackLease> = None;
    let mut last_lease_attempt = None;
    let mut last_lease_renewal = Instant::now();

    while !stop.load(Ordering::Acquire) {
        match source_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(SourceEvent::State(state, source)) => {
                let version = SnapshotVersion::of(&state);
                match source {
                    Source::Cache => {
                        last_error = None;
                        if last_cache_version != Some(version) {
                            last_cache_version = Some(version);
                            last_cache_progress = Some(progress_instant(&state, timeout));
                        }
                        if fallback_active && state.collector.revision > fallback_revision {
                            recover_from_fallback(
                                updates,
                                &mut fallback_active,
                                &mut fallback_lease,
                            );
                            daemon_alive = true;
                            last_daemon_signal = Some(Instant::now());
                            daemon_outage_since = None;
                        }
                    }
                    Source::Daemon => {
                        daemon_alive = true;
                        last_daemon_signal = Some(Instant::now());
                        daemon_outage_since = None;
                        last_error = None;
                        if options.use_cache {
                            if let Err(error) = options.cache_store.save_exact(&state) {
                                let _ = updates.send(ClientUpdate::Error(format!(
                                    "cache write-through failed: {error:#}"
                                )));
                            }
                        }
                        if fallback_active {
                            recover_from_fallback(
                                updates,
                                &mut fallback_active,
                                &mut fallback_lease,
                            );
                        }
                    }
                }
                if delivered_version != Some(version) {
                    delivered_version = Some(version);
                    let status = match source {
                        Source::Cache => "client · cache",
                        Source::Daemon => "client · daemon live",
                    };
                    let _ = updates.send(ClientUpdate::State(state, status.into()));
                }
            }
            Ok(SourceEvent::DaemonUp) => {
                daemon_alive = true;
                last_daemon_signal = Some(Instant::now());
                daemon_outage_since = None;
                last_error = None;
                if fallback_active {
                    recover_from_fallback(updates, &mut fallback_active, &mut fallback_lease);
                }
                let _ = updates.send(ClientUpdate::Status("client · daemon connected".into()));
            }
            Ok(SourceEvent::DaemonHeartbeat) => {
                daemon_alive = true;
                last_daemon_signal = Some(Instant::now());
                daemon_outage_since = None;
                last_error = None;
            }
            Ok(SourceEvent::DaemonDown(error)) => {
                daemon_alive = false;
                daemon_outage_since.get_or_insert_with(Instant::now);
                last_error = Some(error.clone());
                let _ = updates.send(ClientUpdate::Error(format!(
                    "daemon unavailable; monitoring fallback timeout: {error}"
                )));
            }
            Ok(SourceEvent::CacheError(error)) => {
                last_error = Some(error.clone());
                let _ = updates.send(ClientUpdate::Error(error));
            }
            // Source threads can be deliberately absent (both disabled) or
            // terminate after construction failure. The coordinator still
            // owns fallback policy, so a disconnected source channel is just
            // another timer tick rather than a reason to exit.
            Err(RecvTimeoutError::Disconnected) => thread::sleep(Duration::from_millis(250)),
            Err(RecvTimeoutError::Timeout) => {}
        }

        let now = Instant::now();
        if fallback_active && now.duration_since(last_lease_renewal) >= FALLBACK_LEASE_RENEW {
            if let Some(lease) = &fallback_lease {
                if let Err(error) = lease.renew() {
                    let _ = updates.send(ClientUpdate::Error(format!(
                        "fallback lease renewal failed: {error:#}"
                    )));
                }
            }
            last_lease_renewal = now;
        }

        if daemon_alive
            && last_daemon_signal.is_some_and(|signal| now.duration_since(signal) >= timeout)
        {
            daemon_alive = false;
            daemon_outage_since = last_daemon_signal;
            last_error = Some("daemon heartbeat timed out".into());
            let _ = updates.send(ClientUpdate::Error(
                "daemon heartbeat timed out; evaluating fallback".into(),
            ));
        }
        let both_disabled = !options.use_cache && !options.use_daemon;
        let daemon_timed_out = options.use_daemon
            && !daemon_alive
            && daemon_outage_since.is_some_and(|since| now.duration_since(since) >= timeout);
        let cache_stale = !options.use_cache
            || last_cache_progress.is_none_or(|progress| now.duration_since(progress) >= timeout);
        let fallback_due = both_disabled || (daemon_timed_out && cache_stale);
        let can_retry_lease = last_lease_attempt
            .is_none_or(|attempt| now.duration_since(attempt) >= FALLBACK_LEASE_RETRY);
        if !fallback_due {
            fallback_disabled_reported = false;
        }
        if options.fallback && fallback_due && !fallback_active && can_retry_lease {
            last_lease_attempt = Some(now);
            match FallbackLease::try_acquire(&options.fallback_lease_path) {
                Ok(Some(lease)) => {
                    fallback_revision = delivered_version.map_or(0, |version| version.revision);
                    fallback_active = true;
                    last_lease_renewal = now;
                    fallback_lease = Some(lease);
                    last_error = None;
                    let reason = if both_disabled {
                        "cache and daemon disabled; embedded read-only collector active"
                    } else {
                        "daemon/cache sources stale beyond timeout; embedded read-only collector active"
                    };
                    let _ = updates.send(ClientUpdate::FallbackRequired(reason.into()));
                }
                Ok(None) => {
                    let _ = updates.send(ClientUpdate::Status(
                        "fallback collector already leased by another local Slick client".into(),
                    ));
                }
                Err(error) => {
                    let _ = updates.send(ClientUpdate::Error(format!(
                        "cannot acquire fallback lease: {error:#}"
                    )));
                }
            }
        } else if fallback_due && !options.fallback && !fallback_disabled_reported {
            fallback_disabled_reported = true;
            let _ = updates.send(ClientUpdate::Status(
                "all enabled sources unavailable; fallback disabled".into(),
            ));
        }

        let health = ClientHealth {
            daemon_enabled: options.use_daemon,
            daemon_connected: daemon_alive,
            daemon_age_secs: last_daemon_signal
                .map(|signal| age_bucket(now.duration_since(signal))),
            cache_enabled: options.use_cache,
            cache_live: options.use_cache
                && last_cache_progress
                    .is_some_and(|progress| now.duration_since(progress) < timeout),
            cache_age_secs: last_cache_progress
                .map(|progress| age_bucket(now.duration_since(progress))),
            fallback_active,
            error: last_error.clone(),
        };
        if last_health.as_ref() != Some(&health) {
            last_health = Some(health.clone());
            let _ = updates.send(ClientUpdate::Health(health));
        }
    }
}

fn age_bucket(age: Duration) -> u64 {
    let seconds = age.as_secs();
    if seconds < 60 {
        (seconds / 5) * 5
    } else {
        (seconds / 60) * 60
    }
}

fn recover_from_fallback(
    updates: &Sender<ClientUpdate>,
    fallback_active: &mut bool,
    lease: &mut Option<FallbackLease>,
) {
    *fallback_active = false;
    *lease = None;
    let _ = updates.send(ClientUpdate::DaemonRecovered);
    let _ = updates.send(ClientUpdate::Status(
        "client · daemon recovered; embedded collector stopped".into(),
    ));
}

fn progress_instant(state: &CacheState, timeout: Duration) -> Instant {
    let now = Instant::now();
    let age = state
        .saved_at
        .map_or(timeout.saturating_add(Duration::from_secs(1)), |saved| {
            Duration::from_secs(
                u64::try_from(CacheState::now().saturating_sub(saved).max(0)).unwrap_or(u64::MAX),
            )
        });
    now.checked_sub(age.min(timeout.saturating_add(Duration::from_secs(1))))
        .unwrap_or(now)
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
        file_identity,
    })
}

fn follow_local(store: &CacheStore, tx: &Sender<SourceEvent>, stop: &AtomicBool) {
    if store.path().exists() {
        if let Ok(state) = store.load() {
            let _ = tx.send(SourceEvent::State(Box::new(state), Source::Cache));
        }
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
                let _ = tx.send(SourceEvent::State(Box::new(state), Source::Cache));
            }
            Err(error) => {
                let _ = tx.send(SourceEvent::CacheError(format!(
                    "local cache update failed: {error:#}"
                )));
            }
        }
    }
}

fn follow_refresh_commands(
    endpoint: &str,
    token_path: &Path,
    commands: &Receiver<String>,
    tx: &Sender<SourceEvent>,
    stop: &AtomicBool,
) {
    let base = endpoint.trim_end_matches('/');
    let client = match Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            let _ = tx.send(SourceEvent::DaemonDown(format!(
                "build daemon refresh client: {error}"
            )));
            return;
        }
    };
    while !stop.load(Ordering::Acquire) {
        let domain = match commands.recv_timeout(Duration::from_millis(250)) {
            Ok(domain) => domain,
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let result = (|| -> Result<()> {
            let token = read_token(token_path)?;
            client
                .post(format!("{base}/refresh"))
                .header(AUTHORIZATION, format!("Bearer {token}"))
                .query(&[("domain", domain.as_str())])
                .send()
                .context("request daemon refresh")?
                .error_for_status()
                .context("daemon refresh rejected")?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                let _ = tx.send(SourceEvent::DaemonHeartbeat);
            }
            Err(error) => {
                let _ = tx.send(SourceEvent::DaemonDown(format!(
                    "refresh request failed: {error:#}"
                )));
            }
        }
    }
}

fn follow_remote(endpoint: &str, token_path: &Path, tx: &Sender<SourceEvent>, stop: &AtomicBool) {
    let base = endpoint.trim_end_matches('/').to_string();
    let snapshot_client = match Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            let _ = tx.send(SourceEvent::DaemonDown(format!(
                "build daemon client: {error}"
            )));
            return;
        }
    };
    let event_client = match Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(None)
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            let _ = tx.send(SourceEvent::DaemonDown(format!(
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
                let _ = tx.send(SourceEvent::DaemonDown(format!(
                    "daemon auth unavailable: {error:#}"
                )));
                interruptible_sleep(stop, reconnect_delay(failures));
                continue;
            }
        };
        match remote_session(&snapshot_client, &event_client, &base, &token, tx, stop) {
            Ok(()) => failures = 0,
            Err(error) if !stop.load(Ordering::Acquire) => {
                failures = failures.saturating_add(1);
                let _ = tx.send(SourceEvent::DaemonDown(format!("{error:#}")));
                interruptible_sleep(stop, reconnect_delay(failures));
            }
            Err(_) => break,
        }
    }
}

fn remote_session(
    snapshot_client: &Client,
    event_client: &Client,
    base: &str,
    token: &str,
    tx: &Sender<SourceEvent>,
    stop: &AtomicBool,
) -> Result<()> {
    let authorization = format!("Bearer {token}");
    let initial: CacheState = snapshot_client
        .get(format!("{base}/snapshot"))
        .header(AUTHORIZATION, &authorization)
        .header(ACCEPT, "application/json")
        .send()
        .context("fetch daemon snapshot")?
        .error_for_status()
        .context("daemon snapshot rejected")?
        .json()
        .context("decode daemon snapshot")?;
    tx.send(SourceEvent::DaemonUp)
        .context("deliver daemon connection state")?;
    tx.send(SourceEvent::State(Box::new(initial), Source::Daemon))
        .context("deliver daemon snapshot")?;

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
        if trimmed.starts_with(':') {
            let _ = tx.send(SourceEvent::DaemonHeartbeat);
        } else if let Some(fragment) = trimmed.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(fragment.trim_start());
        } else if trimmed.is_empty() && !data.is_empty() {
            let state: CacheState = serde_json::from_str(&data).context("decode daemon event")?;
            tx.send(SourceEvent::State(Box::new(state), Source::Daemon))
                .context("deliver live daemon snapshot")?;
            data.clear();
        }
    }
    Ok(())
}

pub(crate) fn read_token(path: &Path) -> Result<String> {
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

pub(crate) struct FallbackLease {
    path: PathBuf,
    owner: String,
}

impl FallbackLease {
    pub(crate) fn try_acquire(path: &Path) -> Result<Option<Self>> {
        if let Ok(metadata) = fs::metadata(path) {
            let stale = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age >= FALLBACK_LEASE_TTL);
            if stale {
                let _ = fs::remove_file(path);
            }
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("create fallback lease dir {}", parent.display()))?;
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = match options.open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(None),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("create fallback lease {}", path.display()));
            }
        };
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |duration| duration.as_nanos());
        let owner = format!("{}:{nonce}", std::process::id());
        writeln!(file, "{owner}")?;
        file.sync_all()?;
        Ok(Some(Self {
            path: path.to_path_buf(),
            owner,
        }))
    }

    fn renew(&self) -> Result<()> {
        let current = fs::read_to_string(&self.path).unwrap_or_default();
        if current.trim() != self.owner {
            bail!("fallback lease ownership changed");
        }
        fs::write(&self.path, format!("{}\n", self.owner))
            .with_context(|| format!("renew fallback lease {}", self.path.display()))
    }
}

impl Drop for FallbackLease {
    fn drop(&mut self) {
        let current = fs::read_to_string(&self.path).unwrap_or_default();
        if current.trim() == self.owner {
            let _ = fs::remove_file(&self.path);
        }
    }
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

    fn options(dir: &Path) -> ClientOptions {
        ClientOptions {
            cache_store: CacheStore::new(dir.join("state.json")),
            use_cache: false,
            use_daemon: false,
            endpoint: "http://127.0.0.1:1".into(),
            token_path: dir.join("token"),
            fallback: true,
            fallback_timeout: Duration::from_millis(10),
            fallback_lease_path: dir.join("fallback.lock"),
        }
    }

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

    #[test]
    fn disabling_both_sources_requests_immediate_fallback() {
        let dir = std::env::temp_dir().join(format!(
            "slick-client-fallback-{}-{}",
            std::process::id(),
            CacheState::now()
        ));
        let subscription = ClientSubscription::spawn(options(&dir));
        let update = subscription
            .rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
        assert!(matches!(update, ClientUpdate::FallbackRequired(_)));
        subscription.stop();
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn cache_only_mode_does_not_fallback_when_cache_is_old() {
        let dir = std::env::temp_dir().join(format!(
            "slick-client-cache-only-{}-{}",
            std::process::id(),
            CacheState::now()
        ));
        let mut options = options(&dir);
        options.use_cache = true;
        options
            .cache_store
            .save_exact(&CacheState {
                saved_at: Some(CacheState::now() - 3_600),
                ..CacheState::default()
            })
            .unwrap();
        let subscription = ClientSubscription::spawn(options);
        let first = subscription
            .rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(matches!(first, ClientUpdate::State(_, _)));
        let deadline = Instant::now() + Duration::from_millis(250);
        while Instant::now() < deadline {
            if let Ok(update) = subscription.rx.recv_timeout(Duration::from_millis(20)) {
                assert!(!matches!(update, ClientUpdate::FallbackRequired(_)));
            }
        }
        subscription.stop();
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn daemon_recovery_relinquishes_active_fallback_without_waiting() {
        let dir = std::env::temp_dir().join(format!(
            "slick-client-recovery-{}-{}",
            std::process::id(),
            CacheState::now()
        ));
        let path = dir.join("fallback.lock");
        let lease = FallbackLease::try_acquire(&path).unwrap().unwrap();
        let (updates_tx, updates_rx) = mpsc::channel();
        let mut active = true;
        let mut lease = Some(lease);
        recover_from_fallback(&updates_tx, &mut active, &mut lease);
        assert!(!active);
        assert!(lease.is_none());
        assert!(!path.exists());
        assert!(matches!(
            updates_rx.recv_timeout(Duration::from_millis(20)).unwrap(),
            ClientUpdate::DaemonRecovered
        ));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn fallback_lease_is_exclusive_and_stale_safe() {
        let dir = std::env::temp_dir().join(format!(
            "slick-client-lease-{}-{}",
            std::process::id(),
            CacheState::now()
        ));
        let path = dir.join("lease");
        let lease = FallbackLease::try_acquire(&path).unwrap().unwrap();
        assert!(FallbackLease::try_acquire(&path).unwrap().is_none());
        lease.renew().unwrap();
        drop(lease);
        assert!(FallbackLease::try_acquire(&path).unwrap().is_some());
        fs::remove_dir_all(dir).ok();
    }
}
