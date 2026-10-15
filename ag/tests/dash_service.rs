//! Service-facing behavior without live hosts or activation. An unconfigured
//! local target prevents fleet network calls; no image pull or browser opens.
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
    os::unix::fs::{PermissionsExt, symlink},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
const BIN: &str = env!("CARGO_BIN_EXE_ag");

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn get(address: &str, path: &str, host: &str, cookie: &str) -> String {
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nCookie: {cookie}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut data = String::new();
    stream.read_to_string(&mut data).unwrap();
    data
}
fn stop(server: &mut Running) {
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(server.0.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(exit) = server.0.try_wait().unwrap() {
            assert!(exit.success());
            return;
        }
        assert!(Instant::now() < deadline, "SIGTERM did not stop dash");
        std::thread::sleep(Duration::from_millis(30));
    }
}

#[test]
fn persistent_token_public_hostname_and_service_sigterm() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.yaml");
    // Explicitly disable Paratenic, no Culture lookup, no SSH hosts.
    fs::write(&config, "version: 1\nparatenic:\n  enabled: false\n").unwrap();
    let token_path = dir.path().join("private/dash-token");
    let origin = "http://helsinki.example.test:7795";
    let mut previous = String::new();
    for attempt in 0..2 {
        let mut server = Running(
            Command::new(BIN)
                .env("HOME", dir.path())
                .env("XDG_STATE_HOME", dir.path().join("state"))
                .env("XDG_CONFIG_HOME", dir.path().join("config"))
                .env("XDG_CACHE_HOME", dir.path().join("cache"))
                .env_remove("PI_AGENT_UTILS_STATE_DIR")
                .env_remove("PI_TTS_MUTE_PATH")
                .env_remove("PI_TTS_FEED_PATH")
                .args(["--json", "--config"])
                .arg(&config)
                .args([
                    "dash",
                    "--no-images",
                    "--no-audio",
                    "--no-open",
                    "--bind",
                    "127.0.0.1:0",
                    "--public-origin",
                    origin,
                    "--token-file",
                ])
                .arg(&token_path)
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let mut line = String::new();
        BufReader::new(server.0.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let ready: Value = serde_json::from_str(&line).unwrap();
        let data = &ready["data"];
        let address = data["address"].as_str().unwrap();
        assert_eq!(data["url"], format!("{origin}/"));
        assert_eq!(data["token_file"], token_path.display().to_string());
        let token = fs::read_to_string(&token_path).unwrap().trim().to_owned();
        assert_eq!(token.len(), 64);
        assert!(
            !line.contains(&token),
            "service logs must not contain the persistent secret"
        );
        assert_eq!(
            fs::metadata(&token_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        if attempt == 1 {
            assert_eq!(token, previous, "restart rotated token");
        }
        previous = token.clone();
        let named = "helsinki.example.test:7795";
        assert!(get(address, "/", named, "").starts_with("HTTP/1.1 401"));
        let bootstrap = get(address, &format!("/?token={token}"), named, "");
        assert!(bootstrap.starts_with("HTTP/1.1 303"), "{bootstrap}");
        assert!(
            bootstrap
                .to_lowercase()
                .contains("referrer-policy: no-referrer")
        );
        let cookie = bootstrap
            .lines()
            .find(|l| l.to_lowercase().starts_with("set-cookie:"))
            .unwrap()
            .split_once(':')
            .unwrap()
            .1
            .trim()
            .split(';')
            .next()
            .unwrap();
        assert!(get(address, "/", named, cookie).starts_with("HTTP/1.1 200"));
        assert!(get(address, "/api/state", named, cookie).starts_with("HTTP/1.1 200"));
        assert!(get(address, "/", "other.example.test:7795", cookie).starts_with("HTTP/1.1 421"));
        stop(&mut server);
        assert!(
            TcpStream::connect(address).is_err(),
            "listener leaked after SIGTERM"
        );
    }
}

#[test]
fn public_origin_validation_and_port_default() {
    assert_eq!(ag::config::DashConfig::default().bind, "127.0.0.1:7795");
    for origin in [
        "http://helsinki.example.test:7795",
        "https://dash.example.test/",
        "http://[::1]:7795",
    ] {
        assert!(ag::dash::validate_public_origin(origin).is_ok(), "{origin}");
    }
    for origin in [
        "ftp://host",
        "http://user:secret@host",
        "http://host/path",
        "http://host/?token=secret",
        "http://host/#fragment",
        "http://ho\nst",
    ] {
        assert!(
            ag::dash::validate_public_origin(origin).is_err(),
            "{origin}"
        );
    }
}

#[test]
fn token_symlinks_are_preserved_and_unsafe_files_fail_without_disclosure() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.yaml");
    fs::write(&config, "paratenic: { enabled: false }\n").unwrap();
    let target = dir.path().join("secret");
    let link = dir.path().join("managed-link");
    let secret = "fixture-token-with-at-least-thirty-two-characters";
    fs::write(&target, secret).unwrap();
    fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    symlink(&target, &link).unwrap();
    let command = || {
        let mut c = Command::new(BIN);
        c.env("HOME", dir.path())
            .env("XDG_STATE_HOME", dir.path().join("state"))
            .env("XDG_CONFIG_HOME", dir.path().join("config"))
            .env("XDG_CACHE_HOME", dir.path().join("cache"))
            .env_remove("PI_AGENT_UTILS_STATE_DIR")
            .env_remove("PI_TTS_MUTE_PATH")
            .env_remove("PI_TTS_FEED_PATH")
            .args(["--json", "--config"])
            .arg(&config)
            .args([
                "dash",
                "--no-open",
                "--no-images",
                "--no-audio",
                "--bind",
                "127.0.0.1:0",
                "--token-file",
            ])
            .arg(&link);
        c
    };
    let mut running = Running(
        command()
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut line = String::new();
    BufReader::new(running.0.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert!(line.contains("success"));
    assert!(!line.contains(secret));
    stop(&mut running);
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), secret);
    fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
    let output = command().output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("owner-private"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains(secret));
    fs::remove_file(&target).unwrap();
    let output = command().output().unwrap();
    assert!(!output.status.success());
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert!(!target.exists());
}
