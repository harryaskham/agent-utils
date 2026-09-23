//! Node-owned speech policy. Explicit writes only; no daemon or polling writer.
use crate::{Error, Result};
use clap::ValueEnum;
use nix::fcntl::{Flock, FlockArg};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_STATE_BYTES: u64 = 16 * 1024;
const MAX_SAFE_EPOCH: u64 = 9_007_199_254_740_991;

#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Serialize,
    Deserialize,
    JsonSchema,
    ValueEnum,
)]
#[serde(rename_all = "snake_case")]
pub enum SpeechKind {
    Read,
    Tts,
    Narrate,
    Choices,
}
impl SpeechKind {
    pub const ALL: [Self; 4] = [Self::Read, Self::Tts, Self::Narrate, Self::Choices];
    pub fn name(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Tts => "tts",
            Self::Narrate => "narrate",
            Self::Choices => "choices",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MuteState {
    pub version: u32,
    #[serde(default)]
    pub muted: BTreeMap<SpeechKind, bool>,
    #[serde(default)]
    pub epochs: BTreeMap<SpeechKind, u64>,
    #[serde(default)]
    pub updated_at_ms: u64,
}
impl Default for MuteState {
    fn default() -> Self {
        Self {
            version: 1,
            muted: SpeechKind::ALL.map(|kind| (kind, false)).into(),
            epochs: SpeechKind::ALL.map(|kind| (kind, 0)).into(),
            updated_at_ms: 0,
        }
    }
}
impl MuteState {
    fn normalize(mut self) -> Result<Self> {
        if self.version != 1
            || self.updated_at_ms > MAX_SAFE_EPOCH
            || self.epochs.values().any(|v| *v > MAX_SAFE_EPOCH)
        {
            return Err(Error::Invalid(
                "invalid speech mute state version or epoch".into(),
            ));
        }
        for kind in SpeechKind::ALL {
            self.muted.entry(kind).or_insert(false);
            self.epochs.entry(kind).or_insert(0);
        }
        Ok(self)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MuteReceipt {
    pub path: PathBuf,
    pub exists: bool,
    pub state: MuteState,
    pub changed: Vec<SpeechKind>,
}

pub fn read_state(path: &Path) -> Result<MuteReceipt> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MuteReceipt {
                path: path.into(),
                exists: false,
                state: MuteState::default(),
                changed: vec![],
            });
        }
        Err(error) => return Err(error.into()),
    };
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > MAX_STATE_BYTES {
        return Err(Error::Invalid(
            "speech mute state must be a regular file ≤16 KiB".into(),
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_STATE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err(Error::Limit("speech mute state exceeds 16 KiB".into()));
    }
    let state: MuteState = serde_json::from_slice(&bytes).map_err(|_| {
        Error::Invalid(format!(
            "invalid speech mute state at {}; inspect/repair it before changing policy",
            path.display()
        ))
    })?;
    Ok(MuteReceipt {
        path: path.into(),
        exists: true,
        state: state.normalize()?,
        changed: vec![],
    })
}

fn write_target(path: &Path) -> Result<PathBuf> {
    let mut current = if path.is_absolute() {
        path.into()
    } else {
        std::env::current_dir()?.join(path)
    };
    for _ in 0..32 {
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.is_symlink() => {
                let link = fs::read_link(&current)?;
                current = if link.is_absolute() {
                    link
                } else {
                    current.parent().expect("absolute path").join(link)
                };
            }
            Ok(meta) if !meta.is_file() => {
                return Err(Error::Invalid(
                    "speech mute state target is not a regular file".into(),
                ));
            }
            Ok(_) => return Ok(fs::canonicalize(current)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let parent = current.parent().expect("absolute path");
                fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(parent)?;
                return Ok(fs::canonicalize(parent)?.join(
                    current
                        .file_name()
                        .ok_or_else(|| Error::Invalid("missing mute state filename".into()))?,
                ));
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(Error::Invalid(
        "speech mute state symlink cycle/depth exceeds 32".into(),
    ))
}

pub fn selected_kinds(kinds: &[SpeechKind]) -> Result<Vec<SpeechKind>> {
    if kinds.len() > 4 {
        return Err(Error::Invalid("select at most four speech types".into()));
    }
    Ok(SpeechKind::ALL
        .into_iter()
        .filter(|k| kinds.is_empty() || kinds.contains(k))
        .collect())
}

pub fn set_muted(path: &Path, kinds: &[SpeechKind], muted: bool) -> Result<MuteReceipt> {
    let kinds = selected_kinds(kinds)?;
    let target = write_target(path)?;
    let lock_path = PathBuf::from(format!("{}.lock", target.display()));
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(lock_path)?;
    if !file.metadata()?.is_file() {
        return Err(Error::Invalid("mute lock is not a regular file".into()));
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    let _lock = loop {
        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => break lock,
            Err((returned, error))
                if error == nix::errno::Errno::EWOULDBLOCK
                    || error == nix::errno::Errno::EAGAIN =>
            {
                if Instant::now() >= deadline {
                    return Err(Error::Invalid(
                        "speech mute state is busy; retry the explicit command".into(),
                    ));
                }
                file = returned;
                std::thread::sleep(Duration::from_millis(10));
            }
            Err((_, error)) => return Err(std::io::Error::from_raw_os_error(error as i32).into()),
        }
    };
    let mut receipt = read_state(&target)?;
    for kind in kinds {
        if receipt.state.muted[&kind] != muted {
            if muted {
                let epoch = receipt.state.epochs[&kind];
                if epoch >= MAX_SAFE_EPOCH {
                    return Err(Error::Limit("speech mute epoch exhausted".into()));
                }
                receipt.state.epochs.insert(kind, epoch + 1);
            }
            receipt.state.muted.insert(kind, muted);
            receipt.changed.push(kind);
        }
    }
    if !receipt.exists || !receipt.changed.is_empty() {
        receipt.state.updated_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::Invalid("system clock precedes UNIX epoch".into()))?
            .as_millis() as u64;
        let parent = target.parent().expect("absolute path");
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer(&mut temporary, &receipt.state)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        temporary.persist(&target).map_err(|e| e.error)?;
        File::open(parent)?.sync_all()?;
    }
    receipt.path = path.into();
    receipt.exists = true;
    Ok(receipt)
}
