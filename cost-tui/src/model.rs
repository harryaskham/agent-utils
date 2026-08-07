use std::collections::BTreeMap;

use remote_cli::Snapshot;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const AGGREGATE_KEY: &str = "__aggregate__";

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize, JsonSchema)]
pub struct AccountId {
    pub login: String,
    pub host: String,
}

impl AccountId {
    #[must_use]
    pub fn key(&self) -> String {
        format!("{}@{}", self.login, self.host)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(default)]
pub struct Quota {
    #[serde(rename = "quota_id")]
    pub id: String,
    pub credits_used: f64,
    pub entitlement: f64,
    pub remaining: f64,
    #[serde(rename = "quota_remaining")]
    pub available: f64,
    pub percent_remaining: f64,
    pub overage_count: f64,
    pub overage_entitlement: f64,
    pub overage_permitted: bool,
    pub unlimited: bool,
    pub token_based_billing: bool,
    pub timestamp_utc: String,
    #[serde(rename = "quota_reset_at")]
    #[schemars(with = "String")]
    pub reset_at: Value,
}

impl Quota {
    #[must_use]
    pub fn remaining_value(&self) -> f64 {
        if self.available > 0.0 || self.remaining == 0.0 {
            self.available
        } else {
            self.remaining
        }
    }

    #[must_use]
    pub fn percent_left(&self) -> f64 {
        if self.percent_remaining > 0.0 || self.entitlement <= 0.0 {
            self.percent_remaining.clamp(0.0, 100.0)
        } else {
            (self.remaining_value() / self.entitlement * 100.0).clamp(0.0, 100.0)
        }
    }

    #[must_use]
    pub fn used_ratio(&self) -> f64 {
        if self.unlimited || self.entitlement <= 0.0 {
            0.0
        } else {
            (self.credits_used / self.entitlement).clamp(0.0, 1.0)
        }
    }

    #[must_use]
    pub fn reset_label(&self) -> String {
        match &self.reset_at {
            Value::String(value) if !value.is_empty() => value.split_once('T').map_or_else(
                || value.chars().take(19).collect(),
                |(date, time)| format!("{} {}", date, time.chars().take(8).collect::<String>()),
            ),
            Value::Number(value) if value.as_i64().unwrap_or(0) > 0 => {
                format!("epoch {value}")
            }
            _ => "billing cycle".into(),
        }
    }

    #[must_use]
    pub fn reset_marker(&self) -> String {
        match &self.reset_at {
            Value::String(value) if !value.is_empty() => value.clone(),
            Value::Number(value) => value.to_string(),
            _ if !self.timestamp_utc.is_empty() => self
                .timestamp_utc
                .get(..7)
                .unwrap_or(&self.timestamp_utc)
                .to_string(),
            _ => String::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(default)]
pub struct AccountUsage {
    pub account: AccountId,
    pub login: String,
    pub plan: String,
    pub sku: String,
    pub assigned_date: String,
    pub quotas: BTreeMap<String, Quota>,
    pub refreshed_at: i64,
    pub error: Option<String>,
}

impl AccountUsage {
    #[must_use]
    pub fn loading(account: AccountId) -> Self {
        Self {
            login: account.login.clone(),
            account,
            ..Self::default()
        }
    }

    #[must_use]
    pub fn premium(&self) -> Option<&Quota> {
        self.quotas
            .get("premium_interactions")
            .or_else(|| self.quotas.get("ai_credits"))
    }

    #[must_use]
    pub fn online(&self) -> bool {
        self.error.is_none() && self.premium().is_some()
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(default)]
pub struct ChartPoint {
    pub captured_at: i64,
    pub credits_used: f64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(default)]
pub struct WindowSpend {
    pub dollars: f64,
    pub covered_secs: i64,
    pub complete: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(default)]
pub struct RateSummary {
    pub current_dollars_per_minute: Option<f64>,
    pub current_interval_secs: Option<i64>,
    pub hour: WindowSpend,
    pub day: WindowSpend,
    pub week: WindowSpend,
    pub twenty_eight_days: WindowSpend,
    pub calendar_month: WindowSpend,
    pub sample_count: usize,
    pub latest_sample_at: Option<i64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(default)]
pub struct CollectorHealth {
    pub running: bool,
    pub current_domain: Option<String>,
    pub last_attempt_at: Option<i64>,
    pub last_success_at: Option<i64>,
    pub next_attempt_at: Option<i64>,
    pub successful_accounts: usize,
    pub total_accounts: usize,
    pub last_error: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(default)]
pub struct CostState {
    pub schema_version: u32,
    pub revision: u64,
    pub saved_at: Option<i64>,
    pub usages: Vec<AccountUsage>,
    /// Bounded, daemon-produced graph series suitable for cache/SSE clients.
    pub series: BTreeMap<String, Vec<ChartPoint>>,
    /// Per-account summaries plus [`AGGREGATE_KEY`].
    pub rates: BTreeMap<String, RateSummary>,
    pub collector: CollectorHealth,
}

impl Default for CostState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            saved_at: None,
            usages: Vec::new(),
            series: BTreeMap::new(),
            rates: BTreeMap::new(),
            collector: CollectorHealth::default(),
        }
    }
}

impl CostState {
    #[must_use]
    pub fn now() -> i64 {
        remote_cli::unix_now()
    }

    pub fn normalize(&mut self) {
        self.schema_version = 1;
        self.usages.sort_by(|left, right| {
            host_rank(&left.account.host)
                .cmp(&host_rank(&right.account.host))
                .then_with(|| left.account.host.cmp(&right.account.host))
                .then_with(|| left.account.login.cmp(&right.account.login))
        });
        self.usages
            .dedup_by(|left, right| left.account == right.account);
        for points in self.series.values_mut() {
            points.sort_by_key(|point| point.captured_at);
            points.dedup_by(|left, right| {
                left.captured_at == right.captured_at
                    && (left.credits_used - right.credits_used).abs() < f64::EPSILON
            });
        }
    }
}

impl Snapshot for CostState {
    const APP_NAME: &'static str = "cost-tui";
    const DISPLAY_NAME: &'static str = "Cost TUI";
    const CACHE_DIR_ENV: &'static str = "COST_TUI_CACHE_DIR";

    fn normalize(&mut self) {
        Self::normalize(self);
    }

    fn revision(&self) -> u64 {
        self.revision
    }

    fn set_revision(&mut self, revision: u64) {
        self.revision = revision;
    }

    fn saved_at(&self) -> Option<i64> {
        self.saved_at
    }

    fn set_saved_at(&mut self, saved_at: Option<i64>) {
        self.saved_at = saved_at;
    }

    fn latest_refresh(&self) -> Option<i64> {
        self.collector.last_success_at.or_else(|| {
            self.usages
                .iter()
                .map(|usage| usage.refreshed_at)
                .filter(|timestamp| *timestamp > 0)
                .max()
        })
    }
}

#[must_use]
pub fn host_rank(host: &str) -> u8 {
    u8::from(host != "github.com")
}
