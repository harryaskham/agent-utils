//! Fleet health: one bounded, concurrent pass over everything `ag` can reach.
//! Read-only. Each check is independent; one slow node never hides others.
use crate::{
    Result,
    config::{Config, Host},
    gallery,
    model::{Listing, MediaKind, SpeechRecord},
    paratenic::{self, Endpoint},
    speech::{self, MuteReceipt, SpeechKind},
    store, transport,
};
use ahp_types::state::SessionStatus;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    task::JoinSet,
};

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, deny_unknown_fields)]
pub struct DoctorInput {
    #[serde(flatten)]
    pub selection: crate::model::Selection,
}

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    Skip,
    /// The node is down or not listening: reported quietly, never a failure.
    Offline,
    Warn,
    Error,
}
impl Status {
    pub fn symbol(self) -> &'static str {
        match self {
            Self::Ok => "●",
            Self::Skip => "○",
            Self::Offline => "◌",
            Self::Warn => "▲",
            Self::Error => "✕",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Check {
    /// ssh | paratenic | speech | images | audio
    pub name: String,
    pub status: Status,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct NodeHealth {
    pub host: String,
    pub status: Status,
    pub checks: Vec<Check>,
}

#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct DoctorReport {
    pub observed_at: String,
    pub status: Status,
    pub nodes: Vec<NodeHealth>,
    pub counts: DoctorCounts,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, JsonSchema)]
pub struct DoctorCounts {
    pub ok: usize,
    pub warn: usize,
    pub error: usize,
    pub offline: usize,
    /// Sessions whose catalogue reports input-needed across reachable hosts.
    pub input_needed_sessions: usize,
}

fn check(name: &str, status: Status, summary: impl Into<String>) -> Check {
    Check {
        name: name.into(),
        status,
        summary: summary.into(),
        latency_ms: None,
        detail: None,
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn age(ms: u64) -> String {
    let secs = now_ms().saturating_sub(ms) / 1000;
    match secs {
        0..60 => format!("{secs}s ago"),
        60..3600 => format!("{}m ago", secs / 60),
        3600..86_400 => format!("{}h ago", secs / 3600),
        _ => format!("{}d ago", secs / 86_400),
    }
}

/// Parse `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)` to epoch ms.
pub fn parse_rfc3339_ms(value: &str) -> Option<u64> {
    let b = value.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    let n = |r: std::ops::Range<usize>| value.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (
        n(0..4)?,
        n(5..7)?,
        n(8..10)?,
        n(11..13)?,
        n(14..16)?,
        n(17..19)?,
    );
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        i = start;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        let frac = value.get(start..i)?;
        let padded = format!("{:0<3}", &frac[..frac.len().min(3)]);
        ms = padded.parse().ok()?;
    }
    let offset = match b.get(i)? {
        b'Z' | b'z' => 0,
        sign @ (b'+' | b'-') => {
            let off = n(i + 1..i + 3)? * 3600 + n(i + 4..i + 6)? * 60;
            if *sign == b'+' { off } else { -off }
        }
        _ => return None,
    };
    let (y2, m2) = if mo <= 2 {
        (y - 1, mo + 9)
    } else {
        (y, mo - 3)
    };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + h * 3600 + mi * 60 + s - offset;
    u64::try_from(secs * 1000 + ms).ok()
}

async fn ssh_and_speech(config: &Config, host: &Host) -> Vec<Check> {
    let started = Instant::now();
    let status: Result<MuteReceipt> = if host.local {
        match host.paths.mute() {
            Ok(path) => tokio::task::spawn_blocking(move || speech::read_state(&path))
                .await
                .unwrap_or_else(|e| Err(crate::Error::Transport(e.to_string()))),
            Err(error) => Err(error),
        }
    } else {
        let mut args = vec!["node".into(), "tts-status".into()];
        if let Some(path) = &host.paths.tts_mute {
            args.extend(["--path".into(), path.clone()]);
        }
        transport::query(config, host, &args).await
    };
    let latency = started.elapsed().as_millis() as u64;
    let mut checks = vec![];
    let link = if host.local { "local" } else { "ssh" };
    match status {
        Ok(receipt) => {
            let muted: Vec<_> = SpeechKind::ALL
                .into_iter()
                .filter(|k| receipt.state.muted.get(k).copied().unwrap_or(false))
                .map(SpeechKind::name)
                .collect();
            checks.push(Check {
                latency_ms: Some(latency),
                ..check(
                    link,
                    Status::Ok,
                    if host.local {
                        "this machine".into()
                    } else {
                        format!("ag reachable · {latency} ms")
                    },
                )
            });
            // Latest durable speech request: liveness of agents on this node.
            let latest: Result<Listing<SpeechRecord>> = if host.local {
                match host.paths.tts() {
                    Ok(path) => tokio::task::spawn_blocking(move || store::speech_list(&path, 1))
                        .await
                        .unwrap_or_else(|e| Err(crate::Error::Transport(e.to_string()))),
                    Err(e) => Err(e),
                }
            } else {
                let mut args = vec![
                    "node".into(),
                    "tts-list".into(),
                    "--limit".into(),
                    "1".into(),
                ];
                if let Some(path) = &host.paths.tts_feed {
                    args.extend(["--path".into(), path.clone()]);
                }
                transport::query(config, host, &args).await
            };
            let mute = if muted.is_empty() {
                String::new()
            } else {
                format!(" · muted {}", muted.join(","))
            };
            checks.push(match latest {
                Ok(listing) => match listing.records.last() {
                    Some(record) => {
                        let at = parse_rfc3339_ms(&record.timestamp);
                        Check {
                            detail: Some(serde_json::json!({"latest": record.timestamp, "agent": record.agent, "muted": muted})),
                            ..check(
                                "speech",
                                Status::Ok,
                                format!(
                                    "last speech {}{}{mute}",
                                    at.map(age).unwrap_or_else(|| record.timestamp.clone()),
                                    record.agent.as_deref().map(|a| format!(" · {a}")).unwrap_or_default()
                                ),
                            )
                        }
                    }
                    None => check("speech", Status::Ok, format!("no speech recorded{mute}")),
                },
                Err(error) => check("speech", Status::Warn, format!("feed unreadable: {error}")),
            });
        }
        Err(error) => {
            let text = error.to_string();
            let (status, summary) = match paratenic::offline_reason(&text) {
                Some(reason) => (Status::Offline, format!("offline · {reason}")),
                None => (Status::Error, text),
            };
            checks.push(Check {
                latency_ms: Some(latency),
                ..check(link, status, summary)
            });
        }
    }
    checks
}

/// Minimal bounded HTTP/1.1 GET for the plaintext Paratenic /status probe.
async fn http_status(base: &str, timeout: Duration) -> Result<(u16, Value)> {
    let url = url::Url::parse(base).map_err(|e| crate::Error::Invalid(e.to_string()))?;
    if url.scheme() != "http" {
        return Err(crate::Error::Invalid(
            "status probe supports http only".into(),
        ));
    }
    let host = url.host_str().unwrap_or_default().to_owned();
    let port = url.port_or_known_default().unwrap_or(80);
    let work = async {
        let mut stream = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
        stream
            .write_all(format!("GET /status HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n").as_bytes())
            .await?;
        let mut bytes = vec![];
        stream.take(1024 * 1024 + 1).read_to_end(&mut bytes).await?;
        Ok::<_, std::io::Error>(bytes)
    };
    let bytes = tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| crate::Error::Transport("status probe timed out".into()))??;
    let split = bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| crate::Error::Transport("malformed status response".into()))?;
    let head = String::from_utf8_lossy(&bytes[..split]).to_lowercase();
    let code = head
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let mut body = bytes[split + 4..].to_vec();
    if head.contains("transfer-encoding: chunked") {
        let mut out = vec![];
        let mut rest = body.as_slice();
        while let Some(end) = rest.windows(2).position(|w| w == b"\r\n") {
            let size = usize::from_str_radix(String::from_utf8_lossy(&rest[..end]).trim(), 16)
                .unwrap_or(0);
            if size == 0 || rest.len() < end + 2 + size {
                break;
            }
            out.extend_from_slice(&rest[end + 2..end + 2 + size]);
            rest = &rest[(end + 4 + size).min(rest.len())..];
        }
        body = out;
    }
    Ok((code, serde_json::from_slice(&body).unwrap_or(Value::Null)))
}

