//! How results and errors leave the process.
//!
//! Agents and pipes get compact JSON on stdout (errors as JSON on stderr);
//! people at a terminal get readable text. `--output` overrides the choice.

use serde::Serialize;
use std::fmt;
use std::io::{IsTerminal, Write};

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum Format {
    /// Compact JSON, one document per command.
    Json,
    /// Indented JSON.
    Pretty,
    /// Human-readable text.
    Text,
}

impl Format {
    pub fn detect(requested: Option<Format>, agent: bool) -> Format {
        requested.unwrap_or(if agent || !std::io::stdout().is_terminal() {
            Format::Json
        } else {
            Format::Text
        })
    }
}

/// A failure with a stable, machine-matchable code and a next step.
#[derive(Debug, Serialize)]
pub struct GmError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip)]
    pub exit: i32,
}

/// Exit codes are part of the contract: scripts branch on them.
pub mod exit {
    pub const ERROR: i32 = 1;
    pub const USAGE: i32 = 2;
    pub const NOT_FOUND: i32 = 3;
    /// The repository or remote is in a state that needs a decision first.
    pub const CONFLICT: i32 = 4;
    pub const AUTH: i32 = 5;
}

impl GmError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        GmError {
            code,
            message: message.into(),
            hint: None,
            exit: exit::ERROR,
        }
    }
    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    pub fn exit(mut self, code: i32) -> Self {
        self.exit = code;
        self
    }
    pub fn usage(message: impl Into<String>) -> Self {
        GmError::new("invalid_argument", message).exit(exit::USAGE)
    }
    pub fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        GmError::new(code, message).exit(exit::NOT_FOUND)
    }
}

impl fmt::Display for GmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl From<git2::Error> for GmError {
    fn from(error: git2::Error) -> Self {
        GmError::new("git_error", error.message().to_string())
    }
}

impl From<std::io::Error> for GmError {
    fn from(error: std::io::Error) -> Self {
        GmError::new("io_error", error.to_string())
    }
}

impl From<serde_json::Error> for GmError {
    fn from(error: serde_json::Error) -> Self {
        GmError::new("json_error", error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, GmError>;

/// Every command result can render itself for people; JSON comes from serde.
pub trait Render: Serialize {
    fn text(&self) -> String;
}

pub fn emit<T: Render>(format: Format, value: &T) {
    let mut out = std::io::stdout().lock();
    let rendered = match format {
        Format::Json => serde_json::to_string(value).expect("serializable output"),
        Format::Pretty => serde_json::to_string_pretty(value).expect("serializable output"),
        Format::Text => value.text().trim_end().to_string(),
    };
    if !rendered.is_empty() {
        let _ = writeln!(out, "{rendered}");
    }
}

pub fn emit_error(format: Format, error: &GmError) {
    let mut err = std::io::stderr().lock();
    match format {
        Format::Text => {
            let _ = writeln!(err, "error: {}", error.message);
            if let Some(hint) = &error.hint {
                let _ = writeln!(err, "hint: {hint}");
            }
        }
        _ => {
            let body = serde_json::json!({ "error": error });
            let _ = writeln!(err, "{body}");
        }
    }
}

/// Text styling that disappears when stdout is not a terminal.
pub mod style {
    use owo_colors::OwoColorize;
    use std::io::IsTerminal;
    use std::sync::OnceLock;

    fn enabled() -> bool {
        static ENABLED: OnceLock<bool> = OnceLock::new();
        *ENABLED.get_or_init(|| {
            std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none()
        })
    }

    pub fn change(s: &str) -> String {
        if enabled() {
            s.magenta().bold().to_string()
        } else {
            s.to_string()
        }
    }
    pub fn commit(s: &str) -> String {
        if enabled() {
            s.blue().to_string()
        } else {
            s.to_string()
        }
    }
    pub fn dim(s: &str) -> String {
        if enabled() {
            s.dimmed().to_string()
        } else {
            s.to_string()
        }
    }
    pub fn bookmark(s: &str) -> String {
        if enabled() {
            s.yellow().to_string()
        } else {
            s.to_string()
        }
    }
    pub fn good(s: &str) -> String {
        if enabled() {
            s.green().to_string()
        } else {
            s.to_string()
        }
    }
    pub fn bad(s: &str) -> String {
        if enabled() {
            s.red().to_string()
        } else {
            s.to_string()
        }
    }
}
