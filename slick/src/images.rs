//! Image fetch + cache for inline rendering.
//!
//! Slack proxies emoji and hosts attachments behind authenticated URLs, so the
//! bytes must be fetched once and cached on disk before any terminal-graphics
//! placement is possible. This module owns only that: acquisition, bounded
//! caching, and pixel dimensions. Placement policy (emoji are punctuation,
//! attachments are content) lives in the UI.

use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Largest image Slick will cache. Emoji are ~2 KiB; this bounds a hostile or
/// accidental multi-megabyte attachment without needing streaming logic.
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;

/// A cached image ready for terminal placement.
#[derive(Clone, Debug)]
pub struct CachedImage {
    /// Encoded bytes (PNG/JPEG/GIF as served).
    pub bytes: Arc<Vec<u8>>,
    /// Pixel width, when it could be determined from the header.
    pub width: u32,
    /// Pixel height, when it could be determined from the header.
    pub height: u32,
}

impl CachedImage {
    /// Cell footprint for a full-size placement given terminal cell metrics.
    ///
    /// Falls back to a small block when dimensions are unknown so an
    /// undecodable attachment still occupies visible, obviously-wrong space
    /// rather than silently vanishing.
    #[must_use]
    pub fn block_cells(
        &self,
        cell_width_px: u16,
        cell_height_px: u16,
        max_cols: u16,
    ) -> (u16, u16) {
        if self.width == 0 || self.height == 0 {
            return (max_cols.min(20), 3);
        }
        let cell_w = u32::from(cell_width_px.max(1));
        let cell_h = u32::from(cell_height_px.max(1));
        let cols = u16::try_from(self.width.div_ceil(cell_w)).unwrap_or(max_cols);
        let cols = cols.clamp(1, max_cols.max(1));
        // Scale height by the same factor the column clamp applied to width so
        // a wide image shrinks rather than stretching.
        let scaled_width = u32::from(cols) * cell_w;
        let scaled_height =
            u64::from(self.height) * u64::from(scaled_width) / u64::from(self.width);
        let rows = scaled_height.div_ceil(u64::from(cell_h));
        let rows = u16::try_from(rows).unwrap_or(u16::MAX).max(1);
        (cols, rows)
    }
}

/// Disk-backed image cache keyed by URL.
#[derive(Debug)]
pub struct ImageStore {
    root: PathBuf,
    memory: HashMap<String, CachedImage>,
    failed: HashMap<String, String>,
    write_errors: Vec<String>,
}

impl ImageStore {
    /// Store rooted at `root` (created lazily on first write).
    #[must_use]
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            memory: HashMap::new(),
            failed: HashMap::new(),
            write_errors: Vec::new(),
        }
    }

    /// Cached entry for `url`, if already fetched in this session or on disk.
    pub fn get(&mut self, url: &str) -> Option<CachedImage> {
        if let Some(hit) = self.memory.get(url) {
            return Some(hit.clone());
        }
        let path = self.path_for(url);
        let bytes = std::fs::read(&path).ok()?;
        let entry = Self::decode(bytes);
        self.memory.insert(url.to_string(), entry.clone());
        Some(entry)
    }

    /// Whether a previous fetch for this URL failed (so callers stop retrying).
    #[must_use]
    pub fn failed(&self, url: &str) -> bool {
        self.failed.contains_key(url)
    }

    /// Record a failed fetch so it is not retried every frame.
    pub fn record_failure(&mut self, url: &str, reason: String) {
        self.failed.insert(url.to_string(), reason);
    }

    /// Insert freshly fetched bytes, writing through to disk best-effort.
    ///
    /// The disk copy is an optimisation, not the cache itself: a read-only or
    /// sandboxed `HOME` (the Nix build sandbox points it at an unwritable
    /// `/homeless-shelter`) must degrade to memory-only rather than failing the
    /// caller. Only genuinely invalid payloads are errors.
    pub fn insert(&mut self, url: &str, bytes: Vec<u8>) -> Result<CachedImage> {
        if bytes.is_empty() {
            bail!("empty image body");
        }
        if bytes.len() > MAX_IMAGE_BYTES {
            bail!("image exceeds {MAX_IMAGE_BYTES} byte cache limit");
        }
        if let Err(error) = self.write_through(url, &bytes) {
            self.write_errors.push(error.to_string());
        }
        let entry = Self::decode(bytes);
        self.memory.insert(url.to_string(), entry.clone());
        Ok(entry)
    }

    /// Persist bytes to the on-disk cache.
    fn write_through(&self, url: &str, bytes: &[u8]) -> Result<()> {
        let path = self.path_for(url);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create image cache dir {}", parent.display()))?;
        }
        std::fs::write(&path, bytes)
            .with_context(|| format!("write image cache {}", path.display()))
    }

    /// Disk write-through failures observed so far, for status reporting.
    #[must_use]
    pub fn write_errors(&self) -> &[String] {
        &self.write_errors
    }

    /// Cache path for a URL: a stable hash keeps proxied query strings, which
    /// can exceed filename limits, off the filesystem.
    fn path_for(&self, url: &str) -> PathBuf {
        self.root.join(format!("{}.img", stable_hash(url)))
    }

    fn decode(bytes: Vec<u8>) -> CachedImage {
        let (width, height) = image_dimensions(&bytes).unwrap_or((0, 0));
        CachedImage {
            bytes: Arc::new(bytes),
            width,
            height,
        }
    }
}

