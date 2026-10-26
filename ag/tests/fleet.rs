//! Real process boundary: the `ag` binary against an in-process fake Paratenic
//! AHP host speaking JSON-RPC over WebSocket. No real fleet, Culture config or
//! network host is touched; every test uses its own HOME/state/config.
use ag::config::{Config, Host, HostParatenic, ParatenicConfig, Paths};
use configurable_cli::AppConfig;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tempfile::TempDir;

#[path = "support/fake_ahp.rs"]
mod fake_ahp;
use fake_ahp::{TOKEN, fake_host};

const BIN: &str = env!("CARGO_BIN_EXE_ag");

fn closed_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

struct Fixture {
    temp: TempDir,
    config: PathBuf,
}
impl Fixture {
    fn new(nodes: &[(&str, Option<String>)]) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let token = temp.path().join("token");
        std::fs::write(&token, format!("{TOKEN}\n")).unwrap();
        let config = temp.path().join("config.yaml");
        // Never touch real SSH: every node reports itself unreachable.
        let ssh = temp.path().join("fake-ssh");
        std::fs::write(
            &ssh,
            "#!/bin/sh\necho 'ssh: connect to host x port 22: Connection refused' >&2\nexit 255\n",
        )
        .unwrap();
        std::fs::set_permissions(&ssh, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let hosts = nodes
            .iter()
            .map(|(name, url)| Host {
                name: (*name).into(),
                address: (*name).into(),
                // The fake host never runs SSH; ag peers resolve on localhost.
                local: false,
                paratenic: HostParatenic {
                    url: url.clone(),
                    token_file: Some(token.display().to_string()),
                    ..HostParatenic::default()
                },
                ..Host::default()
            })
            .collect();
        let cfg = Config {
            paths: Paths {
                tts_feed: Some(temp.path().join("speech.jsonl").display().to_string()),
                image_dir: Some(temp.path().join("images").display().to_string()),
                tts_mute: Some(temp.path().join("mute.json").display().to_string()),
                audio_dir: None,
            },
            paratenic: ParatenicConfig {
                culture_config: Some(temp.path().join("no-culture.yaml").display().to_string()),
                request_timeout_seconds: 5,
                answer_timeout_seconds: 3,
                ..ParatenicConfig::default()
            },
            connect_timeout_seconds: 2,
            ssh_command: ssh.display().to_string(),
            hosts,
            ..Config::default()
        };
        cfg.validate().unwrap();
        ag::config::manager().save(&config, &cfg).unwrap();
        Self { temp, config }
    }
    fn command(&self) -> Command {
        let mut command = Command::new(BIN);
        command
            .env("HOME", self.temp.path())
            .env("AG_CONFIG", &self.config)
            .env("XDG_STATE_HOME", self.temp.path().join("state"))
            .env("XDG_CONFIG_HOME", self.temp.path().join("xdg"))
            .env("XDG_CACHE_HOME", self.temp.path().join("cache"))
            .env_remove("AG_STATE_DIR")
            .env_remove("NO_COLOR")
            .env("TERM", "xterm-256color");
        command
    }
    fn json(&self, args: &[&str]) -> (i32, Value) {
        let out = self.command().args(args).output().unwrap();
        let value = serde_json::from_slice(&out.stdout).unwrap_or_else(|_| {
            panic!(
                "non-JSON stdout for {args:?}: {}\n{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            )
        });
        (out.status.code().unwrap_or(-1), value)
    }
}

fn url(address: SocketAddr) -> Option<String> {
    Some(format!("ws://{address}/ahp"))
}

#[test]
fn choices_list_reads_authoritative_input_needed_and_marks_unanswerable_entries() {
    let (address, fake) = fake_host();
    let fixture = Fixture::new(&[("alpha", url(address))]);
    let (code, value) = fixture.json(&["--json", "choices", "list"]);
    assert_eq!(code, 0, "{value}");
    let data = &value["data"];
    assert_eq!(data["actionable"], 1);
    let node = &data["nodes"][0];
    assert_eq!(node["state"], "ok");
    assert_eq!(node["sessions"], 3);
    assert_eq!(node["input_needed_sessions"], 2);
    let agents = node["agents"].as_array().unwrap();
    assert_eq!(
        agents.len(),
        1,
        "default view hides unanswerable entries: {agents:?}"
    );
    let choice = &agents[0]["choices"][0];
    assert_eq!(choice["request_id"], "choice-1");
    assert_eq!(choice["kind"], "chatInput");
    assert_eq!(choice["questions"][0]["options"][0]["recommended"], true);
    assert_eq!(agents[0]["cwd"], "/work/agent-utils");

    let (_, all) = fixture.json(&["--json", "choices", "list", "--all"]);
    let stale: Vec<&Value> = all["data"]["nodes"][0]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|a| a["choices"].as_array().unwrap())
        .filter(|c| c["actionable"] == false)
        .collect();
    assert_eq!(stale.len(), 2);
    assert!(
        stale
            .iter()
            .any(|c| c["stale_reason"].as_str().unwrap().contains("read-only"))
    );
    assert!(stale.iter().any(|c| c["kind"] == "unknown"));
    assert!(
        fake.lock()
            .unwrap()
            .auth
            .iter()
            .all(|a| a.as_deref() == Some(&format!("Bearer {TOKEN}")))
    );
}

