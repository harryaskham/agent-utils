use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::cache::CacheStore;
use crate::config::{CollectorConfig, WorkIqConfig};
use crate::model::{CacheState, RefreshState};
use crate::service::WorkIqService;
use crate::workiq::WorkIqClient;

const CONTINUE_SECS: i64 = 2;
const MAX_FAILURE_BACKOFF_SECS: i64 = 30 * 60;
const WORKIQ_RECONNECT_COOLDOWN: Duration = Duration::from_secs(30 * 60);

pub type SharedCache = remote_cli::SharedSnapshot<CacheState>;

#[derive(Clone, Debug)]
pub struct DaemonOptions {
    pub cache_store: CacheStore,
    pub bind: String,
    pub unix_socket: Option<PathBuf>,
    pub token_path: PathBuf,
    pub min_refresh_secs: u64,
    pub workiq: WorkIqConfig,
    pub collector: CollectorConfig,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RefreshKind {
    Identity,
    Mail(String),
    Calendar,
    Chats,
    ChatMessages(String),
    Teams,
    ChannelMessages { team_id: String, channel_id: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RefreshTask {
    key: String,
    kind: RefreshKind,
    interval_secs: i64,
    priority: i64,
}

pub fn run(options: DaemonOptions) -> Result<()> {
    let token = remote_cli::load_or_create_token(&options.token_path)?;
    let mut initial = options.cache_store.load().unwrap_or_default();
    if initial.is_demo_fixture() {
        eprintln!("annum daemon: discarding legacy demo fixture from durable cache");
        initial = CacheState::default();
        options.cache_store.save(&initial)?;
    }
    initial.collector.running = true;
    initial.collector.last_error.clear();
    let shared = Arc::new(SharedCache::new(initial, options.cache_store));
    let service = WorkIqService::new(WorkIqClient::start(&options.workiq)?);
    let server = start_snapshot_server(
        &options.bind,
        options.unix_socket.clone(),
        Arc::clone(&shared),
        token,
        options.collector.clone(),
        service.clone(),
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
        "annum daemon: serving authenticated snapshots at {endpoints} (token file {})",
        options.token_path.display()
    );
    shared.update(|state| state.collector.running = true);
    let spacing = Duration::from_secs(options.min_refresh_secs.max(1));
    let mut last_workiq_reconnect = None;

    loop {
        let snapshot = shared.snapshot();
        let requested = shared
            .take_refresh_request()
            .and_then(|domain| requested_task(&snapshot, &options.collector, &domain));
        let Some(task) = requested.or_else(|| select_task(&snapshot, &options.collector)) else {
            thread::sleep(Duration::from_secs(1));
            continue;
        };
        execute_task(
            &shared,
            &service,
            &options.workiq,
            &options.collector,
            task,
            &mut last_workiq_reconnect,
        );
        thread::sleep(spacing);
    }
}

pub fn sync_once(
    store: &CacheStore,
    workiq: &WorkIqConfig,
    collector: &CollectorConfig,
) -> Result<CacheState> {
    let service = WorkIqService::new(WorkIqClient::start(workiq)?);
    let mut state = store.load().unwrap_or_default();
    service.refresh_identity(&mut state)?;
    // Advance bounded pages. Repeated invocations continue from durable cursors.
    let _ = service.refresh_mail_folder(&mut state, "inbox", collector.mail_backfill_days)?;
    let _ = service.refresh_mail_folder(&mut state, "sentitems", collector.mail_backfill_days)?;
    service.refresh_calendar_view(
        &mut state,
        collector.calendar_past_days,
        collector.calendar_future_days,
    )?;
    service.refresh_chats(&mut state)?;
    for chat_id in state
        .chats
        .iter()
        .take(collector.max_chats_per_cycle)
        .map(|chat| chat.id.clone())
        .collect::<Vec<_>>()
    {
        let _ = service.refresh_chat_messages(&mut state, &chat_id)?;
    }
    if collector.include_teams_channels {
        service.refresh_teams(&mut state)?;
    }
    state.normalize();
    store.save(&state)?;
    Ok(state)
}

fn execute_task(
    shared: &SharedCache,
    service: &WorkIqService,
    workiq: &WorkIqConfig,
    collector: &CollectorConfig,
    task: RefreshTask,
    last_workiq_reconnect: &mut Option<Instant>,
) {
    let started = CacheState::now();
    shared.update(|state| {
        state.collector.current_domain = Some(task.key.clone());
        state.collector.last_cycle_at = Some(started);
        let health = state.domain_health_mut(&task.key);
        health.state = RefreshState::Refreshing;
        health.last_attempt_at = Some(started);
        health.detail = format!("refreshing {}", task_label(&task.kind));
    });
    let mut working = shared.snapshot();
    let mut result = run_task(service, &mut working, collector, &task.kind);
    let reconnect_due = result.as_ref().is_err_and(missing_remote_fetch_tool)
        && last_workiq_reconnect.is_none_or(|last| last.elapsed() >= WORKIQ_RECONNECT_COOLDOWN);
    if reconnect_due {
        *last_workiq_reconnect = Some(Instant::now());
        eprintln!(
            "annum daemon: WorkIQ remote fetch tool is unavailable; restarting the persistent MCP child once"
        );
        match WorkIqClient::start(workiq) {
            Ok(client) => {
                service.replace_client(client);
                working = shared.snapshot();
                result = run_task(service, &mut working, collector, &task.kind);
            }
            Err(error) => {
                result = Err(error.context("restart WorkIQ MCP after missing fetch tool"));
            }
        }
    }
    let finished = CacheState::now();
    shared.replace_payload(working, |state, current| {
        state.collector = current.collector.clone();
        state.collector.current_domain = None;
        state.collector.last_cycle_at = Some(finished);
        let health = state.domain_health_mut(&task.key);
        match &result {
            Ok(complete) => {
                health.state = if *complete {
                    RefreshState::Healthy
                } else {
                    RefreshState::Partial
                };
                if *complete {
                    health.last_success_at = Some(finished);
                }
                health.next_attempt_at = Some(finished.saturating_add(if *complete {
                    task.interval_secs
                } else {
                    CONTINUE_SECS
                }));
                health.consecutive_failures = 0;
                health.detail = if *complete {
                    format!("complete {}", task_label(&task.kind))
                } else {
                    format!(
                        "backfill/delta page retained for {}",
                        task_label(&task.kind)
                    )
                };
                state.collector.last_error.clear();
            }
            Err(error) => {
                let failures = health.consecutive_failures.saturating_add(1);
                health.consecutive_failures = failures;
                health.state = RefreshState::Error;
                health.next_attempt_at = Some(finished.saturating_add(failure_backoff(failures)));
                health.detail = format!("{error:#}");
                state.collector.last_error = format!("{}: {error:#}", task.key);
            }
        }
    });
    match result {
        Ok(true) => eprintln!("annum daemon: complete domain={}", task.key),
        Ok(false) => eprintln!(
            "annum daemon: progress domain={} next={}s",
            task.key, CONTINUE_SECS
        ),
        Err(error) => eprintln!("annum daemon: failed domain={} error={error:#}", task.key),
    }
}

fn run_task(
    service: &WorkIqService,
    state: &mut CacheState,
    collector: &CollectorConfig,
    kind: &RefreshKind,
) -> Result<bool> {
    match kind {
        RefreshKind::Identity => service.refresh_identity(state).map(|()| true),
        RefreshKind::Mail(folder) => {
            service.refresh_mail_folder(state, folder, collector.mail_backfill_days)
        }
        RefreshKind::Calendar => service
            .refresh_calendar_view(
                state,
                collector.calendar_past_days,
                collector.calendar_future_days,
            )
            .map(|()| true),
        RefreshKind::Chats => service.refresh_chats(state).map(|()| true),
        RefreshKind::ChatMessages(chat_id) => service.refresh_chat_messages(state, chat_id),
        RefreshKind::Teams => service.refresh_teams(state).map(|()| true),
        RefreshKind::ChannelMessages {
            team_id,
            channel_id,
        } => service.refresh_channel_messages(state, team_id, channel_id),
    }
}

fn select_task(state: &CacheState, config: &CollectorConfig) -> Option<RefreshTask> {
    let now = CacheState::now();
    let mut tasks = all_tasks(state, config);
    tasks.retain(|task| {
        state
            .collector
            .domains
            .get(&task.key)
            .and_then(|health| health.next_attempt_at)
            .is_none_or(|next| next <= now)
    });
    tasks.into_iter().max_by_key(|task| {
        let last = state
            .collector
            .domains
            .get(&task.key)
            .and_then(|health| health.last_success_at)
            .or_else(|| state.last_refresh.get(&task.key).copied())
            .unwrap_or(0);
        now.saturating_sub(last)
            .saturating_mul(100)
            .saturating_add(task.priority)
    })
}

fn all_tasks(state: &CacheState, config: &CollectorConfig) -> Vec<RefreshTask> {
    let mut tasks = vec![
        task(
            "identity",
            RefreshKind::Identity,
            config.identity_refresh_secs,
            100,
        ),
        task(
            "mail:inbox",
            RefreshKind::Mail("inbox".into()),
            config.mail_refresh_secs,
            90,
        ),
        task(
            "mail:sentitems",
            RefreshKind::Mail("sentitems".into()),
            config.mail_refresh_secs.saturating_mul(2),
            45,
        ),
        task(
            "calendar",
            RefreshKind::Calendar,
            config.calendar_refresh_secs,
            85,
        ),
        task("chats", RefreshKind::Chats, config.chats_refresh_secs, 88),
    ];
    tasks.extend(
        state
            .chats
            .iter()
            .take(config.max_chats_per_cycle)
            .map(|chat| {
                task(
                    &format!("chat:{}", chat.id),
                    RefreshKind::ChatMessages(chat.id.clone()),
                    config.chats_refresh_secs,
                    82,
                )
            }),
    );
    if config.include_teams_channels {
        tasks.push(task(
            "teams",
            RefreshKind::Teams,
            config.teams_refresh_secs,
            55,
        ));
        for (team_id, channels) in &state.channels {
            tasks.extend(channels.iter().map(|channel| {
                task(
                    &format!("channel:{team_id}:{}", channel.id),
                    RefreshKind::ChannelMessages {
                        team_id: team_id.clone(),
                        channel_id: channel.id.clone(),
                    },
                    config.teams_refresh_secs,
                    50,
                )
            }));
        }
    }
    if state.account.id.is_empty() {
        tasks.retain(|task| task.key == "identity");
    }
    tasks
}

fn requested_task(
    state: &CacheState,
    config: &CollectorConfig,
    domain: &str,
) -> Option<RefreshTask> {
    all_tasks(state, config)
        .into_iter()
        .find(|task| task.key == domain)
}

fn task(key: &str, kind: RefreshKind, interval_secs: u64, priority: i64) -> RefreshTask {
    RefreshTask {
        key: key.into(),
        kind,
        interval_secs: i64::try_from(interval_secs).unwrap_or(i64::MAX),
        priority,
    }
}

fn task_label(kind: &RefreshKind) -> &'static str {
    match kind {
        RefreshKind::Identity => "identity",
        RefreshKind::Mail(_) => "mail delta",
        RefreshKind::Calendar => "calendar view",
        RefreshKind::Chats => "chat inventory",
        RefreshKind::ChatMessages(_) => "chat messages",
        RefreshKind::Teams => "team/channel inventory",
        RefreshKind::ChannelMessages { .. } => "channel messages",
    }
}

fn missing_remote_fetch_tool(error: &anyhow::Error) -> bool {
    let detail = format!("{error:#}");
    detail.contains("Unknown tool: 'fetch'") || detail.contains("Unknown tool: \"fetch\"")
}

fn failure_backoff(failures: u32) -> i64 {
    (10_i64.saturating_mul(1_i64 << failures.saturating_sub(1).min(10)))
        .min(MAX_FAILURE_BACKOFF_SECS)
}

fn start_snapshot_server(
    bind: &str,
    unix_socket: Option<PathBuf>,
    shared: Arc<SharedCache>,
    token: String,
    collector: CollectorConfig,
    service: WorkIqService,
) -> Result<remote_cli::ServerHandle> {
    let mut options = remote_cli::ServerOptions::new(shared, token);
    options.bind = (!bind.is_empty()).then(|| bind.to_string());
    options.unix_socket = unix_socket;
    let validator_config = collector.clone();
    options.refresh_validator =
        Arc::new(move |state, domain| requested_task(state, &validator_config, domain).is_some());
    options.health_projector = Some(Arc::new(|state| {
        remote_cli::ProjectedResponse::json(&state.collector)
            .expect("collector health is serializable")
    }));
    options.command_handler = Some(Arc::new(move |operation, input| {
        let confirmed = input
            .get("confirmed")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        if matches!(operation, "create_entity" | "update_entity" | "do_action") && !confirmed {
            return Err("confirmation required for Microsoft 365 mutation".into());
        }
        if !matches!(
            operation,
            "ask" | "retrieve" | "create_entity" | "update_entity" | "do_action"
        ) {
            return Err(format!("unsupported Annum daemon operation: {operation}"));
        }
        let arguments = input
            .get("arguments")
            .cloned()
            .ok_or_else(|| "daemon command is missing arguments".to_string())?;
        service
            .client()
            .call(operation, arguments)
            .map_err(|error| format!("{error:#}"))
    }));
    options.projector = Some(Arc::new(|state, route, _path| {
        let mut projected = state.clone();
        match route {
            "/snapshot/email" => {
                projected.events.clear();
                projected.chats.clear();
                projected.chat_messages.clear();
                projected.teams.clear();
                projected.channels.clear();
                projected.channel_messages.clear();
            }
            "/snapshot/calendar" => {
                projected.mail.clear();
                projected.chats.clear();
                projected.chat_messages.clear();
                projected.teams.clear();
                projected.channels.clear();
                projected.channel_messages.clear();
            }
            "/snapshot/chats" => {
                projected.mail.clear();
                projected.events.clear();
                projected.teams.clear();
                projected.channels.clear();
                projected.channel_messages.clear();
            }
            "/snapshot/teams" => {
                projected.mail.clear();
                projected.events.clear();
                projected.chats.clear();
                projected.chat_messages.clear();
            }
            _ => return None,
        }
        remote_cli::ProjectedResponse::json(&projected).ok()
    }));
    remote_cli::start_server(options)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Channel, Chat};

    #[test]
    fn missing_identity_is_the_only_initial_task() {
        let tasks = all_tasks(&CacheState::default(), &CollectorConfig::default());
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].kind, RefreshKind::Identity);
    }

    #[test]
    fn inventory_expands_into_chat_and_channel_deltas() {
        let mut state = CacheState::default();
        state.account.id = "me".into();
        state.chats.push(Chat {
            id: "c1".into(),
            ..Chat::default()
        });
        state.channels.insert(
            "t1".into(),
            vec![Channel {
                id: "ch1".into(),
                team_id: "t1".into(),
                ..Channel::default()
            }],
        );
        let tasks = all_tasks(&state, &CollectorConfig::default());
        assert!(tasks.iter().any(|task| task.key == "chat:c1"));
        assert!(tasks.iter().any(|task| task.key == "channel:t1:ch1"));
    }

    #[test]
    fn missing_fetch_tool_is_reconnectable_but_other_errors_are_not() {
        assert!(missing_remote_fetch_tool(&anyhow::anyhow!(
            "Mcp error: -32602: Unknown tool: 'fetch'"
        )));
        assert!(!missing_remote_fetch_tool(&anyhow::anyhow!("network down")));
    }

    #[test]
    fn failure_backoff_is_bounded() {
        assert_eq!(failure_backoff(1), 10);
        assert_eq!(failure_backoff(2), 20);
        assert_eq!(failure_backoff(100), MAX_FAILURE_BACKOFF_SECS);
    }
}
