use crate::{
    Error, Result,
    config::{self, Config, Host},
    model::*,
    speech::{self, SpeechKind},
    store, transport,
};
use mcp_cli::{JsonError, McpServer, StdioServerConfig, ToolRouter};
use std::{path::PathBuf, time::Duration};
use tokio::{runtime::Runtime, sync::mpsc, task::JoinSet};
use tokio_util::sync::CancellationToken;

pub struct Service {
    pub config: Config,
    pub config_path: Option<PathBuf>,
    pub runtime: Runtime,
}
impl Service {
    pub fn new(config: Config, config_path: Option<PathBuf>) -> Result<Self> {
        Ok(Self {
            config,
            config_path,
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
        })
    }
    pub fn hosts(&self, selection: &Selection) -> Result<Vec<Host>> {
        if selection.local && !selection.hosts.is_empty() {
            return Err(Error::Invalid(
                "--local and --host cannot be combined".into(),
            ));
        }
        let mut hosts = if selection.local {
            vec![Host::local()]
        } else if selection.hosts.is_empty() {
            self.config
                .hosts
                .iter()
                .filter(|host| host.enabled)
                .cloned()
                .collect()
        } else {
            selection
                .hosts
                .iter()
                .map(|name| {
                    self.config
                        .hosts
                        .iter()
                        .find(|h| &h.name == name)
                        .cloned()
                        .ok_or_else(|| Error::Invalid(format!("unknown host: {name}")))
                })
                .collect::<Result<Vec<_>>>()?
        };
        hosts.sort_by(|a, b| a.name.cmp(&b.name));
        hosts.dedup_by(|a, b| a.name == b.name);
        for host in &mut hosts {
            host.paths = host.paths.over(&self.config.paths);
        }
        if hosts.is_empty() {
            return Err(Error::Invalid("no enabled hosts".into()));
        }
        Ok(hosts)
    }
    fn one_host(&self, selection: &Selection) -> Result<Host> {
        let mut hosts = self.hosts(selection)?;
        if hosts.len() != 1 {
            return Err(Error::Invalid(
                "select exactly one --host (or --local) for image get/info".into(),
            ));
        }
        Ok(hosts.remove(0))
    }
    pub fn speech_status(&self, selection: Selection) -> Result<FleetSpeechControl> {
        self.speech_control(selection, vec![], None)
    }
    pub fn speech_mute(&self, input: SpeechControlInput) -> Result<FleetSpeechControl> {
        if !input.confirmed {
            return Err(Error::Invalid("ag_tts_mute requires confirmed=true".into()));
        }
        self.speech_control(input.selection, input.kinds, Some(true))
    }
    pub fn speech_unmute(&self, input: SpeechControlInput) -> Result<FleetSpeechControl> {
        if !input.confirmed {
            return Err(Error::Invalid(
                "ag_tts_unmute requires confirmed=true".into(),
            ));
        }
        self.speech_control(input.selection, input.kinds, Some(false))
    }
    fn speech_control(
        &self,
        selection: Selection,
        kinds: Vec<SpeechKind>,
        muted: Option<bool>,
    ) -> Result<FleetSpeechControl> {
        let kinds = speech::selected_kinds(&kinds)?;
        let hosts = self.hosts(&selection)?;
        self.runtime.block_on(async {
            let mut jobs = JoinSet::new();
            for host in hosts {
                let config = self.config.clone();
                let kinds = kinds.clone();
                jobs.spawn(async move {
                    let result = if host.local {
                        match host.paths.mute() {
                            Ok(path) => {
                                blocking(move || match muted {
                                    Some(value) => speech::set_muted(&path, &kinds, value),
                                    None => speech::read_state(&path),
                                })
                                .await
                            }
                            Err(error) => Err(error),
                        }
                    } else {
                        let action = match muted {
                            Some(true) => "tts-mute",
                            Some(false) => "tts-unmute",
                            None => "tts-status",
                        };
                        let mut args = vec!["node".into(), action.into()];
                        if let Some(path) = &host.paths.tts_mute {
                            args.extend(["--path".into(), path.clone()]);
                        }
                        if muted.is_some() {
                            for kind in kinds {
                                args.extend(["--kind".into(), kind.name().into()]);
                            }
                        }
                        transport::query(&config, &host, &args).await
                    };
                    match result {
                        Ok(data) => NodeSpeechControl {
                            host: host.name,
                            disposition: if muted.is_some() {
                                SpeechDisposition::Applied
                            } else {
                                SpeechDisposition::Observed
                            },
                            data: Some(data),
                            error: None,
                        },
                        Err(error) => NodeSpeechControl {
                            host: host.name,
                            disposition: if muted.is_some() {
                                SpeechDisposition::Unconfirmed
                            } else {
                                SpeechDisposition::Error
                            },
                            data: None,
                            error: Some(JsonError::from_error(&error)),
                        },
                    }
                });
            }
            let mut hosts = vec![];
            while let Some(result) = jobs.join_next().await {
                hosts
                    .push(result.map_err(|e| {
                        Error::Transport(format!("speech policy task failed: {e}"))
                    })?);
            }
            hosts.sort_by(|a, b| a.host.cmp(&b.host));
            Ok(FleetSpeechControl { hosts })
        })
    }
    pub fn tts_list(&self, input: ListInput) -> Result<FleetListing<SpeechRecord>> {
        store::check_limit(input.limit)?;
        let hosts = self.hosts(&input.selection)?;
        self.runtime.block_on(async {
            let mut jobs = JoinSet::new();
            for host in hosts {
                let config = self.config.clone();
                let limit = input.limit;
                jobs.spawn(async move {
                    let result = if host.local {
                        match host.paths.tts() {
                            Ok(path) => blocking(move || store::speech_list(&path, limit)).await,
                            Err(e) => Err(e),
                        }
                    } else {
                        let mut args = vec![
                            "node".into(),
                            "tts-list".into(),
                            "--limit".into(),
                            limit.to_string(),
                        ];
                        if let Some(path) = &host.paths.tts_feed {
                            args.extend(["--path".into(), path.clone()]);
                        }
                        transport::query(&config, &host, &args).await
                    };
                    node_listing(host.name, result)
                });
            }
            collect(jobs).await
        })
    }
    pub fn image_list(&self, input: ListInput) -> Result<FleetListing<ImageRecord>> {
        store::check_limit(input.limit)?;
        let hosts = self.hosts(&input.selection)?;
        self.runtime.block_on(async {
            let mut jobs = JoinSet::new();
            for host in hosts {
                let config = self.config.clone();
                let limit = input.limit;
                let agent = input.agent.clone();
                jobs.spawn(async move {
                    let result = if host.local {
                        match host.paths.images() {
                            Ok(path) => {
                                blocking(move || store::image_list(&path, limit, agent.as_deref()))
                                    .await
                            }
                            Err(e) => Err(e),
                        }
                    } else {
                        let mut args = image_args("image-list", &host, None);
                        args.extend(["--limit".into(), limit.to_string()]);
                        if let Some(agent) = agent {
                            args.extend(["--agent".into(), agent]);
                        }
                        transport::query(&config, &host, &args).await
                    };
                    node_listing(host.name, result)
                });
            }
            collect(jobs).await
        })
    }
    pub fn image_info(&self, input: ImageInput) -> Result<ImageRecord> {
        let host = self.one_host(&input.selection)?;
        if host.local {
            store::image_info(&host.paths.images()?, &input.id)
        } else {
            self.runtime.block_on(transport::query(
                &self.config,
                &host,
                &image_args("image-info", &host, Some(input.id)),
            ))
        }
    }
    pub fn image_bytes(&self, input: ImageInput) -> Result<Vec<u8>> {
        let record = self.image_info(input.clone())?;
        let host = self.one_host(&input.selection)?;
        let bytes = if host.local {
            store::image_bytes(&host.paths.images()?, &input.id)?
        } else {
            self.runtime.block_on(transport::capture(
                &self.config,
                &host,
                &image_args("image-read", &host, Some(input.id)),
                MAX_IMAGE_BYTES,
            ))?
        };
        use sha2::{Digest, Sha256};
        if bytes.len() as u64 != record.bytes
            || format!("{:x}", Sha256::digest(&bytes)) != record.sha256
        {
            return Err(Error::Invalid(
                "downloaded image checksum/size mismatch".into(),
            ));
        }
        Ok(bytes)
    }
    pub async fn follow(
        &self,
        selection: Selection,
        lines: usize,
        tx: mpsc::Sender<FleetEvent>,
        cancel: CancellationToken,
    ) -> Result<()> {
        store::check_limit(lines)?;
        let hosts = self.hosts(&selection)?;
        let mut jobs = JoinSet::new();
        for host in hosts {
            let config = self.config.clone();
            let tx = tx.clone();
            let cancel = cancel.clone();
            jobs.spawn(async move {
                let (node_tx, mut node_rx) = mpsc::channel(16);
                let forwarding_cancel = cancel.clone(); let name = host.name.clone();
                let forward = tokio::spawn(async move {
                    loop {
                        tokio::select! {
                            _ = forwarding_cancel.cancelled() => break,
                            event = node_rx.recv() => {
                                let Some(event) = event else { break; };
                                tokio::select! {
                                    _ = forwarding_cancel.cancelled() => break,
                                    result = tx.send(FleetEvent { host: name.clone(), event }) => if result.is_err() { forwarding_cancel.cancel(); break; },
                                }
                            }
                        }
                    }
                });
                let mut cursor = None;
                let mut delay = config.reconnect_seconds;
                loop {
                    let result = if host.local {
                        match host.paths.tts() {
                            Ok(path) => local_tail(path, lines, &mut cursor, config.poll_ms, &node_tx, &cancel).await,
                            Err(e) => Err(e),
                        }
                    } else { transport::stream(&config, &host, lines, &mut cursor, &node_tx, &cancel).await };
                    if cancel.is_cancelled() { break; }
                    let message = result.err().map(|e| e.to_string()).unwrap_or_else(|| "stream ended".into());
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        _ = node_tx.send(TailEvent::Status { state: "offline".into(), message: format!("{}; retrying in {delay}s", message.chars().take(500).collect::<String>()) }) => (),
                    }
                    tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(delay)) => () }
                    delay = (delay * 2).min(60);
                }
                drop(node_tx);
                let _ = forward.await;
            });
        }
        drop(tx);
        while let Some(result) = jobs.join_next().await {
            result.map_err(|e| Error::Transport(format!("tail task failed: {e}")))?;
        }
        Ok(())
    }
}

