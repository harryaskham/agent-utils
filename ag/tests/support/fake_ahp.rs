//! Minimal fake Paratenic AHP host for real-boundary tests and visual QA.
//! Speaks JSON-RPC over WebSocket with bearer auth; echoes dispatches with the
//! caller's origin like Paratenic does. Not a protocol implementation.
#![allow(dead_code)]
use serde_json::{Value, json};
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::{
    Message,
    handshake::server::{ErrorResponse, Request, Response},
};

pub const TOKEN: &str = "fixture-bearer-token";

#[derive(Default)]
pub struct Fake {
    /// Richer multi-agent data for visual QA (`examples/fake_paratenic.rs`).
    pub demo: bool,
    pub clients: Vec<String>,
    pub auth: Vec<Option<String>>,
    pub dispatches: Vec<Value>,
    pub reject: Option<String>,
    /// Pending requests removed once accepted.
    pub answered: Vec<String>,
    /// Serve pi-daemon's sessions instead: a Durable session asking with
    /// `ask_user`, and a TUI Pi (`tui-…`) whose question Paratenic also lists.
    pub pi_daemon: bool,
    /// With `pi_daemon`: serve only the Durable session (`Some(false)`, the
    /// daemon's :7463) or only the TUI Pi (`Some(true)`, the bridge's :7464).
    pub bridge: Option<bool>,
    /// Refuse the WebSocket upgrade with this HTTP status (a bridge before
    /// pi-daemon 1.11 answers 404 on /ahp).
    pub refuse: Option<u16>,
    /// The protocol versions each client offered at `initialize`.
    pub offered: Vec<Vec<String>>,
    /// Speak AHP 1.0 (a pi-daemon after bd-0e06d8) instead of 0.8.0 (Paratenic).
    pub current: bool,
}

pub fn select_request(id: &str, message: &str, freeform: bool) -> Value {
    json!({
        "id": id,
        "message": message,
        "questions": [{
            "kind": "single-select", "id": "choice", "message": message, "required": true,
            "allowFreeformInput": freeform,
            "options": [
                {"id": "opt-a", "label": "Ship it", "description": "Merge and deploy", "recommended": true},
                {"id": "opt-b", "label": "Hold", "description": "Wait for review"}
            ]
        }]
    })
}

pub fn session(uri: &str, title: &str, status: u32, chat_mode: &str, inputs: Vec<Value>) -> Value {
    json!({
        "provider": "pi", "title": title, "status": status, "lifecycle": "ready",
        "activeClients": [],
        "chats": [{"resource": format!("{uri}/chat"), "title": title, "status": status, "modifiedAt": "2026-10-11T10:00:00Z", "interactivity": chat_mode}],
        "defaultChat": format!("{uri}/chat"),
        "inputNeeded": inputs,
    })
}

/// pi-daemon `/ahp`: an `ask_user` question (single select over its choices,
/// question id `answer`), and a TUI Pi it serves with Paratenic's `choice-1`.
pub fn pi_daemon_sessions(answered: &[String], bridge: Option<bool>) -> Vec<(Value, Value)> {
    let waiting = 24 | 1;
    let mut rows = vec![];
    let chat_input = |chat: &str, request: Value| json!({"kind": "chatInput", "id": request["id"].as_str().unwrap(), "chat": chat, "request": request});
    let d = "ahp-session:/durable-1";
    if bridge != Some(true) && !answered.iter().any(|r| r == "12") {
        let ask = json!({"id": "12", "message": "Keep the chart?", "questions": [{"kind": "single-select", "id": "answer", "message": "Keep the chart?", "required": true, "allowFreeformInput": false, "options": [{"id": "Keep", "label": "Keep"}, {"id": "Discard", "label": "Discard"}]}]});
        let chat = "ahp-chat:/durable-1/1";
        let mut state = session(
            d,
            "chart review",
            waiting,
            "full",
            vec![chat_input(chat, ask)],
        );
        state["chats"][0]["resource"] = chat.into();
        rows.push((
            json!({"resource": d, "provider": "personal", "title": "chart review", "status": waiting, "createdAt": "2026-10-11T09:00:00Z", "modifiedAt": "2026-10-11T10:07:00Z", "workingDirectories": ["file:///work/charts"]}),
            state,
        ));
    }
    let t = "ahp-session:/tui-0190-pi-session";
    if bridge != Some(false) && !answered.iter().any(|r| r == "choice-1") {
        rows.push((
            json!({"resource": t, "provider": "tui", "title": "agent-utils", "status": waiting, "createdAt": "2026-10-11T09:00:00Z", "modifiedAt": "2026-10-11T10:05:00Z", "workingDirectories": ["file:///work/agent-utils"]}),
            session(t, "agent-utils", waiting, "full", vec![json!({"kind": "chatInput", "id": "choice-1", "chat": format!("{t}/chat"), "request": select_request("choice-1", "Deploy the release?", true)})]),
        ));
    }
    rows
}