async fn paratenic_check(
    config: &Config,
    host: &Host,
    endpoint: Option<Endpoint>,
) -> (Check, usize) {
    let Some(endpoint) = endpoint else {
        let why = if !config.paratenic.enabled || host.paratenic.enabled == Some(false) {
            "disabled"
        } else {
            "not configured (no ag or Culture endpoint)"
        };
        return (check("paratenic", Status::Skip, why), 0);
    };
    let timeout = Duration::from_secs(config.paratenic.request_timeout_seconds);
    let started = Instant::now();
    let ahp = async {
        let connect = Duration::from_secs(config.connect_timeout_seconds).min(timeout);
        let connection = paratenic::Connection::open_with(&endpoint, connect, timeout).await?;
        let sessions = connection.sessions().await;
        let connect_ms = connection.connect_ms;
        connection.close().await;
        Ok::<_, crate::Error>((connect_ms, sessions?))
    };
    let probe = async {
        match endpoint.http_base() {
            Some(base) if base.starts_with("http://") => http_status(&base, timeout).await.ok(),
            _ => None,
        }
    };
    let (ahp, status) = tokio::join!(tokio::time::timeout(timeout * 3, ahp), probe);
    let latency = started.elapsed().as_millis() as u64;
    let mut detail = serde_json::json!({"url": endpoint.url, "source": endpoint.source});
    let mut warnings = vec![];
    if let Some((code, body)) = &status {
        detail["httpStatus"] = (*code).into();
        if *code == 200 {
            for key in [
                "uptimeSeconds",
                "sessions",
                "connectedSessions",
                "providerConnections",
                "backendConnections",
                "pendingBackendCommands",
            ] {
                if let Some(v) = body.get(key) {
                    detail[key] = v.clone();
                }
            }
            if body.pointer("/persistence/rootCheckpointPending") == Some(&Value::Bool(true))
                && body
                    .pointer("/persistence/rootSaveAgeMs")
                    .and_then(Value::as_u64)
                    .is_some_and(|ms| ms > 30_000)
            {
                warnings.push("root checkpoint slow".to_owned());
            }
        } else if body.get("error").and_then(Value::as_str) == Some("inspection_busy") {
            warnings.push("host lock contended (inspection_busy)".into());
        } else {
            warnings.push(format!("/status HTTP {code}"));
        }
    }
    match ahp {
        Ok(Ok((connect_ms, sessions))) => {
            let waiting = sessions
                .iter()
                .filter(|s| SessionStatus::from_bits(s.status).contains(SessionStatus::InputNeeded))
                .count();
            let offline = sessions
                .iter()
                .filter(|s| {
                    s.meta
                        .as_ref()
                        .and_then(|m| m.get("paratenic"))
                        .and_then(|m| m.get("backendOnline"))
                        .and_then(Value::as_bool)
                        == Some(false)
                })
                .count();
            detail["connectMs"] = connect_ms.into();
            detail["catalogue"] = sessions.len().into();
            detail["inputNeeded"] = waiting.into();
            detail["backendOffline"] = offline.into();
            if connect_ms > 5_000 {
                warnings.push(format!("slow connect {connect_ms} ms"));
            }
            let mut summary = format!(
                "{} sessions · {waiting} waiting · {latency} ms",
                sessions.len()
            );
            if !warnings.is_empty() {
                summary.push_str(&format!(" · {}", warnings.join("; ")));
            }
            (
                Check {
                    latency_ms: Some(latency),
                    detail: Some(detail),
                    ..check(
                        "paratenic",
                        if warnings.is_empty() {
                            Status::Ok
                        } else {
                            Status::Warn
                        },
                        summary,
                    )
                },
                waiting,
            )
        }
        Ok(Err(error)) => {
            let text = error.to_string();
            let (status, summary) = match paratenic::offline_reason(&text) {
                Some(reason) => (Status::Offline, format!("offline · {reason}")),
                None => (
                    Status::Error,
                    format!(
                        "{text}{}",
                        if warnings.is_empty() {
                            String::new()
                        } else {
                            format!(" · {}", warnings.join("; "))
                        }
                    ),
                ),
            };
            (
                Check {
                    latency_ms: Some(latency),
                    detail: Some(detail),
                    ..check("paratenic", status, summary)
                },
                0,
            )
        }
        Err(_) => (
            Check {
                latency_ms: Some(latency),
                detail: Some(detail),
                ..check("paratenic", Status::Offline, "offline · timed out")
            },
            0,
        ),
    }
}