#[test]
fn answer_dispatches_exact_chat_input_completed_and_reports_authoritative_echo() {
    let (address, fake) = fake_host();
    let fixture = Fixture::new(&[("alpha", url(address))]);
    let (_, listed) = fixture.json(&["--json", "choices", "list"]);
    let choice = &listed["data"]["nodes"][0]["agents"][0]["choices"][0];
    let revision = choice["revision"].as_str().unwrap();
    let (code, receipt) = fixture.json(&[
        "--json",
        "choices",
        "answer",
        "--node",
        "alpha",
        "--session",
        "ahp-session:/agent-a",
        "--request",
        "choice-1",
        "--option",
        "2",
        "--revision",
        revision,
    ]);
    assert_eq!(code, 0, "{receipt}");
    assert_eq!(receipt["data"]["state"], "accepted");
    let dispatch = fake.lock().unwrap().dispatches[0].clone();
    assert_eq!(dispatch["channel"], "ahp-session:/agent-a/chat");
    assert_eq!(dispatch["action"]["type"], "chat/inputCompleted");
    assert_eq!(dispatch["action"]["requestId"], "choice-1");
    assert_eq!(dispatch["action"]["response"], "accept");
    assert_eq!(
        dispatch["action"]["answers"]["choice"],
        json!({"state": "submitted", "value": {"kind": "selected", "value": "opt-b"}})
    );
    assert_eq!(receipt["data"]["client_seq"], dispatch["clientSeq"]);

    // Already answered: refused locally as gone, never re-dispatched.
    let (code, again) = fixture.json(&[
        "--json",
        "choices",
        "answer",
        "--node",
        "alpha",
        "--session",
        "ahp-session:/agent-a",
        "--request",
        "choice-1",
        "--option",
        "1",
    ]);
    assert_eq!(code, 3);
    assert_eq!(again["data"]["state"], "gone");
    assert_eq!(fake.lock().unwrap().dispatches.len(), 1);
}