pub fn fixture_sessions(demo: bool, answered: &[String]) -> Vec<(Value, Value)> {
    let waiting = 24 | 1;
    let mut rows = vec![];
    let chat_input = |uri: &str, request: Value| json!({"kind": "chatInput", "id": format!("{uri}#{}", request["id"].as_str().unwrap()), "chat": format!("{uri}/chat"), "request": request});
    if demo {
        let open = |id: &str| !answered.iter().any(|r| r == id);
        let mut add = |uri: &str,
                       title: &str,
                       cwd: &str,
                       minutes: u32,
                       mode: &str,
                       inputs: Vec<Value>| {
            if inputs.is_empty() {
                return;
            }
            rows.push((
                json!({"resource": uri, "provider": "pi", "title": title, "status": waiting, "createdAt": "2026-10-11T09:00:00Z", "modifiedAt": format!("2026-10-11T10:{minutes:02}:00Z"), "workingDirectories": [format!("file://{cwd}")]}),
                session(uri, title, waiting, mode, inputs),
            ));
        };
        let release = "ahp-session:/demo-release";
        let mut inputs = vec![];
        if open("choice-7") {
            inputs.push(chat_input(release, json!({"id": "choice-7", "message": "Release 0.4.0 is green on CI and the Android canary. Ship it to the Play internal track now?", "questions": [{"kind": "single-select", "id": "choice", "message": "Release 0.4.0 is green on CI and the Android canary. Ship it to the Play internal track now?", "required": true, "allowFreeformInput": true, "options": [
                {"id": "ship", "label": "Ship to internal track", "description": "Promote the signed AAB and post release notes", "recommended": true},
                {"id": "hold", "label": "Hold until tomorrow", "description": "Keep the build staged; re-check crash rate in the morning"},
                {"id": "abort", "label": "Abandon this build", "description": "Delete the staged artifact and reopen the release bead"}]}]})));
        }
        if open("ac-mk2-01") {
            inputs.push(chat_input(release, json!({"id": "ac-mk2-01", "message": "Which changelog voice should the release notes use?", "questions": [{"kind": "single-select", "id": "choice", "message": "Which changelog voice should the release notes use?", "required": true, "allowFreeformInput": true, "options": [{"id": "terse", "label": "Terse bullet list"}, {"id": "narrative", "label": "Short narrative paragraph"}]}]})));
        }
        add(
            release,
            "android-improvements",
            "/Users/harry/cosmos/projects/android-utils",
            42,
            "full",
            inputs,
        );
        let form = "ahp-session:/demo-form";
        if open("form-3") {
            add(
                form,
                "culture-web",
                "/home/harry/paratenic",
                37,
                "full",
                vec![chat_input(
                    form,
                    json!({"id": "form-3", "message": "Configure the canary rollout", "questions": [
                {"kind": "multi-select", "id": "nodes", "title": "Canary nodes", "message": "Which nodes should take the canary first?", "required": true, "options": [{"id": "ms-dev", "label": "ms-dev"}, {"id": "helsinki", "label": "helsinki"}, {"id": "aurora", "label": "aurora"}]},
                {"kind": "boolean", "id": "notify", "title": "Notify", "message": "Post a note to Culture when the canary starts?", "required": true},
                {"kind": "text", "id": "note", "title": "Operator note", "message": "Anything the agent should know?", "required": false}]}),
                )],
            );
        }
        let ro = "ahp-session:/demo-readonly";
        add(
            ro,
            "billing-sync",
            "/srv/billing",
            12,
            "read-only",
            vec![chat_input(
                ro,
                select_request("ac-ro-9", "Retry the failed export batch?", false),
            )],
        );
        return rows;
    }
    let a = "ahp-session:/agent-a";
    if !answered.iter().any(|r| r == "choice-1") {
        rows.push((
            json!({"resource": a, "provider": "pi", "title": "agent-utils", "status": waiting, "createdAt": "2026-10-11T09:00:00Z", "modifiedAt": "2026-10-11T10:05:00Z", "workingDirectories": ["file:///work/agent-utils"]}),
            session(a, "agent-utils", waiting, "full", vec![chat_input(a, select_request("choice-1", "Deploy the release?", true))]),
        ));
    }
    let b = "ahp-session:/agent-b";
    rows.push((
        json!({"resource": b, "provider": "pi", "title": "read-only agent", "status": waiting, "createdAt": "2026-10-11T09:00:00Z", "modifiedAt": "2026-10-11T10:00:00Z"}),
        session(b, "read-only agent", waiting, "read-only", vec![
            chat_input(b, select_request("ac-async-1", "Pick a palette", false)),
            json!({"kind": "toolFutureKind", "id": "future-1", "chat": format!("{b}/chat")}),
        ]),
    ));
    let c = "ahp-session:/agent-c";
    rows.push((
        json!({"resource": c, "provider": "pi", "title": "idle agent", "status": 1, "createdAt": "2026-10-11T09:00:00Z", "modifiedAt": "2026-10-11T09:00:00Z"}),
        session(c, "idle agent", 1, "full", vec![]),
    ));
    rows
}

