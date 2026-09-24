use ag::{
    config::{Config, Host, Paths},
    gallery::{GalleryInput, remote_rsync},
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

fn image(root: &Path, number: usize, label: &str) {
    let id = format!("agent/img-{number:05}.png");
    fs::create_dir_all(root.join("agent")).unwrap();
    let bytes = b"\x89PNG\r\n\x1a\nfixture";
    fs::write(root.join(&id), bytes).unwrap();
    fs::write(root.join(format!("{id}.json")), json!({"version":1,"id":id,"agent":"agent","sha256":format!("{:x}",Sha256::digest(bytes)),"bytes":bytes.len(),"mimeType":"image/png","timestamp":"2026-09-23T00:00:00Z","source":{"label":label}}).to_string()).unwrap();
}
fn service(root: &Path, source: &Path) -> Service {
    let mut config = Config {
        paths: Paths {
            image_dir: Some(source.to_string_lossy().into()),
            ..Paths::default()
        },
        ..Config::default()
    };
    config.gallery.cache_dir = Some(root.join("cache").to_string_lossy().into());
    Service::new(config, None).unwrap()
}
fn input() -> GalleryInput {
    GalleryInput {
        confirmed: true,
        ..GalleryInput::default()
    }
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

#[test]
fn all_images_incremental_cache_offline_and_no_html_injection() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    for i in 0..1005 {
        image(&source, i, "</script><script>bad()</script>");
    }
    let service = service(root.path(), &source);
    assert!(service.image_gallery(GalleryInput::default()).is_err());
    let receipt = service.image_gallery(input()).unwrap();
    assert_eq!(
        receipt.images, 1005,
        "gallery is not capped at recent-list 1000"
    );
    assert_eq!(receipt.hosts[0].state, "synced");
    assert_eq!(receipt.hosts[0].invalid, 0);
    let html = fs::read_to_string(&receipt.index).unwrap();
    assert!(!html.contains("</script><script>bad()"));
    assert_eq!(
        manifest(&receipt.index)["images"].as_array().unwrap().len(),
        1005
    );
    assert_eq!(
        fs::metadata(&receipt.index).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let image_path = receipt.cache_dir.join(
        manifest(&receipt.index)["images"][0]["src"]
            .as_str()
            .unwrap(),
    );
    let first = fs::metadata(&image_path).unwrap().modified().unwrap();
    service.image_gallery(input()).unwrap();
    assert_eq!(
        fs::metadata(&image_path).unwrap().modified().unwrap(),
        first
    );
    fs::rename(&source, root.path().join("gone")).unwrap();
    let offline = service
        .image_gallery(GalleryInput {
            offline: true,
            ..input()
        })
        .unwrap();
    assert_eq!(offline.images, 1005);
    assert_eq!(offline.hosts[0].state, "cached");
    let failed = service.image_gallery(input()).unwrap();
    assert_eq!(failed.images, 1005);
    assert_eq!(failed.hosts[0].state, "unavailable");
}

#[test]
fn invalid_images_and_source_links_never_enter_the_gallery() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    image(&source, 0, "valid");
    image(&source, 1, "corrupt");
    fs::write(source.join("agent/img-00001.png"), b"broken").unwrap();
    symlink(root.path(), source.join("escape")).unwrap();
    symlink("/etc/passwd", source.join("agent/secret.png")).unwrap();
    let result = service(root.path(), &source)
        .image_gallery(input())
        .unwrap();
    assert_eq!(result.images, 1);
    assert_eq!(result.hosts[0].invalid, 1);
    assert_eq!(manifest(&result.index)["images"][0]["label"], "valid");
}

#[test]
fn checksum_pull_repairs_a_corrupted_cached_image_without_touching_source() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    image(&source, 0, "repair");
    let service = service(root.path(), &source);
    let receipt = service.image_gallery(input()).unwrap();
    let cache = receipt.cache_dir.join(
        manifest(&receipt.index)["images"][0]["src"]
            .as_str()
            .unwrap(),
    );
    let timestamp = fs::metadata(&cache).unwrap().modified().unwrap();
    let mut bytes = fs::read(&cache).unwrap();
    bytes[0] ^= 1;
    fs::write(&cache, bytes).unwrap();
    fs::File::options()
        .write(true)
        .open(&cache)
        .unwrap()
        .set_modified(timestamp)
        .unwrap();
    let broken = service
        .image_gallery(GalleryInput {
            offline: true,
            ..input()
        })
        .unwrap();
    assert_eq!(broken.images, 0);
    assert_eq!(broken.hosts[0].invalid, 1);
    let repaired = service
        .image_gallery(GalleryInput {
            checksum: true,
            ..input()
        })
        .unwrap();
    assert_eq!(repaired.images, 1);
    assert_eq!(
        fs::read(cache).unwrap(),
        fs::read(source.join("agent/img-00000.png")).unwrap()
    );
}

