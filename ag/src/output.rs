//! Human speech presentation only; JSON and peer records never pass through here.
//!
//! Direction: compact, quiet, scannable. One metadata rail above unstyled prose,
//! with a single blank row between records. Use the terminal's own ANSI palette.
use ag::{model::SpeechRecord, terminal_text};
use clap::ColorChoice;
use std::{ffi::OsStr, io::IsTerminal};

const RESET: &str = "\x1b[0m";
const TIMESTAMP: &str = "\x1b[2m";
const HOST: &str = "\x1b[36m";
const AGENT: &str = "\x1b[1m";

pub struct SpeechOutput {
    color: bool,
}

impl SpeechOutput {
    pub fn new(choice: ColorChoice) -> Self {
        Self {
            color: use_color(
                choice,
                std::io::stdout().is_terminal(),
                std::env::var_os("NO_COLOR").as_deref(),
                std::env::var_os("TERM").as_deref(),
            ),
        }
    }

    fn styled(&self, style: &str, value: &str) -> String {
        // Sanitize *before* adding our own trusted SGR sequences.
        let value = terminal_text(value);
        if self.color {
            format!("{style}{value}{RESET}")
        } else {
            value
        }
    }

    /// Two logical lines plus a blank separator; the terminal handles wrapping.
    pub fn entry(&self, host: &str, record: &SpeechRecord) -> String {
        let kind_style = match record.kind.as_str() {
            "tts" => "\x1b[32m",
            "narrate" => "\x1b[33m",
            "read" => "\x1b[35m",
            "choices" => "\x1b[34m",
            _ => TIMESTAMP,
        };
        let agent = record
            .agent
            .as_deref()
            .or(record.session.as_deref())
            .unwrap_or("unknown");
        format!(
            "{} {} {} {}\n{}\n\n",
            self.styled(TIMESTAMP, &record.timestamp),
            self.styled(HOST, &format!("[{host}]")),
            self.styled(kind_style, &format!("[{}]", record.kind)),
            self.styled(AGENT, agent),
            message_line(&record.text),
        )
    }
}

fn use_color(
    choice: ColorChoice,
    tty: bool,
    no_color: Option<&OsStr>,
    term: Option<&OsStr>,
) -> bool {
    match choice {
        ColorChoice::Always => true,
        ColorChoice::Never => false,
        ColorChoice::Auto => {
            tty && no_color.is_none_or(|v| v.is_empty()) && term != Some(OsStr::new("dumb"))
        }
    }
}

fn message_line(text: &str) -> String {
    // Fold LF/CRLF paragraph breaks, but do not decode literal backslash escapes
    // or allow a bare CR, ESC, BEL, etc. to change the terminal state.
    let mut line = String::with_capacity(text.len());
    for part in text.lines() {
        if part.is_empty() {
            continue;
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(part);
    }
    terminal_text(&line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(text: &str) -> SpeechRecord {
        serde_json::from_value(json!({
            "timestamp": "2026-10-07T08:09:09.894Z",
            "kind": "narrate",
            "agent": "android-improvements",
            "session": "session-id",
            "text": text,
        }))
        .unwrap()
    }

    #[test]
    fn header_body_and_one_blank_row_without_color() {
        let output = SpeechOutput { color: false };
        assert_eq!(
            output.entry(
                "ms-dev-2",
                &record("First paragraph.\n\nSecond paragraph.\r\n")
            ),
            "2026-10-07T08:09:09.894Z [ms-dev-2] [narrate] android-improvements\nFirst paragraph. Second paragraph.\n\n"
        );
    }

    #[test]
    fn colors_are_header_only_and_reset_before_the_body() {
        let output = SpeechOutput { color: true };
        assert_eq!(
            output.entry("ms-dev-2", &record("Hello.")),
            "\x1b[2m2026-10-07T08:09:09.894Z\x1b[0m \x1b[36m[ms-dev-2]\x1b[0m \x1b[33m[narrate]\x1b[0m \x1b[1mandroid-improvements\x1b[0m\nHello.\n\n"
        );
        for (kind, sgr) in [("tts", 32), ("read", 35), ("choices", 34), ("future", 2)] {
            let mut record = record("Message");
            record.kind = kind.into();
            assert!(
                output
                    .entry("host", &record)
                    .contains(&format!("\x1b[{sgr}m[{kind}]\x1b[0m"))
            );
        }
    }

    #[test]
    fn legacy_identity_empty_and_unicode_bodies_are_preserved() {
        let output = SpeechOutput { color: false };
        let mut record = record("");
        record.agent = None;
        assert!(output.entry("host", &record).ends_with("session-id\n\n\n"));
        record.session = None;
        record.text = "héllo 世界 🦀".into();
        assert!(
            output
                .entry("host", &record)
                .ends_with("unknown\nhéllo 世界 🦀\n\n")
        );
    }

    #[test]
    fn untrusted_fields_cannot_inject_terminal_controls_or_extra_rows() {
        let mut record = record("\nHello\n\nworld\r\n\x1b[2J\x07\t\rX \\n literal\n");
        record.timestamp = "time\nspoof".into();
        record.kind = "kind\x1b[31m".into();
        record.agent = Some("agent\rspoof".into());
        let output = SpeechOutput { color: false }.entry("host\x1b]0;title\x07", &record);
        assert_eq!(output.lines().count(), 3);
        assert!(!output.contains('\x1b'));
        assert!(output.contains("time\\nspoof"));
        assert!(output.contains("host\\u{1b}]0;title\\u{7}"));
        assert!(output.contains("kind\\u{1b}[31m"));
        assert!(output.contains("agent\\rspoof"));
        assert!(output.ends_with("Hello world \\u{1b}[2J\\u{7}\\t\\rX \\n literal\n\n"));
        assert_eq!(message_line("bare\r"), "bare\\r");
    }

    #[test]
    fn color_policy_respects_tty_environment_and_explicit_overrides() {
        let dumb = Some(OsStr::new("dumb"));
        let no_color = Some(OsStr::new("1"));
        assert!(use_color(ColorChoice::Auto, true, None, None));
        assert!(use_color(
            ColorChoice::Auto,
            true,
            Some(OsStr::new("")),
            None
        ));
        assert!(!use_color(ColorChoice::Auto, false, None, None));
        assert!(!use_color(ColorChoice::Auto, true, no_color, None));
        assert!(!use_color(ColorChoice::Auto, true, None, dumb));
        assert!(use_color(ColorChoice::Always, false, no_color, dumb));
        assert!(!use_color(ColorChoice::Never, true, None, None));
    }
}
