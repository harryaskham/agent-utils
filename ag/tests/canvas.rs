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
                // SSH-path tests: never reach this machine's real daemon.
                gateway: String::new(),
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
        assert!(
            entry["text"].as_str().unwrap().ends_with('…'),
            "bounded on a char boundary"
        );
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

// ---------------------------------------------------------------------------
// The gateway: an in-process fake Cursive daemon speaking the real HTTP API
// (`/v1/info`, `/v1/fleet/canvases`, `/v1/[hosts/NODE/]canvases`,
// `…/canvases/ID/export`, `…/call/cursive_export`, `/v1/fleet/stream`).

#[derive(Default)]
struct Gateway {
    name: String,
    peers: Vec<String>,
    /// Nodes whose daemon is down (the gateway cannot reach them).
    offline: std::collections::HashSet<String>,
    /// node → canvas summaries (`body`, `svg_revision` are fake-only).
    canvases: std::collections::BTreeMap<String, Vec<Value>>,
    /// Daemons before Cursive 0.7: no `/export`.
    old: std::collections::HashSet<String>,
    /// Canvas ids whose SVG exceeds the tool's 3 MiB.
    big: std::collections::HashSet<String>,
    log: Vec<String>,
}
type Shared = std::sync::Arc<std::sync::Mutex<Gateway>>;
struct FakeGateway {
    url: String,
    state: Shared,
    changes: tokio::sync::broadcast::Sender<String>,
    _runtime: std::thread::JoinHandle<()>,
}
fn envelope_error(message: &str) -> Value {
    json!({"status":"error","meta":{"schema_version":1},"error":{"category":"target_not_found","code":"not_found","message":message}})
}
fn svg_of(canvas: &Value, theme: Option<&str>) -> String {
    let rev = canvas
        .get("svg_revision")
        .unwrap_or(&canvas["revision"])
        .clone();
    let body = canvas["body"]
        .as_str()
        .unwrap_or(canvas["id"].as_str().unwrap());
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" data-cursive-canvas=\"{}\" data-cursive-revision=\"{rev}\" data-theme=\"{}\"><text>{body}</text></svg>\n",
        canvas["id"].as_str().unwrap(),
        theme.unwrap_or("default")
    )
}
async fn fake_daemon(
    axum::extract::State((state, changes)): axum::extract::State<(
        Shared,
        tokio::sync::broadcast::Sender<String>,
    )>,
    method: axum::http::Method,
    uri: axum::http::Uri,
    body: axum::body::Bytes,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let path = uri.path().to_owned();
    let query: std::collections::HashMap<String, String> = uri
        .query()
        .unwrap_or("")
        .split('&')
        .filter_map(|p| p.split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned())))
        .collect();
    let json_reply = |status: u16, value: Value| {
        (
            axum::http::StatusCode::from_u16(status).unwrap(),
            [("content-type", "application/json")],
            value.to_string(),
        )
            .into_response()
    };
    if path == "/v1/fleet/stream" {
        let rx = changes.subscribe();
        let head = futures_util::stream::once(async {
            Ok::<_, std::io::Error>(axum::body::Bytes::from(
                "retry: 2000\n\nevent: hello\ndata: {\"fleet\":true}\n\n",
            ))
        });
        let tail = futures_util::stream::unfold(rx, |mut rx| async move {
            let data = rx.recv().await.ok()?;
            Some((
                Ok(axum::body::Bytes::from(format!(
                    "event: change\ndata: {data}\n\n"
                ))),
                rx,
            ))
        });
        use futures_util::StreamExt;
        return (
            [("content-type", "text/event-stream")],
            axum::body::Body::from_stream(head.chain(tail)),
        )
            .into_response();
    }
    let mut g = state.lock().unwrap();
    g.log.push(format!("{method} {}", uri));
    let rest = path.strip_prefix("/v1/").unwrap_or("").to_owned();
    if rest == "info" {
        return json_reply(
            200,
            json!({"name":g.name,"version":"0.7.0","web":true,"peers":g.peers}),
        );
    }
    if rest == "fleet/canvases" {
        let limit: usize = query
            .get("limit")
            .and_then(|l| l.parse().ok())
            .unwrap_or(100);
        let mut all = vec![];
        let mut hosts = serde_json::Map::new();
        for node in std::iter::once(g.name.clone()).chain(g.peers.clone()) {
            if g.offline.contains(&node) {
                hosts.insert(node.clone(), json!({"online":false,"error":format!("cursive daemon at http://{node}:7685: Connection refused")}));
                continue;
            }
            hosts.insert(node.clone(), json!({"online":true}));
            for c in g.canvases.get(&node).cloned().unwrap_or_default() {
                let mut row = c.clone();
                row["host"] = node.clone().into();
                all.push(row);
            }
        }
        all.sort_by(|a, b| b["updated_ms"].as_u64().cmp(&a["updated_ms"].as_u64()));
        all.truncate(limit);
        return json_reply(200, json!({"name":g.name,"canvases":all,"hosts":hosts}));
    }
    let (node, rest) = match rest.strip_prefix("hosts/") {
        Some(r) => {
            let (node, rest) = r.split_once('/').unwrap_or((r, ""));
            (node.to_owned(), rest.to_owned())
        }
        None => (g.name.clone(), rest),
    };
    if g.offline.contains(&node) {
        return json_reply(
            502,
            envelope_error(&format!(
                "cursive daemon at http://{node}:7685: Connection refused"
            )),
        );
    }
    let canvases = g.canvases.get(&node).cloned().unwrap_or_default();
    let parts: Vec<&str> = rest.split('/').collect();
    match (method.as_str(), parts.as_slice()) {
        ("GET", ["canvases"]) => {
            let limit: usize = query
                .get("limit")
                .and_then(|l| l.parse().ok())
                .unwrap_or(50);
            let offset: usize = query
                .get("offset")
                .and_then(|l| l.parse().ok())
                .unwrap_or(0);
            let mut rows = canvases.clone();
            rows.sort_by(|a, b| b["updated_ms"].as_u64().cmp(&a["updated_ms"].as_u64()));
            let page: Vec<Value> = rows.into_iter().skip(offset).take(limit).collect();
            json_reply(200, Value::Array(page))
        }
        ("GET", ["canvases", id, "export"]) => {
            if g.old.contains(&node) {
                return json_reply(
                    404,
                    envelope_error(&format!("no such endpoint GET /v1/canvases/{id}/export")),
                );
            }
            let Some(canvas) = canvases.iter().find(|c| c["id"] == *id) else {
                return json_reply(404, envelope_error(&format!("canvas '{id}' not found")));
            };
            let rev = canvas
                .get("svg_revision")
                .unwrap_or(&canvas["revision"])
                .to_string();
            (
                [
                    ("content-type", "image/svg+xml"),
                    ("x-cursive-revision", rev.as_str()),
                ],
                svg_of(canvas, query.get("theme").map(String::as_str)),
            )
                .into_response()
        }
        ("POST", ["call", "cursive_export"]) => {
            let input: Value = serde_json::from_slice(&body).unwrap();
            let id = input["canvas"].as_str().unwrap();
            if g.big.contains(id) {
                return json_reply(
                    200,
                    envelope_error(
                        "MCP export exceeds 3 MiB; use a smaller region or CLI export to a file",
                    ),
                );
            }
            let canvas = canvases.iter().find(|c| c["id"] == id).unwrap();
            json_reply(
                200,
                json!({"status":"success","meta":{"schema_version":1},"data":{
                "canvas":id,"revision":canvas["revision"],"mime":"image/svg+xml","encoding":"utf-8",
                "data":svg_of(canvas, input["theme"].as_str())}}),
            )
        }
        _ => json_reply(
            404,
            envelope_error(&format!("no such endpoint {method} /v1/{rest}")),
        ),
    }
}
impl FakeGateway {
    fn start(state: Gateway) -> Self {
        let state: Shared = std::sync::Arc::new(std::sync::Mutex::new(state));
        let (changes, _) = tokio::sync::broadcast::channel(64);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let shared = (state.clone(), changes.clone());
        let runtime = std::thread::spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap()
                .block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                    let app = axum::Router::new().fallback(fake_daemon).with_state(shared);
                    axum::serve(listener, app).await.unwrap();
                });
        });
        Self {
            url,
            state,
            changes,
            _runtime: runtime,
        }
    }
    fn log(&self) -> Vec<String> {
        self.state.lock().unwrap().log.clone()
    }
    fn clear(&self) {
        self.state.lock().unwrap().log.clear();
    }
    fn exports(&self) -> Vec<String> {
        self.log()
            .into_iter()
            .filter(|l| l.contains("/export") || l.contains("cursive_export"))
            .collect()
    }
    fn set(&self, node: &str, canvases: Vec<Value>) {
        self.state
            .lock()
            .unwrap()
            .canvases
            .insert(node.into(), canvases);
    }
}
fn with_gateway(fleet: &Fleet, gateway: &FakeGateway, hosts: Vec<Host>) -> Config {
    let mut config = fleet.config(hosts);
    config.canvases.gateway = gateway.url.clone();
    config
}
fn board(id: &str, revision: u64, updated_ms: u64, body: &str) -> Value {
    json!({"id":id,"kind":"canvas","revision":revision,"objects":2,"updated_ms":updated_ms,"text":null,"body":body})
}

