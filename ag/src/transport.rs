use crate::{
    Error, Result,
    config::{Config, Host},
    model::{Cursor, MAX_RECORD_BYTES, MAX_RESPONSE_BYTES, TailEvent},
};
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader},
    process::{Child, Command},
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub fn remote_command(host: &Host, arguments: &[String]) -> String {
    let executable = shell_quote(&host.command);
    let invocation = std::iter::once(executable.clone())
        .chain(arguments.iter().map(|value| shell_quote(value)))
        .collect::<Vec<_>>()
        .join(" ");
    let missing = shell_quote(&format!(
        "ag: remote executable {:?} is unavailable after login initialization. Install ag on this node (apply its Collective configuration), or set hosts[].command to an installed executable. cltv-run/nix run on the collector does not install remote nodes.",
        host.command
    ));
    // SSH runs a non-login shell. Ask the REMOTE account's shell to initialize
    // its login environment; never copy the collector's PATH to another node.
    // fd 3 saves the protocol stdout while profile chatter goes to stderr.
    // A POSIX sh payload keeps the check/redirections independent of whether
    // the account's login shell is bash, zsh, or another compatible -lc shell.
    // Every stage execs its successor, preserving stdin/EOF and process cleanup.
    let payload = format!(
        "if ! command -v {executable} >/dev/null 2>&1; then printf '%s\\n' {missing} >&2; exit 127; fi; exec {invocation} 1>&3 3>&-"
    );
    let login = format!("exec sh -c {}", shell_quote(&payload));
    format!("exec \"$SHELL\" -lc {} 3>&1 1>&2", shell_quote(&login))
}

pub fn ssh_command(config: &Config, host: &Host, arguments: &[String]) -> Command {
    let mut command = Command::new(&config.ssh_command);
    command.args([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=2",
    ]);
    command
        .arg("-o")
        .arg(format!("ConnectTimeout={}", config.connect_timeout_seconds));
    command.arg("-p").arg(host.port.to_string());
    if let Some(user) = &host.username {
        command.arg("-l").arg(user);
    }
    command.arg("--").arg(&host.address);
    command.arg(remote_command(host, arguments));
    command.kill_on_drop(true);
    command
}

async fn read_bounded(mut input: impl AsyncRead + Unpin, max: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut input)
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > max {
        return Err(Error::Limit(format!("node response exceeds {max} bytes")));
    }
    Ok(bytes)
}
async fn drain_error(mut input: impl AsyncRead + Unpin) -> Result<Vec<u8>> {
    let mut tail = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let n = input.read(&mut buffer).await?;
        if n == 0 {
            return Ok(tail);
        }
        tail.extend_from_slice(&buffer[..n]);
        if tail.len() > 4096 {
            tail.drain(..tail.len() - 4096);
        }
    }
}
async fn stop(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}
pub async fn capture(config: &Config, host: &Host, args: &[String], max: usize) -> Result<Vec<u8>> {
    let mut child = ssh_command(config, host, args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let work = async {
        let (bytes, errors, status) =
            tokio::try_join!(read_bounded(stdout, max), drain_error(stderr), async {
                child.wait().await.map_err(Error::from)
            })?;
        if !status.success() {
            return Err(Error::Transport(format!(
                "SSH exited {status}: {}",
                String::from_utf8_lossy(&errors).trim()
            )));
        }
        Ok(bytes)
    };
    match tokio::time::timeout(Duration::from_secs(config.command_timeout_seconds), work).await {
        Ok(Ok(bytes)) => Ok(bytes),
        Ok(Err(error)) => {
            stop(&mut child).await;
            Err(error)
        }
        Err(_) => {
            stop(&mut child).await;
            Err(Error::Transport("node request timed out".into()))
        }
    }
}
pub async fn query<T: serde::de::DeserializeOwned>(
    config: &Config,
    host: &Host,
    args: &[String],
) -> Result<T> {
    let bytes = capture(config, host, args, MAX_RESPONSE_BYTES).await?;
    match serde_json::from_slice::<mcp_cli::JsonEnvelope<T>>(&bytes)? {
        mcp_cli::JsonEnvelope::Success { data, .. } => Ok(data),
        mcp_cli::JsonEnvelope::Error { error, .. } => Err(Error::Transport(error.message)),
    }
}

// Bounded framing for a peer that never sends a newline (or sends a huge one).
async fn line(reader: &mut (impl AsyncBufRead + Unpin)) -> Result<Option<Vec<u8>>> {
    let mut output = Vec::new();
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            if output.is_empty() {
                return Ok(None);
            }
            return Err(Error::Transport(
                "node closed with a partial JSON frame".into(),
            ));
        }
        let newline = buffer.iter().position(|b| *b == b'\n');
        let count = newline.map_or(buffer.len(), |i| i + 1);
        if output.len() + count > MAX_RECORD_BYTES + 65536 {
            return Err(Error::Limit("node stream frame exceeds 8 MiB".into()));
        }
        output.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if newline.is_some() {
            return Ok(Some(output));
        }
    }
}

pub async fn stream(
    config: &Config,
    host: &Host,
    lines: usize,
    cursor: &mut Option<Cursor>,
    tx: &mpsc::Sender<TailEvent>,
    cancel: &CancellationToken,
) -> Result<()> {
    let mut args = vec![
        "node".into(),
        "tts".into(),
        "--lines".into(),
        lines.to_string(),
        "--follow".into(),
        "--watch-stdin".into(),
        "--poll-ms".into(),
        config.poll_ms.to_string(),
    ];
    if let Some(path) = &host.paths.tts_feed {
        args.extend(["--path".into(), path.clone()]);
    }
    if let Some(cursor) = cursor {
        args.extend(["--cursor".into(), serde_json::to_string(cursor)?]);
    }
    let mut child = ssh_command(config, host, &args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut reader = BufReader::new(child.stdout.take().expect("piped stdout"));
    let errors = tokio::spawn(drain_error(child.stderr.take().expect("piped stderr")));
    let work = async {
        let mut started = false;
        loop {
            let next = if !started {
                tokio::time::timeout(
                    Duration::from_secs(config.command_timeout_seconds),
                    line(&mut reader),
                )
                .await
                .map_err(|_| Error::Transport("node stream startup timed out".into()))??
            } else {
                line(&mut reader).await?
            };
            let Some(bytes) = next else {
                break;
            };
            let event: TailEvent = serde_json::from_slice(&bytes)?;
            started = true;
            if let Some(next) = event.cursor() {
                *cursor = Some(next);
            }
            tx.send(event)
                .await
                .map_err(|_| Error::Transport("tail consumer closed".into()))?;
        }
        Err(Error::Transport("node stream disconnected".into()))
    };
    let result = tokio::select! { _ = cancel.cancelled() => Ok(()), value = work => value };
    stop(&mut child).await;
    let stderr = errors.await.ok().and_then(|v| v.ok()).unwrap_or_default();
    result.map_err(|error| {
        if stderr.is_empty() {
            error
        } else {
            Error::Transport(format!(
                "{error}: {}",
                String::from_utf8_lossy(&stderr).trim()
            ))
        }
    })
}
