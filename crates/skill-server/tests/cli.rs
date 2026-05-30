//! Integration tests for the `skill-server` and `skill-search` binaries.
//!
//! These exercise the compiled CLI end-to-end (argument parsing, config
//! loading, human/JSON output, and error exit codes) which the in-crate unit
//! tests do not cover. They use the `CARGO_BIN_EXE_<name>` paths Cargo provides
//! to integration tests, so no extra test harness dependency is required.

use std::path::PathBuf;
use std::process::Command;

use tempfile::TempDir;

/// Write a minimal valid config and return the temp dir (kept alive by caller)
/// plus the config path.
fn temp_config() -> (TempDir, PathBuf) {
    let dir = TempDir::new().expect("create temp dir");
    let path = dir.path().join("config.yaml");
    std::fs::write(&path, "skill_paths: []\nmcp_servers: []\n").expect("write config");
    (dir, path)
}

fn skill_server() -> Command {
    Command::new(env!("CARGO_BIN_EXE_skill-server"))
}

fn skill_search() -> Command {
    Command::new(env!("CARGO_BIN_EXE_skill-search"))
}

#[test]
fn help_flag_succeeds_without_config() {
    // `--help` is handled by clap before dispatch loads any config.
    let output = skill_server().arg("--help").output().expect("run --help");
    assert!(output.status.success(), "expected --help to exit 0");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("skill-search"),
        "help text should mention the bin name, got: {stdout}"
    );
}

#[test]
fn no_subcommand_prints_help_text() {
    let (_dir, config) = temp_config();
    let output = skill_server()
        .arg("--config")
        .arg(&config)
        .output()
        .expect("run with no subcommand");
    assert!(output.status.success(), "expected exit 0 for no subcommand");
    assert!(
        !output.stdout.is_empty(),
        "no-subcommand run should print help text to stdout"
    );
}

#[test]
fn list_human_succeeds() {
    let (_dir, config) = temp_config();
    let output = skill_server()
        .arg("--config")
        .arg(&config)
        .arg("list")
        .output()
        .expect("run list");
    assert!(output.status.success(), "expected list to exit 0");
}

#[test]
fn list_json_emits_success_envelope() {
    let (_dir, config) = temp_config();
    let output = skill_server()
        .arg("--config")
        .arg(&config)
        .arg("--json")
        .arg("list")
        .output()
        .expect("run list --json");
    assert!(output.status.success(), "expected list --json to exit 0");

    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("stdout should be valid JSON");
    assert_eq!(value["status"], "success");
    assert_eq!(value["meta"]["schema_version"], 1);
    assert_eq!(value["meta"]["command"], "list");
}

#[test]
fn missing_config_errors_with_exit_1() {
    let output = skill_server()
        .arg("--config")
        .arg("/nonexistent/skill-server-test/config.yaml")
        .arg("list")
        .output()
        .expect("run list with missing config");
    assert!(
        !output.status.success(),
        "expected non-zero exit for missing config"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("error:"),
        "stderr should carry an error message, got: {stderr}"
    );
}

#[test]
fn skill_search_binary_shares_the_same_surface() {
    // The skill-search binary is a thin wrapper over the same dispatch path;
    // a smoke check guards against the second bin diverging or failing to build.
    let (_dir, config) = temp_config();
    let output = skill_search()
        .arg("--config")
        .arg(&config)
        .arg("--json")
        .arg("list")
        .output()
        .expect("run skill-search list --json");
    assert!(
        output.status.success(),
        "expected skill-search list --json to exit 0"
    );
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("skill-search stdout should be valid JSON");
    assert_eq!(value["status"], "success");
}