#[test]
fn the_gateway_lists_the_fleet_and_serves_only_changes_over_http() {
    let fleet = Fleet::new();
    let gateway = FakeGateway::start(Gateway {
        name: "hub".into(),
        peers: vec!["mac".into(), "phone".into()],
        offline: ["phone".to_owned()].into(),
        ..Gateway::default()
    });
    gateway.set("hub", vec![board("plan", 3, 300, "Hub plan")]);
    gateway.set(
        "mac",
        vec![board("board", 5, 200, "Mac board"), {
            let mut note = board("scratch", 1, 100, "note");
            note["kind"] = "note".into();
            note
        }],
    );
    // Only mac is configured; hub and phone come from the fleet.
    let mut config = with_gateway(&fleet, &gateway, vec![remote("mac", "ms-mac", Some("u"))]);
    config.canvases.theme = Some("paper".into());
    let service = fleet.service(config);
    let receipt = fleet.pull(&service, false);
    assert!(fleet.log().is_empty(), "no SSH: {:?}", fleet.log());
    let g = &receipt.gateway;
    assert_eq!(
        (g.state.as_str(), g.name.as_deref(), g.hosts, g.hosts_online),
        ("live", Some("hub"), 3, 2)
    );
    assert!(g.loopback && g.web.as_deref() == Some(gateway.url.as_str()));
    let host = |name: &str| {
        receipt
            .hosts
            .iter()
            .find(|h| h.host == name)
            .unwrap()
            .clone()
    };
    assert_eq!(
        (host("hub").via.as_str(), host("hub").state.as_str()),
        ("daemon", "synced")
    );
    assert_eq!(
        (host("mac").via.as_str(), host("mac").canvases),
        ("daemon", 1),
        "notes skipped"
    );
    let phone = host("phone");
    assert_eq!(
        (phone.state.as_str(), phone.warnings.len()),
        ("offline", 0),
        "a sleeping fleet node is quiet"
    );
    assert_eq!(receipt.rendered, 2);
    let mut exports = gateway.exports();
    exports.sort();
    assert_eq!(
        exports,
        [
            "GET /v1/canvases/plan/export?format=svg&theme=paper",
            "GET /v1/hosts/mac/canvases/board/export?format=svg&theme=paper",
        ]
    );
    assert!(
        !gateway
            .log()
            .iter()
            .any(|l| l.contains("/canvases?") && !l.contains("/fleet/")),
        "one fleet listing, no paging: {:?}",
        gateway.log()
    );
    let index = manifest(&receipt.index);
    assert_eq!(index["gateway"]["state"], "live");
    let plan = index["canvases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "plan")
        .unwrap()
        .clone();
    assert_eq!(plan["live"], "#/hub/plan");
    assert_eq!(plan["text"], "Hub plan");
    let file = receipt
        .cache_dir
        .join(plan["src"].as_str().unwrap().split('?').next().unwrap());
    assert!(
        fs::read_to_string(file)
            .unwrap()
            .contains("data-theme=\"paper\"")
    );
    let json_copy: Value =
        serde_json::from_slice(&fs::read(receipt.cache_dir.join("index.json")).unwrap()).unwrap();
    assert_eq!(
        json_copy["canvases"].as_array().unwrap().len(),
        2,
        "the dash's in-place copy"
    );

    // Unchanged: one info + one listing, no exports. Changed: just that one.
    gateway.clear();
    assert_eq!(fleet.pull(&service, false).rendered, 0);
    assert_eq!(
        gateway.log(),
        ["GET /v1/info", "GET /v1/fleet/canvases?limit=200"]
    );
    gateway.set("mac", vec![board("board", 6, 400, "Mac board v6")]);
    gateway.clear();
    assert_eq!(fleet.pull(&service, false).rendered, 1);
    assert_eq!(
        gateway.exports(),
        ["GET /v1/hosts/mac/canvases/board/export?format=svg&theme=paper"]
    );

    // The cache lists fleet-only nodes too, and get works by fleet name.
    let listed = service.canvas_list(CanvasListInput::default()).unwrap();
    assert!(
        listed
            .canvases
            .iter()
            .any(|c| c.host == "hub" && c.live.as_deref() == Some("#/hub/plan"))
    );
    let path = service
        .canvas_render_path(
            &Selection {
                hosts: vec!["hub".into()],
                local: false,
            },
            "plan",
            None,
        )
        .unwrap();
    assert!(path.ends_with("plan.svg"));
    // Offline rebuilds include the fleet-only nodes from the cache.
    let offline = service
        .canvas_pull(CanvasInput {
            offline: true,
            confirmed: true,
            ..CanvasInput::default()
        })
        .unwrap();
    assert!(
        offline
            .hosts
            .iter()
            .any(|h| h.host == "hub" && h.via == "cache")
    );
}

#[test]
fn old_daemons_use_their_tool_and_oversized_exports_fall_back_to_ssh() {
    let fleet = Fleet::new();
    let gateway = FakeGateway::start(Gateway {
        name: "hub".into(),
        peers: vec!["mac".into(), "pi".into()],
        old: ["mac".to_owned(), "pi".to_owned()].into(),
        big: ["huge".to_owned(), "vast".to_owned()].into(),
        ..Gateway::default()
    });
    gateway.set(
        "mac",
        vec![board("small", 1, 30, "small"), board("huge", 2, 20, "huge")],
    );
    gateway.set("pi", vec![board("vast", 4, 10, "vast")]);
    // mac is configured (SSH fallback); pi is fleet-only (no SSH).
    fleet.state(json!({"u@ms-mac": {"canvases": [board("huge", 2, 20, "huge over ssh")]}}));
    let service = fleet.service(with_gateway(
        &fleet,
        &gateway,
        vec![remote("mac", "ms-mac", Some("u"))],
    ));
    let receipt = fleet.pull(&service, false);
    let index = manifest(&receipt.index);
    let find = |id: &str| {
        index["canvases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id)
            .unwrap()
            .clone()
    };
    assert!(
        gateway
            .log()
            .iter()
            .any(|l| l == "POST /v1/hosts/mac/call/cursive_export"),
        "old daemon: tool"
    );
    assert_eq!(find("small")["rendered_revision"], 1);
    assert_eq!(find("small")["text"], "small");
    assert_eq!(
        find("huge")["text"],
        "huge over ssh",
        "beyond the tool: SSH"
    );
    assert_eq!(
        fleet.exports(),
        [("u@ms-mac".to_owned(), "huge".to_owned(), "svg".to_owned())]
    );
    let vast = find("vast");
    assert!(vast["src"].is_null());
    assert!(vast["error"].as_str().unwrap().contains("3 MiB"), "{vast}");
    assert_eq!(
        fleet.log().iter().filter(|e| e["dest"] == "pi").count(),
        0,
        "fleet-only nodes never SSH"
    );
}

#[test]
fn offline_configured_nodes_use_ssh_and_an_unreachable_gateway_means_ssh_only() {
    let fleet = Fleet::new();
    let gateway = FakeGateway::start(Gateway {
        name: "hub".into(),
        peers: vec!["mac".into()],
        offline: ["mac".to_owned()].into(),
        ..Gateway::default()
    });
    fleet.state(json!({"u@ms-mac": {"canvases": [board("plan", 2, 10, "over ssh")]}}));
    let service = fleet.service(with_gateway(
        &fleet,
        &gateway,
        vec![remote("mac", "ms-mac", Some("u"))],
    ));
    let receipt = fleet.pull(&service, false);
    let mac = receipt.hosts.iter().find(|h| h.host == "mac").unwrap();
    assert_eq!(
        (mac.via.as_str(), mac.state.as_str(), mac.canvases),
        ("ssh", "synced", 1)
    );

    let mut config = fleet.config(vec![remote("mac", "ms-mac", Some("u"))]);
    config.canvases.gateway = "http://127.0.0.1:9".into();
    let receipt = fleet.pull(&fleet.service(config), false);
    assert_eq!(receipt.gateway.state, "unreachable");
    assert!(receipt.gateway.error.is_some());
    assert_eq!(
        receipt.hosts.len(),
        1,
        "only configured nodes without a gateway"
    );
    assert_eq!(receipt.hosts[0].via, "ssh");
}

#[test]
fn a_truncated_fleet_listing_is_paged_per_node_and_a_local_host_is_the_gateways_node() {
    let fleet = Fleet::new();
    let gateway = FakeGateway::start(Gateway {
        name: "hub".into(),
        peers: vec!["mac".into()],
        ..Gateway::default()
    });
    gateway.set(
        "hub",
        (0..150)
            .map(|i| board(&format!("h{i}"), 1, 1000 + i, "h"))
            .collect(),
    );
    gateway.set(
        "mac",
        (0..100)
            .map(|i| board(&format!("m{i}"), 1, 500 + i, "m"))
            .collect(),
    );
    let local = Host {
        name: "here".into(),
        ..Host::local()
    };
    let service = fleet.service(with_gateway(&fleet, &gateway, vec![local]));
    let receipt = fleet.pull(&service, false);
    assert_eq!(
        receipt.canvases, 250,
        "both nodes complete beyond the 200-row fleet listing"
    );
    assert!(
        gateway
            .log()
            .iter()
            .any(|l| l == "GET /v1/canvases?limit=200&offset=0")
    );
    assert!(
        gateway
            .log()
            .iter()
            .any(|l| l == "GET /v1/hosts/mac/canvases?limit=200&offset=0")
    );
    let names: Vec<_> = receipt
        .hosts
        .iter()
        .map(|h| (h.host.as_str(), h.via.as_str()))
        .collect();
    assert_eq!(
        names,
        [("here", "daemon"), ("mac", "daemon")],
        "the loopback gateway's node is not listed twice"
    );
    let index = manifest(&receipt.index);
    assert!(
        index["canvases"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["host"] == "here" && c["live"] == "#/hub/h0")
    );
    assert!(fleet.log().is_empty());
}

#[test]
fn the_dash_follows_the_gateway_stream_and_pulls_on_change() {
    let fleet = Fleet::new();
    let gateway = FakeGateway::start(Gateway {
        name: "hub".into(),
        ..Gateway::default()
    });
    gateway.set("hub", vec![board("plan", 1, 10, "first")]);
    let config = fleet.root.join("ag.yaml");
    fs::write(
        &config,
        format!(
            "version: 1\nparatenic: {{enabled: false}}\npi_daemon: {{enabled: false, bridge: false}}\ncanvases:\n  gateway: {}\n  cache_dir: {}\n  program: /nonexistent/cursive\nhosts:\n  - name: local\n    local: true\n",
            gateway.url,
            fleet.root.join("cache").display()
        ),
    )
    .unwrap();
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_ag"))
        .env("HOME", &fleet.root)
        .env("XDG_STATE_HOME", fleet.root.join("state"))
        .args(["--json", "--config"])
        .arg(&config)
        .args([
            "dash",
            "--no-open",
            "--no-images",
            "--no-audio",
            "--no-tts",
            "--bind",
            "127.0.0.1:0",
            "--canvas-refresh",
            "3600",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(child.stdout.take().unwrap()),
        &mut line,
    )
    .unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    let address = ready["data"]["address"].as_str().unwrap().to_owned();
    let state = || -> Value {
        use std::io::{Read, Write};
        let mut stream = std::net::TcpStream::connect(&address).unwrap();
        write!(
            stream,
            "GET /api/state HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut text = String::new();
        stream.read_to_string(&mut text).unwrap();
        serde_json::from_str(text.split("\r\n\r\n").nth(1).unwrap()).unwrap()
    };
    let wait = |what: &str, ok: &dyn Fn(&Value) -> bool| -> Value {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        loop {
            let s = state();
            if ok(&s) {
                return s;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "{what}: {}",
                s["canvases"]
            );
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    };
    // The startup pull, and the stream followed.
    let first = wait("first pull", &|s| {
        s["canvases"]["finished_ms"].is_u64() && s["canvases"]["live"]["state"] == "following"
    });
    assert_eq!(first["canvases"]["canvases"], 1);
    assert_eq!(first["canvases"]["gateway"]["state"], "live");
    // A change on the stream becomes a pull that renders just that board.
    gateway.set("hub", vec![board("plan", 2, 20, "second")]);
    gateway.clear();
    gateway
        .changes
        .send(
            json!({"host":"hub","canvas":"plan","revision":2,"time_ms":20,"actor":"t"}).to_string(),
        )
        .unwrap();
    let after = wait("pull after a change", &|s| {
        s["canvases"]["live"]["changes"] == 1
            && s["canvases"]["finished_ms"].as_u64() > first["canvases"]["finished_ms"].as_u64()
            && !s["canvases"]["running"].as_bool().unwrap()
    });
    assert_eq!(after["canvases"]["rendered"], 1);
    assert_eq!(
        gateway.exports(),
        ["GET /v1/canvases/plan/export?format=svg"]
    );
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() {
        assert!(std::time::Instant::now() < deadline, "dash did not stop");
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[test]
fn a_host_named_as_the_gateways_node_wins_over_a_local_host() {
    let fleet = Fleet::new();
    let gateway = FakeGateway::start(Gateway {
        name: "hub".into(),
        peers: vec!["mac".into()],
        ..Gateway::default()
    });
    gateway.set("hub", vec![board("plan", 1, 10, "hub")]);
    let local = Host {
        name: "here".into(),
        ..Host::local()
    };
    let service = fleet.service(with_gateway(
        &fleet,
        &gateway,
        vec![local, remote("hub", "hub", None)],
    ));
    let receipt = fleet.pull(&service, false);
    let names: Vec<_> = receipt
        .hosts
        .iter()
        .map(|h| (h.host.as_str(), h.via.as_str()))
        .collect();
    assert_eq!(names, [("hub", "daemon"), ("mac", "daemon")]);
    assert_eq!(receipt.canvases, 1);
    assert!(fleet.log().is_empty());
}
