use ag::{
    config::{Config, Host, Paths},
    model::*,
    store,
};
use configurable_cli::AppConfig;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Write},
    os::unix::{
        fs::{MetadataExt, PermissionsExt, symlink},
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
use tempfile::TempDir;

const BIN: &str = env!("CARGO_BIN_EXE_ag");
fn line(text: &str) -> String {
    format!(
        "{}\n",
        json!({"timestamp":"2026-09-22T12:00:00Z","kind":"tts","session":"test","text":text})
    )
}
struct Fixture {
    temp: TempDir,
    config: PathBuf,
    feed: PathBuf,
    images: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config.yaml");
        let feed = temp.path().join("speech.jsonl");
        let images = temp.path().join("images");
        let fixture = Self {
            temp,
            config,
            feed,
            images,
        };
        fixture.save(&Config {
            paths: Paths {
                tts_feed: Some(fixture.feed.display().to_string()),
                image_dir: Some(fixture.images.display().to_string()),
                tts_mute: Some(fixture.temp.path().join("mute.json").display().to_string()),
            },
            ..Config::default()
        });
        fixture
    }
    fn save(&self, config: &Config) {
        config::manager().save(&self.config, config).unwrap();
    }
    fn command(&self) -> Command {
        let mut command = Command::new(BIN);
        command
            .env("HOME", self.temp.path())
            .env("AG_CONFIG", &self.config)
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("BASH_ENV")
            .env_remove("ENV")
            .env_remove("PI_TTS_FEED_PATH")
            .env_remove("PI_TTS_MUTE_PATH")
            .env_remove("PI_SHARED_IMAGES_DIR")
            .env_remove("PI_AGENT_UTILS_STATE_DIR");
        command
    }
    fn run(&self, args: &[&str]) -> (i32, Value, String) {
        let out = self.command().args(args).output().unwrap();
        let value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
        (
            out.status.code().unwrap_or(-1),
            value,
            String::from_utf8_lossy(&out.stdout).into(),
        )
    }
    fn append(&self, text: &str) {
        let mut f = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.feed)
            .unwrap();
        f.write_all(line(text).as_bytes()).unwrap();
        f.flush().unwrap();
    }
    fn image(&self) -> String {
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        let id = "agent/img-test.png";
        fs::create_dir_all(self.images.join("agent")).unwrap();
        fs::write(self.images.join(id), bytes).unwrap();
        fs::write(self.images.join(format!("{id}.json")), json!({"version":1,"id":id,"agent":"agent","sha256":format!("{:x}",Sha256::digest(bytes)),"bytes":bytes.len(),"mimeType":"image/png","timestamp":"2026-09-22T00:00:00Z","source":{"tool":"read"}}).to_string()).unwrap();
        id.into()
    }
    fn ssh(&self, script: &str) -> PathBuf {
        // A hermetic account shell: emulate -lc profile loading without running
        // the operator's real /etc or home startup files during the test suite.
        let shell = self.temp.path().join("login-shell");
        fs::write(&shell, "#!/bin/sh\nset -eu\n[ \"$#\" = 2 ] && [ \"$1\" = -lc ] || exit 64\nif [ -f \"$HOME/.ag-test-profile\" ]; then . \"$HOME/.ag-test-profile\"; fi\nexec /bin/sh -c \"$2\"\n").unwrap();
        fs::set_permissions(&shell, fs::Permissions::from_mode(0o700)).unwrap();
        let path = self.temp.path().join("fake-ssh");
        fs::write(&path, format!("#!/bin/sh\nset -eu\nexport SHELL={}\nprevious=''\nlast=''\nfor argument do previous=\"$last\"; last=\"$argument\"; done\n{script}\nexec /bin/sh -c \"$last\"\n", ag::transport::shell_quote(shell.to_str().unwrap()))).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }
    fn remote_config(&self, ssh: &Path, names: &[&str]) -> Config {
        Config {
            ssh_command: ssh.display().to_string(),
            command_timeout_seconds: 10,
            connect_timeout_seconds: 1,
            reconnect_seconds: 1,
            poll_ms: 100,
            hosts: names
                .iter()
                .map(|name| Host {
                    name: (*name).into(),
                    address: (*name).into(),
                    username: Some("user".into()),
                    port: 8022,
                    command: BIN.into(),
                    paths: Paths {
                        tts_feed: Some(self.feed.display().to_string()),
                        image_dir: Some(self.images.display().to_string()),
                        tts_mute: Some(
                            self.temp
                                .path()
                                .join(format!("{name}-mute.json"))
                                .display()
                                .to_string(),
                        ),
                    },
                    ..Host::default()
                })
                .collect(),
            ..Config::default()
        }
    }
}
use ag::config;