/// Stable, filesystem-safe hash of a URL.
#[must_use]
pub fn stable_hash(value: &str) -> String {
    // FNV-1a: no extra dependency, and collisions only cost a re-fetch.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Read pixel dimensions from a PNG, GIF or JPEG header.
///
/// Header parsing avoids pulling a full decoder into Slick for what is almost
/// always a 64x64 emoji.
#[must_use]
pub fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() >= 24 && bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((width, height));
    }
    if bytes.len() >= 10 && (bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")) {
        let width = u32::from(u16::from_le_bytes(bytes[6..8].try_into().ok()?));
        let height = u32::from(u16::from_le_bytes(bytes[8..10].try_into().ok()?));
        return Some((width, height));
    }
    if bytes.len() > 4 && bytes.starts_with(&[0xFF, 0xD8]) {
        return jpeg_dimensions(bytes);
    }
    None
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut index = 2usize;
    while index + 9 < bytes.len() {
        if bytes[index] != 0xFF {
            index += 1;
            continue;
        }
        let marker = bytes[index + 1];
        let length = usize::from(u16::from_be_bytes(
            bytes[index + 2..index + 4].try_into().ok()?,
        ));
        // SOF0..SOF3 and SOF5..SOF15 carry the frame dimensions.
        if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
            let height = u32::from(u16::from_be_bytes(
                bytes[index + 5..index + 7].try_into().ok()?,
            ));
            let width = u32::from(u16::from_be_bytes(
                bytes[index + 7..index + 9].try_into().ok()?,
            ));
            return Some((width, height));
        }
        index += 2 + length;
    }
    None
}

/// Default on-disk location for cached images.
#[must_use]
pub fn default_root(cache_path: &Path) -> PathBuf {
    cache_path.parent().unwrap_or(Path::new(".")).join("images")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0]);
        bytes
    }

    #[test]
    fn png_and_gif_dimensions_are_read_from_headers() {
        assert_eq!(image_dimensions(&png_header(64, 32)), Some((64, 32)));
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&40u16.to_le_bytes());
        gif.extend_from_slice(&20u16.to_le_bytes());
        assert_eq!(image_dimensions(&gif), Some((40, 20)));
        assert_eq!(image_dimensions(b"not an image"), None);
    }

    #[test]
    fn block_cells_preserve_aspect_and_respect_the_column_budget() {
        let image = CachedImage {
            bytes: Arc::new(Vec::new()),
            width: 160,
            height: 80,
        };
        let (cols, rows) = image.block_cells(8, 16, 40);
        assert_eq!(cols, 20, "160px at 8px per cell is 20 columns");
        assert_eq!(rows, 5, "half the width in pixels, at 16px rows");

        let (cols, _) = image.block_cells(8, 16, 10);
        assert_eq!(cols, 10, "wide images are clamped to the pane");
    }

    #[test]
    fn unknown_dimensions_still_reserve_visible_space() {
        let image = CachedImage {
            bytes: Arc::new(Vec::new()),
            width: 0,
            height: 0,
        };
        let (cols, rows) = image.block_cells(8, 16, 40);
        assert!(
            cols > 0 && rows > 0,
            "an undecodable attachment is never invisible"
        );
    }

    #[test]
    fn store_round_trips_through_disk_and_rejects_oversize() {
        let dir = std::env::temp_dir().join(format!("slick-images-{}", std::process::id()));
        let mut store = ImageStore::new(dir.clone());
        let url = "https://slack-imgs.com/?url=emoji";
        assert!(store.get(url).is_none());

        let entry = store.insert(url, png_header(64, 64)).unwrap();
        assert_eq!((entry.width, entry.height), (64, 64));

        let mut fresh = ImageStore::new(dir.clone());
        let hit = fresh.get(url).expect("cached on disk");
        assert_eq!((hit.width, hit.height), (64, 64));

        assert!(fresh.insert(url, vec![0u8; MAX_IMAGE_BYTES + 1]).is_err());
        assert!(fresh.insert(url, Vec::new()).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unwritable_cache_directory_degrades_to_memory_only() {
        // The Nix build sandbox sets HOME to an unwritable /homeless-shelter,
        // so a cache that treats disk write-through as fatal breaks the build.
        let mut store = ImageStore::new(PathBuf::from("/homeless-shelter/.cache/slick/images"));
        let url = "https://slack-imgs.com/?url=emoji";
        let entry = store
            .insert(url, png_header(64, 64))
            .expect("an unwritable cache is still a working cache");
        assert_eq!((entry.width, entry.height), (64, 64));
        assert!(store.get(url).is_some(), "the entry is served from memory");
        assert!(
            !store.write_errors().is_empty(),
            "the failure is recorded rather than silent"
        );
    }
}