pub async fn local_tail(
    path: PathBuf,
    lines: usize,
    cursor: &mut Option<Cursor>,
    poll_ms: u64,
    tx: &mpsc::Sender<TailEvent>,
    cancel: &CancellationToken,
) -> Result<()> {
    let mut reader = store::TailReader::new(path, lines, *cursor)?;
    loop {
        let (next_reader, events) = blocking(move || {
            let events = reader.poll()?;
            Ok((reader, events))
        })
        .await?;
        reader = next_reader;
        for event in events {
            if let Some(next) = event.cursor() {
                *cursor = Some(next);
            }
            tokio::select! {
                _ = cancel.cancelled() => return Ok(()),
                result = tx.send(event) => result.map_err(|_| Error::Transport("tail consumer closed".into()))?,
            }
        }
        tokio::select! { _ = cancel.cancelled() => return Ok(()), _ = tokio::time::sleep(Duration::from_millis(poll_ms)) => () }
    }
}
fn image_args(command: &str, host: &Host, id: Option<String>) -> Vec<String> {
    let mut args = vec!["node".into(), command.into()];
    if let Some(path) = &host.paths.image_dir {
        args.extend(["--root".into(), path.clone()]);
    }
    if let Some(id) = id {
        args.extend(["--id".into(), id]);
    }
    args
}
fn node_listing<T>(host: String, result: Result<Listing<T>>) -> NodeListing<T> {
    match result {
        Ok(data) => NodeListing {
            host,
            data: Some(data),
            error: None,
        },
        Err(error) => NodeListing {
            host,
            data: None,
            error: Some(JsonError::from_error(&error)),
        },
    }
}
async fn collect<T: Send + 'static>(mut jobs: JoinSet<NodeListing<T>>) -> Result<FleetListing<T>> {
    let mut hosts = vec![];
    while let Some(result) = jobs.join_next().await {
        hosts.push(result.map_err(|e| Error::Transport(format!("query task failed: {e}")))?);
    }
    hosts.sort_by(|a, b| a.host.cmp(&b.host));
    Ok(FleetListing { hosts })
}
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| Error::Transport(format!("reader task failed: {e}")))?
}