#[test]
fn configuration_schema_validation_and_managed_symlink_import() {
    let f = Fixture::new();
    assert_eq!(f.run(&["--json", "config", "validate"]).0, 0);
    let schema = f.run(&["--json", "config", "schema"]).1;
    assert_eq!(schema["status"], "success");
    let target = f.temp.path().join("managed.yaml");
    fs::rename(&f.config, &target).unwrap();
    symlink(&target, &f.config).unwrap();
    let import = f.temp.path().join("import.yaml");
    fs::write(&import, "hosts:\n  - name: here\n    local: true\n").unwrap();
    assert_eq!(
        f.run(&["config", "import", import.to_str().unwrap(), "--force"])
            .0,
        0
    );
    assert!(fs::symlink_metadata(&f.config).unwrap().is_symlink());
    assert!(fs::read_to_string(&target).unwrap().contains("here"));
    fs::write(&target, "unexpected_setting: true\n").unwrap();
    assert_ne!(f.run(&["--json", "hosts"]).0, 0);
    assert!(f.command().arg("--help").output().unwrap().status.success());
    assert!(
        f.command()
            .arg("--version")
            .output()
            .unwrap()
            .status
            .success()
    );
    let invalid = Config {
        hosts: vec![Host::local(), Host::local()],
        ..Config::default()
    };
    assert!(invalid.validate().is_err());
}

#[test]
fn speech_history_is_bounded_and_human_text_cannot_inject_terminal_escapes() {
    let f = Fixture::new();
    f.append("first");
    f.append("second\n\u{1b}[2J");
    let (code, value, _) = f.run(&["--json", "tts", "list", "--limit", "1"]);
    assert_eq!(code, 0);
    assert_eq!(
        value["data"]["hosts"][0]["data"]["records"][0]["text"],
        "second\n\u{1b}[2J"
    );
    let (_, _, text) = f.run(&["tts", "tail", "--no-follow", "-n", "1"]);
    assert!(!text.contains('\u{1b}'));
    assert!(text.contains("\\n"));
    assert_ne!(f.run(&["tts", "list", "--limit", "1001"]).0, 0);
    assert!(store::speech_list(&f.feed, 0).unwrap().records.is_empty());
}

