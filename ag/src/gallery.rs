//! Explicit, incremental fleet image snapshots. Static local HTML, no web daemon.
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
pub struct GalleryReceipt {
    pub index: PathBuf,
    pub cache_dir: PathBuf,
    pub images: usize,
    pub bytes: u64,
    pub hosts: Vec<GalleryHost>,
}
#[derive(Serialize)]
struct Manifest {
    version: u32,
    images: Vec<GalleryImage>,
    hosts: Vec<GalleryHost>,
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
fn cache_root(config: &Config, input: &GalleryInput) -> Result<PathBuf> {
    let path = input
        .cache_dir
        .as_ref()
        .or(config.gallery.cache_dir.as_ref())
        .cloned()
        .unwrap_or_else(|| {
            PathBuf::from(
                std::env::var_os("XDG_CACHE_HOME")
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| {
                        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
                            .join(".cache")
                            .into_os_string()
                    }),
            )
            .join("ag/images")
            .to_string_lossy()
            .into()
        });
    let path = config::expand_home(&path)?;
    // Operator-managed root symlinks are supported; owned descendants are not.
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&path)?;
    Ok(fs::canonicalize(path)?)
}
fn host_key(host: &Host) -> String {
    hash(
        serde_json::to_vec(&(
            host.name.as_str(),
            host.address.as_str(),
            &host.username,
            host.port,
            host.local,
            &host.paths.image_dir,
        ))
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
    let root = host.paths.image_dir.as_ref().map(|p| format!("root={};", shell_quote(p))).unwrap_or_else(|| "root=\"${PI_SHARED_IMAGES_DIR:-${PI_AGENT_UTILS_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/agent-utils}/images}\";".into());
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
    let mut command = Command::new(&config.gallery.rsync_command);
    command.args([
        "-rltp",
        "--no-links",
        "--no-specials",
        "--no-devices",
        "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=",
        "--max-size=67108864",
        "--include=/*/",
        "--include=/*/*",
        "--exclude=*",
    ]);
    command.arg(format!("--timeout={}", config.gallery.sync_timeout_seconds));
    if checksum {
        command.arg("--checksum");
    }
    let source = if host.local {
        format!("{}/", fs::canonicalize(host.paths.images()?)?.display())
    } else {
        let mut ssh = vec![shell_quote(&config.ssh_command), "-T -o BatchMode=yes -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes -o ServerAliveInterval=10 -o ServerAliveCountMax=2".into(), format!("-o ConnectTimeout={} -p {}", config.connect_timeout_seconds, host.port)];
        if let Some(user) = &host.username {
            ssh.push(format!("-l {}", shell_quote(user)));
        }
        command
            .arg("-e")
            .arg(ssh.join(" "))
            .arg("--rsync-path")
            .arg(remote_rsync(host));
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
async fn sync(config: &Config, host: &Host, destination: &Path, checksum: bool) -> Result<()> {
    let mut child = rsync_command(config, host, destination, checksum)?.spawn()?;
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
    let result = tokio::select! {
        value = tokio::time::timeout(Duration::from_secs(config.gallery.sync_timeout_seconds), work) =>
            value.unwrap_or_else(|_| Err(Error::Transport("image sync timed out; cached images retained".into()))),
        _ = tokio::signal::ctrl_c() => Err(Error::Transport("image sync cancelled; cached images retained".into())),
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
fn catalog(path: &Path, host: &str, key: &str) -> Result<(Vec<GalleryImage>, usize, Vec<String>)> {
    let mut images = vec![];
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
            let read = || -> Result<GalleryImage> {
                let record = store::image_info(path, &id)?;
                // Stream validation, never allocate all fleet image bytes in RAM.
                let mut file = File::open(store::image_path(path, &id)?)?;
                let mut digest = Sha256::new();
                let mut bytes = 0u64;
                let mut buffer = [0; 65536];
                loop {
                    let n = file.read(&mut buffer)?;
                    if n == 0 {
                        break;
                    }
                    bytes += n as u64;
                    if bytes > MAX_IMAGE_BYTES as u64 {
                        return Err(Error::Limit("image exceeds 64 MiB".into()));
                    }
                    digest.update(&buffer[..n]);
                }
                if bytes != record.bytes
                    || format!("{:x}", digest.finalize()) != record.sha256.to_lowercase()
                {
                    return Err(Error::Invalid(
                        "image checksum mismatch; use image pull --checksum to repair".into(),
                    ));
                }
                Ok(GalleryImage {
                    host: host.into(),
                    agent: record.agent,
                    id: id.clone(),
                    timestamp: record.timestamp,
                    mime_type: record.mime_type,
                    bytes,
                    sha256: record.sha256,
                    label: record
                        .source
                        .get("label")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .chars()
                        .take(512)
                        .collect(),
                    src: format!("hosts/{key}/archive/{}", url_path(&id)),
                })
            };
            match read() {
                Ok(image) => {
                    size += serde_json::to_vec(&image)?.len();
                    if size > MAX_INDEX_BYTES {
                        return Err(Error::Limit(
                            "gallery index exceeds 64 MiB; select fewer hosts".into(),
                        ));
                    }
                    images.push(image);
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
    Ok((images, invalid, warnings))
}
impl Service {
    pub fn image_gallery(&self, input: GalleryInput) -> Result<GalleryReceipt> {
        if !input.confirmed {
            return Err(Error::Invalid(
                "image gallery/pull writes a local cache; confirmed=true is required".into(),
            ));
        }
        let hosts = self.hosts(&input.selection)?;
        let root = cache_root(&self.config, &input)?;
        private_dir(&root.join("hosts"))?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(root.join("gallery.lock"))?;
        let _lock = Flock::lock(lock, FlockArg::LockExclusiveNonblock)
            .map_err(|_| Error::Invalid("another gallery pull is using this cache".into()))?;
        let mut all = vec![];
        let mut statuses = vec![];
        self.runtime.block_on(async {
            let semaphore = Arc::new(Semaphore::new(self.config.gallery.parallelism));
            let mut jobs = JoinSet::new();
            for host in hosts {
                let config = self.config.clone();
                let root = root.clone();
                let gate = semaphore.clone();
                let options = input.clone();
                jobs.spawn(async move {
                    let _permit = gate
                        .acquire()
                        .await
                        .map_err(|e| Error::Transport(e.to_string()))?;
                    let key = host_key(&host);
                    let directory = root.join("hosts").join(&key);
                    private_dir(&directory)?;
                    let archive = directory.join("archive");
                    private_dir(&archive)?;
                    let stamp = directory.join("last-sync.json");
                    let mut last_sync_ms = fs::read(&stamp)
                        .ok()
                        .filter(|b| b.len() < 64)
                        .and_then(|b| serde_json::from_slice::<u64>(&b).ok());
                    let result = if options.offline {
                        Ok(())
                    } else {
                        sync(&config, &host, &archive, options.checksum).await
                    };
                    let state = if options.offline {
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
                    let scan = tokio::task::spawn_blocking(move || catalog(&archive, &name, &k))
                        .await
                        .map_err(|e| Error::Transport(e.to_string()))?;
                    let (images, invalid, mut warnings) = match scan {
                        Ok(value) => value,
                        Err(error) => (vec![], 0, vec![format!("cache scan incomplete: {error}")]),
                    };
                    if let Some(error) = error {
                        warnings.insert(0, error);
                    }
                    Ok::<_, Error>((
                        GalleryHost {
                            host: host.name,
                            state: state.into(),
                            last_sync_ms,
                            images: images.len(),
                            invalid,
                            warnings,
                        },
                        images,
                    ))
                });
            }
            let mut index_bytes = 0;
            while let Some(result) = tokio::select! {
                result = jobs.join_next() => result,
                _ = tokio::signal::ctrl_c() => {
                    jobs.abort_all();
                    while jobs.join_next().await.is_some() {}
                    return Err(Error::Transport("fleet image pull cancelled; existing cache retained".into()));
                }
            } {
                let (status, images) = result.map_err(|e| Error::Transport(e.to_string()))??;
                index_bytes += serde_json::to_vec(&images)?.len();
                if index_bytes > MAX_INDEX_BYTES {
                    return Err(Error::Limit(
                        "fleet gallery index exceeds 64 MiB; select fewer hosts".into(),
                    ));
                }
                statuses.push(status);
                all.extend(images);
            }
            Ok::<_, Error>(())
        })?;
        statuses.sort_by(|a, b| a.host.cmp(&b.host));
        all.sort_by(|a, b| {
            b.timestamp
                .cmp(&a.timestamp)
                .then(a.host.cmp(&b.host))
                .then(a.id.cmp(&b.id))
        });
        let receipt = GalleryReceipt {
            index: root.join("index.html"),
            cache_dir: root,
            images: all.len(),
            bytes: all.iter().map(|i| i.bytes).sum(),
            hosts: statuses.clone(),
        };
        let json = serde_json::to_string(&Manifest {
            version: 1,
            images: all,
            hosts: statuses,
        })?;
        if json.len() > MAX_INDEX_BYTES {
            return Err(Error::Limit(
                "fleet gallery index exceeds 64 MiB; select fewer hosts".into(),
            ));
        }
        let encoded = json.replace('<', "\\u003c").replace('&', "\\u0026");
        let html = PAGE.replace("__MANIFEST__", &encoded);
        atomic(&receipt.index, html.as_bytes())?;
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
