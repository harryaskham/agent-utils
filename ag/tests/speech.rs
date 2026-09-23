use ag::speech::{SpeechKind, read_state, set_muted};
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    process::{Command, Stdio},
};

#[test]
fn defaults_selective_updates_all_types_and_epoch_fences() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tts/mute.json");
    let state = read_state(&path).unwrap();
    assert!(!state.exists);
    assert!(!path.parent().unwrap().exists());
    assert!(state.state.muted.values().all(|v| !v));
    set_muted(&path, &[SpeechKind::Read, SpeechKind::Tts], true).unwrap();
    let unmuted = set_muted(&path, &[SpeechKind::Read], false).unwrap();
    assert!(!unmuted.state.muted[&SpeechKind::Read]);
    assert!(unmuted.state.muted[&SpeechKind::Tts]);
    assert_eq!(unmuted.state.epochs[&SpeechKind::Read], 1);
    assert_eq!(unmuted.state.epochs[&SpeechKind::Narrate], 0);
    let all = set_muted(&path, &[], true).unwrap();
    assert!(all.state.muted.values().all(|v| *v));
    assert_eq!(all.state.epochs[&SpeechKind::Read], 2);
    assert_eq!(all.state.epochs[&SpeechKind::Tts], 1);
    let same = set_muted(&path, &[], true).unwrap();
    assert!(same.changed.is_empty());
    assert_eq!(same.state, all.state);
    let cleared = set_muted(&path, &[], false).unwrap();
    assert!(cleared.state.muted.values().all(|v| !v));
    assert_eq!(
        cleared.state.epochs, all.state.epochs,
        "unmute preserves backlog fences"
    );
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[test]
fn managed_symlinks_are_preserved_and_invalid_state_is_not_overwritten() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("state/mute.json");
    let link = root.path().join("mute.json");
    let second = root.path().join("alias.json");
    symlink("state/mute.json", &link).unwrap();
    symlink("mute.json", &second).unwrap();
    set_muted(&second, &[SpeechKind::Choices], true).unwrap();
    assert!(fs::symlink_metadata(&link).unwrap().is_symlink());
    assert!(fs::symlink_metadata(&second).unwrap().is_symlink());
    assert!(read_state(&target).unwrap().state.muted[&SpeechKind::Choices]);
    let invalid = r#"{"version":1,"muted":{"tts":"secret-not-to-log"}}"#;
    fs::write(&target, invalid).unwrap();
    let error = set_muted(&link, &[], false).unwrap_err().to_string();
    assert!(!error.contains("secret-not-to-log"));
    assert_eq!(fs::read_to_string(&target).unwrap(), invalid);
    fs::write(&target, r#"{"version":2}"#).unwrap();
    assert!(read_state(&link).is_err());
    fs::write(
        &target,
        r#"{"version":1,"epochs":{"read":9007199254740992}}"#,
    )
    .unwrap();
    assert!(read_state(&link).is_err());
}

#[test]
fn simultaneous_cli_processes_merge_independent_kind_changes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("mute.json");
    let mut children = vec![];
    for kind in SpeechKind::ALL {
        children.push(
            Command::new(env!("CARGO_BIN_EXE_ag"))
                .args([
                    "node",
                    "tts-mute",
                    "--path",
                    path.to_str().unwrap(),
                    "--kind",
                    kind.name(),
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        );
    }
    for child in children {
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let state = read_state(&path).unwrap().state;
    assert!(state.muted.values().all(|v| *v));
    assert!(state.epochs.values().all(|v| *v == 1));
}
