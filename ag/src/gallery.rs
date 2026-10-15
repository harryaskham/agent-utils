//! Explicit, incremental fleet media snapshots: shared images and shared audio.
//! Static local HTML, no web daemon. `ag sync` runs every pathway at once.
use crate::{
    Error, Result,
    config::{self, Config, Host},
    model::*,
    service::Service,
    store,
    transport::shell_quote,
};
use nix::fcntl::{Flock, FlockArg};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncReadExt, process::Command, sync::Semaphore, task::JoinSet};

const MAX_INDEX_BYTES: usize = 64 * 1024 * 1024;
const PAGE: &str = include_str!("../viewer.html");
const AUDIO_PAGE: &str = include_str!("../audio.html");
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct GalleryInput {
    #[serde(flatten)]
    pub selection: Selection,
    pub cache_dir: Option<String>,
    pub offline: bool,
    pub checksum: bool,
    pub confirmed: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GalleryHost {
    pub host: String,
    pub state: String,
    pub last_sync_ms: Option<u64>,
    pub images: usize,
    pub invalid: usize,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AudioHost {
    pub host: String,
    pub state: String,
    pub last_sync_ms: Option<u64>,
    pub clips: usize,
    pub invalid: usize,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GalleryImage {
    pub host: String,
    pub agent: String,
    pub id: String,
    pub timestamp: String,
    pub mime_type: String,
    pub bytes: u64,
    pub sha256: String,
    pub label: String,
    pub src: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GalleryClip {
    pub host: String,
    pub agent: String,
    pub id: String,
    pub timestamp: String,
    pub mime_type: String,
    pub bytes: u64,
    pub sha256: String,
    pub label: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub duration_ms: Option<u64>,
    pub src: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct GalleryReceipt {
    pub index: PathBuf,
    pub cache_dir: PathBuf,
    pub images: usize,
    pub bytes: u64,
    pub hosts: Vec<GalleryHost>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct AudioReceipt {
    pub index: PathBuf,
    pub cache_dir: PathBuf,
    pub clips: usize,
    pub bytes: u64,
    /// Sum of known clip durations.
    pub duration_ms: u64,
    pub hosts: Vec<AudioHost>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct SyncInput {
    #[serde(flatten)]
    pub selection: Selection,
    /// Pathways to sync; empty means all (image and audio).
    pub kinds: Vec<MediaKind>,
    pub image_cache_dir: Option<String>,
    pub audio_cache_dir: Option<String>,
    pub offline: bool,
    pub checksum: bool,
    pub confirmed: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct SyncReceipt {
    pub images: Option<GalleryReceipt>,
    pub audio: Option<AudioReceipt>,
    /// Whole-pathway failures (for example a cache already being pulled).
    pub errors: BTreeMap<String, String>,
}
impl SyncReceipt {
    /// Any pathway or node needing attention (CLI exit 3).
    pub fn partial(&self) -> bool {
        !self.errors.is_empty()
            || self.images.as_ref().is_some_and(|r| {
                r.hosts
                    .iter()
                    .any(|h| h.state == "unavailable" || h.invalid > 0 || !h.warnings.is_empty())
            })
            || self.audio.as_ref().is_some_and(|r| {
                r.hosts
                    .iter()
                    .any(|h| h.state == "unavailable" || h.invalid > 0 || !h.warnings.is_empty())
            })
    }
}
#[derive(Serialize)]
struct ImageManifest {
    version: u32,
    images: Vec<GalleryImage>,
    hosts: Vec<GalleryHost>,
}
#[derive(Serialize)]
struct AudioManifest {
    version: u32,
    clips: Vec<GalleryClip>,
    hosts: Vec<AudioHost>,
}
fn hash(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn private_dir(path: &Path) -> Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    if !fs::symlink_metadata(path)?.is_dir() {
        return Err(Error::Invalid(
            "gallery child directory must not be a symlink".into(),
        ));
    }
    Ok(())
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().expect("file parent"))?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|error| Error::Io(error.error))?;
    Ok(())
}
fn source_dir(kind: MediaKind, host: &Host) -> &Option<String> {
    match kind {
        MediaKind::Image => &host.paths.image_dir,
        MediaKind::Audio => &host.paths.audio_dir,
    }
}
fn source_path(kind: MediaKind, host: &Host) -> Result<PathBuf> {
    match kind {
        MediaKind::Image => host.paths.images(),
        MediaKind::Audio => host.paths.audio(),
    }
}
/// Configured cache path without creating it (read-only callers such as doctor).
pub(crate) fn cache_path(config: &Config, cache_dir: Option<&String>) -> Result<PathBuf> {
    media_cache_path(config, MediaKind::Image, cache_dir)
}
pub fn media_cache_path(
    config: &Config,
    kind: MediaKind,
    cache_dir: Option<&String>,
) -> Result<PathBuf> {
    let configured = match kind {
        MediaKind::Image => config.gallery.cache_dir.as_ref(),
        MediaKind::Audio => config.gallery.audio_cache_dir.as_ref(),
    };
    let leaf = match kind {
        MediaKind::Image => "ag/images",
        MediaKind::Audio => "ag/audio",
    };
    let path = cache_dir.or(configured).cloned().unwrap_or_else(|| {
        PathBuf::from(
            std::env::var_os("XDG_CACHE_HOME")
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| {
                    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                        .join(".cache")
                        .into_os_string()
                }),
        )
        .join(leaf)
        .to_string_lossy()
        .into()
    });
    config::expand_home(&path)
}
fn cache_root(config: &Config, kind: MediaKind, cache_dir: Option<&String>) -> Result<PathBuf> {
    let path = media_cache_path(config, kind, cache_dir)?;
    // Operator-managed root symlinks are supported; owned descendants are not.
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&path)?;
    Ok(fs::canonicalize(path)?)
}
/// Last successful image sync recorded for a node, if any (no network or writes).
pub(crate) fn last_sync_ms(root: &Path, host: &Host) -> Option<u64> {
    media_last_sync_ms(root, MediaKind::Image, host)
}
pub(crate) fn media_last_sync_ms(root: &Path, kind: MediaKind, host: &Host) -> Option<u64> {
    fs::read(
        root.join("hosts")
            .join(host_key(kind, host))
            .join("last-sync.json"),
    )
    .ok()
    .filter(|b| b.len() < 64)
    .and_then(|b| serde_json::from_slice::<Option<u64>>(&b).ok())
    .flatten()
}
/// Stable per-node cache directory. The image key is unchanged from earlier
/// releases so existing caches and last-sync stamps are reused.
pub fn host_key(kind: MediaKind, host: &Host) -> String {
    let identity = (
        host.name.as_str(),
        host.address.as_str(),
        &host.username,
        host.port,
        host.local,
        source_dir(kind, host),
    );
    hash(
        match kind {
            MediaKind::Image => serde_json::to_vec(&identity),
            MediaKind::Audio => serde_json::to_vec(&("audio", identity)),
        }
        .expect("serializable target"),
    )
}
fn url_path(path: &str) -> String {
    path.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
/// The rsync server runs in the remote login environment. Its protocol argv
/// remains argv at every shell hop; profile stdout is diverted away from rsync.
pub fn remote_rsync(host: &Host) -> String {
    remote_media_rsync(MediaKind::Image, host)
}
pub fn remote_media_rsync(kind: MediaKind, host: &Host) -> String {
    let default = match kind {
        MediaKind::Image => {
            "root=\"${PI_SHARED_IMAGES_DIR:-${PI_AGENT_UTILS_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-utils}/images}\";"
        }
        MediaKind::Audio => {
            "root=\"${PI_SHARED_AUDIO_DIR:-${PI_AGENT_UTILS_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-utils}/audio}\";"
        }
    };
    let root = source_dir(kind, host)
        .as_ref()
        .map(|p| format!("root={};", shell_quote(p)))
        .unwrap_or_else(|| default.into());
    let payload = format!(
        "{root} case \"$root\" in '~') root=\"$HOME\";; '~/'*) root=\"$HOME/${{root#\\~/}}\";; esac; cd -- \"$root\" || exit 23; exec rsync \"$@\" 1>&3 3>&-"
    );
    let login = format!("exec sh -c {} ag-rsync \"$@\"", shell_quote(&payload));
    let outer = format!(
        "exec \"$SHELL\" -lc {} ag-rsync \"$@\" 3>&1 1>&2",
        shell_quote(&login)
    );
    format!("sh -c {} ag-rsync", shell_quote(&outer))
}
pub fn rsync_command(
    config: &Config,
    host: &Host,
    destination: &Path,
    checksum: bool,
) -> Result<Command> {
    media_rsync_command(config, MediaKind::Image, host, destination, checksum)
}
pub fn media_rsync_command(
    config: &Config,
    kind: MediaKind,
    host: &Host,
    destination: &Path,
    checksum: bool,
) -> Result<Command> {
    let mut command = Command::new(&config.gallery.rsync_command);
    command.args([
        "-rltp",
        "--no-links",
        "--no-specials",
        "--no-devices",
        "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=",
    ]);
    command.arg(format!("--max-size={}", kind.max_bytes()));
    command.args(["--include=/*/", "--include=/*/*", "--exclude=*"]);
    command.arg(format!("--timeout={}", config.gallery.sync_timeout_seconds));
    if checksum {
        command.arg("--checksum");
    }
    let source = if host.local {
        format!("{}/", fs::canonicalize(source_path(kind, host)?)?.display())
    } else {
        let mut ssh = vec![shell_quote(&config.ssh_command), "-T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=2".into(), format!("-o ConnectTimeout={} -p {}", config.connect_timeout_seconds, host.port)];
        if let Some(user) = &host.username {
            ssh.push(format!("-l {}", shell_quote(user)));
        }
        command
            .arg("-e")
            .arg(ssh.join(" "))
            .arg("--rsync-path")
            .arg(remote_media_rsync(kind, host));
        let address = if host.address.contains(':') && !host.address.starts_with('[') {
            format!("[{}]", host.address)
        } else {
            host.address.clone()
        };
        format!("{address}:./")
    };
    command
        .arg("--")
        .arg(source)
        .arg(format!("{}/", destination.display()));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true);
    Ok(command)
}
struct OwnedSyncGroup(Option<nix::unistd::Pid>);
impl Drop for OwnedSyncGroup {
    fn drop(&mut self) {
        if let Some(group) = self.0 {
            let _ = nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGKILL);
        }
    }
}
async fn sync(
    config: &Config,
    kind: MediaKind,
    host: &Host,
    destination: &Path,
    checksum: bool,
) -> Result<()> {
    let mut child = media_rsync_command(config, kind, host, destination, checksum)?.spawn()?;
    let mut group = OwnedSyncGroup(child.id().map(|pid| nix::unistd::Pid::from_raw(pid as i32)));
    let mut stderr = child.stderr.take().expect("stderr pipe");
    let work = async {
        let errors = async {
            let mut tail = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let n = stderr.read(&mut buffer).await?;
                if n == 0 {
                    break;
                }
                tail.extend_from_slice(&buffer[..n]);
                if tail.len() > 4096 {
                    tail.drain(..tail.len() - 4096);
                }
            }
            Ok::<_, std::io::Error>(tail)
        };
        let (status, errors) = tokio::try_join!(child.wait(), errors)?;
        if !status.success() {
            return Err(Error::Transport(format!(
                "rsync {status}: {}",
                String::from_utf8_lossy(&errors).trim()
            )));
        }
        Ok(())
    };
    let (noun, plural) = (kind.name(), kind.plural());
    let result = tokio::select! {
        value = tokio::time::timeout(Duration::from_secs(config.gallery.sync_timeout_seconds), work) =>
            value.unwrap_or_else(|_| Err(Error::Transport(format!("{noun} sync timed out; cached {plural} retained")))),
        _ = tokio::signal::ctrl_c() => Err(Error::Transport(format!("{noun} sync cancelled; cached {plural} retained"))),
    };
    if result.is_err() {
        if let Some(group) = group.0 {
            let _ = nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGKILL);
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    group.0 = None;
    result
}
/// One verified registration in a host's cached archive.
struct Entry {
    host: String,
    record: MediaRecord,
    bytes: u64,
    src: String,
}
fn catalog(
    kind: MediaKind,
    path: &Path,
    host: &str,
    key: &str,
) -> Result<(Vec<Entry>, usize, Vec<String>)> {
    let mut entries = vec![];
    let mut invalid = 0;
    let mut warnings = vec![];
    let mut size = 0;
    for directory in fs::read_dir(path)? {
        let directory = directory?;
        if !directory.file_type()?.is_dir() {
            continue;
        }
        for entry in fs::read_dir(directory.path())? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(name) = name.strip_suffix(".json") else {
                continue;
            };
            let id = format!("{}/{name}", directory.file_name().to_string_lossy());
            let read = || -> Result<Entry> {
                let record = store::media_info(path, &id, kind)?;
                // Stream validation, never allocate all fleet media bytes in RAM.
                let mut file = File::open(store::media_path(path, &id, kind)?)?;
                let mut digest = Sha256::new();
                let mut bytes = 0u64;
                let mut buffer = [0; 65536];
                loop {
                    let n = file.read(&mut buffer)?;
                    if n == 0 {
                        break;
                    }
                    bytes += n as u64;
                    if bytes > kind.max_bytes() as u64 {
                        return Err(Error::Limit(format!(
                            "{} exceeds {} MiB",
                            kind.name(),
                            kind.max_bytes() / 1024 / 1024
                        )));
                    }
                    digest.update(&buffer[..n]);
                }
                if bytes != record.bytes
                    || format!("{:x}", digest.finalize()) != record.sha256.to_lowercase()
                {
                    return Err(Error::Invalid(format!(
                        "{} checksum mismatch; use {} pull --checksum to repair",
                        kind.name(),
                        kind.name()
                    )));
                }
                Ok(Entry {
                    host: host.into(),
                    src: format!("hosts/{key}/archive/{}", url_path(&id)),
                    bytes,
                    record,
                })
            };
            match read() {
                Ok(entry) => {
                    // Conservative: the full sidecar is larger than its manifest row.
                    size += serde_json::to_vec(&entry.record)?.len() + entry.src.len();
                    if size > MAX_INDEX_BYTES {
                        return Err(Error::Limit(format!(
                            "{} index exceeds 64 MiB; select fewer hosts",
                            kind.name()
                        )));
                    }
                    entries.push(entry);
                }
                Err(error) => {
                    invalid += 1;
                    if warnings.len() < 8 {
                        warnings.push(format!("{id}: {error}"));
                    }
                }
            }
        }
    }
    Ok((entries, invalid, warnings))
}
fn bounded(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}
fn image_entry(entry: Entry) -> GalleryImage {
    let label = bounded(entry.record.label(), 512);
    GalleryImage {
        host: entry.host,
        agent: entry.record.agent,
        id: entry.record.id,
        timestamp: entry.record.timestamp,
        mime_type: entry.record.mime_type,
        bytes: entry.bytes,
        sha256: entry.record.sha256,
        label,
        src: entry.src,
    }
}
fn clip_entry(entry: Entry) -> GalleryClip {
    let record = &entry.record;
    GalleryClip {
        label: bounded(record.label(), 512),
        title: record.text("title").map(|t| bounded(t, 512)),
        description: record.text("description").map(|t| bounded(t, 4096)),
        duration_ms: record.number("durationMs"),
        host: entry.host,
        agent: entry.record.agent,
        id: entry.record.id,
        timestamp: entry.record.timestamp,
        mime_type: entry.record.mime_type,
        bytes: entry.bytes,
        sha256: entry.record.sha256,
        src: entry.src,
    }
}

#[derive(Clone)]
struct HostPull {
    host: String,
    state: String,
    last_sync_ms: Option<u64>,
    count: usize,
    invalid: usize,
    warnings: Vec<String>,
}
/// A completed per-kind pull. Holds the cache lock until its index is written.
struct Pull {
    root: PathBuf,
    hosts: Vec<HostPull>,
    entries: Vec<Entry>,
    _lock: Flock<File>,
}
async fn pull(
    config: Config,
    hosts: Vec<Host>,
    kind: MediaKind,
    cache_dir: Option<String>,
    offline: bool,
    checksum: bool,
    gate: Arc<Semaphore>,
) -> Result<Pull> {
    let root = cache_root(&config, kind, cache_dir.as_ref())?;
    private_dir(&root.join("hosts"))?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(root.join("gallery.lock"))?;
    let lock = Flock::lock(lock, FlockArg::LockExclusiveNonblock)
        .map_err(|_| Error::Invalid(format!("another {} pull is using this cache", kind.name())))?;
    let mut jobs = JoinSet::new();
    for host in hosts {
        let config = config.clone();
        let root = root.clone();
        let gate = gate.clone();
        jobs.spawn(async move {
            let _permit = gate
                .acquire()
                .await
                .map_err(|e| Error::Transport(e.to_string()))?;
            let key = host_key(kind, &host);
            let directory = root.join("hosts").join(&key);
            private_dir(&directory)?;
            let archive = directory.join("archive");
            private_dir(&archive)?;
            let stamp = directory.join("last-sync.json");
            let mut last_sync_ms = fs::read(&stamp)
                .ok()
                .filter(|b| b.len() < 64)
                .and_then(|b| serde_json::from_slice::<u64>(&b).ok());
            let result = if offline {
                Ok(())
            } else {
                sync(&config, kind, &host, &archive, checksum).await
            };
            let state = if offline {
                "cached"
            } else if result.is_ok() {
                "synced"
            } else {
                "unavailable"
            };
            let error = result.err().map(|e| e.to_string());
            if state == "synced" {
                last_sync_ms = Some(now_ms());
                atomic(&stamp, &serde_json::to_vec(&last_sync_ms)?)?;
            }
            let name = host.name.clone();
            let k = key.clone();
            let scan = tokio::task::spawn_blocking(move || catalog(kind, &archive, &name, &k))
                .await
                .map_err(|e| Error::Transport(e.to_string()))?;
            let (entries, invalid, mut warnings) = match scan {
                Ok(value) => value,
                Err(error) => (vec![], 0, vec![format!("cache scan incomplete: {error}")]),
            };
            if let Some(error) = error {
                warnings.insert(0, error);
            }
            Ok::<_, Error>((
                HostPull {
                    host: host.name,
                    state: state.to_owned(),
                    last_sync_ms,
                    count: entries.len(),
                    invalid,
                    warnings,
                },
                entries,
            ))
        });
    }
    let mut statuses = vec![];
    let mut all = vec![];
    while let Some(result) = tokio::select! {
        result = jobs.join_next() => result,
        _ = tokio::signal::ctrl_c() => {
            jobs.abort_all();
            while jobs.join_next().await.is_some() {}
            return Err(Error::Transport(format!("fleet {} pull cancelled; existing cache retained", kind.name())));
        }
    } {
        let (status, entries) = result.map_err(|e| Error::Transport(e.to_string()))??;
        statuses.push(status);
        all.extend(entries);
    }
    statuses.sort_by(|a, b| a.host.cmp(&b.host));
    all.sort_by(|a, b| {
        b.record
            .timestamp
            .cmp(&a.record.timestamp)
            .then(a.host.cmp(&b.host))
            .then(a.record.id.cmp(&b.record.id))
    });
    Ok(Pull {
        root,
        hosts: statuses,
        entries: all,
        _lock: lock,
    })
}
fn write_index(root: &Path, page: &str, manifest: &impl Serialize) -> Result<PathBuf> {
    let json = serde_json::to_string(manifest)?;
    if json.len() > MAX_INDEX_BYTES {
        return Err(Error::Limit(
            "fleet gallery index exceeds 64 MiB; select fewer hosts".into(),
        ));
    }
    let encoded = json.replace('<', "\\u003c").replace('&', "\\u0026");
    let index = root.join("index.html");
    atomic(&index, page.replace("__MANIFEST__", &encoded).as_bytes())?;
    Ok(index)
}
fn image_receipt(pull: Pull) -> Result<GalleryReceipt> {
    let hosts: Vec<GalleryHost> = pull
        .hosts
        .iter()
        .cloned()
        .map(|h| GalleryHost {
            host: h.host,
            state: h.state,
            last_sync_ms: h.last_sync_ms,
            images: h.count,
            invalid: h.invalid,
            warnings: h.warnings,
        })
        .collect();
    let images: Vec<GalleryImage> = pull.entries.into_iter().map(image_entry).collect();
    let receipt = GalleryReceipt {
        index: pull.root.join("index.html"),
        cache_dir: pull.root.clone(),
        images: images.len(),
        bytes: images.iter().map(|i| i.bytes).sum(),
        hosts: hosts.clone(),
    };
    write_index(
        &pull.root,
        PAGE,
        &ImageManifest {
            version: 1,
            images,
            hosts,
        },
    )?;
    Ok(receipt)
}
fn audio_receipt(pull: Pull) -> Result<AudioReceipt> {
    let hosts: Vec<AudioHost> = pull
        .hosts
        .iter()
        .cloned()
        .map(|h| AudioHost {
            host: h.host,
            state: h.state,
            last_sync_ms: h.last_sync_ms,
            clips: h.count,
            invalid: h.invalid,
            warnings: h.warnings,
        })
        .collect();
    let clips: Vec<GalleryClip> = pull.entries.into_iter().map(clip_entry).collect();
    let receipt = AudioReceipt {
        index: pull.root.join("index.html"),
        cache_dir: pull.root.clone(),
        clips: clips.len(),
        bytes: clips.iter().map(|c| c.bytes).sum(),
        duration_ms: clips.iter().filter_map(|c| c.duration_ms).sum(),
        hosts: hosts.clone(),
    };
    write_index(
        &pull.root,
        AUDIO_PAGE,
        &AudioManifest {
            version: 1,
            clips,
            hosts,
        },
    )?;
    Ok(receipt)
}
impl Service {
    pub fn image_gallery(&self, input: GalleryInput) -> Result<GalleryReceipt> {
        if !input.confirmed {
            return Err(Error::Invalid(
                "image gallery/pull writes a local cache; confirmed=true is required".into(),
            ));
        }
        let hosts = self.hosts(&input.selection)?;
        let gate = Arc::new(Semaphore::new(self.config.gallery.parallelism));
        let result = self.runtime.block_on(pull(
            self.config.clone(),
            hosts,
            MediaKind::Image,
            input.cache_dir,
            input.offline,
            input.checksum,
            gate,
        ))?;
        image_receipt(result)
    }
    pub fn audio_gallery(&self, input: GalleryInput) -> Result<AudioReceipt> {
        if !input.confirmed {
            return Err(Error::Invalid(
                "audio gallery/pull writes a local cache; confirmed=true is required".into(),
            ));
        }
        let hosts = self.hosts(&input.selection)?;
        let gate = Arc::new(Semaphore::new(self.config.gallery.parallelism));
        let result = self.runtime.block_on(pull(
            self.config.clone(),
            hosts,
            MediaKind::Audio,
            input.cache_dir,
            input.offline,
            input.checksum,
            gate,
        ))?;
        audio_receipt(result)
    }
    /// Every sync pathway at once (images and audio by default), sharing one
    /// transfer-parallelism budget. One pathway failing never hides another.
    pub fn sync(&self, input: SyncInput) -> Result<SyncReceipt> {
        if !input.confirmed {
            return Err(Error::Invalid(
                "sync writes local caches; confirmed=true is required".into(),
            ));
        }
        let kinds: Vec<MediaKind> = if input.kinds.is_empty() {
            MediaKind::ALL.to_vec()
        } else {
            MediaKind::ALL
                .into_iter()
                .filter(|k| input.kinds.contains(k))
                .collect()
        };
        let hosts = self.hosts(&input.selection)?;
        let gate = Arc::new(Semaphore::new(self.config.gallery.parallelism));
        let run = |kind: MediaKind| {
            let cache_dir = match kind {
                MediaKind::Image => input.image_cache_dir.clone(),
                MediaKind::Audio => input.audio_cache_dir.clone(),
            };
            let wanted = kinds.contains(&kind);
            let future = pull(
                self.config.clone(),
                hosts.clone(),
                kind,
                cache_dir,
                input.offline,
                input.checksum,
                gate.clone(),
            );
            async move { if wanted { Some(future.await) } else { None } }
        };
        let (images, audio) = self
            .runtime
            .block_on(async { tokio::join!(run(MediaKind::Image), run(MediaKind::Audio)) });
        let mut receipt = SyncReceipt::default();
        match images.map(|r| r.and_then(image_receipt)) {
            Some(Ok(value)) => receipt.images = Some(value),
            Some(Err(error)) => {
                receipt.errors.insert("image".into(), error.to_string());
            }
            None => (),
        }
        match audio.map(|r| r.and_then(audio_receipt)) {
            Some(Ok(value)) => receipt.audio = Some(value),
            Some(Err(error)) => {
                receipt.errors.insert("audio".into(), error.to_string());
            }
            None => (),
        }
        Ok(receipt)
    }
}
pub fn open_viewer(path: &Path) -> Result<()> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(target_os = "macos"))]
    let program = if std::env::var_os("TERMUX_VERSION").is_some() {
        "termux-open"
    } else {
        "xdg-open"
    };
    let status = std::process::Command::new(program)
        .arg(path)
        .stdin(Stdio::null())
        .status()?;
    if !status.success() {
        return Err(Error::Transport(format!(
            "{program} could not open the gallery; open {} manually",
            path.display()
        )));
    }
    Ok(())
}
