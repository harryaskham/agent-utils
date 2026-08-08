use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::Result;

use crate::cache::CacheStore;
use crate::collector::fetch_all;
use crate::config::HistoryConfig;
use crate::history::{append_new_samples, summarize, HistorySample, HistoryStore};
use crate::model::{AccountId, AccountUsage, CostState};

pub type SharedCache = remote_cli::SharedSnapshot<CostState>;

#[derive(Clone, Debug)]
pub struct DaemonOptions {
    pub cache_store: CacheStore,
    pub history_store: HistoryStore,
    pub accounts: Vec<AccountId>,
    pub refresh_secs: u64,
    pub min_refresh_secs: u64,
    pub history: HistoryConfig,
    pub bind: String,
    pub unix_socket: Option<PathBuf>,
    pub token_path: PathBuf,
}

pub fn run(options: &DaemonOptions) -> Result<()> {
    let token = remote_cli::load_or_create_token(&options.token_path)?;
    let mut history = options.history_store.load().unwrap_or_else(|error| {
        eprintln!("cost-tui daemon: history load failed: {error:#}");
        Vec::new()
    });
    let mut initial = options.cache_store.load().unwrap_or_default();
    ensure_accounts(&mut initial, &options.accounts);
    let (series, rates) = summarize(&history, options.history.chart_points, CostState::now());
    initial.series = series;
    initial.rates = rates;
    initial.collector.running = true;
    initial.collector.total_accounts = options.accounts.len();
    let shared = Arc::new(SharedCache::new(initial, options.cache_store.clone()));
    let server = start_snapshot_server(
        &options.bind,
        options.unix_socket.clone(),
        Arc::clone(&shared),
        token,
    )?;
    let endpoints = [
        server
            .http_address
            .map(|address| format!("http://{address}")),
        server
            .unix_socket
            .as_ref()
            .map(|path| format!("unix://{}", path.display())),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(", ");
    eprintln!(
        "cost-tui daemon: serving authenticated snapshots at {endpoints} (history {}, token {})",
        options.history_store.path().display(),
        options.token_path.display()
    );

    let cadence = i64::try_from(options.refresh_secs.max(10)).unwrap_or(i64::MAX);
    let poll = Duration::from_secs(options.min_refresh_secs.max(1));
    let mut next_attempt = 0_i64;
    let mut cycles = 0_u64;
    loop {
        let requested = shared.take_refresh_request().is_some();
        let now = CostState::now();
        if !requested && now < next_attempt {
            thread::sleep(poll);
            continue;
        }
        collect_cycle(&shared, options, &mut history);
        cycles = cycles.saturating_add(1);
        if cycles % options.history.compact_every_cycles == 0 {
            match options.history_store.compact(
                &history,
                options.history.retention_days,
                options.history.max_samples_per_account,
                CostState::now(),
            ) {
                Ok(retained) => history = retained,
                Err(error) => eprintln!("cost-tui daemon: history compaction failed: {error:#}"),
            }
        }
        next_attempt = CostState::now().saturating_add(cadence);
        shared.update(|state| state.collector.next_attempt_at = Some(next_attempt));
    }
}

pub fn sync_once(
    cache_store: &CacheStore,
    history_store: &HistoryStore,
    accounts: &[AccountId],
    history_config: &HistoryConfig,
) -> Result<CostState> {
    let mut history = history_store.load().unwrap_or_default();
    let incoming = fetch_all(accounts);
    let added = append_new_samples(&mut history, &incoming);
    history_store.append(&added)?;
    let mut state = cache_store.load().unwrap_or_default();
    merge_usages(&mut state.usages, incoming);
    let (series, rates) = summarize(&history, history_config.chart_points, CostState::now());
    state.series = series;
    state.rates = rates;
    state.collector.last_attempt_at = Some(CostState::now());
    state.collector.last_success_at = state
        .usages
        .iter()
        .filter(|usage| usage.online())
        .map(|usage| usage.refreshed_at)
        .max();
    state.collector.successful_accounts =
        state.usages.iter().filter(|usage| usage.online()).count();
    state.collector.total_accounts = accounts.len();
    state.revision = state.revision.saturating_add(1);
    state.saved_at = Some(CostState::now());
    state.normalize();
    cache_store.save_exact(&state)?;
    Ok(state)
}

fn collect_cycle(shared: &SharedCache, options: &DaemonOptions, history: &mut Vec<HistorySample>) {
    let started = CostState::now();
    shared.update(|state| {
        state.collector.running = true;
        state.collector.current_domain = Some("all".into());
        state.collector.last_attempt_at = Some(started);
        state.collector.total_accounts = options.accounts.len();
    });
    let incoming = fetch_all(&options.accounts);
    let successful = incoming.iter().filter(|usage| usage.online()).count();
    let errors = incoming
        .iter()
        .filter_map(|usage| {
            usage
                .error
                .as_deref()
                .map(|error| (usage.account.key(), error))
        })
        .map(|(account, error)| format!("{account}: {error}"))
        .collect::<Vec<_>>();
    let added = append_new_samples(history, &incoming);
    if let Err(error) = options.history_store.append(&added) {
        eprintln!("cost-tui daemon: history append failed: {error:#}");
    }
    let (series, rates) = summarize(history, options.history.chart_points, CostState::now());
    let finished = CostState::now();
    shared.update(|state| {
        merge_usages(&mut state.usages, incoming);
        state.series = series;
        state.rates = rates;
        state.collector.current_domain = None;
        state.collector.last_attempt_at = Some(started);
        if successful > 0 {
            state.collector.last_success_at = Some(finished);
        }
        state.collector.successful_accounts = successful;
        state.collector.total_accounts = options.accounts.len();
        state.collector.last_error = errors.join(" · ");
    });
    if errors.is_empty() {
        eprintln!(
            "cost-tui daemon: refreshed {successful}/{} accounts; appended {} history samples",
            options.accounts.len(),
            added.len()
        );
    } else {
        eprintln!(
            "cost-tui daemon: refreshed {successful}/{} accounts with {} failures: {}",
            options.accounts.len(),
            errors.len(),
            errors.join(" · ")
        );
    }
}

pub fn merge_usages(current: &mut Vec<AccountUsage>, incoming: Vec<AccountUsage>) {
    let previous: HashMap<_, _> = current
        .iter()
        .cloned()
        .map(|usage| (usage.account.key(), usage))
        .collect();
    *current = incoming
        .into_iter()
        .map(|mut usage| {
            if usage.error.is_some() {
                if let Some(old) = previous.get(&usage.account.key()) {
                    let error = usage.error.take();
                    let refreshed_at = usage.refreshed_at;
                    usage = old.clone();
                    usage.error = error;
                    usage.refreshed_at = refreshed_at;
                }
            }
            usage
        })
        .collect();
    current.sort_by(|left, right| {
        crate::model::host_rank(&left.account.host)
            .cmp(&crate::model::host_rank(&right.account.host))
            .then_with(|| left.account.host.cmp(&right.account.host))
            .then_with(|| left.account.login.cmp(&right.account.login))
    });
}

fn ensure_accounts(state: &mut CostState, accounts: &[AccountId]) {
    let existing: HashMap<_, _> = state
        .usages
        .drain(..)
        .map(|usage| (usage.account.key(), usage))
        .collect();
    state.usages = accounts
        .iter()
        .map(|account| {
            existing
                .get(&account.key())
                .cloned()
                .unwrap_or_else(|| AccountUsage::loading(account.clone()))
        })
        .collect();
    state.normalize();
}

fn start_snapshot_server(
    bind: &str,
    unix_socket: Option<PathBuf>,
    shared: Arc<SharedCache>,
    token: String,
) -> Result<remote_cli::ServerHandle> {
    let mut options = remote_cli::ServerOptions::new(shared, token);
    options.bind = (!bind.is_empty()).then(|| bind.to_string());
    options.unix_socket = unix_socket;
    options.refresh_validator = Arc::new(|_, domain| domain == "all");
    options.health_projector = Some(Arc::new(|state| {
        remote_cli::ProjectedResponse::json(&state.collector)
            .expect("collector health is serializable")
    }));
    remote_cli::start_server(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_refresh_preserves_last_good_quota() {
        let account = AccountId {
            login: "one".into(),
            host: "github.com".into(),
        };
        let mut current = vec![AccountUsage {
            account: account.clone(),
            login: "one".into(),
            plan: "enterprise".into(),
            refreshed_at: 10,
            quotas: [(
                "premium_interactions".into(),
                crate::model::Quota {
                    credits_used: 12.0,
                    ..crate::model::Quota::default()
                },
            )]
            .into_iter()
            .collect(),
            ..AccountUsage::default()
        }];
        merge_usages(
            &mut current,
            vec![AccountUsage {
                account,
                refreshed_at: 20,
                error: Some("offline".into()),
                ..AccountUsage::default()
            }],
        );
        assert!((current[0].premium().unwrap().credits_used - 12.0).abs() < f64::EPSILON);
        assert_eq!(current[0].error.as_deref(), Some("offline"));
        assert_eq!(current[0].refreshed_at, 20);
    }
}
