use mcp_cli::JsonError;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_ITEMS: usize = 1000;

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

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ImageRecord {
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
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ImageInput {
    #[serde(flatten)]
    pub selection: Selection,
    pub id: String,
}
