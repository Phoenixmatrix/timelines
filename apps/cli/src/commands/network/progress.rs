//! Live clone updates stay on stderr; stdout remains the final command result.

use crate::output::Format;
use serde::Serialize;
use std::io::Write;
use std::time::{Duration, Instant};

#[derive(Serialize)]
struct Update<'a> {
    event: &'static str,
    phase: &'static str,
    elapsed_ms: u128,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
}

pub(super) struct Progress {
    format: Format,
    quiet: bool,
    started: Instant,
    last: Instant,
    phase: Option<&'static str>,
}

impl Progress {
    pub(super) fn new(format: Format, quiet: bool) -> Self {
        let now = Instant::now();
        Self {
            format,
            quiet,
            started: now,
            last: now,
            phase: None,
        }
    }

    pub(super) fn stage(&mut self, phase: &'static str, message: &str) {
        self.emit(phase, message, None, None, true);
    }

    pub(super) fn git(&mut self, message: &str) {
        if self.quiet {
            return;
        }
        let text = message.strip_prefix("remote: ").unwrap_or(message).trim();
        let (label, detail) = text.split_once(':').unwrap_or(("", text));
        let phase = match label {
            "Enumerating objects" => "enumerating",
            "Counting objects" => "counting",
            "Compressing objects" => "compressing",
            "Receiving objects" => "receiving",
            "Resolving deltas" => "resolving",
            "Updating files" | "Checking out files" => "checkout",
            _ if message.starts_with("remote: ") => "remote",
            _ => "git",
        };
        let (percent, counts) = counters(detail);
        let finished =
            counts.is_some_and(|(current, total)| current == total) || text.ends_with("done.");
        self.emit(phase, message, percent, counts, finished);
    }

    fn emit(
        &mut self,
        phase: &'static str,
        message: &str,
        percent: Option<u8>,
        counts: Option<(u64, u64)>,
        force: bool,
    ) {
        if self.quiet {
            return;
        }
        let now = Instant::now();
        if !force
            && self.phase == Some(phase)
            && now.duration_since(self.last) < Duration::from_millis(250)
        {
            return;
        }
        self.phase = Some(phase);
        self.last = now;
        let mut stderr = std::io::stderr().lock();
        match self.format {
            Format::Text => {
                let _ = writeln!(stderr, "{message}");
            }
            Format::Json | Format::Pretty => {
                let update = Update {
                    event: "clone.progress",
                    phase,
                    elapsed_ms: now.duration_since(self.started).as_millis(),
                    message,
                    percent,
                    current: counts.map(|c| c.0),
                    total: counts.map(|c| c.1),
                };
                let _ = serde_json::to_writer(&mut stderr, &update);
                let _ = writeln!(stderr);
            }
        }
        let _ = stderr.flush();
    }
}

fn counters(detail: &str) -> (Option<u8>, Option<(u64, u64)>) {
    let percent = detail
        .split_once('%')
        .and_then(|(value, _)| value.trim().parse::<u8>().ok())
        .filter(|value| *value <= 100);
    let counts = detail
        .split_once('(')
        .and_then(|(_, rest)| rest.split_once(')'))
        .and_then(|(fraction, _)| fraction.split_once('/'))
        .and_then(|(current, total)| {
            Some((
                current.trim().parse::<u64>().ok()?,
                total.trim().parse::<u64>().ok()?,
            ))
        })
        .filter(|(current, total)| current <= total);
    (percent, counts)
}

#[cfg(test)]
mod tests {
    use super::counters;

    #[test]
    fn parses_object_counts_without_confusing_bytes_or_rates() {
        assert_eq!(
            counters(" 42% (84/200), 12.00 MiB | 3.00 MiB/s"),
            (Some(42), Some((84, 200)))
        );
        assert_eq!(
            counters(" 100% (200/200), done."),
            (Some(100), Some((200, 200)))
        );
        assert_eq!(counters(" 0% (0/200)"), (Some(0), Some((0, 200))));
    }

    #[test]
    fn leaves_unavailable_or_invalid_counters_absent() {
        assert_eq!(counters(" 200, done."), (None, None));
        assert_eq!(counters(" 101% (201/200)"), (None, None));
        assert_eq!(counters(" warning (not a fraction)"), (None, None));
    }
}