// tungstenite fixes the callback signature.
#[allow(clippy::result_large_err)]
pub async fn serve_connection(stream: tokio::net::TcpStream, state: Arc<Mutex<Fake>>) {
    use futures_util::{SinkExt, StreamExt};
    let auth_state = state.clone();
    let callback = move |request: &Request,
                         response: Response|
          -> Result<Response, ErrorResponse> {
        let header = request
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let refuse = {
            let mut s = auth_state.lock().unwrap();
            s.auth.push(header.clone());
            s.refuse
        };
        if let Some(status) = refuse {
            let mut refused = ErrorResponse::new(None);
            *refused.status_mut() =
                tokio_tungstenite::tungstenite::http::StatusCode::from_u16(status).unwrap();
            return Err(refused);
        }
        if header.as_deref() != Some(&format!("Bearer {TOKEN}")) {
            let mut denied = ErrorResponse::new(Some("unauthorized".into()));
            *denied.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
            return Err(denied);
        }
        Ok(response)
    };
    let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, callback).await else {
        return;
    };
    let mut seq = 100;
    while let Some(Ok(message)) = ws.next().await {
        let Message::Text(text) = message else {
            continue;
        };
        let frame: Value = serde_json::from_str(&text).unwrap();
        let method = frame["method"].as_str().unwrap_or_default().to_owned();
        let params = frame["params"].clone();
        let id = frame.get("id").cloned();
        let (answered, demo, pi_daemon, bridge) = {
            let s = state.lock().unwrap();
            (s.answered.clone(), s.demo, s.pi_daemon, s.bridge)
        };
        let sessions = |answered: &[String]| {
            if pi_daemon {
                pi_daemon_sessions(answered, bridge)
            } else {
                fixture_sessions(demo, answered)
            }
        };
        let result = match method.as_str() {
            "initialize" => {
                let mut fake = state.lock().unwrap();
                fake.clients
                    .push(params["clientId"].as_str().unwrap_or_default().into());
                let offered: Vec<String> = params["protocolVersions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect();
                fake.offered.push(offered);
                let version = if fake.current { "1.0.0" } else { "0.8.0" };
                Some(json!({"protocolVersion": version, "serverSeq": seq, "snapshots": []}))
            }
            "listSessions" => Some(
                json!({"items": sessions(&answered).into_iter().map(|(s, _)| s).collect::<Vec<_>>()}),
            ),
            // Paratenic rejects a non-positive snapshot view (server.rs subscribe).
            "subscribe" if params["view"]["turns"].as_i64().is_some_and(|t| t <= 0) => {
                let reply = json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32602, "message": "subscribe view.turns must be positive"}});
                let _ = ws.send(Message::Text(reply.to_string().into())).await;
                continue;
            }
            "subscribe" => {
                let channel = params["channel"].as_str().unwrap_or_default();
                let state = sessions(&answered)
                    .into_iter()
                    .find(|(s, _)| s["resource"] == channel)
                    .map(|(_, st)| st);
                Some(match state {
                    Some(st) => {
                        json!({"snapshot": {"resource": channel, "state": st, "fromSeq": seq}})
                    }
                    None if channel.ends_with("/chat") => json!({}),
                    None => {
                        json!({"snapshot": {"resource": channel, "state": session(channel, "gone", 1, "full", vec![]), "fromSeq": seq}})
                    }
                })
            }
            "unsubscribe" => None,
            "dispatchAction" => {
                seq += 1;
                let reject = {
                    let mut s = state.lock().unwrap();
                    s.dispatches.push(params.clone());
                    let reject = s.reject.clone();
                    if reject.is_none() {
                        if let Some(request) = params["action"]["requestId"].as_str() {
                            s.answered.push(request.to_owned());
                        }
                    }
                    reject
                };
                let client = state
                    .lock()
                    .unwrap()
                    .clients
                    .last()
                    .cloned()
                    .unwrap_or_default();
                let mut envelope = json!({"channel": params["channel"], "action": params["action"], "serverSeq": seq, "origin": {"clientId": client, "clientSeq": params["clientSeq"]}});
                if let Some(reason) = reject {
                    envelope["rejectionReason"] = reason.into();
                }
                let note = json!({"jsonrpc": "2.0", "method": "action", "params": envelope});
                let _ = ws.send(Message::Text(note.to_string().into())).await;
                None
            }
            _ => Some(json!({})),
        };
        if let (Some(id), Some(result)) = (id, result) {
            let _ = ws
                .send(Message::Text(
                    json!({"jsonrpc": "2.0", "id": id, "result": result})
                        .to_string()
                        .into(),
                ))
                .await;
        }
    }
}

pub fn fake_host() -> (SocketAddr, Arc<Mutex<Fake>>) {
    fake_host_with(Fake::default())
}
pub fn fake_host_with(fake: Fake) -> (SocketAddr, Arc<Mutex<Fake>>) {
    let state = Arc::new(Mutex::new(fake));
    let (tx, rx) = std::sync::mpsc::channel();
    let shared = state.clone();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap()).unwrap();
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                tokio::spawn(serve_connection(stream, shared.clone()));
            }
        });
    });
    (rx.recv().unwrap(), state)
}