fn executable(path: &Path, contents: &str) {
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}
#[test]
fn real_rsync_over_fake_ssh_initializes_login_and_preserves_quoted_paths_and_partial_hosts() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("archive with ' quote");
    image(&source, 0, "remote");
    let login = root.path().join("login");
    executable(
        &login,
        "#!/bin/sh\n[ \"$1\" = -lc ] || exit 72\necho profile-chatter\nshift\nexec /bin/sh -c \"$@\"\n",
    );
    let ssh = root.path().join("ssh");
    executable(
        &ssh,
        &format!(
            "#!/bin/sh\nexport SHELL={}\nwhile [ \"$#\" -gt 0 ]; do case \"$1\" in healthy) shift; break;; down) echo offline >&2; exit 42;; esac; shift; done\nexec /bin/sh -c \"$*\"\n",
            ag::transport::shell_quote(login.to_str().unwrap())
        ),
    );
    let mut config = Config {
        ssh_command: ssh.to_string_lossy().into(),
        hosts: ["healthy", "down"]
            .into_iter()
            .map(|name| Host {
                name: name.into(),
                address: name.into(),
                username: Some("test".into()),
                port: 8022,
                paths: Paths {
                    image_dir: Some(source.to_string_lossy().into()),
                    ..Paths::default()
                },
                ..Host::default()
            })
            .collect(),
        ..Config::default()
    };
    config.gallery.cache_dir = Some(root.path().join("cache").to_string_lossy().into());
    config.gallery.sync_timeout_seconds = 5;
    let service = Service::new(config, None).unwrap();
    let receipt = service.image_gallery(input()).unwrap();
    assert_eq!(receipt.images, 1, "{receipt:?}");
    assert_eq!(receipt.hosts[0].state, "unavailable");
    assert_eq!(receipt.hosts[1].state, "synced");
    assert_eq!(manifest(&receipt.index)["images"][0]["host"], "healthy");
}

#[test]
fn bare_image_and_pull_cli_are_machine_readable_and_mcp_requires_confirmation() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    image(&source, 0, "hello");
    let config = root.path().join("config.yaml");
    ag::config::manager()
        .save(
            &config,
            &Config {
                paths: Paths {
                    image_dir: Some(source.to_string_lossy().into()),
                    ..Paths::default()
                },
                ..Config::default()
            },
        )
        .unwrap();
    let cache = root.path().join("cache");
    let bins = root.path().join("bin");
    fs::create_dir(&bins).unwrap();
    let opened = root.path().join("opened");
    let script = format!(
        "#!/bin/sh\nprintf '%s' \"$1\" > {}\n",
        ag::transport::shell_quote(opened.to_str().unwrap())
    );
    executable(&bins.join("open"), &script);
    executable(&bins.join("xdg-open"), &script);
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_ag"))
            .env(
                "PATH",
                format!("{}:{}", bins.display(), std::env::var("PATH").unwrap()),
            )
            .args(["--config", config.to_str().unwrap()])
            .args(args)
            .output()
            .unwrap()
    };
    let output = run(&["--json", "image", "--cache-dir", cache.to_str().unwrap()]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["data"]["images"], 1);
    assert!(!opened.exists(), "JSON must not open a browser");
    assert!(
        run(&["image", "--offline", "--cache-dir", cache.to_str().unwrap()])
            .status
            .success()
    );
    assert_eq!(
        fs::read_to_string(&opened).unwrap(),
        receipt["data"]["index"].as_str().unwrap()
    );
    let output = run(&[
        "image",
        "pull",
        "--cache-dir",
        cache.to_str().unwrap(),
        "--json",
    ]);
    assert!(output.status.success());
    assert!(!run(&["call", "ag_image_pull", "{}"]).status.success());
    let input = json!({"confirmed":true,"offline":true,"cache_dir":cache}).to_string();
    assert!(run(&["call", "ag_image_pull", &input]).status.success());
    let helper = remote_rsync(&Host {
        paths: Paths {
            image_dir: Some("~/spaces and '; touch /tmp/not-allowed".into()),
            ..Paths::default()
        },
        ..Host::default()
    });
    assert!(helper.contains("ag-rsync"));
}
