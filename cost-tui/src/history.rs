use std::collections::{BTreeMap, HashMap};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::model::{AccountId, AccountUsage, ChartPoint, RateSummary, WindowSpend, AGGREGATE_KEY};

const DOLLARS_PER_CREDIT: f64 = 0.01;
const HOUR_SECS: i64 = 60 * 60;
const DAY_SECS: i64 = 24 * HOUR_SECS;
const WEEK_SECS: i64 = 7 * DAY_SECS;
const TWENTY_EIGHT_DAYS_SECS: i64 = 28 * DAY_SECS;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct HistorySample {
    pub schema_version: u32,
    pub captured_at: i64,
    pub account: AccountId,
    pub credits_used: f64,
    pub entitlement: f64,
    pub remaining: f64,
    pub overage_count: f64,
    pub overage_entitlement: f64,
    pub reset_marker: String,
}

impl HistorySample {
    #[must_use]
    pub fn from_usage(usage: &AccountUsage) -> Option<Self> {
        let quota = usage.premium()?;
        if usage.error.is_some() || usage.refreshed_at <= 0 || !quota.credits_used.is_finite() {
            return None;
        }
        Some(Self {
            schema_version: 1,
            captured_at: usage.refreshed_at,
            account: usage.account.clone(),
            credits_used: quota.credits_used.max(0.0),
            entitlement: quota.entitlement.max(0.0),
            remaining: quota.remaining_value().max(0.0),
            overage_count: quota.overage_count.max(0.0),
            overage_entitlement: quota.overage_entitlement.max(0.0),
            reset_marker: quota.reset_marker(),
        })
    }

    #[must_use]
    pub fn account_key(&self) -> String {
        self.account.key()
    }
}

#[derive(Clone, Debug)]
pub struct HistoryStore {
    path: PathBuf,
}

impl HistoryStore {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn load(&self) -> Result<Vec<HistorySample>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let file = fs::File::open(&self.path)
            .with_context(|| format!("open Cost TUI history {}", self.path.display()))?;
        let mut samples = Vec::new();
        for (index, line) in BufReader::new(file).lines().enumerate() {
            let line = line.with_context(|| {
                format!("read Cost TUI history line {}", index.saturating_add(1))
            })?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<HistorySample>(&line) {
                Ok(sample) if sample.captured_at > 0 && sample.credits_used.is_finite() => {
                    samples.push(sample);
                }
                Ok(_) => eprintln!(
                    "cost-tui history: ignoring invalid numeric sample at {}:{}",
                    self.path.display(),
                    index.saturating_add(1)
                ),
                Err(error) => eprintln!(
                    "cost-tui history: ignoring malformed JSON at {}:{}: {error}",
                    self.path.display(),
                    index.saturating_add(1)
                ),
            }
        }
        sort_and_deduplicate(&mut samples);
        Ok(samples)
    }

    pub fn append(&self, samples: &[HistorySample]) -> Result<()> {
        if samples.is_empty() {
            return Ok(());
        }
        let parent = self
            .path
            .parent()
            .with_context(|| format!("history path has no parent: {}", self.path.display()))?;
        fs::create_dir_all(parent)
            .with_context(|| format!("create Cost TUI history directory {}", parent.display()))?;
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&self.path)
            .with_context(|| format!("open Cost TUI history {}", self.path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        for sample in samples {
            serde_json::to_writer(&mut file, sample)
                .context("serialize Cost TUI history sample")?;
            file.write_all(b"\n")?;
        }
        file.sync_data().context("sync Cost TUI history")?;
        Ok(())
    }

    pub fn compact(
        &self,
        samples: &[HistorySample],
        retention_days: u32,
        max_samples_per_account: usize,
        now: i64,
    ) -> Result<Vec<HistorySample>> {
        let retained = retain_samples(samples, retention_days, max_samples_per_account, now);
        let parent = self
            .path
            .parent()
            .with_context(|| format!("history path has no parent: {}", self.path.display()))?;
        fs::create_dir_all(parent)?;
        let temporary = self
            .path
            .with_extension(format!("jsonl.{}.tmp", std::process::id()));
        let mut options = OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .with_context(|| format!("create history compaction {}", temporary.display()))?;
        for sample in &retained {
            serde_json::to_writer(&mut file, sample)?;
            file.write_all(b"\n")?;
        }
        file.sync_all()?;
        fs::rename(&temporary, &self.path).with_context(|| {
            format!(
                "replace Cost TUI history {} with {}",
                self.path.display(),
                temporary.display()
            )
        })?;
        Ok(retained)
    }
}

