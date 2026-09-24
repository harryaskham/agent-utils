use ag::{
    config::{Config, Paths},
    gallery::GalleryInput,
    service::Service,
};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    time::{Duration, Instant},
};

#[test]
fn a_stalled_transfer_is_bounded_and_keeps_a_readable_gallery() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source");
    fs::create_dir(&source).unwrap();
    let script = root.path().join("stall");
    fs::write(&script, "#!/bin/sh\nexec sleep 30\n").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let mut config = Config {
        paths: Paths {
            image_dir: Some(source.to_string_lossy().into()),
            ..Paths::default()
        },
        ..Config::default()
    };
    config.gallery.cache_dir = Some(root.path().join("cache").to_string_lossy().into());
    config.gallery.rsync_command = script.to_string_lossy().into();
    config.gallery.sync_timeout_seconds = 1;
    let service = Service::new(config, None).unwrap();
    let start = Instant::now();
    let receipt = service
        .image_gallery(GalleryInput {
            confirmed: true,
            ..GalleryInput::default()
        })
        .unwrap();
    assert!(start.elapsed() < Duration::from_secs(4));
    assert_eq!(receipt.hosts[0].state, "unavailable");
    assert!(receipt.hosts[0].warnings[0].contains("timed out"));
    assert!(receipt.index.is_file());
    assert_eq!(receipt.images, 0);
}
