//! A small bounded HTTP/1.0 client for Cursive daemons on the tailnet.
//!
//! Cursive's daemon speaks plain HTTP on loopback and tailnet addresses (no
//! token, no TLS); ag only needs JSON GETs, raw export bytes, one POST and a
//! server-sent-event stream from it. HTTP/1.0 keeps replies unchunked; chunked
//! replies are still decoded. Every read is bounded in bytes and time.
use crate::{Error, Result};
use std::time::Duration;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpStream,
};
use url::Url;

const MAX_HEAD: usize = 64 * 1024;
const MAX_EVENT: usize = 1024 * 1024;

#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    /// Lower-cased names.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
impl Reply {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

/// A daemon base URL: `http://host[:port]`, nothing else (no credentials,
/// path, query or fragment). Returned without a trailing slash.
pub fn base(url: &str) -> Result<String> {
    let parsed = Url::parse(url).map_err(|e| Error::Invalid(format!("{url}: {e}")))?;
    if parsed.scheme() != "http"
        || parsed.host_str().is_none_or(str::is_empty)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(Error::Invalid(format!(
            "{url}: a Cursive daemon URL is http://host[:port] (plain HTTP on loopback or the tailnet)"
        )));
    }
    Ok(url.trim_end_matches('/').to_owned())
}

/// A browser-facing web view origin: `http(s)://host[:port]`.
pub fn web(url: &str) -> Result<String> {
    let parsed = Url::parse(url).map_err(|e| Error::Invalid(format!("{url}: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none_or(str::is_empty)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(Error::Invalid(format!(
            "{url}: the web view URL is http(s)://host[:port]"
        )));
    }
    Ok(url.trim_end_matches('/').to_owned())
}

/// Whether a daemon URL names this machine.
pub fn loopback(url: &str) -> bool {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host().map(|h| h.to_owned()))
        .is_some_and(|host| match host {
            url::Host::Domain(d) => d.eq_ignore_ascii_case("localhost"),
            url::Host::Ipv4(ip) => ip.is_loopback(),
            url::Host::Ipv6(ip) => ip.is_loopback(),
        })
}

async fn connect(url: &Url, timeout: Duration) -> Result<TcpStream> {
    let host = url
        .host_str()
        .ok_or_else(|| Error::Invalid(format!("{url}: no host")))?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let port = url.port_or_known_default().unwrap_or(80);
    match tokio::time::timeout(timeout, TcpStream::connect((host.as_str(), port))).await {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(error)) => Err(Error::Transport(format!(
            "{}: {error}",
            url.origin().ascii_serialization()
        ))),
        Err(_) => Err(Error::Transport(format!(
            "{}: connect timed out",
            url.origin().ascii_serialization()
        ))),
    }
}

fn head(url: &Url, method: &str, headers: &[(&str, &str)], body: Option<&[u8]>) -> String {
    let mut target = url.path().to_owned();
    if let Some(query) = url.query() {
        target.push('?');
        target.push_str(query);
    }
    let authority = match url.port() {
        Some(port) => format!("{}:{port}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_owned(),
    };
    let mut text = format!(
        "{method} {target} HTTP/1.0\r\nHost: {authority}\r\nUser-Agent: ag/{}\r\nAccept: */*\r\n",
        env!("CARGO_PKG_VERSION")
    );
    for (name, value) in headers {
        if !name.contains(['\r', '\n']) && !value.contains(['\r', '\n']) {
            text.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    if let Some(body) = body {
        text.push_str(&format!(
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            body.len()
        ));
    }
    text.push_str("\r\n");
    text
}

fn parse_head(bytes: &[u8]) -> Result<(u16, Vec<(String, String)>)> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| Error::Transport("daemon reply head is not UTF-8".into()))?;
    let mut lines = text.split("\r\n");
    let status = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| Error::Transport("daemon reply has no HTTP status".into()))?;
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_owned()))
        .collect();
    Ok((status, headers))
}

fn dechunk(mut body: &[u8], max: usize) -> Result<Vec<u8>> {
    let mut out = vec![];
    loop {
        let line_end = body
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or_else(|| Error::Transport("truncated chunked reply".into()))?;
        let size = std::str::from_utf8(&body[..line_end])
            .ok()
            .and_then(|s| usize::from_str_radix(s.split(';').next()?.trim(), 16).ok())
            .ok_or_else(|| Error::Transport("bad chunk size".into()))?;
        body = &body[line_end + 2..];
        if size == 0 {
            return Ok(out);
        }
        if body.len() < size || out.len() + size > max {
            return Err(Error::Transport(
                "truncated or oversized chunked reply".into(),
            ));
        }
        out.extend_from_slice(&body[..size]);
        body = body.get(size + 2..).unwrap_or_default();
    }
}

