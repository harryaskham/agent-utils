use crate::{Error, Result, model::*};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

pub fn check_limit(limit: usize) -> Result<()> {
    if limit > MAX_ITEMS {
        return Err(Error::Limit(format!("limit must be 0–{MAX_ITEMS}")));
    }
    Ok(())
}
fn warning(warnings: &mut Vec<String>, text: impl Into<String>) {
    if warnings.len() < 8 {
        warnings.push(text.into());
    }
}
fn identity(meta: &fs::Metadata, offset: u64) -> Cursor {
    Cursor {
        device: meta.dev(),
        inode: meta.ino(),
        offset,
    }
}

fn tail_start(file: &mut File, lines: usize) -> Result<(u64, bool)> {
    let length = file.metadata()?.len();
    if lines == 0 {
        return Ok((length, false));
    }
    let mut at = length;
    let mut count = 0;
    let floor = length.saturating_sub(MAX_RESPONSE_BYTES as u64);
    let mut chunk = [0u8; 65536];
    while at > floor {
        let start = at.saturating_sub(chunk.len() as u64).max(floor);
        let size = (at - start) as usize;
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut chunk[..size])?;
        for i in (0..size).rev() {
            if chunk[i] == b'\n' && start + i as u64 + 1 != length {
                count += 1;
                if count == lines {
                    return Ok((start + i as u64 + 1, false));
                }
            }
        }
        at = start;
    }
    Ok((floor, floor > 0))
}

pub fn speech_list(path: &Path, limit: usize) -> Result<Listing<SpeechRecord>> {
    check_limit(limit)?;
    let mut result = Listing::default();
    if limit == 0 {
        return Ok(result);
    }
    let mut file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            result.warnings.push("feed not created yet".into());
            return Ok(result);
        }
        Err(e) => return Err(e.into()),
    };
    if !file.metadata()?.is_file() {
        return Err(Error::Invalid("feed is not a regular file".into()));
    }
    let (start, clipped) = tail_start(&mut file, limit)?;
    result.truncated = start > 0;
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(MAX_RESPONSE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(Error::Limit("history read exceeded 64 MiB".into()));
    }
    let mut first = true;
    for line in bytes.split_inclusive(|b| *b == b'\n') {
        if first && clipped {
            first = false;
            warning(&mut result.warnings, "history scan limited to last 64 MiB");
            continue;
        }
        first = false;
        if !line.ends_with(b"\n") {
            continue;
        } // Writer's incomplete record is not yet committed.
        if line.len() > MAX_RECORD_BYTES {
            warning(
                &mut result.warnings,
                "oversized speech record skipped (8 MiB limit)",
            );
            continue;
        }
        match serde_json::from_slice(line) {
            Ok(record) => result.records.push(record),
            Err(_) => warning(&mut result.warnings, "malformed speech record skipped"),
        }
    }
    if result.records.len() > limit {
        result.records.drain(..result.records.len() - limit);
    }
    Ok(result)
}

// Incremental file reader: bytes are never reread on normal polls, incomplete
// appends remain pending, and only newline-committed offsets are checkpointed.
pub struct TailReader {
    path: PathBuf,
    file: Option<File>,
    cursor: Option<Cursor>,
    position: u64,
    initial_lines: usize,
    partial: Vec<u8>,
    oversized: bool,
    state: String,
}
impl TailReader {
    pub fn new(path: PathBuf, lines: usize, cursor: Option<Cursor>) -> Result<Self> {
        check_limit(lines)?;
        Ok(Self {
            path,
            file: None,
            cursor,
            position: 0,
            initial_lines: lines,
            partial: vec![],
            oversized: false,
            state: String::new(),
        })
    }
    fn status(&mut self, state: &str, message: &str, events: &mut Vec<TailEvent>) {
        if self.state != state {
            self.state = state.into();
            events.push(TailEvent::Status {
                state: state.into(),
                message: message.into(),
            });
        }
    }
    pub fn poll(&mut self) -> Result<Vec<TailEvent>> {
        let mut events = vec![];
        let meta = match fs::metadata(&self.path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.file = None;
                self.status("waiting", "feed not created yet", &mut events);
                return Ok(events);
            }
            Err(e) => return Err(e.into()),
        };
        if !meta.is_file() {
            return Err(Error::Invalid("feed is not a regular file".into()));
        }
        let current = identity(&meta, 0);
        let changed = self.cursor.is_some_and(|c| {
            c.device != current.device || c.inode != current.inode || self.position > meta.len()
        });
        if self.file.is_none() || changed {
            let mut file = File::open(&self.path)?;
            let opened = identity(&file.metadata()?, 0);
            let start = match self.cursor {
                Some(c)
                    if c.device == opened.device
                        && c.inode == opened.inode
                        && c.offset <= file.metadata()?.len() =>
                {
                    c.offset
                }
                Some(_) => 0,
                None => tail_start(&mut file, self.initial_lines)?.0,
            };
            file.seek(SeekFrom::Start(start))?;
            self.file = Some(file);
            self.position = start;
            self.partial.clear();
            self.oversized = false;
            self.cursor = Some(Cursor {
                offset: start,
                ..opened
            });
            self.status(
                if changed { "reset" } else { "connected" },
                if changed {
                    "feed replaced/truncated; resuming at beginning"
                } else {
                    "following speech feed"
                },
                &mut events,
            );
        }
        let mut read_bytes = 0;
        let mut buffer = [0u8; 8192];
        while read_bytes < MAX_RECORD_BYTES && events.len() < MAX_ITEMS {
            let count = self.file.as_mut().expect("opened file").read(&mut buffer)?;
            if count == 0 {
                break;
            }
            read_bytes += count;
            for part in buffer[..count].split_inclusive(|b| *b == b'\n') {
                self.position += part.len() as u64;
                if !self.oversized {
                    if self.partial.len() + part.len() > MAX_RECORD_BYTES {
                        self.partial.clear();
                        self.oversized = true;
                    } else {
                        self.partial.extend_from_slice(part);
                    }
                }
                if part.ends_with(b"\n") {
                    let cursor = Cursor {
                        offset: self.position,
                        ..self.cursor.expect("cursor initialized")
                    };
                    self.cursor = Some(cursor);
                    if self.oversized {
                        events.push(TailEvent::Status {
                            state: "warning".into(),
                            message: "oversized speech record skipped (8 MiB limit)".into(),
                        });
                    } else {
                        match serde_json::from_slice(&self.partial) {
                            Ok(record) => events.push(TailEvent::Speech { record, cursor }),
                            Err(_) => events.push(TailEvent::Status {
                                state: "warning".into(),
                                message: "malformed speech record skipped".into(),
                            }),
                        }
                    }
                    self.partial.clear();
                    self.oversized = false;
                }
            }
        }
        if let Some(cursor) = self.cursor {
            events.push(TailEvent::Checkpoint { cursor });
        }
        Ok(events)
    }
}

