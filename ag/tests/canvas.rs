//! Fleet canvases against a fake `cursive` that speaks the real CLI contract
//! (`--remote=`, `--json history --list`, `export --format svg|png`): change
//! detection, pruning, PNG fallback, unreachable nodes, destinations, themes,
//! unsafe ids and viewer escaping. No SSH, network or real Cursive data.
use ag::{
    canvas::{CanvasInput, CanvasListInput, valid_id},
    config::{CanvasConfig, Config, Host, HostCursive},
    model::Selection,
    service::Service,
};
use configurable_cli::AppConfig;
use serde_json::{Value, json};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

const FAKE: &str = r#"
import json, os, sys
state = json.load(open(STATE))
args = sys.argv[1:]
dest = "local"; theme = None; rest = []
for a in args:
    if a.startswith("--remote="): dest = a.split("=", 1)[1]
    elif a.startswith("--theme="): theme = a.split("=", 1)[1]
    elif a == "--json": pass
    else: rest.append(a)
with open(LOG, "a") as log:
    log.write(json.dumps({"dest": dest, "theme": theme, "args": rest}) + "\n")
node = state.get(dest)
if node is None or node.get("down"):
    sys.stderr.write(f"ssh: connect to host {dest} port 22: Connection refused\n"); sys.exit(255)
canvases = node.get("canvases", [])
if rest[:2] == ["history", "--list"]:
    limit = int(rest[rest.index("--limit") + 1]); offset = int(rest[rest.index("--offset") + 1])
    rows = [{k: c[k] for k in ("id", "kind", "revision", "objects", "updated_ms", "text") if k in c} for c in canvases]
    print(json.dumps({"status": "success", "meta": {"schema_version": 1}, "data": rows[offset:offset + limit]}))
    sys.exit(0)
if rest[0] == "export":
    cid = rest[1]; fmt = rest[rest.index("--format") + 1]
    canvas = next((c for c in canvases if c["id"] == cid), None)
    if canvas is None:
        print(json.dumps({"status": "error", "error": {"code": "not_found", "message": f"no canvas {cid}"}})); sys.exit(1)
    if fmt == "svg" and not node.get("svg", True):
        sys.stderr.write("error: invalid value 'svg' for '--format <FORMAT>'\n  [possible values: grid, png]\n"); sys.exit(2)
    if canvas.get("broken"):
        sys.stdout.write("not a render"); sys.exit(0)
    if fmt == "png":
        sys.stdout.buffer.write(b"\x89PNG\r\n\x1a\n" + cid.encode()); sys.exit(0)
    rev = canvas.get("svg_revision", canvas["revision"])
    body = canvas.get("body", cid).replace("&", "&amp;").replace("<", "&lt;")
    sys.stdout.write(f'<svg xmlns="http://www.w3.org/2000/svg" data-cursive-canvas="{cid}" data-cursive-revision="{rev}" data-theme="{theme}"><text x="8" y="20">{body}</text></svg>\n')
    sys.exit(0)
sys.exit(2)
"#;