pub fn append_new_samples(
    history: &mut Vec<HistorySample>,
    usages: &[AccountUsage],
) -> Vec<HistorySample> {
    let latest: HashMap<String, (&str, i64, f64)> = history
        .iter()
        .map(|sample| {
            (
                sample.account_key(),
                (
                    sample.reset_marker.as_str(),
                    sample.captured_at,
                    sample.credits_used,
                ),
            )
        })
        .collect();
    let mut added = Vec::new();
    for sample in usages.iter().filter_map(HistorySample::from_usage) {
        let duplicate =
            latest
                .get(&sample.account_key())
                .is_some_and(|(reset, captured_at, credits)| {
                    *reset == sample.reset_marker
                        && *captured_at == sample.captured_at
                        && (*credits - sample.credits_used).abs() < f64::EPSILON
                });
        if !duplicate {
            added.push(sample);
        }
    }
    history.extend(added.iter().cloned());
    sort_and_deduplicate(history);
    added
}

#[must_use]
pub fn retain_samples(
    samples: &[HistorySample],
    retention_days: u32,
    max_samples_per_account: usize,
    now: i64,
) -> Vec<HistorySample> {
    let cutoff = now.saturating_sub(i64::from(retention_days).saturating_mul(DAY_SECS));
    let mut grouped: BTreeMap<String, Vec<HistorySample>> = BTreeMap::new();
    for sample in samples.iter().filter(|sample| sample.captured_at >= cutoff) {
        grouped
            .entry(sample.account_key())
            .or_default()
            .push(sample.clone());
    }
    let mut retained = Vec::new();
    for mut account in grouped.into_values() {
        account.sort_by_key(|sample| sample.captured_at);
        if account.len() > max_samples_per_account {
            account.drain(..account.len() - max_samples_per_account);
        }
        retained.extend(account);
    }
    sort_and_deduplicate(&mut retained);
    retained
}

#[must_use]
pub fn summarize(
    samples: &[HistorySample],
    max_chart_points: usize,
    now: i64,
) -> (
    BTreeMap<String, Vec<ChartPoint>>,
    BTreeMap<String, RateSummary>,
) {
    let mut grouped: BTreeMap<String, Vec<&HistorySample>> = BTreeMap::new();
    for sample in samples {
        grouped
            .entry(sample.account_key())
            .or_default()
            .push(sample);
    }
    let mut series = BTreeMap::new();
    let mut rates = BTreeMap::new();
    for (key, mut account) in grouped {
        account.sort_by_key(|sample| sample.captured_at);
        series.insert(key.clone(), downsample(&account, max_chart_points));
        rates.insert(key, rate_summary(&account, now));
    }
    let aggregate = aggregate_rates(rates.values());
    rates.insert(AGGREGATE_KEY.into(), aggregate);
    (series, rates)
}

fn rate_summary(samples: &[&HistorySample], now: i64) -> RateSummary {
    let latest_sample_at = samples.last().map(|sample| sample.captured_at);
    let current = samples
        .windows(2)
        .rev()
        .find_map(|pair| valid_delta(pair[0], pair[1]));
    RateSummary {
        current_dollars_per_minute: current
            .map(|(credits, seconds)| credits * DOLLARS_PER_CREDIT * 60.0 / seconds as f64),
        current_interval_secs: current.map(|(_, seconds)| seconds),
        hour: window_spend(samples, now.saturating_sub(HOUR_SECS), now),
        day: window_spend(samples, now.saturating_sub(DAY_SECS), now),
        week: window_spend(samples, now.saturating_sub(WEEK_SECS), now),
        twenty_eight_days: window_spend(samples, now.saturating_sub(TWENTY_EIGHT_DAYS_SECS), now),
        calendar_month: window_spend(samples, month_start_epoch(now), now),
        sample_count: samples.len(),
        latest_sample_at,
    }
}