pub fn router() -> ToolRouter<Service> {
    let mut router = ToolRouter::new();
    router.add_typed_tool_with_output_schema("ag_tts_status", "Read node-wide runtime speech mute policy on selected/all enabled nodes. Does not change session settings or audio.", Service::speech_status);
    router.add_typed_tool_with_output_schema("ag_tts_mute", "Mute selected speech kinds on selected/all enabled nodes. Empty kinds means read, tts, narrate and choices. Requires confirmed=true after operator approval. Acknowledges the policy file, not synchronous audio quiescence; errors may be unconfirmed, so reconcile with ag_tts_status.", Service::speech_mute);
    router.add_typed_tool_with_output_schema("ag_tts_unmute", "Unmute selected speech kinds on selected/all enabled nodes. Empty kinds unmutes all four. Requires confirmed=true after operator approval. Allows future speech without replaying muted backlog; does not enable disabled session settings.", Service::speech_unmute);
    router.add_typed_tool_with_output_schema("ag_tts_list", "Read recent speech requests from configured nodes concurrently. Finite snapshot, ≤1000 records per node; failures are reported per node.", Service::tts_list);
    router.add_typed_tool_with_output_schema("ag_image_pull", "Incrementally cache all registered images from selected/all enabled nodes via rsync and generate a private local HTML gallery. No browser launch. Requires confirmed=true for local cache writes. offline=true reads the existing cache without network. Node failures retain cached images and are explicit in the receipt.", Service::image_gallery);
    router.add_typed_tool_with_output_schema("ag_image_list", "List recent durable shared-image metadata across configured nodes. ≤1000 records per node; filter by exact agent name or archive directory.", Service::image_list);
    router.add_typed_tool_with_output_schema("ag_image_info", "Get one image's metadata from an explicitly selected node. Use id from ag_image_list; never resolves paths outside its archive.", Service::image_info);
    router.add_typed_tool(
        "ag_hosts_list",
        "List configured nodes and effective paths; no network I/O.",
        |s: &Service, input: Selection| s.hosts(&input),
    );
    router.add_typed_tool(
        "config_status",
        "Report configuration path and validity.",
        |s: &Service, input: configurable_cli::ConfigPathInput| {
            config::manager()
                .status(input.path.as_deref().or(s.config_path.as_deref()))
                .map_err(|e| Error::Config(e.to_string()))
        },
    );
    router.add_typed_tool(
        "config_validate",
        "Validate configuration without modifying it.",
        |s: &Service, input: configurable_cli::ConfigPathInput| {
            let path = input.path.as_deref().or(s.config_path.as_deref());
            config::load(path)?;
            config::manager()
                .status(path)
                .map_err(|e| Error::Config(e.to_string()))
        },
    );
    router.add_typed_tool(
        "config_schema",
        "Return the canonical configuration schema.",
        |_: &Service, _: configurable_cli::ConfigPathInput| -> Result<serde_json::Value> {
            Ok(serde_json::from_str(
                &config::manager()
                    .schema_json()
                    .map_err(|e| Error::Config(e.to_string()))?,
            )?)
        },
    );
    router.add_typed_tool(
        "config_init",
        "Create a private default config. Requires confirmed=true. Preserves managed symlinks.",
        |s: &Service, input: configurable_cli::ConfigInitInput| -> Result<serde_json::Value> {
            if !input.confirmed {
                return Err(Error::Invalid("config_init requires confirmed=true".into()));
            }
            let manager = config::manager();
            let path = manager.resolve_path(input.path.as_deref().or(s.config_path.as_deref()));
            manager
                .init(&path, input.force)
                .map_err(|e| Error::Config(e.to_string()))?;
            Ok(serde_json::json!({"path":path,"initialized":true}))
        },
    );
    router
}
pub fn server() -> McpServer<Service> {
    McpServer::new(
        StdioServerConfig {
            server_name: "ag".into(),
            server_version: env!("CARGO_PKG_VERSION").into(),
        },
        router(),
    )
    .with_max_frame_bytes(MAX_RECORD_BYTES)
}