fn images_check(config: &Config, host: &Host) -> Check {
    let Ok(root) = gallery::cache_path(config, None) else {
        return check("images", Status::Skip, "no gallery cache");
    };
    match gallery::last_sync_ms(&root, host) {
        Some(ms) => check("images", Status::Ok, format!("gallery synced {}", age(ms))),
        None => check("images", Status::Skip, "not pulled yet (ag image pull)"),
    }
}

fn audio_check(config: &Config, host: &Host) -> Check {
    let Ok(root) = gallery::media_cache_path(config, MediaKind::Audio, None) else {
        return check("audio", Status::Skip, "no audio cache");
    };
    match gallery::media_last_sync_ms(&root, MediaKind::Audio, host) {
        Some(ms) => check("audio", Status::Ok, format!("audio synced {}", age(ms))),
        None => check(
            "audio",
            Status::Skip,
            "not pulled yet (ag audio pull / ag sync)",
        ),
    }
}

pub async fn report(config: &Config, targets: Vec<(Host, Option<Endpoint>)>) -> DoctorReport {
    let mut jobs = JoinSet::new();
    for (host, endpoint) in targets {
        let config = config.clone();
        jobs.spawn(async move {
            let (mut checks, (paratenic, waiting)) = tokio::join!(
                ssh_and_speech(&config, &host),
                paratenic_check(&config, &host, endpoint)
            );
            let link_offline = checks.first().is_some_and(|c| c.status == Status::Offline);
            let images = images_check(&config, &host);
            let audio = audio_check(&config, &host);
            let paratenic_down = matches!(paratenic.status, Status::Offline | Status::Skip);
            let (status, checks) = if link_offline && paratenic_down {
                // A down node is one quiet line: why, plus what is still cached.
                let reason = checks[0].summary.clone();
                let mut cached = vec![check("node", Status::Offline, reason), images];
                // Only mention audio for a down node once something was cached.
                if audio.status == Status::Ok {
                    cached.push(audio);
                }
                (Status::Offline, cached)
            } else {
                let mut paratenic = paratenic;
                if link_offline {
                    // Agents answer over AHP, so the node is up; SSH is the problem.
                    checks[0].status = Status::Warn;
                    checks[0].summary =
                        checks[0]
                            .summary
                            .replacen("offline", "unreachable over SSH", 1);
                } else if paratenic.status == Status::Offline {
                    // Reachable over SSH but Paratenic is not answering.
                    paratenic.status = Status::Warn;
                    paratenic.summary = paratenic.summary.replacen("offline", "not answering", 1);
                }
                checks.insert(1.min(checks.len()), paratenic);
                checks.push(images);
                checks.push(audio);
                let status = checks
                    .iter()
                    .map(|c| {
                        if c.status == Status::Skip {
                            Status::Ok
                        } else {
                            c.status
                        }
                    })
                    .max()
                    .unwrap_or(Status::Ok);
                (status, checks)
            };
            (
                NodeHealth {
                    host: host.name,
                    status,
                    checks,
                },
                waiting,
            )
        });
    }
    let mut nodes = vec![];
    let mut counts = DoctorCounts::default();
    while let Some(Ok((node, waiting))) = jobs.join_next().await {
        counts.input_needed_sessions += waiting;
        match node.status {
            Status::Error => counts.error += 1,
            Status::Warn => counts.warn += 1,
            Status::Offline => counts.offline += 1,
            _ => counts.ok += 1,
        }
        nodes.push(node);
    }
    nodes.sort_by(|a, b| a.host.cmp(&b.host));
    DoctorReport {
        observed_at: paratenic::now_rfc3339(),
        // Offline nodes are reported, but do not make the fleet unhealthy.
        status: nodes
            .iter()
            .map(|n| {
                if n.status == Status::Offline {
                    Status::Ok
                } else {
                    n.status
                }
            })
            .max()
            .unwrap_or(Status::Ok),
        nodes,
        counts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc3339_parsing_matches_formatting() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_ms("2026-10-11T10:50:52.123Z"),
            Some(1_791_715_852_123)
        );
        assert_eq!(
            parse_rfc3339_ms("2026-10-11T11:50:52+01:00"),
            parse_rfc3339_ms("2026-10-11T10:50:52Z")
        );
        assert_eq!(parse_rfc3339_ms("garbage"), None);
        let now = paratenic::now_rfc3339();
        let parsed = parse_rfc3339_ms(&now).unwrap();
        assert!(now_ms().abs_diff(parsed) < 5_000, "{now}");
        assert!(paratenic::offline_reason("IO error: Connection refused (os error 61)").is_some());
        assert!(paratenic::offline_reason("rpc error -32600: denied").is_none());
    }
}