fn valid_delta(previous: &HistorySample, current: &HistorySample) -> Option<(f64, i64)> {
    let elapsed = current.captured_at.saturating_sub(previous.captured_at);
    if elapsed <= 0 || current.credits_used < previous.credits_used {
        return None;
    }
    if !previous.reset_marker.is_empty()
        && !current.reset_marker.is_empty()
        && previous.reset_marker != current.reset_marker
    {
        return None;
    }
    let credits = current.credits_used - previous.credits_used;
    credits.is_finite().then_some((credits, elapsed))
}

fn window_spend(samples: &[&HistorySample], start: i64, end: i64) -> WindowSpend {
    let mut dollars = 0.0;
    for pair in samples.windows(2) {
        let previous = pair[0];
        let current = pair[1];
        let Some((credits, elapsed)) = valid_delta(previous, current) else {
            continue;
        };
        let overlap_start = previous.captured_at.max(start);
        let overlap_end = current.captured_at.min(end);
        let overlap = overlap_end.saturating_sub(overlap_start);
        if overlap > 0 {
            dollars +=
                credits * DOLLARS_PER_CREDIT * (overlap as f64 / elapsed as f64).clamp(0.0, 1.0);
        }
    }
    let first = samples.first().map_or(end, |sample| sample.captured_at);
    let latest = samples.last().map_or(start, |sample| sample.captured_at);
    WindowSpend {
        dollars,
        covered_secs: latest.min(end).saturating_sub(first.max(start)).max(0),
        complete: first <= start && latest >= end.saturating_sub(15 * 60),
    }
}

fn aggregate_rates<'a>(summaries: impl Iterator<Item = &'a RateSummary>) -> RateSummary {
    let values: Vec<_> = summaries.collect();
    let current_rates = values
        .iter()
        .filter_map(|value| value.current_dollars_per_minute)
        .collect::<Vec<_>>();
    RateSummary {
        current_dollars_per_minute: (!current_rates.is_empty())
            .then(|| current_rates.into_iter().sum()),
        current_interval_secs: values
            .iter()
            .filter_map(|value| value.current_interval_secs)
            .max(),
        hour: aggregate_window(values.iter().map(|value| &value.hour)),
        day: aggregate_window(values.iter().map(|value| &value.day)),
        week: aggregate_window(values.iter().map(|value| &value.week)),
        twenty_eight_days: aggregate_window(values.iter().map(|value| &value.twenty_eight_days)),
        calendar_month: aggregate_window(values.iter().map(|value| &value.calendar_month)),
        sample_count: values.iter().map(|value| value.sample_count).sum(),
        latest_sample_at: values
            .iter()
            .filter_map(|value| value.latest_sample_at)
            .max(),
    }
}

fn aggregate_window<'a>(windows: impl Iterator<Item = &'a WindowSpend>) -> WindowSpend {
    let values: Vec<_> = windows.collect();
    WindowSpend {
        dollars: values.iter().map(|value| value.dollars).sum(),
        covered_secs: values
            .iter()
            .map(|value| value.covered_secs)
            .min()
            .unwrap_or(0),
        complete: !values.is_empty() && values.iter().all(|value| value.complete),
    }
}

fn downsample(samples: &[&HistorySample], maximum: usize) -> Vec<ChartPoint> {
    if maximum == 0 || samples.is_empty() {
        return Vec::new();
    }
    if samples.len() <= maximum {
        return samples
            .iter()
            .map(|sample| ChartPoint {
                captured_at: sample.captured_at,
                credits_used: sample.credits_used,
            })
            .collect();
    }
    let last = samples.len() - 1;
    let divisor = maximum.saturating_sub(1).max(1);
    (0..maximum)
        .map(|index| {
            let source = index.saturating_mul(last) / divisor;
            let sample = samples[source];
            ChartPoint {
                captured_at: sample.captured_at,
                credits_used: sample.credits_used,
            }
        })
        .collect()
}

