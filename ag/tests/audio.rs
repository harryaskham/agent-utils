use ag::{
    config::{Config, Host, Paths},
    gallery::{GalleryInput, SyncInput, host_key, remote_media_rsync},
    model::MediaKind,
    service::Service,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::Path,
    process::Command,
};

fn wav(seconds: f64) -> Vec<u8> {
    let data = vec![1u8; (seconds * 8000.0) as usize * 2];
    let mut out = b"RIFF".to_vec();
    out.extend((36 + data.len() as u32).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(8000u32.to_le_bytes());
    out.extend(16000u32.to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend((data.len() as u32).to_le_bytes());
    out.extend(data);
    out
}
fn clip(root: &Path, name: &str, bytes: &[u8], mime: &str, extra: Value) -> String {
    let id = format!("agent/{name}");
    fs::create_dir_all(root.join("agent")).unwrap();
    fs::write(root.join(&id), bytes).unwrap();
    let mut meta = json!({"version":1,"id":id,"agent":"agent","sha256":format!("{:x}",Sha256::digest(bytes)),"bytes":bytes.len(),"mimeType":mime,"timestamp":"2026-10-14T00:00:00Z","source":{"label":"label"}});
    meta.as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    fs::write(root.join(format!("{id}.json")), meta.to_string()).unwrap();
    id
}
fn image(root: &Path, number: usize) {
    let id = format!("agent/img-{number:05}.png");
    fs::create_dir_all(root.join("agent")).unwrap();
    let bytes = b"\x89PNG\r\n\x1a\nfixture";
    fs::write(root.join(&id), bytes).unwrap();
    fs::write(root.join(format!("{id}.json")), json!({"version":1,"id":id,"agent":"agent","sha256":format!("{:x}",Sha256::digest(bytes)),"bytes":bytes.len(),"mimeType":"image/png","timestamp":"2026-09-23T00:00:00Z","source":{"label":"img"}}).to_string()).unwrap();
}
fn config(root: &Path, images: &Path, audio: &Path) -> Config {
    let mut config = Config {
        paths: Paths {
            image_dir: Some(images.to_string_lossy().into()),
            audio_dir: Some(audio.to_string_lossy().into()),
            ..Paths::default()
        },
        ..Config::default()
    };
    config.gallery.cache_dir = Some(root.join("cache/images").to_string_lossy().into());
    config.gallery.audio_cache_dir = Some(root.join("cache/audio").to_string_lossy().into());
    config
}
fn manifest(path: &Path) -> Value {
    let html = fs::read_to_string(path).unwrap();
    let json = html
        .split("id=\"manifest\">")
        .nth(1)
        .unwrap()
        .split("</script>")
        .next()
        .unwrap();
    serde_json::from_str(json).unwrap()
}
fn input() -> GalleryInput {
    GalleryInput {
        confirmed: true,
        ..GalleryInput::default()
    }
}

#[test]
fn audio_pull_catalogs_valid_clips_with_metadata_and_rejects_everything_else() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("audio");
    let good = clip(
        &source,
        "aud-good.wav",
        &wav(1.5),
        "audio/wav",
        json!({"title":"</script><script>bad()</script>","description":"a riff","durationMs":1500}),
    );
    clip(
        &source,
        "aud-corrupt.wav",
        &wav(1.0),
        "audio/wav",
        json!({}),
    );
    fs::write(source.join("agent/aud-corrupt.wav"), b"tampered!").unwrap();
    clip(
        &source,
        "img-smuggled.png",
        b"\x89PNG\r\n\x1a\n",
        "image/png",
        json!({}),
    );
    symlink("/etc/passwd", source.join("agent/aud-link.wav")).unwrap();
    symlink(root.path(), source.join("escape")).unwrap();
    let service = Service::new(
        config(root.path(), &root.path().join("images"), &source),
        None,
    )
    .unwrap();
    assert!(service.audio_gallery(GalleryInput::default()).is_err());
    let receipt = service.audio_gallery(input()).unwrap();
    assert_eq!(receipt.clips, 1, "{receipt:?}");
    assert_eq!(receipt.hosts[0].state, "synced");
    assert_eq!(receipt.hosts[0].invalid, 2, "checksum + non-audio mime");
    assert_eq!(receipt.duration_ms, 1500);
    let html = fs::read_to_string(&receipt.index).unwrap();
    assert!(!html.contains("</script><script>bad()"));
    assert!(html.contains("media-src 'self' file:"));
    let data = manifest(&receipt.index);
    let first = &data["clips"][0];
    assert_eq!(first["id"], good);
    assert_eq!(first["title"], "</script><script>bad()</script>");
    assert_eq!(first["description"], "a riff");
    assert_eq!(first["duration_ms"], 1500);
    assert_eq!(first["mime_type"], "audio/wav");
    let cached = receipt.cache_dir.join(first["src"].as_str().unwrap());
    assert_eq!(fs::read(cached).unwrap(), wav(1.5));
    assert_eq!(
        fs::metadata(&receipt.index).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // Offline reads the cache after the source disappears; failures retain it.
    fs::rename(&source, root.path().join("gone")).unwrap();
    let offline = service
        .audio_gallery(GalleryInput {
            offline: true,
            ..input()
        })
        .unwrap();
    assert_eq!(
        (offline.clips, offline.hosts[0].state.as_str()),
        (1, "cached")
    );
    let failed = service.audio_gallery(input()).unwrap();
    assert_eq!(
        (failed.clips, failed.hosts[0].state.as_str()),
        (1, "unavailable")
    );
}

#[test]
fn audio_and_image_caches_are_keyed_and_located_independently() {
    let host = Host {
        paths: Paths {
            image_dir: Some("~/i".into()),
            audio_dir: Some("~/a".into()),
            ..Paths::default()
        },
        ..Host::default()
    };
    assert_ne!(
        host_key(MediaKind::Image, &host),
        host_key(MediaKind::Audio, &host)
    );
    let helper = remote_media_rsync(MediaKind::Audio, &Host::default());
    assert!(helper.contains("PI_SHARED_AUDIO_DIR") && helper.contains("/audio}"));
    assert!(
        remote_media_rsync(MediaKind::Image, &Host::default()).contains("PI_SHARED_IMAGES_DIR")
    );
    let configured = remote_media_rsync(MediaKind::Audio, &host);
    assert!(configured.contains("~/a") && !configured.contains("PI_SHARED_AUDIO_DIR"));
}

#[test]
fn sync_runs_every_pathway_and_isolates_a_locked_one() {
    let root = tempfile::tempdir().unwrap();
    let images = root.path().join("images");
    let audio = root.path().join("audio");
    image(&images, 0);
    image(&images, 1);
    clip(
        &audio,
        "aud-a.wav",
        &wav(0.5),
        "audio/wav",
        json!({"durationMs": 500}),
    );
    let service = Service::new(config(root.path(), &images, &audio), None).unwrap();
    assert!(
        service.sync(SyncInput::default()).is_err(),
        "needs confirmation"
    );
    let all = service
        .sync(SyncInput {
            confirmed: true,
            ..SyncInput::default()
        })
        .unwrap();
    assert_eq!(all.images.as_ref().unwrap().images, 2);
    assert_eq!(all.audio.as_ref().unwrap().clips, 1);
    assert!(all.errors.is_empty() && !all.partial());
    let only = service
        .sync(SyncInput {
            confirmed: true,
            kinds: vec![MediaKind::Audio],
            ..SyncInput::default()
        })
        .unwrap();
    assert!(only.images.is_none() && only.audio.is_some());
    // Another writer holds the image cache: audio still syncs.
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join("cache/images/gallery.lock"))
        .unwrap();
    let _held = nix::fcntl::Flock::lock(lock, nix::fcntl::FlockArg::LockExclusiveNonblock).unwrap();
    let partial = service
        .sync(SyncInput {
            confirmed: true,
            ..SyncInput::default()
        })
        .unwrap();
    assert!(partial.images.is_none());
    assert!(partial.errors["image"].contains("another image pull"));
    assert_eq!(partial.audio.unwrap().clips, 1);
}

fn executable(path: &Path, contents: &str) {
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn audio_cli_lists_gets_syncs_plays_and_mcp_requires_confirmation() {
    let root = tempfile::tempdir().unwrap();
    let images = root.path().join("images");
    let audio = root.path().join("audio");
    image(&images, 0);
    let id = clip(
        &audio,
        "aud-song.wav",
        &wav(2.0),
        "audio/wav",
        json!({"title":"Song","durationMs":2000}),
    );
    let cfg = root.path().join("config.yaml");
    ag::config::manager()
        .save(&cfg, &config(root.path(), &images, &audio))
        .unwrap();
    let bins = root.path().join("bin");
    fs::create_dir(&bins).unwrap();
    let opened = root.path().join("opened");
    let log = root.path().join("log");
    let open = format!("#!/bin/sh\nprintf '%s' \"$1\" > '{}'\n", opened.display());
    executable(&bins.join("open"), &open);
    executable(&bins.join("xdg-open"), &open);
    // Fake decoder/sink: record argv and the PCM byte count reaching the sink.
    executable(
        &bins.join("ffmpeg"),
        &format!(
            "#!/bin/sh\necho \"ffmpeg $*\" >> '{0}'\nhead -c 4000 /dev/zero\n",
            log.display()
        ),
    );
    executable(
        &bins.join("pacat"),
        &format!(
            "#!/bin/sh\necho \"pacat $* PULSE_SERVER=${{PULSE_SERVER:-}} bytes=$(wc -c | tr -d ' ')\" >> '{0}'\n",
            log.display()
        ),
    );
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_ag"))
            .env(
                "PATH",
                format!("{}:{}", bins.display(), std::env::var("PATH").unwrap()),
            )
            .env("PULSE_SERVER", "tcp:inherited:4713")
            .env_remove("PI_AUDIO_BACKEND")
            .env_remove("PI_AUDIO_SERVER")
            .env_remove("PI_AUDIO_SINK")
            .env_remove("PULSE_SINK")
            .args(["--config", cfg.to_str().unwrap()])
            .args(args)
            .output()
            .unwrap()
    };
    let ok = |args: &[&str]| -> Value {
        let out = run(args);
        assert!(
            out.status.success(),
            "{args:?}: {}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap_or(Value::Null)
    };
    let listing = ok(&["--json", "audio", "list"]);
    assert_eq!(listing["data"]["hosts"][0]["data"]["records"][0]["id"], id);
    assert_eq!(
        listing["data"]["hosts"][0]["data"]["records"][0]["title"],
        "Song"
    );
    let human = run(&["audio", "list"]);
    assert!(String::from_utf8_lossy(&human.stdout).contains("· Song (0:02 · "));
    assert_eq!(
        ok(&["--json", "audio", "info", &id])["data"]["durationMs"],
        2000
    );
    let copy = root.path().join("copy.wav");
    ok(&["--json", "audio", "get", &id, "-o", copy.to_str().unwrap()]);
    assert_eq!(fs::read(&copy).unwrap(), wav(2.0));
    assert!(
        !run(&["audio", "get", &id, "-o", copy.to_str().unwrap()])
            .status
            .success(),
        "never overwrites"
    );

    let receipt = ok(&["--json", "audio"]);
    assert_eq!(receipt["data"]["clips"], 1);
    assert!(!opened.exists(), "JSON must not open a browser");
    assert!(run(&["audio", "--offline"]).status.success());
    assert_eq!(
        fs::read_to_string(&opened).unwrap(),
        receipt["data"]["index"].as_str().unwrap()
    );
    let synced = ok(&["--json", "sync"]);
    assert_eq!(synced["data"]["images"]["images"], 1);
    assert_eq!(synced["data"]["audio"]["clips"], 1);
    let audio_only = ok(&["--json", "sync", "--audio", "--offline"]);
    assert!(audio_only["data"]["images"].is_null());
    let human = run(&["sync", "--offline"]);
    let stdout = String::from_utf8_lossy(&human.stdout);
    assert!(
        stdout.contains("1 images") && stdout.contains("1 audio clips · 0:02"),
        "{stdout}"
    );

    // MCP parity: confirmation-gated writes, read tools without.
    assert!(!run(&["call", "ag_sync", "{}"]).status.success());
    assert!(!run(&["call", "ag_audio_pull", "{}"]).status.success());
    assert!(
        run(&[
            "call",
            "ag_audio_pull",
            r#"{"confirmed":true,"offline":true}"#
        ])
        .status
        .success()
    );
    assert!(
        run(&[
            "call",
            "ag_sync",
            r#"{"confirmed":true,"offline":true,"kinds":["audio"]}"#
        ])
        .status
        .success()
    );
    assert!(run(&["call", "ag_audio_list", "{}"]).status.success());
    let tools = String::from_utf8_lossy(&run(&["tools"]).stdout).into_owned();
    for tool in ["ag_audio_pull", "ag_audio_list", "ag_audio_info", "ag_sync"] {
        assert!(tools.contains(tool), "{tool}");
    }

    // Local playback from the verified cache through routed Pulse.
    let played = ok(&[
        "--json", "audio", "play", &id, "--sink", "studio", "--volume", "50", "--start", "0.5",
    ]);
    assert_eq!(played["data"]["completed"], true);
    assert_eq!(played["data"]["output"]["backend"], "pulse");
    assert!(
        played["data"]["source"]
            .as_str()
            .unwrap()
            .starts_with("cache:")
    );
    let calls = fs::read_to_string(&log).unwrap();
    assert!(
        calls.contains("-ss 0.500") && calls.contains("volume=0.500"),
        "{calls}"
    );
    assert!(
        calls.contains("--device=studio") && calls.contains("--server=tcp:inherited:4713"),
        "{calls}"
    );
    assert!(
        calls.contains("PULSE_SERVER=tcp:inherited:4713 bytes=4000"),
        "{calls}"
    );
    assert!(calls.contains("--stream-name=Song"), "{calls}");
    let missing = run(&[
        "audio",
        "play",
        "agent/aud-nope.wav",
        "--cache-dir",
        root.path().join("empty").to_str().unwrap(),
    ]);
    assert!(!missing.status.success());
    let bad = run(&["audio", "play", &id, "--backend", "alsa-direct"]);
    assert!(String::from_utf8_lossy(&bad.stderr).contains("unsupported audio backend"));
}

#[test]
fn peer_protocol_serves_audio_records_and_bytes() {
    let root = tempfile::tempdir().unwrap();
    let audio = root.path().join("audio");
    let id = clip(
        &audio,
        "aud-x.mp3",
        b"ID3\x04\0\0frames",
        "audio/mpeg",
        json!({}),
    );
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_ag"))
            .args(["node"])
            .args(args)
            .args(["--root", audio.to_str().unwrap()])
            .output()
            .unwrap()
    };
    let list: Value = serde_json::from_slice(&run(&["audio-list"]).stdout).unwrap();
    assert_eq!(list["data"]["records"][0]["id"], id);
    let info: Value = serde_json::from_slice(&run(&["audio-info", "--id", &id]).stdout).unwrap();
    assert_eq!(info["data"]["mimeType"], "audio/mpeg");
    assert_eq!(
        run(&["audio-read", "--id", &id]).stdout,
        b"ID3\x04\0\0frames"
    );
    assert!(
        !run(&["audio-info", "--id", "../etc/passwd"])
            .status
            .success()
    );
}
