//! Actual ag process, HTTP/SSE, local append/rotation and real ag node tail via
//! an isolated SSH exec adapter. No fleet sockets, audio or operator state.
use serde_json::{Value, json};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    os::unix::fs::PermissionsExt,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
const BIN: &str = env!("CARGO_BIN_EXE_ag");
struct Server {
    child: Child,
    dir: tempfile::TempDir,
    address: String,
    cookie: String,
}
impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn line(text: &str) -> String {
    format!(
        "{}\n",
        json!({"text":text,"agent":"fixture-agent","timestamp":"2026-10-07T08:09:09Z","kind":"tts"})
    )
}
impl Server {
    fn new(extra: &[&str]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let ssh = root.join("ssh");
        // Absolute interpreter: /usr/bin/env does not exist in Linux Nix sandboxes.
        let python = std::env::var_os("PATH")
            .and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|dir| dir.join("python3"))
                    .find(|candidate| candidate.is_file())
            })
            .expect("python3 on PATH for the fake SSH peer");
        fs::write(&ssh, format!(r#"#!{python}
import os,sys
host=sys.argv[sys.argv.index('--')+1]
if host in ['down','denied']:
    print('Connection refused' if host=='down' else 'Permission denied (publickey)', file=sys.stderr)
    sys.exit(255)
if '--watch-stdin' in sys.argv[-1]:
    with open({log:?},'a') as f: f.write(str(os.getpid())+'\n')
os.execv('/bin/sh',['sh','-c',sys.argv[-1]])
"#,python=python.display(),log=root.join("tails.log").display().to_string())).unwrap();
        fs::set_permissions(&ssh, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(root.join("local.jsonl"), line("initial local")).unwrap();
        fs::write(root.join("remote.jsonl"), line("initial remote")).unwrap();
        let config = json!({"version":1,"ssh_command":ssh,"poll_ms":100,"reconnect_seconds":1,"command_timeout_seconds":2,
            "paratenic":{"enabled":false},"paths":{"tts_mute":root.join("mute.json"),"image_dir":root.join("images")},
            "hosts":[{"name":"local","local":true,"paths":{"tts_feed":root.join("local.jsonl")}},
                {"name":"remote","address":"remote","command":BIN,"paths":{"tts_feed":root.join("remote.jsonl")}},
                {"name":"down","address":"down"},{"name":"denied","address":"denied"}]});
        fs::write(root.join("config.json"), config.to_string()).unwrap();
        let mut command = Command::new(BIN);
        command
            .env("HOME", root)
            .env("XDG_STATE_HOME", root.join("state"))
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_CACHE_HOME", root.join("cache"))
            .env("SHELL", "/bin/sh")
            .env_remove("PI_AGENT_UTILS_STATE_DIR")
            .env_remove("PI_TTS_FEED_PATH")
            .env_remove("PI_TTS_MUTE_PATH")
            .env_remove("AG_STATE_DIR")
            .args(["--json", "--config"])
            .arg(root.join("config.json"))
            .args([
                "dash",
                "--no-open",
                "--no-images",
                "--no-audio",
                "--bind",
                "127.0.0.1:0",
            ])
            .args(extra)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        let ready: Value = serde_json::from_str(&ready).unwrap();
        let address = ready["data"]["address"]
            .as_str()
            .expect("dash ready")
            .to_owned();
        let url = url::Url::parse(ready["data"]["url"].as_str().unwrap()).unwrap();
        let token = url
            .query_pairs()
            .find(|(k, _)| k == "token")
            .unwrap()
            .1
            .to_string();
        let cookie = format!("ag_dash_{}={token}", url.port().unwrap());
        Self {
            child,
            dir,
            address,
            cookie,
        }
    }
    fn request(&self, path: &str, headers: &str, auth: bool) -> (String, BufReader<TcpStream>) {
        let mut stream = TcpStream::connect(&self.address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            stream,
            "GET {path} HTTP/1.0\r\nHost: {}\r\nCookie: {}\r\n{headers}\r\n",
            self.address,
            if auth { &self.cookie } else { "" }
        )
        .unwrap();
        let mut reader = BufReader::new(stream);
        let mut head = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(!line.is_empty());
            head.push_str(&line);
            if line == "\r\n" {
                break;
            }
        }
        (head, reader)
    }
    fn snapshot(&self) -> Value {
        let (head, mut reader) = self.request("/api/tts", "", true);
        assert!(head.contains("200 OK"), "{head}");
        let mut body = String::new();
        reader.read_to_string(&mut body).unwrap();
        serde_json::from_str(&body).unwrap()
    }
    fn wait(&self, predicate: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            let state = self.snapshot();
            if predicate(&state) {
                return state;
            }
            assert!(Instant::now() < deadline, "{state}");
            std::thread::sleep(Duration::from_millis(30))
        }
    }
    fn append(&self, host: &str, text: &str) {
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(self.dir.path().join(format!("{host}.jsonl")))
            .unwrap();
        file.write_all(line(text).as_bytes()).unwrap();
    }
    fn tail_pids(&self) -> Vec<i32> {
        fs::read_to_string(self.dir.path().join("tails.log"))
            .unwrap_or_default()
            .lines()
            .map(|v| v.parse().unwrap())
            .collect()
    }
    fn stop(&mut self) {
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(self.child.id() as i32),
            nix::sys::signal::Signal::SIGTERM,
        )
        .unwrap();
        let start = Instant::now();
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(start.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(20))
        }
        assert!(TcpStream::connect(&self.address).is_err());
        for pid in self.tail_pids() {
            assert!(
                nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err(),
                "tail child {pid} leaked"
            )
        }
    }
}
fn event(reader: &mut BufReader<TcpStream>) -> (String, String, Value) {
    let (mut kind, mut id, mut body) = (String::new(), String::new(), String::new());
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(!line.is_empty(), "SSE closed unexpectedly");
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() && !body.is_empty() {
            return (kind, id, serde_json::from_str(&body).unwrap());
        }
        if let Some(v) = line.strip_prefix("event: ") {
            kind = v.into()
        }
        if let Some(v) = line.strip_prefix("id: ") {
            id = v.into()
        }
        if let Some(v) = line.strip_prefix("data: ") {
            body.push_str(v)
        }
    }
}
fn speech(reader: &mut BufReader<TcpStream>, text: &str) -> String {
    for _ in 0..30 {
        let (_, id, v) = event(reader);
        if v["record"]["text"] == text {
            return id;
        }
    }
    panic!("speech not delivered")
}
#[test]
fn one_collector_fans_out_replays_rotates_and_stops_with_open_sse() {
    let mut server = Server::new(&[]);
    // Both failing nodes report independently: wait for each.
    let initial = server.wait(|v| {
        let nodes = v["nodes"].as_array().unwrap();
        v["records"].as_array().is_some_and(|r| r.len() == 2)
            && nodes.iter().any(|n| n["state"] == "error")
            && nodes
                .iter()
                .any(|n| n["host"] == "down" && n["state"] == "offline")
    });
    assert_eq!(initial["subscribers"], 0);
    assert!(
        initial["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["host"] == "down" && n["state"] == "offline")
    );
    server.append("local", "without browsers");
    server.wait(|v| v["received_speech"] == 3);
    let (head, mut a) = server.request("/api/tts/events", "", true);
    assert!(head.contains("text/event-stream"));
    assert!(head.contains("no-store"));
    assert!(head.contains("x-accel-buffering: no"));
    let (kind, _, snapshot) = event(&mut a);
    assert_eq!(kind, "snapshot");
    assert_eq!(snapshot["records"].as_array().unwrap().len(), 3);
    let (_, mut b) = server.request("/api/tts/events", "", true);
    event(&mut b);
    let start = Instant::now();
    server.append("remote", "shared new speech");
    let last = speech(&mut a, "shared new speech");
    assert_eq!(speech(&mut b, "shared new speech"), last);
    assert!(start.elapsed() < Duration::from_millis(1500));
    assert_eq!(
        server.tail_pids().len(),
        1,
        "browsers started duplicate tails"
    );
    drop(a);
    server.append("local", "missed while away");
    server.wait(|v| v["received_speech"] == 5);
    let (_, mut resumed) = server.request(
        "/api/tts/events",
        &format!("Last-Event-ID: {last}\r\n"),
        true,
    );
    let (kind, _, data) = event(&mut resumed);
    assert_eq!(kind, "feed");
    assert_eq!(data["record"]["text"], "missed while away");
    // Atomic rename changes inode and reuses the same collector/HTTP stream.
    let replacement = server.dir.path().join("replace");
    fs::write(&replacement, line("rotated")).unwrap();
    fs::rename(replacement, server.dir.path().join("remote.jsonl")).unwrap();
    speech(&mut b, "rotated");
    assert_eq!(server.tail_pids().len(), 1);
    server.stop();
    let mut rest = String::new();
    b.read_to_string(&mut rest).unwrap();
}
#[test]
fn expired_restart_cursors_and_large_messages_are_explicit_and_bounded() {
    let mut server = Server::new(&[]);
    let old = server.wait(|v| v["received_speech"] == 2)["event_id"]
        .as_str()
        .unwrap()
        .to_owned();
    for i in 0..600 {
        server.append("local", &format!("message {i}"));
    }
    let state = server.wait(|v| v["received_speech"].as_u64().unwrap() >= 602);
    assert!(state["retained_events"].as_u64().unwrap() <= 500);
    let (_, mut sse) = server.request(&format!("/api/tts/events?after={old}"), "", true);
    let (kind, _, snapshot) = event(&mut sse);
    assert_eq!(kind, "snapshot");
    assert_eq!(snapshot["reason"], "expired");
    let (_, mut reset) =
        server.request("/api/tts/events", "Last-Event-ID: old-process:22\r\n", true);
    let (_, _, snapshot) = event(&mut reset);
    assert_eq!(snapshot["reason"], "restarted");
    server.append("local", &"世".repeat(20000));
    let state = server.wait(|v| {
        v["records"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["record"]["truncated"] == true)
    });
    let r = state["records"].as_array().unwrap().last().unwrap();
    assert!(r["record"]["text"].as_str().unwrap().len() <= 16384);
    assert!(state["retained_bytes"].as_u64().unwrap() <= 2097152);
    server.stop();
}
#[test]
fn zero_history_follows_only_new_appends_and_config_limits_are_validated() {
    use configurable_cli::AppConfig;
    let mut config = ag::config::Config::default();
    config.dash.tts_lines = 1001;
    assert!(config.validate().is_err());
    config.dash.tts_lines = 0;
    config.dash.tts = false;
    assert!(config.validate().is_ok());
    let mut server = Server::new(&["--tts-lines", "0"]);
    let initial = server.wait(|v| {
        v["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|n| n["state"] == "connected")
            .count()
            == 2
    });
    assert_eq!(initial["received_speech"], 0);
    server.append("local", "new only");
    server.wait(|v| v["received_speech"] == 1);
    server.stop();
}

#[test]
fn stalled_sse_reader_cannot_block_collection_other_routes_or_shutdown() {
    let mut server = Server::new(&[]);
    server.wait(|v| v["received_speech"] == 2);
    for _ in 0..160 {
        server.append("local", &"x".repeat(16384));
    }
    server.wait(|v| v["received_speech"] == 162);
    // Leave the multi-MiB initial snapshot unread, filling its TCP window.
    let (_, _stalled) = server.request("/api/tts/events", "", true);
    server.append("local", "healthy while another viewer is stalled");
    let start = Instant::now();
    server.wait(|v| v["received_speech"] == 163);
    let (headers, _) = server.request("/api/state", "", true);
    assert!(headers.contains("200 OK"));
    assert!(start.elapsed() < Duration::from_millis(1500));
    server.stop();
}

#[test]
fn authorization_connection_limit_and_opt_out() {
    let mut server = Server::new(&["--no-tts"]);
    for path in ["/api/tts", "/api/tts/events", "/tts.js"] {
        let (head, _) = server.request(path, "", false);
        assert!(head.contains("401 Unauthorized"))
    }
    let (head, _) = server.request("/api/tts/events", "Origin: http://evil.test\r\n", true);
    assert!(head.contains("403 Forbidden"));
    let state = server.snapshot();
    assert_eq!(state["enabled"], false);
    assert_eq!(state["running"], false);
    assert_eq!(state["received_speech"], 0);
    let mut streams = vec![];
    for _ in 0..32 {
        let (head, mut stream) = server.request("/api/tts/events", "", true);
        assert!(head.contains("200 OK"));
        event(&mut stream);
        streams.push(stream)
    }
    let (head, _) = server.request("/api/tts/events", "", true);
    assert!(head.contains("503 Service Unavailable"));
    assert_eq!(server.snapshot()["subscribers"], 32);
    assert!(server.tail_pids().is_empty());
    streams.clear();
    server.wait(|v| v["subscribers"] == 0);
    server.stop();
}