pub fn image_path(root: &Path, id: &str) -> Result<PathBuf> {
    let path = Path::new(id);
    let components: Vec<_> = path.components().collect();
    if components.len() != 2
        || !components.iter().all(|c| matches!(c, Component::Normal(_)))
        || id.contains('\\')
        || id.contains('\0')
    {
        return Err(Error::Invalid(
            "image id must be agent/filename without traversal".into(),
        ));
    }
    let directory = root.join(components[0]);
    if !fs::symlink_metadata(&directory)?.is_dir() {
        return Err(Error::Invalid(
            "image directory must not be a symlink".into(),
        ));
    }
    let full = root.join(path);
    if !fs::symlink_metadata(&full)?.is_file() {
        return Err(Error::Invalid(
            "image must be a regular non-symlink file".into(),
        ));
    }
    Ok(full)
}
pub fn image_info(root: &Path, id: &str) -> Result<ImageRecord> {
    let image = image_path(root, id)?;
    let sidecar = PathBuf::from(format!("{}.json", image.display()));
    let meta = fs::symlink_metadata(&sidecar)?;
    if !meta.is_file() || meta.len() > 65536 {
        return Err(Error::Limit(
            "image metadata must be a non-symlink file ≤64 KiB".into(),
        ));
    }
    let mut data = vec![];
    File::open(&sidecar)?.take(65537).read_to_end(&mut data)?;
    if data.len() > 65536 {
        return Err(Error::Limit("image metadata exceeds 64 KiB".into()));
    }
    let record: ImageRecord = serde_json::from_slice(&data)?;
    if record.version != 1
        || record.id != id
        || record.bytes == 0
        || record.bytes > MAX_IMAGE_BYTES as u64
        || record.sha256.len() != 64
        || !record.sha256.bytes().all(|c| c.is_ascii_hexdigit())
        || fs::metadata(&image)?.len() != record.bytes
    {
        return Err(Error::Invalid(
            "image metadata identity/size/version mismatch".into(),
        ));
    }
    Ok(record)
}
pub fn image_bytes(root: &Path, id: &str) -> Result<Vec<u8>> {
    let record = image_info(root, id)?;
    let mut bytes = Vec::new();
    File::open(image_path(root, id)?)?
        .take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 != record.bytes
        || format!("{:x}", Sha256::digest(&bytes)) != record.sha256
    {
        return Err(Error::Invalid("image checksum/size mismatch".into()));
    }
    Ok(bytes)
}
pub fn image_list(root: &Path, limit: usize, agent: Option<&str>) -> Result<Listing<ImageRecord>> {
    check_limit(limit)?;
    let mut result = Listing::default();
    if limit == 0 {
        return Ok(result);
    }
    let dirs = match fs::read_dir(root) {
        Ok(dirs) => dirs,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            result.warnings.push("image archive not created yet".into());
            return Ok(result);
        }
        Err(e) => return Err(e.into()),
    };
    let mut latest = BTreeMap::new();
    let mut scanned = 0;
    'scan: for dir in dirs {
        let dir = dir?;
        if !dir.file_type()?.is_dir() {
            continue;
        }
        for entry in fs::read_dir(dir.path())? {
            scanned += 1;
            if scanned > 200_000 {
                result.truncated = true;
                warning(
                    &mut result.warnings,
                    "archive scan limited to 200000 files; narrow the agent filter",
                );
                break 'scan;
            }
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let filename = entry.file_name().to_string_lossy().into_owned();
            let Some(filename) = filename.strip_suffix(".json") else {
                continue;
            };
            let id = format!("{}/{filename}", dir.file_name().to_string_lossy());
            match image_info(root, &id) {
                Ok(record)
                    if agent.is_none_or(|filter| {
                        record.agent == filter || dir.file_name() == filter
                    }) =>
                {
                    latest.insert((record.timestamp.clone(), record.id.clone()), record);
                    if latest.len() > limit {
                        latest.pop_first();
                        result.truncated = true;
                    }
                }
                Ok(_) => (),
                Err(_) => warning(
                    &mut result.warnings,
                    format!("invalid image metadata skipped: {id}"),
                ),
            }
        }
    }
    result.records = latest.into_values().rev().collect();
    Ok(result)
}