fn sort_and_deduplicate(samples: &mut Vec<HistorySample>) {
    samples.sort_by(|left, right| {
        left.account_key()
            .cmp(&right.account_key())
            .then_with(|| left.captured_at.cmp(&right.captured_at))
    });
    samples.dedup_by(|left, right| {
        left.account == right.account
            && left.captured_at == right.captured_at
            && (left.credits_used - right.credits_used).abs() < f64::EPSILON
            && left.reset_marker == right.reset_marker
    });
}

/// Gregorian month start without pulling a timezone/runtime dependency. Usage
/// snapshots are UTC, so calendar-month-to-date is intentionally UTC.
fn month_start_epoch(timestamp: i64) -> i64 {
    let days = timestamp.div_euclid(DAY_SECS);
    let (year, month, _) = civil_from_days(days);
    days_from_civil(year, month, 1).saturating_mul(DAY_SECS)
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(at: i64, used: f64, reset: &str) -> HistorySample {
        HistorySample {
            schema_version: 1,
            captured_at: at,
            account: AccountId {
                login: "one".into(),
                host: "github.com".into(),
            },
            credits_used: used,
            entitlement: 50_000_000.0,
            remaining: 50_000_000.0 - used,
            overage_count: 0.0,
            overage_entitlement: 0.0,
            reset_marker: reset.into(),
        }
    }

    #[test]
    fn newest_pair_produces_exact_per_minute_rate() {
        let values = [sample(1_000, 10_000.0, "a"), sample(1_300, 16_000.0, "a")];
        let refs = values.iter().collect::<Vec<_>>();
        let summary = rate_summary(&refs, 1_300);
        assert_eq!(summary.current_interval_secs, Some(300));
        assert!((summary.current_dollars_per_minute.unwrap() - 12.0).abs() < 0.000_001);
    }

    #[test]
    fn reset_never_creates_negative_or_cross_cycle_spend() {
        let values = [
            sample(1_000, 40_000.0, "a"),
            sample(1_300, 1_000.0, "b"),
            sample(1_600, 2_000.0, "b"),
        ];
        let refs = values.iter().collect::<Vec<_>>();
        let summary = rate_summary(&refs, 1_600);
        assert!((summary.current_dollars_per_minute.unwrap() - 2.0).abs() < 0.000_001);
        assert!(summary.hour.dollars >= 10.0 && summary.hour.dollars < 10.01);
    }

    #[test]
    fn calendar_conversion_finds_known_month_start() {
        // 2024-03-15T00:00:00Z -> 2024-03-01T00:00:00Z.
        assert_eq!(month_start_epoch(1_710_460_800), 1_709_251_200);
    }

    #[test]
    fn jsonl_store_round_trips_owner_only_and_compacts() {
        let root = std::env::temp_dir().join(format!(
            "cost-tui-history-test-{}-{}",
            std::process::id(),
            remote_cli::unix_now()
        ));
        let store = HistoryStore::new(root.join("history.jsonl"));
        let values = vec![sample(100, 1.0, "a"), sample(200, 2.0, "a")];
        store.append(&values).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.len(), 2);
        std::fs::OpenOptions::new()
            .append(true)
            .open(store.path())
            .unwrap()
            .write_all(b"not-json\n")
            .unwrap();
        assert_eq!(store.load().unwrap().len(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(store.path())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        let retained = store.compact(&loaded, 28, 1, 200).unwrap();
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].captured_at, 200);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn downsample_preserves_first_and_last() {
        let values = (0..100)
            .map(|index| sample(index, index as f64, "a"))
            .collect::<Vec<_>>();
        let refs = values.iter().collect::<Vec<_>>();
        let points = downsample(&refs, 10);
        assert_eq!(points.first().unwrap().captured_at, 0);
        assert_eq!(points.last().unwrap().captured_at, 99);
    }
}