struct Fleet {
    _dir: tempfile::TempDir,
    root: PathBuf,
}
impl Fleet {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        // Absolute interpreter: /usr/bin/env does not exist in Linux Nix sandboxes.
        let python = std::env::var_os("PATH")
            .and_then(|paths| {
                std::env::split_paths(&paths)
                    .map(|d| d.join("python3"))
                    .find(|c| c.is_file())
            })
            .expect("python3 on PATH for the fake cursive");
        let fake = root.join("cursive");
        // Fixture paths are baked in: tests stay independent and parallel.
        fs::write(
            &fake,
            format!(
                "#!{}\nSTATE = {:?}\nLOG = {:?}\n{FAKE}",
                python.display(),
                root.join("state.json").display().to_string(),
                root.join("log.jsonl").display().to_string()
            ),
        )
        .unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        let fleet = Self { _dir: dir, root };
        fleet.state(json!({}));
        fleet
    }
    fn state(&self, value: Value) {
        fs::write(self.root.join("state.json"), value.to_string()).unwrap();
    }
    fn log(&self) -> Vec<Value> {
        fs::read_to_string(self.root.join("log.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    fn clear_log(&self) {
        let _ = fs::remove_file(self.root.join("log.jsonl"));
    }
    fn exports(&self) -> Vec<(String, String, String)> {
        self.log()
            .into_iter()
            .filter(|e| e["args"][0] == "export")
            .map(|e| {
                (
                    e["dest"].as_str().unwrap().to_owned(),
                    e["args"][1].as_str().unwrap().to_owned(),
                    e["args"][3].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }
    fn config(&self, hosts: Vec<Host>) -> Config {
        Config {
            hosts,
            canvases: CanvasConfig {
                program: self.root.join("cursive").to_string_lossy().into(),
                cache_dir: Some(self.root.join("cache").to_string_lossy().into()),
                timeout_seconds: 10,
                ..CanvasConfig::default()
            },
            ..Config::default()
        }
    }
    fn service(&self, config: Config) -> Service {
        Service::new(config, None).unwrap()
    }
    fn pull(&self, service: &Service, force: bool) -> ag::canvas::CanvasReceipt {
        service
            .canvas_pull(CanvasInput {
                confirmed: true,
                force,
                ..CanvasInput::default()
            })
            .unwrap()
    }
}
fn remote(name: &str, address: &str, user: Option<&str>) -> Host {
    Host {
        name: name.into(),
        address: address.into(),
        username: user.map(Into::into),
        ..Host::default()
    }
}
fn canvas(id: &str, revision: u64, updated_ms: u64) -> Value {
    json!({"id":id,"kind":"canvas","revision":revision,"objects":3,"updated_ms":updated_ms,"text":null})
}
fn manifest(index: &Path) -> Value {
    let html = fs::read_to_string(index).unwrap();
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
fn only_new_or_changed_canvases_are_exported_and_removed_ones_pruned() {
    let fleet = Fleet::new();
    let mut note = canvas("scratch", 1, 50);
    note["kind"] = json!("note");
    fleet.state(json!({"harry@alpha": {"canvases": [
        {"id":"plan","kind":"canvas","revision":3,"objects":5,"updated_ms":200,"text":"ocr preview","body":"Ship the <dash> & docs"},
        canvas("../evil", 9, 100),
        note,
    ]}}));
    let service = fleet.service(fleet.config(vec![remote("alpha", "alpha", Some("harry"))]));
    assert!(
        service.canvas_pull(CanvasInput::default()).is_err(),
        "cache writes require confirmation"
    );
    let first = fleet.pull(&service, false);
    assert_eq!(
        first.canvases, 1,
        "notes are excluded by default; unsafe ids skipped"
    );
    assert_eq!(first.rendered, 1);
    let host = &first.hosts[0];
    assert_eq!(host.state, "synced");
    assert!(
        host.warnings.iter().any(|w| w.contains("unsafe ids")),
        "{:?}",
        host.warnings
    );
    let listed = fleet
        .log()
        .into_iter()
        .find(|e| e["args"][0] == "history")
        .unwrap();
    assert_eq!(listed["dest"], "harry@alpha");
    assert_eq!(
        listed["args"],
        json!(["history", "--list", "--limit", "200", "--offset", "0"])
    );
    assert_eq!(
        fleet.exports(),
        vec![("harry@alpha".into(), "plan".into(), "svg".into())]
    );
    let index = manifest(&first.index);
    let plan = &index["canvases"][0];
    assert_eq!(plan["id"], "plan");
    assert_eq!(plan["revision"], 3);
    assert_eq!(plan["rendered_revision"], 3);
    assert_eq!(plan["ocr"], "ocr preview");
    assert_eq!(
        plan["text"], "Ship the <dash> & docs",
        "SVG text is unescaped for search"
    );
    assert_eq!(
        plan["open"],
        format!(
            "'{}' '--remote=harry@alpha' canvas 'plan'",
            fleet.root.join("cursive").display()
        )
    );
    let src = plan["src"].as_str().unwrap();
    assert!(src.ends_with("/plan.svg?v=3"), "{src}");
    let file = first.cache_dir.join(src.split('?').next().unwrap());
    assert!(fs::read_to_string(&file).unwrap().starts_with("<svg"));
    assert_eq!(
        fs::metadata(&file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(
        !fleet.root.join("cache/hosts").read_dir().unwrap().any(|d| {
            d.unwrap()
                .path()
                .read_dir()
                .unwrap()
                .any(|f| f.unwrap().file_name().to_string_lossy().contains("evil"))
        })
    );

    // Nothing changed: one listing, no export.
    fleet.clear_log();
    let second = fleet.pull(&service, false);
    assert_eq!(second.rendered, 0);
    assert!(fleet.exports().is_empty());
    assert_eq!(fleet.log().len(), 1);

    // A new revision and a new canvas: exactly those two.
    fleet.state(
        json!({"harry@alpha": {"canvases": [canvas("plan", 4, 300), canvas("board", 1, 250)]}}),
    );
    fleet.clear_log();
    let third = fleet.pull(&service, false);
    assert_eq!(third.rendered, 2);
    let mut exported: Vec<_> = fleet.exports().into_iter().map(|e| e.1).collect();
    exported.sort();
    assert_eq!(exported, ["board", "plan"]);

    // Gone from the node: dropped from the view and the cache.
    fleet.state(json!({"harry@alpha": {"canvases": [canvas("board", 1, 250)]}}));
    let fourth = fleet.pull(&service, false);
    assert_eq!(fourth.canvases, 1);
    assert!(!file.exists(), "a removed canvas's render is deleted");

    // force re-exports everything listed.
    fleet.clear_log();
    assert_eq!(fleet.pull(&service, true).rendered, 1);
    assert_eq!(fleet.exports().len(), 1);
}

#[test]
fn nodes_without_svg_export_render_png_without_reprobing_every_poll() {
    let fleet = Fleet::new();
    fleet.state(
        json!({"old": {"svg": false, "canvases": [canvas("plan", 1, 10), canvas("ideas", 1, 9)]}}),
    );
    let service = fleet.service(fleet.config(vec![remote("old", "old", None)]));
    let first = fleet.pull(&service, false);
    assert_eq!(first.rendered, 2);
    assert!(
        first.hosts[0]
            .warnings
            .iter()
            .any(|w| w.contains("predates SVG export"))
    );
    // One refused SVG attempt, then PNG for everything on that node.
    assert_eq!(
        fleet
            .exports()
            .iter()
            .map(|e| e.2.as_str())
            .collect::<Vec<_>>(),
        ["svg", "png", "png"]
    );
    let index = manifest(&first.index);
    assert!(
        index["canvases"][0]["src"]
            .as_str()
            .unwrap()
            .contains(".png?v=1")
    );
    assert_eq!(index["canvases"][0]["format"], "png");
    fleet.clear_log();
    assert_eq!(fleet.pull(&service, false).rendered, 0);
    assert!(
        fleet.exports().is_empty(),
        "unchanged PNG renders are current"
    );
    fleet.state(
        json!({"old": {"svg": false, "canvases": [canvas("plan", 2, 11), canvas("ideas", 1, 9)]}}),
    );
    fleet.clear_log();
    assert_eq!(fleet.pull(&service, false).rendered, 1);
    assert_eq!(
        fleet.exports(),
        vec![("old".into(), "plan".into(), "png".into())],
        "no SVG re-probe within the re-probe window"
    );
}

#[test]
fn an_unreachable_node_keeps_its_cached_renders() {
    let fleet = Fleet::new();
    fleet.state(json!({"beta": {"canvases": [canvas("plan", 1, 10)]}}));
    let service = fleet.service(fleet.config(vec![remote("beta", "beta", None)]));
    fleet.pull(&service, false);
    fleet.state(json!({"beta": {"down": true}}));
    let receipt = fleet.pull(&service, false);
    let host = &receipt.hosts[0];
    assert_eq!(host.state, "unavailable");
    assert!(
        host.warnings[0].contains("exited 255") && host.warnings[0].contains("Connection refused"),
        "{:?}",
        host.warnings
    );
    assert_eq!(receipt.canvases, 1);
    let cached = &manifest(&receipt.index)["canvases"][0];
    assert!(cached["src"].as_str().unwrap().ends_with("plan.svg?v=1"));
    // Offline rebuilds from the cache without running cursive at all.
    let mut config = fleet.config(vec![remote("beta", "beta", None)]);
    config.canvases.program = "/nonexistent/cursive".into();
    let offline = fleet
        .service(config)
        .canvas_pull(CanvasInput {
            offline: true,
            confirmed: true,
            ..CanvasInput::default()
        })
        .unwrap();
    assert_eq!(offline.hosts[0].state, "cached");
    assert_eq!(offline.canvases, 1);
}

#[test]
fn destinations_themes_and_local_nodes() {
    let fleet = Fleet::new();
    let one = || json!({"canvases": [canvas("plan", 1, 10)]});
    fleet.state(json!({"ssh://u@gamma:2222": one(), "mac": one(), "local": one(), "ssh://[fd7a::1]:22": one()}));
    let mut config = fleet.config(vec![
        Host {
            port: 2222,
            ..remote("gamma", "gamma", Some("u"))
        },
        Host {
            cursive: HostCursive {
                remote: Some("mac".into()),
                enabled: None,
            },
            ..remote("mac-alias", "ms-mac", Some("ignored"))
        },
        Host {
            name: "here".into(),
            ..Host::local()
        },
        remote("v6", "fd7a::1", None),
        Host {
            cursive: HostCursive {
                enabled: Some(false),
                remote: None,
            },
            ..remote("skipped", "skipped", None)
        },
    ]);
    config.canvases.theme = Some("paper".into());
    let service = fleet.service(config);
    let receipt = fleet.pull(&service, false);
    assert_eq!(receipt.hosts.len(), 4, "a disabled node is not listed");
    assert!(
        receipt.hosts.iter().all(|h| h.state == "synced"),
        "{:?}",
        receipt.hosts
    );
    let log = fleet.log();
    let mut dests: Vec<_> = log
        .iter()
        .filter(|e| e["args"][0] == "export")
        .map(|e| e["dest"].as_str().unwrap().to_owned())
        .collect();
    dests.sort();
    assert_eq!(
        dests,
        ["local", "mac", "ssh://[fd7a::1]:22", "ssh://u@gamma:2222"]
    );
    for entry in &log {
        let theme = if entry["args"][0] == "export" {
            json!("paper")
        } else {
            Value::Null
        };
        assert_eq!(entry["theme"], theme, "theme only on SVG exports: {entry}");
    }
    let cached = fs::read_to_string(
        receipt.cache_dir.join(
            manifest(&receipt.index)["canvases"][0]["src"]
                .as_str()
                .unwrap()
                .split('?')
                .next()
                .unwrap(),
        ),
    )
    .unwrap();
    assert!(cached.contains("data-theme=\"paper\""));
    // Changing the theme re-renders: the cached SVG was drawn with another palette.
    let mut config = fleet.config(vec![remote("v6", "fd7a::1", None)]);
    config.canvases.theme = Some("nord".into());
    fleet.clear_log();
    assert_eq!(fleet.pull(&fleet.service(config), false).rendered, 1);
}

#[test]
fn rendered_revisions_failures_and_escaping() {
    let fleet = Fleet::new();
    fleet.state(json!({"delta": {"canvases": [
        {"id":"plan","kind":"canvas","revision":5,"objects":1,"updated_ms":10,"svg_revision":6,"body":"</script><script>alert(1)</script>"}
    ]}}));
    let service = fleet.service(fleet.config(vec![remote("delta", "delta", None)]));
    let first = fleet.pull(&service, false);
    let html = fs::read_to_string(&first.index).unwrap();
    assert!(
        !html.contains("</script><script>alert(1)"),
        "manifest text cannot close the script"
    );
    let entry = &manifest(&first.index)["canvases"][0];
    assert_eq!(
        entry["rendered_revision"], 6,
        "the SVG names the revision it drew"
    );
    assert_eq!(entry["revision"], 6);
    // The list catches up: the render is current.
    fleet.state(json!({"delta": {"canvases": [canvas("plan", 6, 10)]}}));
    fleet.clear_log();
    assert_eq!(fleet.pull(&service, false).rendered, 0);
    // A broken export keeps the previous render, reports it, and retries next poll.
    fleet.state(json!({"delta": {"canvases": [{"id":"plan","kind":"canvas","revision":7,"objects":1,"updated_ms":11,"broken":true}]}}));
    let failed = fleet.pull(&service, false);
    assert_eq!(failed.rendered, 0);
    let entry = &manifest(&failed.index)["canvases"][0];
    assert_eq!(entry["revision"], 7);
    assert_eq!(entry["rendered_revision"], 6);
    assert!(entry["error"].as_str().unwrap().contains("not an SVG"));
    assert!(
        failed.hosts[0]
            .warnings
            .iter()
            .any(|w| w.contains("could not be exported"))
    );
    fleet.state(json!({"delta": {"canvases": [canvas("plan", 7, 11)]}}));
    fleet.clear_log();
    assert_eq!(
        fleet.pull(&service, false).rendered,
        1,
        "failed exports are retried"
    );

    let listed = service
        .canvas_list(CanvasListInput {
            query: Some("PLAN".into()),
            ..CanvasListInput::default()
        })
        .unwrap();
    assert_eq!(listed.canvases.len(), 1);
    assert!(
        service
            .canvas_list(CanvasListInput {
                query: Some("absent".into()),
                ..CanvasListInput::default()
            })
            .unwrap()
            .canvases
            .is_empty()
    );
    let path = service
        .canvas_render_path(
            &Selection {
                hosts: vec!["delta".into()],
                local: false,
            },
            "plan",
            None,
        )
        .unwrap();
    assert!(path.ends_with("plan.svg"));
    assert!(
        service
            .canvas_render_path(&Selection::default(), "../plan", None)
            .is_err()
    );
}

#[test]
fn multibyte_text_anywhere_in_a_render_is_safe() {
    // Fleet regression: a fixed 4096-byte cut landed inside '─' and panicked
    // the whole pull. Three bodies shifted by 0-2 bytes put a 3-byte glyph
    // across every byte offset, whatever the header length.
    let fleet = Fleet::new();
    let boards: Vec<Value> = (0..3)
        .map(|k| {
            json!({"id":format!("boxes-{k}"),"kind":"canvas","revision":2,"objects":1,"updated_ms":5,
                "body":format!("{}{}", "a".repeat(k), "─".repeat(5000))})
        })
        .collect();
    fleet.state(json!({"eps": {"canvases": boards}}));
    let service = fleet.service(fleet.config(vec![remote("eps", "eps", None)]));
    let receipt = fleet.pull(&service, false);
    assert_eq!(receipt.hosts[0].state, "synced", "{:?}", receipt.hosts);
    assert_eq!(receipt.rendered, 3);
    for entry in manifest(&receipt.index)["canvases"].as_array().unwrap() {
        assert_eq!(entry["rendered_revision"], 2);
        assert!(entry["text"].as_str().unwrap().ends_with('…'), "bounded on a char boundary");
    }
}

#[test]
fn ids_and_configuration_are_validated() {
    for id in ["plan", "a.b-c_d", "x".repeat(96).as_str()] {
        assert!(valid_id(id), "{id}");
    }
    for id in [
        "",
        ".",
        "..",
        "../x",
        "a/b",
        "a b",
        "x".repeat(97).as_str(),
        "é",
    ] {
        assert!(!valid_id(id), "{id}");
    }
    let mut config = Config::default();
    assert!(config.validate().is_ok());
    config.canvases.theme = Some("neon".into());
    assert!(config.validate().is_err());
    config.canvases.theme = Some("paper".into());
    config.hosts[0].cursive.remote = Some("host; rm -rf /".into());
    assert!(config.validate().is_err());
    config.hosts[0].cursive.remote = Some("-oProxyCommand=x".into());
    assert!(config.validate().is_err());
    config.hosts[0].cursive.remote = Some("ssh://harry@helsinki:22".into());
    assert!(config.validate().is_ok());
    config.dash.canvas_refresh_seconds = 5;
    assert!(config.validate().is_err());
}