/// One request: status, headers and a body of at most `max` bytes, within
/// `timeout` in total. Transport failures are errors; every status returns.
pub async fn request(
    method: &str,
    url: &str,
    body: Option<&[u8]>,
    headers: &[(&str, &str)],
    max: usize,
    timeout: Duration,
) -> Result<Reply> {
    let parsed = Url::parse(url).map_err(|e| Error::Invalid(format!("{url}: {e}")))?;
    let work = async {
        let mut stream = connect(&parsed, timeout).await?;
        stream
            .write_all(head(&parsed, method, headers, body).as_bytes())
            .await?;
        if let Some(body) = body {
            stream.write_all(body).await?;
        }
        let mut bytes = vec![];
        (&mut stream)
            .take((max + MAX_HEAD) as u64 + 1)
            .read_to_end(&mut bytes)
            .await?;
        let split = bytes
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .filter(|&i| i <= MAX_HEAD)
            .ok_or_else(|| Error::Transport(format!("{url}: no HTTP reply")))?;
        let (status, headers) = parse_head(&bytes[..split])?;
        let raw = &bytes[split + 4..];
        let chunked = headers
            .iter()
            .any(|(k, v)| k == "transfer-encoding" && v.to_ascii_lowercase().contains("chunked"));
        let body = if chunked {
            dechunk(raw, max)?
        } else {
            raw.to_vec()
        };
        if body.len() > max {
            return Err(Error::Limit(format!("{url}: reply exceeds {max} bytes")));
        }
        Ok(Reply {
            status,
            headers,
            body,
        })
    };
    match tokio::time::timeout(timeout, work).await {
        Ok(result) => result,
        Err(_) => Err(Error::Transport(format!(
            "{url}: no reply within {}s",
            timeout.as_secs()
        ))),
    }
}

/// A JSON GET that must answer 200.
pub async fn get_json<T: serde::de::DeserializeOwned>(
    url: &str,
    max: usize,
    timeout: Duration,
) -> Result<T> {
    let reply = request("GET", url, None, &[], max, timeout).await?;
    if reply.status != 200 {
        return Err(Error::Transport(format!(
            "{url}: HTTP {} {}",
            reply.status,
            error_message(&reply.body).unwrap_or_default()
        )));
    }
    Ok(serde_json::from_slice(&reply.body)?)
}

/// The message of a Cursive JSON error envelope.
pub fn error_message(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()?
        .get("error")?
        .get("message")?
        .as_str()
        .map(str::to_owned)
}

/// A server-sent-event stream (`event:`/`data:` lines; comments ignored).
pub struct Events {
    reader: BufReader<TcpStream>,
}
impl Events {
    pub async fn connect(url: &str, timeout: Duration) -> Result<Self> {
        let parsed = Url::parse(url).map_err(|e| Error::Invalid(format!("{url}: {e}")))?;
        let mut stream = connect(&parsed, timeout).await?;
        stream
            .write_all(head(&parsed, "GET", &[("Accept", "text/event-stream")], None).as_bytes())
            .await?;
        let mut reader = BufReader::new(stream);
        let mut head = vec![];
        loop {
            let mut line = vec![];
            let read = tokio::time::timeout(timeout, reader.read_until(b'\n', &mut line))
                .await
                .map_err(|_| Error::Transport(format!("{url}: no stream reply")))??;
            if read == 0 {
                return Err(Error::Transport(format!("{url}: closed before replying")));
            }
            if line == b"\r\n" || line == b"\n" {
                break;
            }
            head.extend_from_slice(&line);
            if head.len() > MAX_HEAD {
                return Err(Error::Transport(format!("{url}: oversized reply head")));
            }
        }
        let (status, _) = parse_head(&head)?;
        if status != 200 {
            return Err(Error::Transport(format!("{url}: HTTP {status}")));
        }
        Ok(Self { reader })
    }
    /// The next event as (type, data). `None` when the stream ends; an error
    /// when nothing (not even a keep-alive comment) arrives within `idle`.
    pub async fn next(&mut self, idle: Duration) -> Result<Option<(String, String)>> {
        let (mut kind, mut data) = (String::new(), String::new());
        loop {
            let mut line = vec![];
            let read = tokio::time::timeout(
                idle,
                (&mut self.reader)
                    .take(MAX_EVENT as u64)
                    .read_until(b'\n', &mut line),
            )
            .await
            .map_err(|_| Error::Transport("event stream went quiet".into()))??;
            if read == 0 {
                return Ok(None);
            }
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\r', '\n']);
            if line.is_empty() {
                if !data.is_empty() || !kind.is_empty() {
                    return Ok(Some((kind, data)));
                }
            } else if let Some(value) = line.strip_prefix("event:") {
                kind = value.trim().to_owned();
            } else if let Some(value) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value.trim_start());
            }
        }
    }
}