#[test]
fn incremental_tail_handles_partial_lines_rotation_truncation_and_restart_cursor() {
    let f = Fixture::new();
    f.append("first");
    let mut reader = store::TailReader::new(f.feed.clone(), 1, None).unwrap();
    let first = reader.poll().unwrap();
    assert_eq!(speech(&first), vec!["first"]);
    let cursor = first
        .iter()
        .filter_map(TailEvent::cursor)
        .next_back()
        .unwrap();
    let mut restarted = store::TailReader::new(f.feed.clone(), 10, Some(cursor)).unwrap();
    assert!(speech(&restarted.poll().unwrap()).is_empty());
    OpenOptions::new()
        .append(true)
        .open(&f.feed)
        .unwrap()
        .write_all(b"{\"text\":\"partial\"}")
        .unwrap();
    assert!(speech(&reader.poll().unwrap()).is_empty());
    OpenOptions::new()
        .append(true)
        .open(&f.feed)
        .unwrap()
        .write_all(b"\n")
        .unwrap();
    assert_eq!(speech(&reader.poll().unwrap()), vec!["partial"]);
    fs::rename(&f.feed, f.temp.path().join("old.jsonl")).unwrap();
    f.append("rotated");
    assert_eq!(speech(&reader.poll().unwrap()), vec!["rotated"]);
    fs::write(&f.feed, "{\"text\":\"small\"}\n").unwrap();
    assert_eq!(speech(&reader.poll().unwrap()), vec!["small"]);
}
fn speech(events: &[TailEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(|event| match event {
            TailEvent::Speech { record, .. } => Some(record.text.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn image_listing_metadata_fetch_checksums_and_containment() {
    let f = Fixture::new();
    let id = f.image();
    let (code, value, _) = f.run(&["--json", "image", "list"]);
    assert_eq!(code, 0);
    assert_eq!(value["data"]["hosts"][0]["data"]["records"][0]["id"], id);
    assert!(store::image_bytes(&f.images, "../config.yaml").is_err());
    let output = f.temp.path().join("copy.png");
    assert_eq!(
        f.run(&[
            "--json",
            "image",
            "get",
            &id,
            "--output",
            output.to_str().unwrap()
        ])
        .0,
        0
    );
    assert_eq!(
        fs::read(&output).unwrap(),
        fs::read(f.images.join(&id)).unwrap()
    );
    assert_ne!(
        f.run(&["image", "get", &id, "-o", output.to_str().unwrap()])
            .0,
        0
    );
    fs::write(f.images.join(&id), b"\x89PNG\r\n\x1a\nchanged").unwrap();
    assert!(store::image_bytes(&f.images, &id).is_err());
    fs::remove_file(f.images.join(&id)).unwrap();
    symlink(&output, f.images.join(&id)).unwrap();
    assert!(store::image_bytes(&f.images, &id).is_err());
}

#[test]
fn cli_and_mcp_use_identical_typed_read_handlers() {
    let f = Fixture::new();
    f.append("hello");
    let cli = f.run(&["--json", "tts", "list"]).1;
    let tool = f.run(&["call", "ag_tts_list", "{}"]).1;
    assert_eq!(cli["data"], tool["data"]);
    let mut child = f
        .command()
        .args(["mcp", "stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(concat!(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1\"}}}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"ag_tts_list\",\"arguments\":{}}}\n"
    ).as_bytes()).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let messages: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert!(
        messages[1]["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "ag_image_list")
    );
    assert_eq!(
        messages[2]["result"]["structuredContent"]["data"],
        cli["data"]
    );
    assert_ne!(f.run(&["call", "ag_tts_list", "{\"limit\":1001}"]).0, 0);
    assert_ne!(
        f.run(&["call", "ag_image_info", "{\"id\":\"../../private\"}"])
            .0,
        0
    );
}

#[test]
fn fleet_reads_real_peer_processes_with_quoted_paths_and_partial_failure() {
    let f = Fixture::new();
    f.append("global view");
    f.image();
    let special = f.temp.path().join("feed with '$literal'.jsonl");
    fs::copy(&f.feed, &special).unwrap();
    let ssh = f.ssh("if [ \"$previous\" = down ]; then echo offline >&2; exit 42; fi");
    let mut config = f.remote_config(&ssh, &["healthy", "down"]);
    config.hosts[0].paths.tts_feed = Some(special.display().to_string());
    f.save(&config);
    let (code, value, _) = f.run(&["--json", "tts", "list"]);
    assert_eq!(code, 3);
    assert_eq!(
        value["data"]["hosts"][1]["data"]["records"][0]["text"],
        "global view"
    );
    assert_eq!(
        value["data"]["hosts"][0]["error"]["code"],
        "node_unavailable"
    );
    assert_eq!(
        f.run(&[
            "--json",
            "--host",
            "healthy",
            "image",
            "info",
            "agent/img-test.png"
        ])
        .0,
        0
    );
}

#[test]
fn remote_login_path_and_profile_chatter_preserve_json_binary_and_live_streams() {
    let f = Fixture::new();
    f.append("from remote login PATH");
    let id = f.image();
    let bin_dir = f.temp.path().join("remote profile's bin");
    fs::create_dir(&bin_dir).unwrap();
    symlink(BIN, bin_dir.join("ag")).unwrap();
    fs::write(
        f.temp.path().join(".ag-test-profile"),
        format!(
            "export PATH={}:$PATH\nprintf 'login profile banner\\n'\n",
            ag::transport::shell_quote(bin_dir.to_str().unwrap())
        ),
    )
    .unwrap();
    let special = f
        .temp
        .path()
        .join("feed with '$literal' ; not-a-command.jsonl");
    fs::copy(&f.feed, &special).unwrap();
    let ssh = f.ssh("export PATH=/bin:/usr/bin");
    let mut config = f.remote_config(&ssh, &["remote"]);
    config.hosts[0].command = "ag".into();
    config.hosts[0].paths.tts_feed = Some(special.display().to_string());
    f.save(&config);

    let (code, result, _) = f.run(&["--json", "tts", "list"]);
    assert_eq!(code, 0, "{result}");
    assert_eq!(
        result["data"]["hosts"][0]["data"]["records"][0]["text"],
        "from remote login PATH"
    );
    let output = f.temp.path().join("download.png");
    assert_eq!(
        f.run(&[
            "--json",
            "image",
            "get",
            &id,
            "-o",
            output.to_str().unwrap()
        ])
        .0,
        0
    );
    assert_eq!(
        fs::read(output).unwrap(),
        fs::read(f.images.join(id)).unwrap()
    );

    let mut child = OwnedChild(
        f.command()
            .args(["--json", "tts", "tail"])
            .process_group(0)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let (tx, rx) = mpsc::channel();
    let stdout = child.0.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if tx.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    loop {
        let row: Value = serde_json::from_str(
            &rx.recv_timeout(Duration::from_secs(10))
                .expect("login-initialized stream"),
        )
        .unwrap();
        if row["data"]["type"] == "speech" {
            assert_eq!(row["data"]["record"]["text"], "from remote login PATH");
            break;
        }
        assert_ne!(row["data"]["state"], "offline", "{row}");
    }
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.0.id() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    wait_exit(&mut child.0, 5);
    reader.join().unwrap();
}

#[test]
fn missing_remote_binary_reports_deployment_not_just_path_failure() {
    let f = Fixture::new();
    let ssh = f.ssh("");
    let mut config = f.remote_config(&ssh, &["remote"]);
    config.hosts[0].command = f.temp.path().join("not-installed").display().to_string();
    f.save(&config);
    let (code, result, _) = f.run(&["--json", "tts", "list"]);
    assert_eq!(code, 3);
    let message = result["data"]["hosts"][0]["error"]["message"]
        .as_str()
        .unwrap();
    assert!(message.contains("after login initialization"), "{message}");
    assert!(message.contains("Install ag on this node"), "{message}");
    assert!(message.contains("hosts[].command"), "{message}");
}

#[test]
fn stalled_node_times_out_without_losing_healthy_results() {
    let f = Fixture::new();
    f.append("healthy");
    let pid = f.temp.path().join("slow-pid");
    let ssh = f.ssh(&format!(
        "if [ \"$previous\" = slow ]; then echo $$ > {}; exec sleep 30; fi",
        ag::transport::shell_quote(pid.to_str().unwrap())
    ));
    let mut config = f.remote_config(&ssh, &["healthy", "slow"]);
    config.command_timeout_seconds = 4;
    f.save(&config);
    let started = Instant::now();
    let (code, value, _) = f.run(&["--json", "tts", "list"]);
    assert_eq!(code, 3);
    assert!(started.elapsed() < Duration::from_secs(15));
    assert_eq!(
        value["data"]["hosts"][0]["data"]["records"][0]["text"],
        "healthy"
    );
    assert!(
        value["data"]["hosts"][1]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("timed out")
    );
    let pid = fs::read_to_string(pid).unwrap().trim().parse().unwrap();
    assert!(nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err());
}

#[test]
fn peer_stops_on_stdin_eof_even_when_feed_does_not_exist() {
    let f = Fixture::new();
    let mut child = OwnedChild(
        f.command()
            .args([
                "node",
                "tts",
                "--path",
                f.feed.to_str().unwrap(),
                "--follow",
                "--watch-stdin",
                "--poll-ms",
                "100",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap(),
    );
    drop(child.0.stdin.take());
    wait_exit(&mut child.0, 5);
}

#[test]
fn mute_cli_defaults_to_all_nodes_and_types_and_reports_partial_failure() {
    let f = Fixture::new();
    let ssh = f.ssh("if [ \"$previous\" = down ]; then echo offline >&2; exit 42; fi");
    f.save(&f.remote_config(&ssh, &["one", "two", "down"]));
    let (code, value, _) = f.run(&["--json", "tts", "mute", "--narrate", "--choices"]);
    assert_eq!(code, 3, "{value}");
    for name in ["one", "two"] {
        let state = ag::speech::read_state(&f.temp.path().join(format!("{name}-mute.json")))
            .unwrap()
            .state;
        assert!(state.muted[&ag::speech::SpeechKind::Narrate]);
        assert!(state.muted[&ag::speech::SpeechKind::Choices]);
        assert!(!state.muted[&ag::speech::SpeechKind::Read]);
        assert!(!state.muted[&ag::speech::SpeechKind::Tts]);
    }
    assert_eq!(value["data"]["hosts"][0]["disposition"], "unconfirmed");
    assert_eq!(f.run(&["--host", "one", "--json", "tts", "mute"]).0, 0);
    assert!(
        ag::speech::read_state(&f.temp.path().join("one-mute.json"))
            .unwrap()
            .state
            .muted
            .values()
            .all(|v| *v)
    );
    assert_eq!(
        f.run(&["--host", "one", "--json", "tts", "unmute", "--read"])
            .0,
        0
    );
    assert!(
        ag::speech::read_state(&f.temp.path().join("one-mute.json"))
            .unwrap()
            .state
            .muted[&ag::speech::SpeechKind::Tts]
    );
    assert_eq!(f.run(&["--json", "tts", "unmute"]).0, 3);
    for name in ["one", "two"] {
        assert!(
            ag::speech::read_state(&f.temp.path().join(format!("{name}-mute.json")))
                .unwrap()
                .state
                .muted
                .values()
                .all(|v| !v)
        );
    }
    let status = f.run(&["--host", "two", "--json", "tts", "status"]);
    assert_eq!(status.0, 0);
    assert_eq!(status.1["data"]["hosts"][0]["disposition"], "observed");
    let local = f.temp.path().join("local-mute.json");
    assert_eq!(
        f.run(&[
            "--local",
            "--mute-state",
            local.to_str().unwrap(),
            "tts",
            "mute",
            "--tts"
        ])
        .0,
        0
    );
    let state = ag::speech::read_state(&local).unwrap().state;
    assert!(state.muted[&ag::speech::SpeechKind::Tts]);
    assert!(!state.muted[&ag::speech::SpeechKind::Choices]);
}

#[test]
fn speech_mcp_confirmation_and_cli_share_one_policy() {
    let f = Fixture::new();
    let path = f.temp.path().join("mute.json");
    assert_ne!(
        f.run(&["call", "ag_tts_mute", "{\"kinds\":[\"read\"]}"]).0,
        0
    );
    assert!(!path.exists());
    assert_eq!(
        f.run(&[
            "call",
            "ag_tts_mute",
            "{\"kinds\":[\"read\"],\"confirmed\":true}"
        ])
        .0,
        0
    );
    let cli = f.run(&["--json", "tts", "status"]).1;
    let mcp = f.run(&["call", "ag_tts_status", "{}"]).1;
    assert_eq!(cli["data"], mcp["data"]);
    assert_eq!(
        cli["data"]["hosts"][0]["data"]["state"]["muted"]["read"],
        true
    );
    assert_eq!(
        f.run(&["call", "ag_tts_unmute", "{\"confirmed\":true}"]).0,
        0
    );
    assert!(
        ag::speech::read_state(&path)
            .unwrap()
            .state
            .muted
            .values()
            .all(|v| !v)
    );
}

struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn wait_exit(child: &mut Child, seconds: u64) {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    loop {
        if child.try_wait().unwrap().is_some() {
            return;
        }
        assert!(Instant::now() < deadline, "process failed to stop");
        std::thread::sleep(Duration::from_millis(20));
    }
}
#[test]
fn live_fanout_reconnects_without_replay_and_ctrl_c_reaps_ssh_peers() {
    let f = Fixture::new();
    f.append("before-disconnect");
    let meta = fs::metadata(&f.feed).unwrap();
    let cursor = Cursor {
        device: meta.dev(),
        inode: meta.ino(),
        offset: meta.len(),
    };
    let event = TailEvent::Speech {
        record: serde_json::from_str(&line("before-disconnect")).unwrap(),
        cursor,
    };
    let event_path = f.temp.path().join("first-event");
    fs::write(
        &event_path,
        format!("{}\n", serde_json::to_string(&event).unwrap()),
    )
    .unwrap();
    let marker = f.temp.path().join("connected");
    let pid_log = f.temp.path().join("pids");
    let args_log = f.temp.path().join("args");
    let quote = ag::transport::shell_quote;
    let ssh = f.ssh(&format!("echo $$ >> {}\nprintf '%s\\n' \"$last\" >> {}\nif [ ! -f {} ]; then touch {}; cat {}; exit 75; fi", quote(pid_log.to_str().unwrap()), quote(args_log.to_str().unwrap()), quote(marker.to_str().unwrap()), quote(marker.to_str().unwrap()), quote(event_path.to_str().unwrap())));
    f.save(&f.remote_config(&ssh, &["flaky"]));
    let mut child = OwnedChild(
        f.command()
            .args(["--json", "tts", "tail"])
            .process_group(0)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let stdout = child.0.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if tx.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    let mut seen = vec![];
    loop {
        let text = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("first stream event");
        let event: Value = serde_json::from_str(&text).unwrap();
        if event["data"]["type"] == "speech" {
            seen.push(event["data"]["record"]["text"].as_str().unwrap().to_owned());
            break;
        }
    }
    f.append("after-reconnect");
    while !seen.iter().any(|s| s == "after-reconnect") {
        let event: Value = serde_json::from_str(
            &rx.recv_timeout(Duration::from_secs(10))
                .expect("reconnected stream event"),
        )
        .unwrap();
        if event["data"]["type"] == "speech" {
            seen.push(event["data"]["record"]["text"].as_str().unwrap().to_owned());
        }
    }
    assert_eq!(seen, ["before-disconnect", "after-reconnect"]);
    assert!(fs::read_to_string(args_log).unwrap().contains("--cursor"));
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.0.id() as i32),
        nix::sys::signal::Signal::SIGINT,
    )
    .unwrap();
    wait_exit(&mut child.0, 5);
    reader.join().unwrap();
    for pid in fs::read_to_string(pid_log).unwrap().lines() {
        assert!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid.parse().unwrap()), None).is_err(),
            "SSH peer leaked after Ctrl-C"
        );
    }
}