#[test]
fn pi_daemon_sessions_join_the_node_deduplicated_and_answer_through_the_daemon() {
    // A node's Paratenic lists a TUI Pi asking choice-1. Its pi-daemon /ahp
    // lists a Durable session asking with ask_user and the same TUI Pi again
    // (as tui-…), found through pi-client's client.hosts (bd-4fc36c).
    let (paratenic, paratenic_fake) = fake_host();
    let (daemon, daemon_fake) = fake_ahp::fake_host_with(fake_ahp::Fake {
        pi_daemon: true,
        ..Default::default()
    });
    let fixture = Fixture::new(&[("alpha", url(paratenic))]);
    let token = fixture.temp.path().join("token");
    let pi_settings = fixture.temp.path().join("pi-settings.json");
    std::fs::write(
        &pi_settings,
        json!({
            "theme": "anything",
            "client": {
                "tokenFile": token.display().to_string(),
                "hosts": [{"name": "alpha", "url": format!("ws://{daemon}")}],
            },
        })
        .to_string(),
    )
    .unwrap();
    let manager = ag::config::manager();
    let mut config = ag::config::load(Some(&fixture.config)).unwrap();
    config.paratenic.pi_settings = Some(pi_settings.display().to_string());
    manager.save(&fixture.config, &config).unwrap();

    let (code, listed) = fixture.json(&["--json", "choices", "list"]);
    assert_eq!(code, 0, "{listed}");
    let nodes = listed["data"]["nodes"].as_array().unwrap();
    let rows: Vec<(&str, &str, &str)> = nodes
        .iter()
        .map(|n| {
            (
                n["host"].as_str().unwrap(),
                n["node"].as_str().unwrap(),
                n["source"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("alpha", "alpha", "paratenic"),
            ("alpha-pi-daemon", "alpha", "pi-daemon")
        ]
    );
    assert_eq!(
        nodes[1]["endpoint"],
        format!("ws://{daemon}/ahp"),
        "pi-client URLs gain /ahp"
    );
    // The TUI Pi's question appears once (pi-daemon's copy); Paratenic keeps
    // only what pi-daemon does not serve.
    let daemon_agents = nodes[1]["agents"].as_array().unwrap();
    let kinds: Vec<(&str, &str)> = daemon_agents
        .iter()
        .map(|a| {
            (
                a["kind"].as_str().unwrap(),
                a["choices"][0]["request_id"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(kinds, [("daemon", "12"), ("tui", "choice-1")]);
    let paratenic_ids: Vec<&str> = nodes[0]["agents"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|a| a["choices"].as_array().unwrap())
        .map(|c| c["request_id"].as_str().unwrap())
        .collect();
    assert!(!paratenic_ids.contains(&"choice-1"), "{paratenic_ids:?}");
    assert_eq!(listed["data"]["actionable"], 2);

    // ask_user answers go to the daemon with its question id.
    let ask = &daemon_agents[0]["choices"][0];
    assert_eq!(ask["title"], "Keep the chart?");
    let (code, receipt) = fixture.json(&[
        "--json",
        "choices",
        "answer",
        "--node",
        "alpha-pi-daemon",
        "--session",
        "ahp-session:/durable-1",
        "--request",
        "12",
        "--option",
        "Discard",
        "--revision",
        ask["revision"].as_str().unwrap(),
    ]);
    assert_eq!(code, 0, "{receipt}");
    assert_eq!(receipt["data"]["state"], "accepted");
    let dispatch = daemon_fake.lock().unwrap().dispatches[0].clone();
    assert_eq!(dispatch["channel"], "ahp-chat:/durable-1/1");
    assert_eq!(
        dispatch["action"]["answers"]["answer"],
        json!({"state": "submitted", "value": {"kind": "selected", "value": "Discard"}})
    );
    assert!(paratenic_fake.lock().unwrap().dispatches.is_empty());

    // pi-daemon 1.11: the daemon serves only its Durable sessions; TUI Pis come
    // from the bridge's /ahp, still deduplicated against Paratenic.
    let (daemon_only, _) = fake_ahp::fake_host_with(fake_ahp::Fake {
        pi_daemon: true,
        bridge: Some(false),
        ..Default::default()
    });
    let (bridge, bridge_fake) = fake_ahp::fake_host_with(fake_ahp::Fake {
        pi_daemon: true,
        bridge: Some(true),
        ..Default::default()
    });
    std::fs::write(
        &pi_settings,
        json!({"client": {"tokenFile": token.display().to_string(), "hosts": [
            {"name": "alpha", "url": format!("ws://{daemon_only}"), "bridge": format!("ws://{bridge}")},
        ]}})
        .to_string(),
    )
    .unwrap();
    let (code, listed) = fixture.json(&["--json", "choices", "list"]);
    assert_eq!(code, 0, "{listed}");
    let nodes = listed["data"]["nodes"].as_array().unwrap();
    let rows: Vec<(&str, &str)> = nodes
        .iter()
        .map(|n| (n["host"].as_str().unwrap(), n["source"].as_str().unwrap()))
        .collect();
    assert_eq!(
        rows,
        [
            ("alpha", "paratenic"),
            ("alpha-pi-bridge", "pi-bridge"),
            ("alpha-pi-daemon", "pi-daemon")
        ]
    );
    assert_eq!(nodes[1]["endpoint"], format!("ws://{bridge}/ahp"));
    assert_eq!(nodes[1]["agents"][0]["kind"], "tui");
    assert_eq!(
        nodes[1]["agents"][0]["choices"][0]["request_id"],
        "choice-1"
    );
    assert_eq!(nodes[2]["agents"][0]["kind"], "daemon");
    assert!(
        nodes[0]["agents"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|a| a["choices"].as_array().unwrap())
            .all(|c| c["request_id"] != "choice-1"),
        "the TUI Pi's question is shown once, from the bridge"
    );
    let tui = &nodes[1]["agents"][0]["choices"][0];
    let (code, receipt) = fixture.json(&[
        "--json",
        "choices",
        "answer",
        "--node",
        "alpha-pi-bridge",
        "--session",
        "ahp-session:/tui-0190-pi-session",
        "--request",
        "choice-1",
        "--option",
        "Hold",
        "--revision",
        tui["revision"].as_str().unwrap(),
    ]);
    assert_eq!(code, 0, "{receipt}");
    assert_eq!(
        bridge_fake.lock().unwrap().dispatches.len(),
        1,
        "answered through the bridge"
    );

    // A bridge before pi-daemon 1.11 has no /ahp (404): listed as unsupported,
    // not a failure.
    let (old_bridge, _) = fake_ahp::fake_host_with(fake_ahp::Fake {
        refuse: Some(404),
        ..Default::default()
    });
    std::fs::write(
        &pi_settings,
        json!({"client": {"tokenFile": token.display().to_string(), "hosts": [
            {"name": "alpha", "url": format!("ws://{daemon_only}"), "bridge": format!("ws://{old_bridge}")},
        ]}})
        .to_string(),
    )
    .unwrap();
    let (code, listed) = fixture.json(&["--json", "choices", "list"]);
    assert_eq!(code, 0, "an old bridge never fails the run: {listed}");
    let old = listed["data"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["host"] == "alpha-pi-bridge")
        .unwrap()
        .clone();
    assert_eq!(old["state"], "unsupported", "{old}");

    // Without pi-client hosts, Culture's <node>-pi-daemon entry is used.
    std::fs::write(&pi_settings, "{}").unwrap();
    std::fs::write(
        fixture.temp.path().join("no-culture.yaml"),
        format!(
            "hosts:\n- id: alpha-pi-daemon\n  url: ws://{daemon}/ahp\n  token_file: {}\n",
            token.display()
        ),
    )
    .unwrap();
    let (_, listed) = fixture.json(&["--json", "choices", "list"]);
    assert_eq!(listed["data"]["nodes"][1]["host"], "alpha-pi-daemon");

    // Opting out keeps only Paratenic, which then shows the TUI Pi itself.
    let mut config = ag::config::load(Some(&fixture.config)).unwrap();
    config.paratenic.pi_daemon = false;
    manager.save(&fixture.config, &config).unwrap();
    let (_, listed) = fixture.json(&["--json", "choices", "list"]);
    let nodes = listed["data"]["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 1);
    assert_eq!(
        nodes[0]["agents"][0]["choices"][0]["request_id"],
        "choice-1"
    );
}

#[test]
fn pi_daemon_and_bridge_work_and_report_health_without_paratenic() {
    // Paratenic disabled (or not running) must not hide a node's pi-daemon or
    // the TUI Pis its bridge serves: they list, answer and report health alone.
    let (daemon, _) = fake_ahp::fake_host_with(fake_ahp::Fake {
        pi_daemon: true,
        bridge: Some(false),
        ..Default::default()
    });
    let (bridge, bridge_fake) = fake_ahp::fake_host_with(fake_ahp::Fake {
        pi_daemon: true,
        bridge: Some(true),
        ..Default::default()
    });
    let fixture = Fixture::new(&[("alpha", None)]);
    let token = fixture.temp.path().join("token");
    let pi_settings = fixture.temp.path().join("pi-settings.json");
    std::fs::write(
        &pi_settings,
        json!({"client": {"tokenFile": token.display().to_string(), "hosts": [
            {"name": "alpha", "url": format!("ws://{daemon}"), "bridge": format!("ws://{bridge}")},
        ]}})
        .to_string(),
    )
    .unwrap();
    let manager = ag::config::manager();
    let mut config = ag::config::load(Some(&fixture.config)).unwrap();
    config.paratenic.enabled = false;
    config.pi_daemon.settings = Some(pi_settings.display().to_string());
    manager.save(&fixture.config, &config).unwrap();

    let (code, listed) = fixture.json(&["--json", "choices", "list"]);
    assert_eq!(code, 0, "{listed}");
    let nodes = listed["data"]["nodes"].as_array().unwrap();
    let rows: Vec<(&str, &str)> = nodes
        .iter()
        .map(|n| (n["host"].as_str().unwrap(), n["state"].as_str().unwrap()))
        .collect();
    assert_eq!(
        rows,
        [
            ("alpha", "disabled"),
            ("alpha-pi-bridge", "ok"),
            ("alpha-pi-daemon", "ok")
        ]
    );
    assert_eq!(listed["data"]["actionable"], 2);
    let tui = &nodes[1]["agents"][0]["choices"][0];
    let (code, receipt) = fixture.json(&[
        "--json",
        "choices",
        "answer",
        "--node",
        "alpha-pi-bridge",
        "--session",
        "ahp-session:/tui-0190-pi-session",
        "--request",
        "choice-1",
        "--option",
        "Hold",
        "--revision",
        tui["revision"].as_str().unwrap(),
    ]);
    assert_eq!(code, 0, "{receipt}");
    assert_eq!(receipt["data"]["state"], "accepted");
    assert_eq!(bridge_fake.lock().unwrap().dispatches.len(), 1);

    // Health: pi-daemon and bridge rows; a disabled Paratenic stays out of the card.
    let (code, report) = fixture.json(&["--json", "doctor"]);
    assert_eq!(code, 0, "{report}");
    let alpha = &report["data"]["nodes"][0];
    let names: Vec<&str> = alpha["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(names[..3], ["ssh", "pi-daemon", "pi-bridge"], "{alpha}");
    assert!(!names.contains(&"paratenic"), "{names:?}");
    assert_eq!(alpha["checks"][1]["status"], "ok");
    assert!(
        alpha["checks"][1]["summary"]
            .as_str()
            .unwrap()
            .contains("1 session · 1 waiting"),
        "{alpha}"
    );
    assert!(
        alpha["checks"][2]["summary"]
            .as_str()
            .unwrap()
            .contains("TUI Pi"),
        "{alpha}"
    );
    assert!(
        alpha["checks"][0]["summary"]
            .as_str()
            .unwrap()
            .contains("unreachable over SSH"),
        "agents answer over pi-daemon, so the node is up: {alpha}"
    );
    assert_eq!(alpha["status"], "warn");
    assert_eq!(report["data"]["counts"]["offline"], 0);

    // A bridge before pi-daemon 1.11 (no /ahp) is a warning naming the fix.
    let (old_bridge, _) = fake_ahp::fake_host_with(fake_ahp::Fake {
        refuse: Some(404),
        ..Default::default()
    });
    std::fs::write(
        &pi_settings,
        json!({"client": {"tokenFile": token.display().to_string(), "hosts": [
            {"name": "alpha", "url": format!("ws://{daemon}"), "bridge": format!("ws://{old_bridge}")},
        ]}})
        .to_string(),
    )
    .unwrap();
    let (_, report) = fixture.json(&["--json", "doctor"]);
    let bridge_check = report["data"]["nodes"][0]["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "pi-bridge")
        .unwrap()
        .clone();
    assert_eq!(bridge_check["status"], "warn", "{bridge_check}");
    assert!(
        bridge_check["summary"]
            .as_str()
            .unwrap()
            .contains("need pi-daemon ≥ 1.11")
    );

    // Without pi-client hosts, Culture's <node>-pi-daemon and <node>-pi serve.
    std::fs::write(&pi_settings, "{}").unwrap();
    std::fs::write(
        fixture.temp.path().join("no-culture.yaml"),
        format!(
            "hosts:\n- id: alpha-pi-daemon\n  url: ws://{daemon}/ahp\n  token_file: {t}\n- id: alpha-pi\n  url: ws://{bridge}/ahp\n  token_file: {t}\n",
            t = token.display()
        ),
    )
    .unwrap();
    let (_, listed) = fixture.json(&["--json", "choices", "list"]);
    let hosts: Vec<&str> = listed["data"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["host"].as_str().unwrap())
        .collect();
    assert_eq!(hosts, ["alpha", "alpha-pi-bridge", "alpha-pi-daemon"]);

    // Opting the bridge out per node keeps the daemon.
    let mut config = ag::config::load(Some(&fixture.config)).unwrap();
    config.hosts[0].pi_daemon.bridge = Some(false);
    manager.save(&fixture.config, &config).unwrap();
    let (_, listed) = fixture.json(&["--json", "choices", "list"]);
    let hosts: Vec<&str> = listed["data"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["host"].as_str().unwrap())
        .collect();
    assert_eq!(hosts, ["alpha", "alpha-pi-daemon"]);
}

#[test]
fn freeform_validation_revision_fence_rejection_and_read_only_chats() {
    let (address, fake) = fake_host();
    let fixture = Fixture::new(&[("alpha", url(address))]);
    let base = [
        "--json",
        "choices",
        "answer",
        "--node",
        "alpha",
        "--session",
        "ahp-session:/agent-a",
        "--request",
        "choice-1",
    ];

    let (code, changed) = fixture.json(
        &[
            &base[..],
            &["--option", "1", "--revision", "0000000000000000"],
        ]
        .concat(),
    );
    assert_eq!(
        (code, changed["data"]["state"].as_str()),
        (3, Some("changed"))
    );

    let (code, invalid) = fixture.json(&[&base[..], &["--option", "Nope"]].concat());
    assert_eq!(code, 1);
    assert!(
        invalid["error"]["message"]
            .as_str()
            .unwrap()
            .contains("no option matches")
    );

    let (code, readonly) = fixture.json(&[
        "--json",
        "choices",
        "answer",
        "--node",
        "alpha",
        "--session",
        "ahp-session:/agent-b",
        "--request",
        "ac-async-1",
        "--option",
        "1",
    ]);
    assert_eq!(
        (code, readonly["data"]["state"].as_str()),
        (3, Some("unavailable"))
    );
    assert!(
        fake.lock().unwrap().dispatches.is_empty(),
        "nothing is dispatched before validation passes"
    );

    fake.lock().unwrap().reject = Some("another input completion is already pending".into());
    let (code, rejected) = fixture.json(&[&base[..], &["--text", "only after lunch"]].concat());
    assert_eq!(
        (code, rejected["data"]["state"].as_str()),
        (3, Some("rejected"))
    );
    assert_eq!(
        rejected["data"]["reason"],
        "another input completion is already pending"
    );
    let answer = &fake.lock().unwrap().dispatches[0]["action"]["answers"]["choice"]["value"];
    assert_eq!(answer["freeformValues"], json!(["only after lunch"]));
}

#[test]
fn stable_pooled_client_ids_and_monotonic_sequences_across_runs() {
    let (address, fake) = fake_host();
    let fixture = Fixture::new(&[("alpha", url(address))]);
    fake.lock().unwrap().reject = Some("fixture refusal".into());
    for _ in 0..2 {
        let (_, receipt) = fixture.json(&[
            "--json",
            "choices",
            "answer",
            "--node",
            "alpha",
            "--session",
            "ahp-session:/agent-a",
            "--request",
            "choice-1",
            "--option",
            "1",
        ]);
        assert_eq!(receipt["data"]["state"], "rejected");
    }
    let fake = fake.lock().unwrap();
    let ids: std::collections::BTreeSet<_> = fake.clients.iter().collect();
    assert_eq!(
        ids.len(),
        1,
        "sequential runs reuse one logical client: {:?}",
        fake.clients
    );
    let seqs: Vec<i64> = fake
        .dispatches
        .iter()
        .map(|d| d["clientSeq"].as_i64().unwrap())
        .collect();
    assert!(
        seqs[1] > seqs[0],
        "clientSeq never repeats for a reused id: {seqs:?}"
    );
}

#[test]
fn down_and_unauthorized_hosts_fail_per_node_without_hiding_healthy_ones() {
    let (address, _fake) = fake_host();
    let fixture = Fixture::new(&[
        ("alpha", url(address)),
        (
            "down",
            Some(format!("ws://127.0.0.1:{}/ahp", closed_port())),
        ),
        ("none", None),
    ]);
    std::fs::write(fixture.temp.path().join("token"), "wrong\n").unwrap();
    let (code, value) = fixture.json(&["--json", "choices", "list"]);
    let nodes = value["data"]["nodes"].as_array().unwrap();
    let state = |host: &str| nodes.iter().find(|n| n["host"] == host).unwrap();
    assert_eq!(state("down")["state"], "offline");
    assert_eq!(state("down")["error"], "not listening");
    assert_eq!(state("none")["state"], "unconfigured");
    assert_eq!(
        state("alpha")["state"],
        "error",
        "a refused bearer is a real failure"
    );
    assert!(state("alpha")["error"].as_str().unwrap().contains("401"));
    assert_eq!(code, 3);

    std::fs::write(fixture.temp.path().join("token"), format!("{TOKEN}\n")).unwrap();
    let started = Instant::now();
    let (code, value) = fixture.json(&["--json", "choices", "list"]);
    assert_eq!(code, 0, "offline nodes are reported, not failures: {value}");
    assert_eq!(value["data"]["actionable"], 1);
    assert!(started.elapsed() < Duration::from_secs(8));

    let out = fixture
        .command()
        .args(["choices", "list"])
        .output()
        .unwrap();
    let (stdout, stderr) = (
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
    assert!(stderr.contains("offline: down"), "{stderr}");
    assert!(
        stdout.contains("Deploy the release?") && stdout.contains("1 waiting"),
        "{stdout}"
    );
}

#[test]
fn mcp_answer_requires_confirmation() {
    let (address, fake) = fake_host();
    let fixture = Fixture::new(&[("alpha", url(address))]);
    let input = json!({"host": "alpha", "session": "ahp-session:/agent-a", "request_id": "choice-1", "option": "1"});
    let out = fixture
        .command()
        .args(["call", "ag_choices_answer", &input.to_string()])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stdout).contains("confirmed=true"));
    assert!(fake.lock().unwrap().dispatches.is_empty());
    let tools = fixture.command().arg("tools").output().unwrap();
    let tools = String::from_utf8_lossy(&tools.stdout);
    for name in ["ag_choices_list", "ag_choices_answer", "ag_doctor"] {
        assert!(tools.contains(name), "{name} missing");
    }
}

#[test]
fn doctor_reports_paratenic_catalogue_and_collapses_offline_nodes() {
    let (address, _fake) = fake_host();
    let fixture = Fixture::new(&[
        ("alpha", url(address)),
        (
            "down",
            Some(format!("ws://127.0.0.1:{}/ahp", closed_port())),
        ),
    ]);
    // The fixture's fake SSH reports every node as refusing connections.
    let (code, report) = fixture.json(&["--json", "doctor"]);
    assert_eq!(code, 0, "offline and warnings are not failures: {report}");
    let nodes = report["data"]["nodes"].as_array().unwrap();
    let alpha = nodes.iter().find(|n| n["host"] == "alpha").unwrap();
    assert_eq!(
        alpha["status"], "warn",
        "agents answer over AHP, so only SSH is degraded"
    );
    assert!(
        alpha["checks"][0]["summary"]
            .as_str()
            .unwrap()
            .contains("unreachable over SSH")
    );
    let named = |node: &Value, name: &str| {
        node["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .cloned()
            .unwrap_or(Value::Null)
    };
    assert!(
        named(alpha, "paratenic")["summary"]
            .as_str()
            .unwrap()
            .contains("3 sessions · 2 waiting")
    );
    assert_eq!(
        named(alpha, "pi-daemon")["status"],
        "skip",
        "no pi-client host or Culture entry: not configured, not a failure"
    );
    let down = nodes.iter().find(|n| n["host"] == "down").unwrap();
    assert_eq!(
        down["checks"].as_array().unwrap().len(),
        2,
        "one quiet node line plus cached images"
    );
    assert_eq!(report["data"]["counts"]["offline"], 1);
    assert_eq!(report["data"]["counts"]["warn"], 1);
}

// ---- dash ---------------------------------------------------------------

fn http(
    address: &str,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> (u16, String, String) {
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .unwrap();
    let mut request = format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n");
    if !headers.iter().any(|(k, _)| k.eq_ignore_ascii_case("host")) {
        request.push_str(&format!("Host: {address}\r\n"));
    }
    for (k, v) in headers {
        request.push_str(&format!("{k}: {v}\r\n"));
    }
    if let Some(body) = body {
        request.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    request.push_str("\r\n");
    request.push_str(body.unwrap_or(""));
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let (head, body) = response.split_once("\r\n\r\n").unwrap_or((&response, ""));
    let code = head.split_whitespace().nth(1).unwrap().parse().unwrap();
    (code, head.to_owned(), body.to_owned())
}

fn body_for_unknown_host() -> String {
    json!({"host": "nowhere", "session": "ahp-session:/x", "request_id": "r", "answers": {}})
        .to_string()
}

struct Dash {
    child: Child,
}
impl Drop for Dash {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start_dash(fixture: &Fixture, extra: &[&str]) -> (Dash, String, String) {
    let mut child = fixture
        .command()
        .args([
            "--json",
            "dash",
            "--bind",
            "127.0.0.1:0",
            "--no-open",
            "--no-images",
            "--no-audio",
        ])
        // Token tests opt in; a loopback bind is open by default.
        .args(if extra.contains(&"--access") {
            &[][..]
        } else {
            &["--access", "token"][..]
        })
        .args(extra)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    let mut stdout = std::io::BufReader::new(child.stdout.take().unwrap());
    std::io::BufRead::read_line(&mut stdout, &mut line).unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    let url = ready["data"]["url"].as_str().unwrap().to_owned();
    let address = ready["data"]["address"].as_str().unwrap().to_owned();
    (Dash { child }, url, address)
}

fn session_cookie(address: &str, url: &str) -> String {
    let path = &url[url.find("/?").unwrap()..];
    let (code, head, _) = http(address, "GET", path, &[], None);
    assert_eq!(code, 303);
    let line = head
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("set-cookie:"))
        .unwrap();
    assert!(line.contains("HttpOnly") && line.contains("SameSite=Strict"));
    line.split_once(':')
        .unwrap()
        .1
        .trim()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

#[test]
fn dash_on_a_private_address_needs_no_token_but_keeps_host_and_csrf_checks() {
    // Loopback (like a tailnet address) is open by default: the network is the
    // boundary. DNS-rebinding and cross-site protections still apply.
    let (address, fake) = fake_host();
    let fixture = Fixture::new(&[("alpha", url(address))]);
    let (_dash, url, bind) = start_dash(&fixture, &["--access", "auto"]);
    assert!(!url.contains("token"), "{url}");
    assert!(url.ends_with('/'), "{url}");

    let (code, _, page) = http(&bind, "GET", "/", &[], None);
    assert_eq!(code, 200);
    assert!(page.contains("ag · fleet"));
    let (code, head, _) = http(&bind, "GET", "/?token=old-bookmark", &[], None);
    assert_eq!(code, 303, "an old ?token= link just redirects");
    assert!(!head.to_ascii_lowercase().contains("set-cookie"), "{head}");
    assert_eq!(
        http(
            &bind,
            "GET",
            "/api/state",
            &[("Host", "evil.example:80")],
            None
        )
        .0,
        421,
        "rebinding Host refused"
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let (code, _, body) = http(&bind, "GET", "/api/state", &[], None);
        assert_eq!(code, 200);
        let state: Value = serde_json::from_str(&body).unwrap();
        if state["choices"]["actionable"] == 1 {
            break;
        }
        assert!(Instant::now() < deadline, "{state}");
        std::thread::sleep(Duration::from_millis(200));
    }
    let body = json!({"host": "alpha", "session": "ahp-session:/agent-a", "request_id": "choice-1", "answers": {"choice": "opt-a"}}).to_string();
    assert_eq!(
        http(&bind, "POST", "/api/answer", &[], Some(&body)).0,
        403,
        "a form post without the custom header is refused"
    );
    let cross = [("X-Ag-Dash", "1"), ("Origin", "http://evil.example")];
    assert_eq!(
        http(&bind, "POST", "/api/answer", &cross, Some(&body)).0,
        403,
        "cross-origin refused"
    );
    assert!(fake.lock().unwrap().dispatches.is_empty());
    let (code, _, receipt) = http(
        &bind,
        "POST",
        "/api/answer",
        &[("X-Ag-Dash", "1")],
        Some(&body),
    );
    assert_eq!(code, 200, "{receipt}");
    assert_eq!(
        serde_json::from_str::<Value>(&receipt).unwrap()["state"],
        "accepted"
    );

    // --access token still requires one on the same address.
    let (_locked, url, bind) = start_dash(&fixture, &["--access", "token"]);
    assert!(url.contains("?token="));
    assert_eq!(http(&bind, "GET", "/api/state", &[], None).0, 401);
}

#[test]
fn private_reach_covers_loopback_and_tailscale_only() {
    use ag::config::DashAccess;
    use ag::dash::{open_access, private_reach};
    for ip in [
        "127.0.0.1",
        "::1",
        "100.83.90.42",
        "100.64.0.1",
        "100.127.255.254",
        "fd7a:115c:a1e0::1",
    ] {
        assert!(private_reach(ip.parse().unwrap()), "{ip}");
    }
    for ip in [
        "0.0.0.0",
        "::",
        "192.168.1.5",
        "100.128.0.1",
        "100.63.255.255",
        "8.8.8.8",
        "fd00::1",
    ] {
        assert!(!private_reach(ip.parse().unwrap()), "{ip}");
    }
    let tailnet = "100.83.90.42:7795".parse().unwrap();
    let wildcard = "0.0.0.0:7795".parse().unwrap();
    assert!(open_access(DashAccess::Auto, tailnet));
    assert!(!open_access(DashAccess::Auto, wildcard));
    assert!(!open_access(DashAccess::Token, tailnet));
    assert!(open_access(DashAccess::Open, wildcard));
}

#[test]
fn dash_serves_live_state_and_answers_only_with_token_cookie_and_same_origin_header() {
    let (address, fake) = fake_host();
    let fixture = Fixture::new(&[("alpha", url(address))]);
    let (mut dash, url, bind) = start_dash(&fixture, &[]);
    assert!(url.contains("?token=") && url.starts_with("http://127.0.0.1:"));

    assert_eq!(http(&bind, "GET", "/", &[], None).0, 401);
    assert_eq!(http(&bind, "GET", "/api/state", &[], None).0, 401);
    assert_eq!(http(&bind, "GET", "/?token=wrong", &[], None).0, 401);
    let cookie = session_cookie(&bind, &url);
    let auth = [("Cookie", cookie.as_str())];
    assert_eq!(
        http(
            &bind,
            "GET",
            "/",
            &[("Cookie", &cookie), ("Host", "evil.example:80")],
            None
        )
        .0,
        421,
        "rebinding Host refused"
    );

    let (code, head, page) = http(&bind, "GET", "/", &auth, None);
    assert_eq!(code, 200);
    assert!(
        head.to_ascii_lowercase()
            .contains("content-security-policy")
            && page.contains("ag · fleet")
    );

    let deadline = Instant::now() + Duration::from_secs(10);
    let state = loop {
        let (_, _, body) = http(&bind, "GET", "/api/state", &auth, None);
        let state: Value = serde_json::from_str(&body).unwrap();
        if state["choices"]["actionable"] == 1 || Instant::now() > deadline {
            break state;
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    assert_eq!(state["choices"]["actionable"], 1, "{state}");
    assert_eq!(state["images"]["enabled"], false);

    let body = json!({"host": "alpha", "session": "ahp-session:/agent-a", "request_id": "choice-1", "answers": {"choice": "opt-a"}}).to_string();
    assert_eq!(
        http(&bind, "POST", "/api/answer", &auth, Some(&body)).0,
        403,
        "custom header required"
    );
    let origin = [
        ("Cookie", cookie.as_str()),
        ("X-Ag-Dash", "1"),
        ("Origin", "http://evil.example"),
    ];
    assert_eq!(
        http(&bind, "POST", "/api/answer", &origin, Some(&body)).0,
        403,
        "cross-origin refused"
    );
    assert!(fake.lock().unwrap().dispatches.is_empty());
    let ok = [("Cookie", cookie.as_str()), ("X-Ag-Dash", "1")];
    let (code, _, receipt) = http(&bind, "POST", "/api/answer", &ok, Some(&body));
    assert_eq!(code, 200, "{receipt}");
    assert_eq!(
        serde_json::from_str::<Value>(&receipt).unwrap()["state"],
        "accepted"
    );
    assert_eq!(
        fake.lock().unwrap().dispatches[0]["action"]["answers"]["choice"]["value"]["value"],
        "opt-a"
    );

    // The answered node is re-read immediately; the question disappears.
    let (_, _, body) = http(&bind, "GET", "/api/state", &auth, None);
    let state: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(state["choices"]["actionable"], 0);
    assert_eq!(state["receipts"][0]["state"], "accepted");

    // A failure is a receipt too (and is logged), not just an HTTP error.
    let unknown = body_for_unknown_host();
    let (code, _, failed) = http(&bind, "POST", "/api/answer", &ok, Some(&unknown));
    assert_eq!(code, 400, "{failed}");
    assert!(failed.contains("no AHP endpoint for nowhere"), "{failed}");
    let (_, _, body) = http(&bind, "GET", "/api/state", &auth, None);
    let state: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(state["receipts"][0]["state"], "failed");
    assert_eq!(state["receipts"][0]["host"], "nowhere");
    assert_eq!(state["receipts"][1]["state"], "accepted");

    for path in [
        "/gallery/../config.yaml",
        "/gallery/hosts/x/archive/../../token",
        "/gallery/hosts/x/archive/a.json",
    ] {
        assert_eq!(http(&bind, "GET", path, &auth, None).0, 404, "{path}");
    }
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(dash.child.id() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while dash.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "dash must stop on Ctrl-C");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(TcpStream::connect(&bind).is_err(), "listener released");
}

#[test]
fn dash_serves_the_gallery_cache_with_restrictive_headers() {
    let (address, _fake) = fake_host();
    let fixture = Fixture::new(&[("alpha", url(address))]);
    let cache = fixture.temp.path().join("cache/ag/images");
    let archive = cache.join("hosts/abc/archive/agent");
    std::fs::create_dir_all(&archive).unwrap();
    std::fs::write(
        cache.join("index.html"),
        "<!doctype html><title>gallery</title>",
    )
    .unwrap();
    std::fs::write(
        archive.join("img-1.svg"),
        "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    )
    .unwrap();
    std::fs::write(fixture.temp.path().join("secret.txt"), "nope").unwrap();
    std::os::unix::fs::symlink(
        fixture.temp.path().join("secret.txt"),
        archive.join("escape.png"),
    )
    .unwrap();
    let (_dash, url, bind) = start_dash(&fixture, &[]);
    let cookie = session_cookie(&bind, &url);
    let auth = [("Cookie", cookie.as_str())];
    let (code, head, _) = http(&bind, "GET", "/gallery/index.html", &auth, None);
    assert_eq!(code, 200);
    assert!(head.contains("frame-ancestors 'self'"));
    let (code, head, _) = http(
        &bind,
        "GET",
        "/gallery/hosts/abc/archive/agent/img-1.svg",
        &auth,
        None,
    );
    assert_eq!(code, 200);
    assert!(head.contains("sandbox") && head.to_ascii_lowercase().contains("nosniff"));
    assert_eq!(
        http(
            &bind,
            "GET",
            "/gallery/hosts/abc/archive/agent/escape.png",
            &auth,
            None
        )
        .0,
        404,
        "symlink escape refused"
    );
    let (_, _, state) = http(&bind, "GET", "/api/state", &auth, None);
    assert_eq!(
        serde_json::from_str::<Value>(&state).unwrap()["images"]["available"],
        true
    );
}

// ---- TUI over a real pseudo-terminal -------------------------------------

#[test]
fn dash_serves_the_audio_cache_with_ranges_and_restrictive_headers() {
    let (address, _fake) = fake_host();
    let fixture = Fixture::new(&[("alpha", url(address))]);
    let cache = fixture.temp.path().join("cache/ag/audio");
    let archive = cache.join("hosts/abc/archive/agent");
    std::fs::create_dir_all(&archive).unwrap();
    std::fs::write(
        cache.join("index.html"),
        "<!doctype html><title>audio</title>",
    )
    .unwrap();
    let clip: Vec<u8> = (0..100u8).map(|i| b'A' + i % 26).collect();
    std::fs::write(archive.join("aud-1.wav"), &clip).unwrap();
    std::fs::write(archive.join("aud-1.wav.json"), "{}").unwrap();
    std::fs::write(fixture.temp.path().join("secret.txt"), "nope").unwrap();
    std::os::unix::fs::symlink(
        fixture.temp.path().join("secret.txt"),
        archive.join("escape.wav"),
    )
    .unwrap();
    let (_dash, url, bind) = start_dash(&fixture, &[]);
    let file = "/audio/hosts/abc/archive/agent/aud-1.wav";
    assert_eq!(http(&bind, "GET", file, &[], None).0, 401);
    let cookie = session_cookie(&bind, &url);
    let auth = [("Cookie", cookie.as_str())];
    let (_, _, page) = http(&bind, "GET", "/", &auth, None);
    assert!(page.contains("tab-audio") && page.contains("/audio/index.html"));
    let (code, head, _) = http(&bind, "GET", "/audio/index.html", &auth, None);
    assert_eq!(code, 200);
    assert!(head.contains("media-src 'self'") && head.contains("frame-ancestors 'self'"));
    let (code, head, body) = http(&bind, "GET", file, &auth, None);
    assert_eq!(code, 200);
    let lower = head.to_ascii_lowercase();
    assert!(lower.contains("content-type: audio/wav") && lower.contains("accept-ranges: bytes"));
    assert!(head.contains("sandbox") && lower.contains("nosniff"));
    assert_eq!(body.as_bytes(), clip.as_slice());
    let ranged = [("Cookie", cookie.as_str()), ("Range", "bytes=10-19")];
    let (code, head, body) = http(&bind, "GET", file, &ranged, None);
    assert_eq!(code, 206);
    assert!(
        head.to_ascii_lowercase()
            .contains("content-range: bytes 10-19/100")
    );
    assert_eq!(body.as_bytes(), &clip[10..20]);
    let suffix = [("Cookie", cookie.as_str()), ("Range", "bytes=-5")];
    assert_eq!(
        http(&bind, "GET", file, &suffix, None).2.as_bytes(),
        &clip[95..]
    );
    let open = [("Cookie", cookie.as_str()), ("Range", "bytes=90-")];
    assert_eq!(
        http(&bind, "GET", file, &open, None).2.as_bytes(),
        &clip[90..]
    );
    let beyond = [("Cookie", cookie.as_str()), ("Range", "bytes=200-")];
    let (code, head, _) = http(&bind, "GET", file, &beyond, None);
    assert_eq!(code, 416);
    assert!(
        head.to_ascii_lowercase()
            .contains("content-range: bytes */100")
    );
    for path in [
        "/audio/hosts/abc/archive/agent/aud-1.wav.json",
        "/audio/hosts/abc/archive/agent/escape.wav",
        "/audio/../config.yaml",
        "/audio/hosts/abc/archive/../../index.html",
    ] {
        assert_eq!(http(&bind, "GET", path, &auth, None).0, 404, "{path}");
    }
    let (_, _, state) = http(&bind, "GET", "/api/state", &auth, None);
    let state: Value = serde_json::from_str(&state).unwrap();
    assert_eq!(state["audio"]["available"], true);
    assert_eq!(state["audio"]["enabled"], false);
    let refresh = [("Cookie", cookie.as_str()), ("X-Ag-Dash", "1")];
    let body = json!({"what": ["audio"]}).to_string();
    assert_eq!(
        http(&bind, "POST", "/api/refresh", &refresh, Some(&body)).0,
        202
    );
    let (_, _, state) = http(&bind, "GET", "/api/state", &auth, None);
    assert_eq!(
        serde_json::from_str::<Value>(&state).unwrap()["audio"]["running"],
        false,
        "--no-audio never starts a pull"
    );
}

#[test]
fn choices_tui_answers_over_a_real_pty_and_restores_the_terminal() {
    use nix::pty::openpty;
    use std::os::fd::AsRawFd;
    let (address, fake) = fake_host();
    let fixture = Fixture::new(&[("alpha", url(address))]);
    let pty = openpty(None, None).unwrap();
    let slave_path = nix::unistd::ttyname(&pty.slave).unwrap();
    Command::new("stty")
        .args(["cols", "110", "rows", "32"])
        .stdin(std::fs::File::open(&slave_path).unwrap())
        .status()
        .unwrap();
    let slave = pty.slave;
    let mut child = fixture
        .command()
        .arg("choices")
        .stdin(Stdio::from(slave.try_clone().unwrap()))
        .stdout(Stdio::from(slave.try_clone().unwrap()))
        .stderr(Stdio::from(slave.try_clone().unwrap()))
        .spawn()
        .unwrap();
    drop(slave);
    let master = std::fs::File::from(pty.master);
    let mut writer = master.try_clone().unwrap();
    let screen = Arc::new(Mutex::new(Vec::<u8>::new()));
    {
        let screen = screen.clone();
        let mut reader = master.try_clone().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                screen.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });
    }
    let wait_for = |needle: &str| {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if String::from_utf8_lossy(&screen.lock().unwrap()).contains(needle) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "screen never showed {needle:?}: {}",
                String::from_utf8_lossy(&screen.lock().unwrap())
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    };
    wait_for("Deploy the release?");
    wait_for("1 waiting");
    // Focus the question, move to option 2, answer with Enter.
    writer.write_all(b"\t").unwrap();
    std::thread::sleep(Duration::from_millis(150));
    writer.write_all(b"j").unwrap();
    std::thread::sleep(Duration::from_millis(150));
    writer.write_all(b"\r").unwrap();
    wait_for("answered on alpha");
    assert_eq!(
        fake.lock().unwrap().dispatches[0]["action"]["answers"]["choice"]["value"]["value"],
        "opt-b"
    );
    wait_for("0 waiting");
    // Mouse capture was enabled; q exits and restores the terminal.
    assert!(String::from_utf8_lossy(&screen.lock().unwrap()).contains("\x1b[?1000h"));
    writer.write_all(b"q").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < deadline, "TUI did not exit on q");
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(status.success());
    std::thread::sleep(Duration::from_millis(100));
    let tail = String::from_utf8_lossy(&screen.lock().unwrap()).to_string();
    assert!(
        tail.contains("\x1b[?1049l") && tail.contains("\x1b[?1000l"),
        "alternate screen and mouse capture restored"
    );
    let _ = master.as_raw_fd();
    let _ = Path::new(&slave_path);
}
