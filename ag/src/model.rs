use crate::speech::{MuteReceipt, SpeechKind};
use mcp_cli::JsonError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
/// Songs and long recordings (e.g. ~25 minutes of 48 kHz stereo WAV).
pub const MAX_AUDIO_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_ITEMS: usize = 1000;

/// Durable shared-artifact archives. Both use the same producer contract:
/// `<root>/<agent>/<file>` plus an atomically published `<file>.json` sidecar.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    JsonSchema,
    clap::ValueEnum,
)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Audio,
}
impl MediaKind {
    pub const ALL: [Self; 2] = [Self::Image, Self::Audio];
    pub fn name(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Audio => "audio",
        }
    }
    /// Human plural for receipts, e.g. "3 images" / "3 clips".
    pub fn plural(self) -> &'static str {
        match self {
            Self::Image => "images",
            Self::Audio => "clips",
        }
    }
    pub fn max_bytes(self) -> usize {
        match self {
            Self::Image => MAX_IMAGE_BYTES,
            Self::Audio => MAX_AUDIO_BYTES,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct SpeechRecord {
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub session: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    pub text: String,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, Value>,
}

/// One registered image or audio sidecar. Audio sidecars may add optional
/// `title`, `description`, `durationMs`, `sampleRate` and `channels`, retained
/// in `extra`.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct MediaRecord {
    pub version: u32,
    pub id: String,
    pub sha256: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub bytes: u64,
    pub timestamp: String,
    pub agent: String,
    #[serde(default)]
    pub session: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub source: Value,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, Value>,
}

pub type ImageRecord = MediaRecord;
pub type AudioRecord = MediaRecord;
impl MediaRecord {
    pub fn label(&self) -> &str {
        self.source
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("")
    }
    pub fn text(&self, key: &str) -> Option<&str> {
        self.extra
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
    }
    pub fn number(&self, key: &str) -> Option<u64> {
        self.extra.get(key).and_then(|v| v.as_u64())
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Cursor {
    pub device: u64,
    pub inode: u64,
    pub offset: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Listing<T> {
    pub records: Vec<T>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub truncated: bool,
}
impl<T> Default for Listing<T> {
    fn default() -> Self {
        Self {
            records: vec![],
            warnings: vec![],
            truncated: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct NodeListing<T> {
    pub host: String,
    pub data: Option<Listing<T>>,
    pub error: Option<JsonError>,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct FleetListing<T> {
    pub hosts: Vec<NodeListing<T>>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TailEvent {
    Speech {
        record: SpeechRecord,
        cursor: Cursor,
    },
    Checkpoint {
        cursor: Cursor,
    },
    Status {
        state: String,
        message: String,
    },
}
impl TailEvent {
    pub fn cursor(&self) -> Option<Cursor> {
        match self {
            Self::Speech { cursor, .. } | Self::Checkpoint { cursor } => Some(*cursor),
            Self::Status { .. } => None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct FleetEvent {
    pub host: String,
    #[serde(flatten)]
    pub event: TailEvent,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct Selection {
    pub hosts: Vec<String>,
    pub local: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct ListInput {
    #[serde(flatten)]
    pub selection: Selection,
    pub limit: usize,
    pub agent: Option<String>,
}
impl Default for ListInput {
    fn default() -> Self {
        Self {
            selection: Selection::default(),
            limit: 20,
            agent: None,
        }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct SpeechControlInput {
    #[serde(flatten)]
    pub selection: Selection,
    /// Empty means all four types. Other types retain their state.
    pub kinds: Vec<SpeechKind>,
    /// Required for MCP mutations; the explicit CLI command supplies this.
    pub confirmed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SpeechDisposition {
    Observed,
    Applied,
    Error,
    Unconfirmed,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct NodeSpeechControl {
    pub host: String,
    pub disposition: SpeechDisposition,
    pub data: Option<MuteReceipt>,
    pub error: Option<JsonError>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct FleetSpeechControl {
    pub hosts: Vec<NodeSpeechControl>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MediaInput {
    #[serde(flatten)]
    pub selection: Selection,
    pub id: String,
}
pub type ImageInput = MediaInput;
pub type AudioInput = MediaInput;
