//! `ag audio play`: local playback of one shared clip through the standard
//! output graph, mirroring the Pi audio reel's backend selection:
//! `ffmpeg … -f s16le` piped into pacat (Pulse, default; honours
//! PULSE_SERVER/PULSE_SINK), sox `play`, or `ffplay` (CoreAudio on macOS).
//! CLI-only: playback is never exposed over MCP, and it never touches the
//! speech mute policy or queue.
use crate::{Error, Result};
use serde::Serialize;
use std::{path::Path, process::Stdio};
use tokio::process::Command;

pub const RATE: u32 = 48_000;

#[derive(Clone, Debug, Default)]
pub struct PlayOptions {
    pub backend: Option<String>,
    pub server: Option<String>,
    pub sink: Option<String>,
    /// Percent, 0–150.
    pub volume: u32,
    pub start_seconds: f64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Output {
    pub backend: String,
    pub server: Option<String>,
    pub sink: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct PlayReceipt {
    pub id: String,
    pub source: String,
    pub output: Output,
    pub completed: bool,
}

fn value(name: &str, v: Option<String>) -> Result<Option<String>> {
    match v.filter(|v| !v.is_empty()) {
        Some(v) if v.len() > 1024 || v.chars().any(char::is_control) => Err(Error::Invalid(
            format!("audio {name} must be a bounded value without control characters"),
        )),
        other => Ok(other),
    }
}

/// Explicit flags, then PI_AUDIO_*, then PULSE_*, then the platform default.
pub fn resolve_output(
    options: &PlayOptions,
    env: impl Fn(&str) -> Option<String>,
    macos: bool,
) -> Result<Output> {
    let server = value(
        "server",
        options
            .server
            .clone()
            .or_else(|| env("PI_AUDIO_SERVER").filter(|v| !v.is_empty()))
            .or_else(|| env("PULSE_SERVER")),
    )?;
    let sink = value(
        "sink",
        options
            .sink
            .clone()
            .or_else(|| env("PI_AUDIO_SINK").filter(|v| !v.is_empty()))
            .or_else(|| env("PULSE_SINK")),
    )?;
    let requested = options
        .backend
        .clone()
        .or_else(|| env("PI_AUDIO_BACKEND").filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "auto".into())
        .to_ascii_lowercase();
    let backend = match requested.as_str() {
        "auto" => {
            if server.is_some() || sink.is_some() || !macos {
                "pulse"
            } else {
                "ffplay"
            }
        }
        "pulse" | "pulseaudio" | "pacat" | "paplay" | "pipewire" => "pulse",
        "sox" | "play" => "sox",
        "ffplay" | "coreaudio" | "ffmpeg" => "ffplay",
        other => {
            return Err(Error::Invalid(format!(
                "unsupported audio backend '{other}' (auto, pulse, sox, ffplay)"
            )));
        }
    };
    Ok(Output {
        backend: backend.into(),
        server,
        sink,
    })
}

pub fn decoder_args(path: &Path, start_seconds: f64, volume: u32) -> Vec<String> {
    let mut args: Vec<String> = ["-nostdin", "-hide_banner", "-loglevel", "error"]
        .map(String::from)
        .into();
    if start_seconds > 0.0 {
        args.extend(["-ss".into(), format!("{start_seconds:.3}")]);
    }
    // file: prevents the path from selecting another ffmpeg protocol.
    args.extend(["-i".into(), format!("file:{}", path.display())]);
    args.extend(["-vn", "-sn", "-dn"].map(String::from));
    if volume != 100 {
        args.extend([
            "-af".into(),
            format!("volume={:.3}", f64::from(volume) / 100.0),
        ]);
    }
    args.extend(
        [
            "-acodec",
            "pcm_s16le",
            "-f",
            "s16le",
            "-ar",
            &RATE.to_string(),
            "-ac",
            "2",
            "pipe:1",
        ]
        .map(String::from),
    );
    args
}

/// Sink program, argv and environment overrides (None removes the variable).
pub struct SinkCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(&'static str, Option<String>)>,
}
pub fn sink_command(output: &Output, label: &str) -> SinkCommand {
    let label: String = label
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(120)
        .collect();
    let rate = RATE.to_string();
    let strings = |items: &[&str]| items.iter().map(|s| s.to_string()).collect();
    match output.backend.as_str() {
        "sox" => SinkCommand {
            program: "play".into(),
            args: strings(&[
                "-q",
                "-t",
                "raw",
                "-b",
                "16",
                "-e",
                "signed-integer",
                "-L",
                "-r",
                &rate,
                "-c",
                "2",
                "-",
            ]),
            env: output
                .sink
                .clone()
                .map(|s| vec![("AUDIODEV", Some(s))])
                .unwrap_or_default(),
        },
        "ffplay" => SinkCommand {
            program: "ffplay".into(),
            args: strings(&[
                "-nodisp",
                "-autoexit",
                "-loglevel",
                "error",
                "-f",
                "s16le",
                "-ar",
                &rate,
                "-ch_layout",
                "stereo",
                "-i",
                "-",
            ]),
            env: vec![],
        },
        _ => {
            let mut args: Vec<String> = vec![
                "--playback".into(),
                "--raw".into(),
                "--format=s16le".into(),
                format!("--rate={RATE}"),
                "--channels=2".into(),
            ];
            if let Some(server) = &output.server {
                args.push(format!("--server={server}"));
            }
            if let Some(sink) = &output.sink {
                args.push(format!("--device={sink}"));
            }
            args.push("--client-name=ag audio".into());
            args.push(format!("--stream-name={label}"));
            SinkCommand {
                program: "pacat".into(),
                args,
                env: vec![("PULSE_SERVER", output.server.clone())],
            }
        }
    }
}

fn missing(error: std::io::Error, program: &str) -> Error {
    if error.kind() == std::io::ErrorKind::NotFound {
        Error::Transport(format!(
            "{program} not found; install it or choose another --backend (pulse, sox, ffplay)"
        ))
    } else {
        error.into()
    }
}

/// Decode `path` and play it until it ends or Ctrl-C. Both children are
/// owned and reaped; a failed decoder or sink is an error with its stderr.
pub async fn play(path: &Path, label: &str, options: &PlayOptions) -> Result<(Output, bool)> {
    if options.volume > 150 {
        return Err(Error::Invalid("volume must be 0–150".into()));
    }
    if !options.start_seconds.is_finite() || options.start_seconds < 0.0 {
        return Err(Error::Invalid(
            "start must be a nonnegative number of seconds".into(),
        ));
    }
    let output = resolve_output(
        options,
        |k| std::env::var(k).ok(),
        cfg!(target_os = "macos"),
    )?;
    let mut decoder = Command::new("ffmpeg")
        .args(decoder_args(path, options.start_seconds, options.volume))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| missing(e, "ffmpeg"))?;
    let pcm: Stdio = decoder
        .stdout
        .take()
        .expect("decoder stdout")
        .try_into()
        .map_err(|e: std::io::Error| Error::Transport(e.to_string()))?;
    let SinkCommand { program, args, env } = sink_command(&output, label);
    let mut sink = Command::new(&program);
    sink.args(&args)
        .stdin(pcm)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in env {
        match value {
            Some(v) => sink.env(key, v),
            None => sink.env_remove(key),
        };
    }
    let mut sink = sink.spawn().map_err(|e| missing(e, &program))?;
    let tail = |stderr: Option<tokio::process::ChildStderr>| async move {
        use tokio::io::AsyncReadExt;
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let mut buffer = Vec::new();
            let _ = stderr.read_to_end(&mut buffer).await;
            text = String::from_utf8_lossy(&buffer[buffer.len().saturating_sub(600)..])
                .trim()
                .to_owned();
        }
        text
    };
    let decoder_err = tokio::spawn(tail(decoder.stderr.take()));
    let sink_err = tokio::spawn(tail(sink.stderr.take()));
    let finished = tokio::select! {
        status = async { tokio::join!(decoder.wait(), sink.wait()) } => Some(status),
        _ = tokio::signal::ctrl_c() => None,
    };
    let Some((decoded, played)) = finished else {
        let _ = decoder.kill().await;
        let _ = sink.kill().await;
        return Ok((output, false));
    };
    let (decoded, played) = (decoded?, played?);
    let decoder_err = decoder_err.await.unwrap_or_default();
    let sink_err = sink_err.await.unwrap_or_default();
    if !decoded.success() {
        return Err(Error::Transport(format!("ffmpeg {decoded}: {decoder_err}")));
    }
    if !played.success() {
        return Err(Error::Transport(format!("{program} {played}: {sink_err}")));
    }
    Ok((output, true))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_resolution_and_specs() {
        let env = |k: &str| match k {
            "PULSE_SERVER" => Some("tcp:h:4713".into()),
            _ => None,
        };
        let o = resolve_output(&PlayOptions::default(), env, true).unwrap();
        assert_eq!(o.backend, "pulse", "routed Pulse wins on macOS");
        assert_eq!(o.server.as_deref(), Some("tcp:h:4713"));
        let o = resolve_output(&PlayOptions::default(), |_| None, true).unwrap();
        assert_eq!(o.backend, "ffplay");
        let o = resolve_output(
            &PlayOptions {
                backend: Some("pacat".into()),
                sink: Some("studio".into()),
                ..PlayOptions::default()
            },
            |_| None,
            false,
        )
        .unwrap();
        let sink = sink_command(&o, "a\nb");
        assert_eq!(sink.program, "pacat");
        assert!(sink.args.contains(&"--device=studio".to_string()));
        assert!(sink.args.contains(&"--stream-name=a b".to_string()));
        assert!(
            resolve_output(
                &PlayOptions {
                    backend: Some("alsa".into()),
                    ..PlayOptions::default()
                },
                |_| None,
                false
            )
            .is_err()
        );
        let args = decoder_args(Path::new("/x/a:b.mp3"), 1.5, 50);
        assert!(args.windows(2).any(|w| w == ["-ss", "1.500"]));
        assert!(args.contains(&"file:/x/a:b.mp3".to_string()));
        assert!(args.contains(&"volume=0.500".to_string()));
    }
}
